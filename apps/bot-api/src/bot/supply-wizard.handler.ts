import axios from 'axios';
import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';

import {
    OzonApiService,
    OzonCluster,
    OzonCredentials,
    OzonFboWarehouseSearchItem,
    OzonDraftStatus,
    OzonDraftTimeslot,
    OzonSupplyCancelStatus,
    OzonSupplyCreateStatus,
} from '../config/ozon-api.service';

import { OzonSheetService } from '../ozon/ozon-sheet.service';
import { OzonSupplyService } from '../ozon/ozon-supply.service';
import { OzonSupplyProcessResult, OzonSupplyTask, OzonSupplyEventType } from '../ozon/ozon-supply.types';
import { UserCredentialsStore } from './user-credentials.store';
import { SupplyOrderStore } from '../storage/supply-order.store';
import { UserSessionService } from './user-session.service';

import {
    SupplyWizardStore,
    SupplyWizardState,
    SupplyWizardDropOffOption,
    SupplyWizardDraftWarehouseOption,
    SupplyWizardWarehouseOption,
    SupplyWizardTimeslotOption,
    SupplyWizardOrderSummary,
    SupplyWizardSupplyItem,
    SupplyWizardTaskContext,
} from './supply-wizard.store';

import { SupplyProcessService, SupplyOrderDetails } from './services/supply-process.service';
import { NotificationService } from './services/notification.service';
import { SupplyProcessingCoordinatorService } from './services/supply-processing-coordinator.service';
import { WizardEvent } from './services/wizard-event.types';
import { SupplyWizardViewService } from './supply-wizard/view.service';

@Injectable()
export class SupplyWizardHandler {
    private readonly logger = new Logger(SupplyWizardHandler.name);
    private readonly dropOffOptionsLimit = 10;
    private readonly draftPollIntervalMs = 10_000;
    private readonly draftPollMaxAttempts = 1_000;
    private readonly draftRecreateMaxAttempts = 1_000;
    private readonly draftLifetimeMs = 30 * 60 * 1000;
    private readonly readyDaysMin = 0;
    private readonly readyDaysMax = 28;
    private readonly warehousePageSize = 10;
    private readonly orderIdPollAttempts = 5;
    private readonly orderIdPollDelayMs = 1_000;
    private readonly cancelStatusMaxAttempts = 10;
    private readonly cancelStatusPollDelayMs = 1_000;
    private latestDraftWarehouses: SupplyWizardDraftWarehouseOption[] = [];
    private latestDraftId?: number;
    private latestDraftOperationId?: string;
    private readonly taskAbortControllers = new Map<string, { controller: AbortController; chatId: string }>();

    constructor(
        private readonly credentialsStore: UserCredentialsStore,
        private readonly sheetService: OzonSheetService,
        private readonly supplyService: OzonSupplyService,
        private readonly ozonApi: OzonApiService,
        private readonly process: SupplyProcessService,
        private readonly wizardStore: SupplyWizardStore,
        private readonly sessions: UserSessionService,
        private readonly processing: SupplyProcessingCoordinatorService,
        private readonly notifications: NotificationService,
        private readonly view: SupplyWizardViewService,
        private readonly orderStore: SupplyOrderStore,
    ) {}

    getState(chatId: string): SupplyWizardState | undefined {
        return this.wizardStore.get(chatId);
    }

    async start(ctx: Context): Promise<void> {
        const chatId = this.extractChatId(ctx);
        if (!chatId) {
            await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
            return;
        }

        const persistedOrders = await this.orderStore.list(chatId);
        const credentials = await this.resolveCredentials(chatId);
        const initialStage = credentials ? 'landing' : 'authWelcome';

        try {
            const persistedState = await this.sessions.loadChatState(chatId);
            if (persistedState) {
                this.wizardStore.hydrate(chatId, persistedState);
            }

            let baseState = this.wizardStore.get(chatId);
            if (!baseState) {
                baseState = this.wizardStore.start(
                    chatId,
                    {
                        clusters: persistedState?.clusters ?? [],
                        warehouses: persistedState?.warehouses ?? {},
                        dropOffs: [],
                    },
                    { stage: initialStage },
                );
            }

            const state =
                this.updateWizardState(chatId, (current) => {
                    const snapshot = current ?? baseState!;
                    return {
                        ...snapshot,
                        stage: snapshot.stage ?? initialStage,
                        orders: persistedOrders,
                        pendingApiKey: undefined,
                        pendingClientId: undefined,
                    };
                }) ?? {
                    ...baseState!,
                    stage: baseState?.stage ?? initialStage,
                    orders: persistedOrders,
                    pendingApiKey: undefined,
                    pendingClientId: undefined,
                };

            await this.syncPendingTasks(chatId);
            const landingState = this.wizardStore.get(chatId) ?? state;

            if (!credentials) {
                await this.view.updatePrompt(
                    ctx,
                    chatId,
                    landingState,
                    this.view.renderAuthWelcome(),
                    this.view.buildAuthWelcomeKeyboard(),
                    { parseMode: 'HTML' },
                );
                await this.notifications.notifyWizard(WizardEvent.Start, { ctx, lines: [`stage: ${landingState.stage}`] });
                return;
            }

            await this.view.updatePrompt(
                ctx,
                chatId,
                landingState,
                this.view.renderLanding(landingState),
                this.view.buildLandingKeyboard(landingState),
                { parseMode: 'HTML' },
            );
            await this.notifications.notifyWizard(WizardEvent.Start, { ctx, lines: [`stage: ${landingState.stage}`] });
        } catch (error) {
            this.logger.error(`start wizard failed: ${this.describeError(error)}`);
            await ctx.reply(`❌ Не удалось инициализировать мастер: ${this.describeError(error)}`);
        }
    }

    async handleDocument(ctx: Context): Promise<void> {
        const chatId = this.extractChatId(ctx);
        if (!chatId) {
            await ctx.reply('Не удалось определить чат. Используйте приватный диалог с ботом.');
            return;
        }

        let state = this.wizardStore.get(chatId);
        if (!state) {
            await this.start(ctx);
            state = this.wizardStore.get(chatId);
        }

        if (!state || state.stage !== 'awaitSpreadsheet') {
            await ctx.reply('Сначала запустите мастер командой /start.');
            return;
        }

        const document = (ctx.message as any)?.document;
        if (!document) return;

        if (!/\.xlsx$/i.test(document.file_name ?? '')) {
            await ctx.reply('Принимаю только файлы .xlsx.');
            return;
        }

        try {
            await this.view.updatePrompt(
                ctx,
                chatId,
                state,
                'Получаю файл, подождите...',
                this.view.buildUploadKeyboard(),
            );
            const buffer = await this.downloadTelegramFile(ctx, document.file_id);
            await this.processSpreadsheet(ctx, chatId, state, { buffer, label: document.file_name ?? 'файл' });
            await this.notifications.notifyWizard(WizardEvent.DocumentUploaded, {
                ctx,
                lines: [
                    `file: ${document.file_name ?? 'unknown'}`,
                    document.file_size ? `size: ${document.file_size} bytes` : undefined,
                ],
            });
        } catch (error) {
            this.logger.error(`handleDocument failed: ${this.describeError(error)}`);
            await ctx.reply(`❌ Не удалось обработать файл: ${this.describeError(error)}`);
            await ctx.reply('Пришлите Excel-файл (Артикул, Количество) повторно.');
            await this.notifications.notifyWizard(WizardEvent.DocumentError, { ctx, lines: [this.describeError(error)] });
        }
    }

    async handleAuthApiKeyInput(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        text: string,
    ): Promise<void> {
        const apiKey = text.trim();
        if (!apiKey) {
            await ctx.reply('API Key не должен быть пустым. Попробуйте ещё раз.');
            return;
        }

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                pendingApiKey: apiKey,
                stage: 'authClientId',
            };
        });

        if (!updated) {
            await ctx.reply('Мастер закрыт. Запустите /start заново.');
            return;
        }

        await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            this.view.renderAuthClientIdPrompt(this.maskSecret(apiKey)),
            this.view.buildAuthClientIdKeyboard(),
        );
    }

    async handleAuthClientIdInput(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        text: string,
    ): Promise<void> {
        const clientId = text.trim();
        if (!clientId) {
            await ctx.reply('Client ID не должен быть пустым. Попробуйте ещё раз.');
            return;
        }

        const apiKey = state.pendingApiKey;
        if (!apiKey) {
            await ctx.reply('Сначала введите API Key.');
            await this.showAuthApiKey(ctx, chatId, state);
            return;
        }

        await this.credentialsStore.set(chatId, { clientId, apiKey });

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                pendingApiKey: undefined,
                pendingClientId: undefined,
                stage: 'landing',
            };
        });

        if (!updated) {
            await ctx.reply('Мастер закрыт. Запустите /start заново.');
            return;
        }

        await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            this.view.renderLanding(updated),
            this.view.buildLandingKeyboard(updated),
            { parseMode: "HTML" }
        );

        await this.notifications.notifyWizard(WizardEvent.AuthCompleted, {
            ctx,
            lines: [`client_id: ${this.maskSecret(clientId)}`],
        });
    }

    async handleSpreadsheetLink(ctx: Context, text: string): Promise<void> {
        const chatId = this.extractChatId(ctx);
        if (!chatId) return;
        let state = this.wizardStore.get(chatId);
        if (!state) {
            await this.start(ctx);
            state = this.wizardStore.get(chatId);
        }

        if (!state || state.stage !== 'awaitSpreadsheet') {
            await ctx.reply('Запустите мастер командой /start и загрузите файл.');
            return;
        }

        const trimmed = text.trim();
        if (!trimmed) {
            await ctx.reply('Пришлите ссылку на Google Sheets или документ .xlsx.');
            return;
        }

        try {
            await this.view.updatePrompt(
                ctx,
                chatId,
                state,
                'Загружаю таблицу, подождите...',
                this.view.buildUploadKeyboard(),
            );
            await this.processSpreadsheet(ctx, chatId, state, { spreadsheet: trimmed, label: trimmed });
            await this.notifications.notifyWizard(WizardEvent.SpreadsheetLink, { ctx, lines: [`link: ${trimmed}`] });
        } catch (error) {
            this.logger.error(`handleSpreadsheetLink failed: ${this.describeError(error)}`);
            await ctx.reply(`❌ Не удалось обработать таблицу: ${this.describeError(error)}`);
            await this.notifications.notifyWizard(WizardEvent.SpreadsheetError, { ctx, lines: [this.describeError(error)] });
        }
    }

    async handleDropOffSearch(ctx: Context, text: string): Promise<void> {
        const chatId = this.extractChatId(ctx);
        if (!chatId) return;

        const state = this.wizardStore.get(chatId);
        if (
            !state ||
            !['awaitDropOffQuery', 'dropOffSelect', 'clusterPrompt', 'draftWarehouseSelect'].includes(state.stage)
        ) {
            await ctx.reply('Сначала загрузите файл и дождитесь запроса на выбор пункта сдачи.');
            return;
        }

        const query = text.trim();
        if (!query) {
            await ctx.reply('Введите название города или адрес пункта сдачи.');
            return;
        }

        const credentials = await this.resolveCredentials(chatId);
        if (!credentials) {
            await ctx.reply('🔐 Сначала сохраните ключи через /start.');
            return;
        }

        let warehouses: OzonFboWarehouseSearchItem[] = [];
        try {
            warehouses = await this.ozonApi.searchFboWarehouses(
                { search: query, supplyTypes: ['CREATE_TYPE_CROSSDOCK'] },
                credentials,
            );
        } catch (error) {
            this.logger.error(`searchFboWarehouses failed: ${this.describeError(error)}`);
            await ctx.reply(`Не удалось получить пункты сдачи: ${this.describeError(error)}`);
            return;
        }

        const options = this.mapDropOffSearchResults(warehouses);
        const activeTaskId = this.resolveActiveTaskId(chatId, state);

        if (!options.length) {
            const hasExistingSelection = Boolean(state.selectedDropOffId);
            const updated = this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: hasExistingSelection ? 'clusterPrompt' : 'awaitDropOffQuery',
                    dropOffs: [],
                    dropOffSearchQuery: query,
                    draftWarehouses: [],
                    draftTimeslots: [],
                    selectedTimeslot: undefined,
                    ...(hasExistingSelection
                        ? {}
                        : { selectedDropOffId: undefined, selectedDropOffName: undefined }),
                };
            });

            if (activeTaskId) {
                this.updateTaskContext(chatId, activeTaskId, (context) => ({
                    ...context,
                    stage: hasExistingSelection ? 'clusterPrompt' : 'awaitDropOffQuery',
                    dropOffSearchQuery: query,
                    draftWarehouses: [],
                    draftTimeslots: [],
                    selectedTimeslot: undefined,
                    selectedDropOffId: hasExistingSelection ? context.selectedDropOffId : undefined,
                    selectedDropOffName: hasExistingSelection ? context.selectedDropOffName : undefined,
                    updatedAt: Date.now(),
                }));
            }

            const targetState = updated ?? state;
            await this.view.updatePrompt(
                ctx,
                chatId,
                targetState,
                `По запросу «${query}» ничего не найдено. Попробуйте уточнить название города или адреса.`,
                this.view.buildDropOffQueryKeyboard(),
            );
            return;
        }

        const limited = options.slice(0, this.dropOffOptionsLimit);
        const truncated = limited.length < options.length;

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                stage: 'dropOffSelect',
                dropOffs: limited,
                dropOffSearchQuery: query,
                selectedDropOffId: undefined,
                selectedDropOffName: undefined,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
            };
        });

        if (!updated) {
            await ctx.reply('Мастер закрыт. Запустите /start, чтобы начать заново.');
            return;
        }

        const targetTaskId = this.resolveActiveTaskId(chatId, updated);
        if (targetTaskId) {
            this.updateTaskContext(chatId, targetTaskId, (context) => ({
                ...context,
                stage: 'dropOffSelect',
                selectedDropOffId: undefined,
                selectedDropOffName: undefined,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
                dropOffSearchQuery: query,
                updatedAt: Date.now(),
            }));
        }

        const lines = limited.map((option, index) => {
            const address = option.address ? ` — ${option.address}` : '';
            return `${index + 1}. ${option.name} (${option.warehouse_id})${address}`;
        });

        const summaryParts = [
            `Найдены пункты сдачи по запросу «${query}»:`,
            ...lines,
        ];

        if (truncated) {
            summaryParts.push(
                `… Показаны первые ${limited.length} из ${options.length} результатов. Уточните запрос, чтобы сузить список.`,
            );
        }

        const promptText = [
            ...summaryParts,
            '',
            'Выберите пункт сдачи кнопкой ниже или введите новый запрос, чтобы найти другой вариант.',
        ].join('\n');

        await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            promptText,
            this.view.buildDropOffKeyboard(updated),
        );
    }

    async handleReadyDays(ctx: Context, text: string): Promise<void> {
        const chatId = this.extractChatId(ctx);
        if (!chatId) return;

        const state = this.wizardStore.get(chatId);
        if (!state || state.stage !== 'awaitReadyDays') {
            await ctx.reply('Сначала загрузите файл и выберите склад/пункт сдачи.');
            return;
        }

        const normalizedText = text.trim().replace(',', '.');
        const parsed = Number(normalizedText);
        if (!Number.isFinite(parsed)) {
            await ctx.reply('Введите число: 0 или значение от 1 до 28.');
            return;
        }

        const readyInDays = Math.floor(parsed);
        const handled = await this.applyReadyDays(ctx, chatId, state, readyInDays);
        if (!handled) {
            await ctx.reply('Используйте 0 для первого доступного слота или число от 1 до 28.');
        }
    }

    private normalizeReadyDaysValue(value: number): number | undefined {
        if (!Number.isFinite(value)) {
            return undefined;
        }
        const rounded = Math.floor(value);
        if (rounded === 0) {
            return 0;
        }
        if (rounded < this.readyDaysMin || rounded > this.readyDaysMax) {
            return undefined;
        }
        return rounded;
    }

    private async applyReadyDays(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
        value: number,
    ): Promise<boolean> {
        const state = this.wizardStore.get(chatId) ?? fallback;
        if (!state || state.stage !== 'awaitReadyDays') {
            return false;
        }

        const normalized = this.normalizeReadyDaysValue(value);
        if (normalized === undefined) {
            return false;
        }

        await this.startSupplyProcessing(ctx, chatId, state, normalized);
        return true;
    }

    private async promptReadyDays(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
        options: { summaryLines?: string[] } = {},
    ): Promise<void> {
        const updated =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'awaitReadyDays',
                    readyInDays: undefined,
                    warehouseSearchQuery: undefined,
                    warehousePage: 0,
                };
            }) ?? fallback;

        const activeTaskId = this.resolveActiveTaskId(chatId, updated);
        if (activeTaskId) {
            this.updateTaskContext(chatId, activeTaskId, (context) => ({
                ...context,
                stage: 'awaitReadyDays',
                readyInDays: undefined,
                updatedAt: Date.now(),
            }));
        }

        const summarySource = options.summaryLines && options.summaryLines.length
            ? options.summaryLines
            : this.buildReadyContext(updated);
        const summary = summarySource.filter((line): line is string => Boolean(line && line.length));
        const textLines = summary.length
            ? [...summary, '', this.view.renderReadyDaysPrompt()]
            : [this.view.renderReadyDaysPrompt()];

        await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            textLines.join('\n'),
            this.view.buildReadyDaysKeyboard(),
            { parseMode: "HTML" }
        );
    }

    private buildReadyContext(state: SupplyWizardState): string[] {
        const lines: string[] = [];

        if (state.selectedClusterName || state.selectedClusterId) {
            lines.push(`Кластер: ${state.selectedClusterName ?? state.selectedClusterId}.`);
        }

        if (state.autoWarehouseSelection) {
            lines.push('Склад: Первый доступный (определю автоматически).');
        } else if (state.selectedWarehouseName || state.selectedWarehouseId) {
            lines.push(`Склад: ${state.selectedWarehouseName ?? state.selectedWarehouseId}.`);
        }

        if (state.selectedDropOffName || state.selectedDropOffId) {
            lines.push(`Пункт сдачи: ${state.selectedDropOffName ?? state.selectedDropOffId}.`);
        }

        if (state.selectedTimeslot?.label) {
            lines.push(`Таймслот: ${state.selectedTimeslot.label}.`);
        }

        return lines;
    }

    private async startSupplyProcessing(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        readyInDays: number,
    ): Promise<void> {
        const task = this.getSelectedTask(chatId, state);
        if (!task) {
            await ctx.reply('Не найдены товары для обработки. Запустите мастер заново.');
            this.wizardStore.clear(chatId);
            await this.sessions.deleteChatState(chatId);
            return;
        }
        if (!task.taskId) {
            await ctx.reply('Не удалось определить идентификатор задачи. Запустите мастер заново.');
            this.wizardStore.clear(chatId);
            await this.sessions.deleteChatState(chatId);
            return;
        }

        if (
            !state.selectedClusterId ||
            !state.selectedDropOffId ||
            (!state.selectedWarehouseId && !state.autoWarehouseSelection)
        ) {
            await ctx.reply('Должны быть выбраны кластер, склад и пункт сдачи. Запустите мастер заново.');
            this.wizardStore.clear(chatId);
            await this.sessions.deleteChatState(chatId);
            return;
        }

        const credentials = await this.resolveCredentials(chatId);
        if (!credentials) {
            await ctx.reply('🔐 Сначала сохраните ключи через /start.');
            return;
        }

        const abortController = this.registerAbortController(chatId, task.taskId);

        const wasAutoWarehouseSelection = typeof state.selectedWarehouseId !== 'number';
        const effectiveTask = this.cloneTask(task);

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                stage: 'landing',
                readyInDays,
                autoWarehouseSelection: current.autoWarehouseSelection,
                warehouseSearchQuery: undefined,
                warehousePage: 0,
            };
        });

        if (!updated) {
            await ctx.reply('Мастер закрыт. Запустите заново.');
            this.clearAbortController(task.taskId);
            return;
        }

        effectiveTask.clusterId = updated.selectedClusterId;
        effectiveTask.city = updated.selectedClusterName ?? '';
        effectiveTask.warehouseId = updated.selectedWarehouseId;
        effectiveTask.warehouseName = wasAutoWarehouseSelection
            ? effectiveTask.warehouseName
            : updated.selectedWarehouseName ?? effectiveTask.warehouseName;
        effectiveTask.selectedTimeslot = updated.selectedTimeslot?.data ?? effectiveTask.selectedTimeslot;
        effectiveTask.readyInDays = readyInDays;
        effectiveTask.warehouseAutoSelect = wasAutoWarehouseSelection;
        effectiveTask.warehouseSelectionPendingNotified = false;
        if (updated.draftOperationId) {
            effectiveTask.draftOperationId = updated.draftOperationId;
        }
        if (typeof updated.draftId === 'number') {
            effectiveTask.draftId = updated.draftId;
        }

        const warehouseLabel = wasAutoWarehouseSelection
            ? 'Первый доступный склад'
            : updated.selectedWarehouseName ??
            (typeof updated.selectedWarehouseId === 'number' ? `Склад ${updated.selectedWarehouseId}` : '—');

        const summaryLines = [
            `Кластер: ${updated.selectedClusterName ?? '—'}`,
            `Склад: ${warehouseLabel}`,
            `Пункт сдачи: ${updated.selectedDropOffName ?? updated.selectedDropOffId ?? '—'}`,
        ];

        summaryLines.push(`Готовность к отгрузке: ${readyInDays} дн.`);

        if (task.taskId) {
            this.updateTaskContext(chatId, task.taskId, (context) => {
                const nextTask = this.cloneTask(effectiveTask);
                return {
                    ...context,
                    stage: 'processing',
                    selectedClusterId: updated.selectedClusterId,
                    selectedClusterName: updated.selectedClusterName,
                    selectedWarehouseId: updated.selectedWarehouseId,
                    selectedWarehouseName: updated.selectedWarehouseName,
                    selectedDropOffId: updated.selectedDropOffId,
                    selectedDropOffName: updated.selectedDropOffName,
                    selectedTimeslot: updated.selectedTimeslot,
                    readyInDays,
                    autoWarehouseSelection: wasAutoWarehouseSelection,
                    draftOperationId: updated.draftOperationId,
                    draftId: updated.draftId,
                    draftStatus: updated.draftStatus,
                    draftCreatedAt: updated.draftCreatedAt,
                    draftExpiresAt: updated.draftExpiresAt,
                    draftError: updated.draftError,
                    draftWarehouses: updated.draftWarehouses,
                    draftTimeslots: updated.draftTimeslots,
                    task: nextTask,
                    summaryItems: nextTask.items.map((item) => ({
                        article: item.article,
                        quantity: item.quantity,
                        sku: item.sku,
                    })),
                    updatedAt: Date.now(),
                };
            });
        }

        try {
            await this.orderStore.saveTask(chatId, {
                task: effectiveTask,
                clusterId: updated.selectedClusterId!,
                clusterName: updated.selectedClusterName,
                warehouseId: updated.selectedWarehouseId,
                warehouseName:
                    wasAutoWarehouseSelection
                        ? warehouseLabel
                        : updated.selectedWarehouseName ??
                        (typeof updated.selectedWarehouseId === 'number'
                            ? String(updated.selectedWarehouseId)
                            : undefined),
                dropOffId: updated.selectedDropOffId!,
                dropOffName: updated.selectedDropOffName ?? String(updated.selectedDropOffId),
                readyInDays,
                timeslotLabel:
                    updated.selectedTimeslot?.label ?? this.process.describeTimeslot(effectiveTask.selectedTimeslot),
                warehouseAutoSelect: wasAutoWarehouseSelection,
                timeslotAutoSelect: true,
            });

            if (!this.wizardStore.get(chatId)) {
                this.clearAbortController(task.taskId);
                await this.orderStore.deleteByTaskId(chatId, task.taskId);
                return;
            }

            await this.syncPendingTasks(chatId);

            const landingState = this.wizardStore.get(chatId) ?? updated;
            const landingText = this.view.renderLanding(landingState);
            const promptText = [
                ...summaryLines,
                '',
                'Задача запущена. Проверяйте раздел «Мои задачи».',
                '',
                landingText,
            ].join('\n');

            if (!this.wizardStore.get(chatId)) {
                this.clearAbortController(task.taskId);
                await this.orderStore.deleteByTaskId(chatId, task.taskId);
                return;
            }

            await this.view.updatePrompt(
                ctx,
                chatId,
                landingState,
                promptText,
                this.view.buildLandingKeyboard(landingState),
                { parseMode: "HTML" }
            );
            await this.notifications.notifyWizard(WizardEvent.SupplyProcessing, { ctx, lines: summaryLines });
            if (!this.wizardStore.get(chatId)) {
                this.clearAbortController(task.taskId);
                await this.orderStore.deleteByTaskId(chatId, task.taskId);
                return;
            }
        } catch (error) {
            this.clearAbortController(task.taskId);
            throw error;
        }

        void this.processing.run({
            task: effectiveTask,
            credentials,
            readyInDays,
            dropOffWarehouseId: updated.selectedDropOffId,
            abortController,
            callbacks: {
                onEvent: async (result) => {
                    await this.sendSupplyEvent(ctx, result);
                },
                onWindowExpired: async () => {
                    await this.handleWindowExpired(ctx, chatId, updated, task);
                },
                onSupplyCreated: async (result) => {
                    await this.handleSupplySuccess(ctx, chatId, updated, task, result);
                },
                onError: async (error) => {
                    await this.handleSupplyFailure(ctx, chatId, updated, error);
                },
                onAbort: async () => {
                    this.logger.log(`[${chatId}] обработка поставки отменена пользователем`);
                },
                onFinally: async () => {
                    this.clearAbortController(task.taskId);
                },
            },
        });
    }

    private createTaskContext(options: {
        task: OzonSupplyTask;
        stage: SupplyWizardTaskContext['stage'];
        createdAt?: number;
        overrides?: Partial<SupplyWizardTaskContext>;
    }): SupplyWizardTaskContext {
        const { task, stage, createdAt, overrides = {} } = options;
        const summaryItems: SupplyWizardSupplyItem[] = task.items.map((item) => ({
            article: item.article,
            quantity: item.quantity,
            sku: item.sku,
        }));

        return {
            taskId: task.taskId ?? `${Date.now()}`,
            stage,
            draftStatus: overrides.draftStatus ?? 'idle',
            draftOperationId: overrides.draftOperationId,
            draftId: overrides.draftId,
            draftCreatedAt: overrides.draftCreatedAt,
            draftExpiresAt: overrides.draftExpiresAt,
            draftError: overrides.draftError,
            draftWarehouses: overrides.draftWarehouses?.map((item) => ({ ...item })) ?? [],
            draftTimeslots: overrides.draftTimeslots?.map((item) => ({ ...item })) ?? [],
            selectedClusterId: overrides.selectedClusterId,
            selectedClusterName: overrides.selectedClusterName,
            selectedWarehouseId: overrides.selectedWarehouseId,
            selectedWarehouseName: overrides.selectedWarehouseName,
            selectedDropOffId: overrides.selectedDropOffId,
            selectedDropOffName: overrides.selectedDropOffName,
            selectedTimeslot: overrides.selectedTimeslot
                ? {
                      ...overrides.selectedTimeslot,
                      data: overrides.selectedTimeslot.data
                          ? { ...overrides.selectedTimeslot.data }
                          : overrides.selectedTimeslot.data,
                  }
                : undefined,
            readyInDays: overrides.readyInDays,
            autoWarehouseSelection: overrides.autoWarehouseSelection,
            dropOffSearchQuery: overrides.dropOffSearchQuery,
            promptMessageId: overrides.promptMessageId,
            task: this.cloneTask(task),
            summaryItems,
            createdAt: createdAt ?? Date.now(),
            updatedAt: overrides.updatedAt,
        };
    }

    private resolveActiveTaskId(chatId: string, state: SupplyWizardState): string | undefined {
        const selected = state.selectedTaskId;
        if (selected) {
            const context = this.wizardStore.getTaskContext(chatId, selected);
            if (context) {
                return context.taskId;
            }
        }

        const contexts = this.wizardStore.listTaskContexts(chatId);
        if (contexts.length) {
            return contexts[0].taskId;
        }

        if (selected) {
            return selected;
        }

    }

    private updateTaskContext(
        chatId: string,
        taskId: string,
        updater: (context: SupplyWizardTaskContext) => SupplyWizardTaskContext,
    ): void {
        try {
            this.wizardStore.upsertTaskContext(chatId, taskId, (existing) => {
                if (!existing) return undefined;
                return updater(existing);
            });
        } catch (error) {
            this.logger.warn(`[${chatId}] failed to update task context ${taskId}: ${this.describeError(error)}`);
        }
    }

    private async handleWindowExpired(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
        task: OzonSupplyTask,
    ): Promise<void> {
        const entity = task.taskId ? await this.orderStore.findTask(chatId, task.taskId) : null;

        await this.orderStore.deleteByTaskId(chatId, task.taskId);
        await this.syncPendingTasks(chatId);

        this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                pendingTasks: current.pendingTasks?.filter((entry) => entry.taskId !== task.taskId),
                activeTaskId: current.activeTaskId === task.taskId ? undefined : current.activeTaskId,
            };
        });
        this.wizardStore.removeTaskContext(chatId, task.taskId);

        const dropOffLabel =
            entity?.dropOffName ??
            fallback.selectedDropOffName ??
            (typeof fallback.selectedDropOffId === 'number' ? String(fallback.selectedDropOffId) : '—');
        const warehouseLabel =
            entity?.warehouse ??
            fallback.selectedWarehouseName ??
            (typeof fallback.selectedWarehouseId === 'number' ? `Склад ${fallback.selectedWarehouseId}` : '—');
        const totalItems = task.items.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
        const skuCount = task.items.length;

        const messageLines = [
            `Задача ${task.taskId ?? '—'} остановлена ⛔️`,
            `Откуда: ${dropOffLabel ?? '—'}`,
            `Куда: ${warehouseLabel ?? '—'}`,
            `Товаров: ${skuCount} SKU / ${totalItems} шт.`,
            'Слот не был найден в заданном временном диапазоне. Пересоздайте задачу.',
        ];

        await ctx.reply(messageLines.join('\n'));

        const latestState = this.wizardStore.get(chatId) ?? fallback;
        await this.presentLandingAfterCancel(ctx, chatId, latestState);

        await this.notifications.notifyWizard(WizardEvent.TaskExpired, {
            ctx,
            lines: [
                `task: ${task.taskId ?? 'unknown'}`,
                `dropOff: ${dropOffLabel ?? 'n/a'}`,
                `warehouse: ${warehouseLabel ?? 'n/a'}`,
            ],
        });
    }

    private async syncPendingTasks(chatId: string): Promise<SupplyWizardOrderSummary[]> {
        const pending = await this.orderStore.listTaskSummaries(chatId);
        this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                pendingTasks: pending,
            };
        });
        return pending;
    }

    private updateWizardState(
        chatId: string,
        updater: (state: SupplyWizardState | undefined) => SupplyWizardState | undefined,
    ): SupplyWizardState | undefined {
        const next = this.wizardStore.update(chatId, updater);
        if (next) {
            this.syncActiveTaskContext(chatId, next);
        }
        this.persistState(chatId, next);
        return next;
    }

    private persistState(chatId: string, state?: SupplyWizardState): void {
        if (!state) {
            void this.sessions.deleteChatState(chatId).catch((error) => {
                this.logger.warn(`[${chatId}] failed to delete wizard session: ${this.describeError(error)}`);
            });
            return;
        }

        void this.sessions.saveChatState(chatId, state).catch((error) => {
            this.logger.warn(`[${chatId}] failed to persist wizard session: ${this.describeError(error)}`);
        });
    }

    private syncActiveTaskContext(chatId: string, state: SupplyWizardState): void {
        const context = this.buildActiveTaskContext(chatId, state);
        const taskId = context?.taskId;
        if (!taskId) {
            return;
        }

        try {
            this.wizardStore.upsertTaskContext(chatId, taskId, () => context);
        } catch (error) {
            this.logger.warn(`[${chatId}] failed to sync task context ${taskId}: ${this.describeError(error)}`);
        }
    }

    private buildActiveTaskContext(chatId: string, state: SupplyWizardState): SupplyWizardTaskContext | undefined {
        const activeTaskId = state.selectedTaskId;
        let baseContext: SupplyWizardTaskContext | undefined = activeTaskId
            ? this.wizardStore.getTaskContext(chatId, activeTaskId)
            : undefined;

        if (!baseContext) {
            const contexts = this.wizardStore.listTaskContexts(chatId);
            if (contexts.length) {
                baseContext = contexts[0];
            }
        }

        if (!baseContext) {
            return undefined;
        }

        const contextOverride = this.wizardStore.getTaskContext(chatId, baseContext.taskId);
        const effectiveTask = contextOverride ? this.cloneTask(contextOverride.task) : this.cloneTask(baseContext.task);
        return {
            ...baseContext,
            stage: state.stage,
            draftStatus: state.draftStatus ?? baseContext.draftStatus,
            draftOperationId: state.draftOperationId ?? baseContext.draftOperationId,
            draftId: state.draftId ?? baseContext.draftId,
            draftCreatedAt: state.draftCreatedAt ?? baseContext.draftCreatedAt,
            draftExpiresAt: state.draftExpiresAt ?? baseContext.draftExpiresAt,
            draftError: state.draftError ?? baseContext.draftError,
            selectedClusterId: state.selectedClusterId ?? baseContext.selectedClusterId,
            selectedClusterName: state.selectedClusterName ?? baseContext.selectedClusterName,
            selectedWarehouseId: state.selectedWarehouseId ?? baseContext.selectedWarehouseId,
            selectedWarehouseName: state.selectedWarehouseName ?? baseContext.selectedWarehouseName,
            selectedDropOffId: state.selectedDropOffId ?? baseContext.selectedDropOffId,
            selectedDropOffName: state.selectedDropOffName ?? baseContext.selectedDropOffName,
            selectedTimeslot: state.selectedTimeslot ?? baseContext.selectedTimeslot,
            readyInDays: state.readyInDays ?? baseContext.readyInDays,
            autoWarehouseSelection: state.autoWarehouseSelection ?? baseContext.autoWarehouseSelection,
            dropOffSearchQuery: state.dropOffSearchQuery ?? baseContext.dropOffSearchQuery,
            promptMessageId: state.promptMessageId ?? baseContext.promptMessageId,
            task: effectiveTask,
            summaryItems: effectiveTask.items.map((item) => ({
                article: item.article,
                quantity: item.quantity,
                sku: item.sku,
            })),
            updatedAt: Date.now(),
        };
    }

    private async cancelPendingTask(ctx: Context, chatId: string, taskId: string): Promise<void> {
        this.abortActiveTask(chatId, taskId);
        await this.orderStore.deleteByTaskId(chatId, taskId);
        await this.syncPendingTasks(chatId);
        this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                selectedTaskId: current.selectedTaskId === taskId ? undefined : current.selectedTaskId,
                autoWarehouseSelection: false,
            };
        });
        this.wizardStore.removeTaskContext(chatId, taskId);
        await this.notifications.notifyWizard(WizardEvent.TaskCancelled, { ctx, lines: [`task: ${taskId}`] });
    }

    async handleCallback(ctx: Context, data: string): Promise<void> {
        const chatId = this.extractChatId(ctx);
        if (!chatId) return;

        const state = this.wizardStore.get(chatId);
        if (!state) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Перезапустите бота, нажав /start');
            return;
        }

        const [, action, ...rest] = data.split(':');

        switch (action) {
            case 'auth':
                await this.onAuthCallback(ctx, chatId, state, rest);
                return;
            case 'landing':
                await this.onLandingCallback(ctx, chatId, state, rest);
                return;
            case 'support':
                await this.onSupportCallback(ctx, chatId, state, rest);
                return;
            case 'authReset':
                await this.onAuthResetCallback(ctx, chatId, state, rest);
                return;
            case 'orders':
                await this.onOrdersCallback(ctx, chatId, state, rest);
                return;
            case 'upload':
                await this.onUploadCallback(ctx, chatId, state, rest);
                return;
            case 'tasks':
                await this.onTasksCallback(ctx, chatId, state, rest);
                return;
            case 'ready':
                await this.onReadyCallback(ctx, chatId, state, rest);
                return;
            case 'clusterStart':
                await this.onClusterStart(ctx, chatId, state);
                return;
            case 'cluster':
                await this.onClusterSelect(ctx, chatId, state, rest[0]);
                return;
            case 'warehouse':
                await this.onWarehouseSelect(ctx, chatId, state, rest);
                return;
            case 'dropoff':
                await this.onDropOffSelect(ctx, chatId, state, rest[0]);
                return;
            case 'draftWarehouse':
                await this.onDraftWarehouseSelect(ctx, chatId, state, rest[0]);
                return;
      case 'timeslot':
        await this.onTimeslotSelect(ctx, chatId, state, rest[0]);
        return;
      case 'cancel': {
        this.abortActiveTask(chatId);
        const contexts = this.wizardStore.listTaskContexts(chatId);
        if (contexts.length) {
          const taskIds = contexts
            .map((context) => context.taskId)
            .filter((taskId): taskId is string => Boolean(taskId));
          if (taskIds.length) {
            await Promise.all(taskIds.map((taskId) => this.orderStore.deleteByTaskId(chatId, taskId)));
            await this.syncPendingTasks(chatId);
          }
        }
        this.wizardStore.clear(chatId);
        await this.sessions.deleteChatState(chatId);
        await this.safeAnswerCbQuery(ctx, chatId, 'Задача отменена');
        await this.presentLandingAfterCancel(ctx, chatId, state);
        return;
      }
            default:
                await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
                return;
        }
    }

    private async onAuthCallback(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        parts: string[],
    ): Promise<void> {
        const action = parts[0];

        switch (action) {
            case 'login':
                await this.showAuthApiKey(ctx, chatId, state);
                await this.safeAnswerCbQuery(ctx, chatId);
                return;
            case 'info':
                await this.showAuthInstruction(ctx, chatId, state);
                await this.safeAnswerCbQuery(ctx, chatId);
                return;
            case 'back': {
                const target = parts[1];
                if (target === 'welcome') {
                    await this.showAuthWelcome(ctx, chatId, state);
                    await this.safeAnswerCbQuery(ctx, chatId);
                    return;
                }
                if (target === 'apiKey') {
                    await this.showAuthApiKey(ctx, chatId, state, { keepExisting: true });
                    await this.safeAnswerCbQuery(ctx, chatId);
                    return;
                }
                break;
            }
            default:
                break;
        }

        await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
    }

    private async showAuthWelcome(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
    ): Promise<void> {
        const state =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'authWelcome',
                };
            }) ?? fallback;

        await this.view.updatePrompt(
            ctx,
            chatId,
            state,
            this.view.renderAuthWelcome(),
            this.view.buildAuthWelcomeKeyboard(),
            { parseMode: 'HTML' },
        );
    }

    private async showAuthInstruction(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
    ): Promise<void> {
        const state =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'authWelcome',
                };
            }) ?? fallback;

        await this.view.updatePrompt(
            ctx,
            chatId,
            state,
            this.view.renderAuthInstruction(),
            this.view.buildAuthInstructionKeyboard(),
        );
    }

    private async showAuthApiKey(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
        options: { keepExisting?: boolean } = {},
    ): Promise<void> {
        const state =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'authApiKey',
                    pendingApiKey: options.keepExisting ? current.pendingApiKey : undefined,
                };
            }) ?? fallback;

        await this.view.updatePrompt(
            ctx,
            chatId,
            state,
            this.view.renderAuthApiKeyPrompt(),
            this.view.buildAuthApiKeyKeyboard(),
        );
    }

    private async showAuthClientId(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
    ): Promise<void> {
        const updated =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'authClientId',
                };
            }) ?? fallback;

        const masked = updated.pendingApiKey ? this.maskSecret(updated.pendingApiKey) : undefined;

        await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            this.view.renderAuthClientIdPrompt(masked),
            this.view.buildAuthClientIdKeyboard(),
        );
    }

    private maskSecret(value: string): string {
        if (!value) {
            return '***';
        }
        if (value.length <= 4) {
            return '*'.repeat(value.length);
        }
        return `${value.slice(0, 2)}…${value.slice(-2)}`;
    }

    private async onLandingCallback(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        parts: string[],
    ): Promise<void> {
        const action = parts[0];

        switch (action) {
            case 'start':
                await this.presentUploadPrompt(ctx, chatId, state);
                await this.safeAnswerCbQuery(ctx, chatId, 'Жду файл');
                return;
            case 'back':
                await this.showLanding(ctx, chatId, state);
                await this.safeAnswerCbQuery(ctx, chatId, 'Вернулись назад');
                return;
            default:
                await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
                return;
        }
    }

    private async onSupportCallback(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        parts: string[],
    ): Promise<void> {
        const action = parts[0];

        if (!action) {
            await this.showSupportInfo(ctx, chatId, state);
            await this.safeAnswerCbQuery(ctx, chatId);
            return;
        }

        if (action === 'back') {
            await this.showLanding(ctx, chatId, state);
            await this.safeAnswerCbQuery(ctx, chatId, 'Вернулись назад');
            return;
        }

        await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
    }

    private async onAuthResetCallback(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        parts: string[],
    ): Promise<void> {
        const action = parts[0];

        switch (action) {
            case 'prompt': {
                await this.promptAuthReset(ctx, chatId, state);
                await this.safeAnswerCbQuery(ctx, chatId);
                return;
            }
            case 'confirm': {
                await this.safeAnswerCbQuery(ctx, chatId, 'Удаляем ключи…');
                await this.handleAuthResetConfirm(ctx, chatId);
                return;
            }
            case 'cancel': {
                await this.showLanding(ctx, chatId, state);
                await this.safeAnswerCbQuery(ctx, chatId, 'Отменено');
                return;
            }
            default:
                await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
                return;
        }
    }

    private async promptAuthReset(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
    ): Promise<void> {
        const updated =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'authResetConfirm',
                };
            }) ?? fallback;

        await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            this.view.renderAuthResetPrompt(),
            this.view.buildAuthResetKeyboard(),
            { parseMode: 'HTML' },
        );
    }

    private async handleAuthResetConfirm(ctx: Context, chatId: string): Promise<void> {
        await this.credentialsStore.clear(chatId);
        this.wizardStore.clear(chatId);
        await this.sessions.deleteChatState(chatId);

        await ctx.reply('✅ Ключи удалены из базы бота.');

        await this.notifications.notifyWizard(WizardEvent.AuthCleared, { ctx });

        await this.start(ctx);
    }

    private async showSupportInfo(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
    ): Promise<void> {
        const state =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'support',
                };
            }) ?? fallback;

        await this.view.updatePrompt(
            ctx,
            chatId,
            state,
            this.view.renderSupportInfo(),
            this.view.buildSupportKeyboard(),
            { parseMode: 'HTML' },
        );
    }

    private async handleReadyBack(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
    ): Promise<void> {
        const latest = this.wizardStore.get(chatId) ?? fallback;
        if (!latest) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
            return;
        }

        if (latest.draftWarehouses?.length) {
            await this.showDraftWarehouseSelectionPrompt(ctx, chatId, latest);
            await this.safeAnswerCbQuery(ctx, chatId, 'Вернулись к выбору склада');
            return;
        }

        if (latest.selectedClusterId && latest.selectedDropOffId) {
            const updated =
                this.updateWizardState(chatId, (current) => {
                    if (!current) return undefined;
                    return {
                        ...current,
                        stage: 'warehouseSelect',
                        readyInDays: undefined,
                        selectedTimeslot: undefined,
                        draftTimeslots: [],
                    };
                }) ?? latest;

            await this.showWarehouseSelection(ctx, chatId, updated);
            await this.safeAnswerCbQuery(ctx, chatId, 'Вернулись к выбору склада');
            return;
        }

        await this.showLanding(ctx, chatId, latest);
        await this.safeAnswerCbQuery(ctx, chatId, 'Вернулись назад');
    }

    private async showDraftWarehouseSelectionPrompt(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
    ): Promise<void> {
        const state =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'draftWarehouseSelect',
                    readyInDays: undefined,
                    selectedTimeslot: undefined,
                    draftTimeslots: [],
                };
            }) ?? fallback;

        const warehouses = state.draftWarehouses ?? [];

        if (!warehouses.length) {
            await this.view.updatePrompt(
                ctx,
                chatId,
                state,
                'Список складов пока пуст. Подождите пару секунд и попробуйте снова.',
                this.view.withCancel(),
            );
            return;
        }

        const headerLines = ['Черновик готов ✅'];
        if (state.draftOperationId) {
            headerLines.push(`operation_id: ${state.draftOperationId}`);
        }
        if (typeof state.draftId === 'number') {
            headerLines.push(`draft_id: ${state.draftId}`);
        }
        if (state.draftExpiresAt) {
            headerLines.push(`Действителен примерно до ${this.formatDraftExpiresAt(state.draftExpiresAt)}.`);
        }

        const summaryLines = this.view.formatDraftWarehouseSummary(warehouses);

        const promptText = [
            ...headerLines,
            '',
            'Склады, готовые принять поставку:',
            ...summaryLines,
            '',
            'Выберите склад кнопкой ниже, чтобы продолжить.',
        ].join('\n');

        await this.view.updatePrompt(
            ctx,
            chatId,
            state,
            promptText,
            this.view.buildDraftWarehouseKeyboard(state),
        );
    }

    private async showLanding(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
    ): Promise<void> {
        await this.syncPendingTasks(chatId);
        const state =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'landing',
                    activeOrderId: undefined,
                    activeTaskId: undefined,
                };
            }) ?? fallback;

        await this.view.updatePrompt(
            ctx,
            chatId,
            state,
            this.view.renderLanding(state),
            this.view.buildLandingKeyboard(state),
            { parseMode: "HTML" }
        );
    }

    private async presentUploadPrompt(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
    ): Promise<void> {
        const state =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'awaitSpreadsheet',
                    spreadsheet: undefined,
                    selectedTaskId: undefined,
                    dropOffs: [],
                    dropOffSearchQuery: undefined,
                    selectedDropOffId: undefined,
                    selectedDropOffName: undefined,
                    selectedClusterId: undefined,
                    selectedClusterName: undefined,
                    selectedWarehouseId: undefined,
                    selectedWarehouseName: undefined,
                    draftWarehouses: [],
                    draftTimeslots: [],
                    draftStatus: 'idle',
                    draftOperationId: undefined,
                    draftId: undefined,
                    draftCreatedAt: undefined,
                    draftExpiresAt: undefined,
                    draftError: undefined,
                    selectedTimeslot: undefined,
                    readyInDays: undefined,
                };
            }) ?? fallback;

        await this.view.updatePrompt(
            ctx,
            chatId,
            state,
            this.view.renderUploadPrompt(),
            this.view.buildUploadKeyboard(),
            { parseMode: 'HTML' },
        );
    }

    private async onOrdersCallback(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        parts: string[],
    ): Promise<void> {
        const action = parts[0];

        switch (action) {
            case 'list':
                await this.showOrdersList(ctx, chatId, state);
                await this.safeAnswerCbQuery(ctx, chatId);
                return;
            case 'details': {
                const orderId = parts[1];
                await this.showOrderDetails(ctx, chatId, state, orderId);
                await this.safeAnswerCbQuery(ctx, chatId);
                return;
            }
            case 'cancel': {
                const orderId = parts[1];
                const message = await this.cancelSupplyOrder(ctx, chatId, state, orderId);
                await this.safeAnswerCbQuery(ctx, chatId, message);
                return;
            }
            case 'back':
                await this.showLanding(ctx, chatId, state);
                await this.safeAnswerCbQuery(ctx, chatId, 'Вернулись назад');
                return;
            default:
                await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
                return;
        }
    }

  private async onUploadCallback(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    parts: string[],
  ): Promise<void> {
    const action = parts[0];

    if (action === 'restart') {
      await this.presentUploadPrompt(ctx, chatId, state);
      await this.safeAnswerCbQuery(ctx, chatId, 'Загрузите новый файл');
      return;
    }

    await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
  }

  private async presentLandingAfterCancel(
    ctx: Context,
    chatId: string,
    fallback: SupplyWizardState,
  ): Promise<void> {
    const pendingTasks = await this.syncPendingTasks(chatId);
    const orders = await this.orderStore.list(chatId);

    const baseState =
      this.wizardStore.start(
        chatId,
        {
          clusters: fallback.clusters ?? [],
          warehouses: fallback.warehouses ?? {},
          dropOffs: [],
        },
        { stage: 'landing' },
      ) ?? fallback;

    const updated =
      this.updateWizardState(chatId, (current) => {
        if (!current) return undefined;
        return {
          ...current,
          orders,
          pendingTasks,
          promptMessageId: undefined,
          activeOrderId: undefined,
          activeTaskId: undefined,
        };
      }) ?? baseState;

    await this.view.updatePrompt(
      ctx,
      chatId,
      updated,
      this.view.renderLanding(updated),
      this.view.buildLandingKeyboard(updated),
      { parseMode: 'HTML' },
    );
  }

  private async onTasksCallback(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    parts: string[],
  ): Promise<void> {
    const action = parts[0];

        switch (action) {
            case 'list': {
                await this.syncPendingTasks(chatId);
                const current = this.wizardStore.get(chatId) ?? state;
                const updated =
                    this.updateWizardState(chatId, (existing) => {
                        if (!existing) return undefined;
                        return {
                            ...existing,
                            stage: 'tasksList',
                            activeTaskId: undefined,
                        };
                    }) ?? current;

                await this.view.updatePrompt(
                    ctx,
                    chatId,
                    updated,
                    this.view.renderTasksList(updated),
                    this.view.buildTasksListKeyboard(updated),
                );
                await this.safeAnswerCbQuery(ctx, chatId);
                return;
            }
            case 'details': {
                const taskId = parts[1];
                await this.syncPendingTasks(chatId);
                const current = this.wizardStore.get(chatId) ?? state;
                if (!taskId) {
                    await this.safeAnswerCbQuery(ctx, chatId, 'Задача не найдена');
                    return;
                }
                const task = current.pendingTasks.find((item) => item.taskId === taskId || item.id === taskId);
                if (!task) {
                    await this.safeAnswerCbQuery(ctx, chatId, 'Задача не найдена');
                    return;
                }

                const updated =
                    this.updateWizardState(chatId, (existing) => {
                        if (!existing) return undefined;
                        return {
                            ...existing,
                            stage: 'taskDetails',
                            activeTaskId: taskId,
                        };
                    }) ?? current;

                await this.view.updatePrompt(
                    ctx,
                    chatId,
                    updated,
                    this.view.renderTaskDetails(task),
                    this.view.buildTaskDetailsKeyboard(task),
                );
                await this.safeAnswerCbQuery(ctx, chatId);
                return;
            }
            case 'cancel': {
                const taskId = parts[1];
                if (!taskId) {
                    await this.safeAnswerCbQuery(ctx, chatId, 'Задача не найдена');
                    return;
                }

                await this.cancelPendingTask(ctx, chatId, taskId);
                await this.syncPendingTasks(chatId);
                const current = this.wizardStore.get(chatId) ?? state;
                if (current.pendingTasks.length) {
                    const updated =
                        this.updateWizardState(chatId, (existing) => {
                            if (!existing) return undefined;
                            return {
                                ...existing,
                                stage: 'tasksList',
                                activeTaskId: undefined,
                            };
                        }) ?? current;

                    await this.view.updatePrompt(
                        ctx,
                        chatId,
                        updated,
                        this.view.renderTasksList(updated),
                        this.view.buildTasksListKeyboard(updated),
                    );
                } else {
                    await this.showLanding(ctx, chatId, current);
                }
                await this.safeAnswerCbQuery(ctx, chatId, 'Задача отменена');
                return;
            }
            case 'back':
                await this.showLanding(ctx, chatId, state);
                await this.safeAnswerCbQuery(ctx, chatId, 'Вернулись назад');
                return;
            default:
                await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
                return;
        }
    }

    private async onReadyCallback(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        parts: string[],
    ): Promise<void> {
        const action = parts[0];

        switch (action) {
            case 'select': {
                const value = Number(parts[1]);
                const handled = await this.applyReadyDays(ctx, chatId, state, value);
                await this.safeAnswerCbQuery(ctx, chatId, handled ? 'Готовность учтена' : 'Некорректное значение');
                if (!handled) {
                    const latest = this.wizardStore.get(chatId) ?? state;
                    if (latest?.stage === 'awaitReadyDays') {
                        await this.promptReadyDays(ctx, chatId, latest);
                    }
                }
                return;
            }
            case 'back': {
                await this.handleReadyBack(ctx, chatId, state);
                return;
            }
            default:
                await this.safeAnswerCbQuery(ctx, chatId, 'Неизвестное действие');
                return;
        }
    }

    private async showOrdersList(
        ctx: Context,
        chatId: string,
        fallback: SupplyWizardState,
    ): Promise<void> {
        const state =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'ordersList',
                };
            }) ?? fallback;

        await this.view.updatePrompt(
            ctx,
            chatId,
            state,
            this.view.renderOrdersList(state),
            this.view.buildOrdersListKeyboard(state),
        );
    }

    private async showOrderDetails(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        orderId?: string,
    ): Promise<void> {
        if (!orderId) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Заявка не найдена');
            return;
        }

        const currentState = this.wizardStore.get(chatId) ?? state;
        const order = currentState.orders.find((item) => item.id === orderId);
        if (!order) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Заявка не найдена');
            return;
        }

        const updated =
            this.updateWizardState(chatId, (existing) => {
                if (!existing) return undefined;
                return {
                    ...existing,
                    stage: 'orderDetails',
                    activeOrderId: orderId,
                };
            }) ?? currentState;

        await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            this.view.renderOrderDetails(order),
            this.view.buildOrderDetailsKeyboard(order),
        );
    }

    private async cancelSupplyOrder(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        orderId?: string,
    ): Promise<string> {
        const current = this.wizardStore.get(chatId) ?? state;
        const rawTargetId = orderId ?? current.activeOrderId;
        const targetId = rawTargetId ? rawTargetId.trim() : '';
        if (!targetId) {
            await ctx.reply('Поставка не найдена. Откройте её в списке и попробуйте снова.');
            return 'Поставка не найдена';
        }

        const order =
            current.orders.find((item) => item.id === targetId) ??
            current.orders.find((item) => item.operationId === targetId);
        if (!order) {
            await ctx.reply('Поставка не найдена. Обновите список и попробуйте снова.');
            return 'Поставка не найдена';
        }

        const credentials = await this.resolveCredentials(chatId);
        if (!credentials) {
            await ctx.reply('🔐 Сначала сохраните ключи через /start.');
            return 'Нет ключей';
        }

        const operationId = order.operationId ?? order.id;
        if (!operationId) {
            await ctx.reply('Не удалось найти operation_id для этой поставки. Попробуйте позже.');
            return 'operation_id отсутствует';
        }

        let resolvedOrderId = order.orderId;
        if (!resolvedOrderId) {
            let status: OzonSupplyCreateStatus | undefined;
            try {
                status = await this.ozonApi.getSupplyCreateStatus(operationId, credentials);
            } catch (error) {
                const message = `Не удалось получить статус поставки: ${this.describeError(error)}`;
                await ctx.reply(`❌ ${message}`);
                await this.notifications.notifyWizard(WizardEvent.OrderCancelFailed, {
                    ctx,
                    lines: [
                        `operation: ${operationId}`,
                        message,
                    ],
                });
                return 'Ошибка';
            }

            const ids = this.process.extractOrderIdsFromStatus(status);
            resolvedOrderId = ids[0];
            if (!resolvedOrderId) {
                await ctx.reply('❌ Ozon не вернул идентификатор заказа для этой поставки. Попробуйте позже.');
                await this.notifications.notifyWizard(WizardEvent.OrderCancelFailed, {
                    ctx,
                    lines: [
                        `operation: ${operationId}`,
                        'order_ids: []',
                    ],
                });
                return 'order_id не найден';
            }

            await this.orderStore.setOrderId(chatId, order.operationId ?? operationId, resolvedOrderId);
            this.updateWizardState(chatId, (existing) => {
                if (!existing) return undefined;
                const orders = existing.orders.map((item) => {
                    if (
                        (item.operationId && item.operationId === order.operationId) ||
                        item.id === order.id
                    ) {
                        return {
                            ...item,
                            orderId: resolvedOrderId,
                            id: String(resolvedOrderId),
                        };
                    }
                    return item;
                });
                return {
                    ...existing,
                    orders,
                };
            });
        }

        if (!resolvedOrderId) {
            await ctx.reply('❌ Не удалось определить order_id для этой поставки.');
            return 'order_id не найден';
        }

        const refreshedState = this.wizardStore.get(chatId) ?? current;
        const normalizedOrder =
            refreshedState.orders.find((item) => item.orderId === resolvedOrderId) ??
            refreshedState.orders.find((item) => item.operationId === order.operationId) ??
            order;

        const aligned =
            this.updateWizardState(chatId, (existing) => {
                if (!existing) return undefined;
                return {
                    ...existing,
                    stage: 'orderDetails',
                    activeOrderId: normalizedOrder.id,
                };
            }) ?? refreshedState;

        const orderDetailsText = this.view.renderOrderDetails(normalizedOrder);
        const progressText = [orderDetailsText, '', '⏳ Отменяю поставку...'].join('\n');
        const progressKeyboard = this.view.withNavigation([], { back: 'wizard:orders:list' });

        await this.view.updatePrompt(
            ctx,
            chatId,
            aligned,
            progressText,
            progressKeyboard,
        );

        let cancelOperationId: string | undefined;
        try {
            cancelOperationId = await this.ozonApi.cancelSupplyOrder(resolvedOrderId, credentials);
        } catch (error) {
            const message = `Не удалось отправить запрос на отмену: ${this.describeError(error)}`;
            await ctx.reply(`❌ ${message}`);
            await this.view.updatePrompt(
                ctx,
                chatId,
                aligned,
                orderDetailsText,
                this.view.buildOrderDetailsKeyboard(normalizedOrder),
            );
            await this.notifications.notifyWizard(WizardEvent.OrderCancelFailed, {
                ctx,
                lines: [
                    `operation: ${operationId}`,
                    `order_id: ${resolvedOrderId}`,
                    message,
                ],
            });
            return 'Ошибка';
        }

        if (!cancelOperationId) {
            await ctx.reply('❌ Ozon не вернул operation_id отмены. Попробуйте позже.');
            await this.view.updatePrompt(
                ctx,
                chatId,
                aligned,
                orderDetailsText,
                this.view.buildOrderDetailsKeyboard(normalizedOrder),
            );
            await this.notifications.notifyWizard(WizardEvent.OrderCancelFailed, {
                ctx,
                lines: [
                    `operation: ${operationId}`,
                    `order_id: ${resolvedOrderId}`,
                    'cancel operation_id missing',
                ],
            });
            return 'operation_id отсутствует';
        }

        const cancelStatus = await this.process.waitForCancelStatus(cancelOperationId, credentials, {
            maxAttempts: this.cancelStatusMaxAttempts,
            delayMs: this.cancelStatusPollDelayMs,
        });

        if (!this.process.isCancelSuccessful(cancelStatus)) {
            const reason = this.process.describeCancelStatus(cancelStatus);
            await ctx.reply(`❌ Не удалось подтвердить отмену поставки. ${reason}`);
            await this.view.updatePrompt(
                ctx,
                chatId,
                aligned,
                orderDetailsText,
                this.view.buildOrderDetailsKeyboard(normalizedOrder),
            );
            await this.notifications.notifyWizard(WizardEvent.OrderCancelFailed, {
                ctx,
                lines: [
                    `operation: ${operationId}`,
                    `order_id: ${resolvedOrderId}`,
                    `cancel_operation: ${cancelOperationId}`,
                    `status: ${reason}`,
                ],
            });
            return 'Отмена не подтверждена';
        }

        if (order.operationId) {
            await this.orderStore.deleteByOperationId(chatId, order.operationId);
            await this.orderStore.deleteById(chatId, order.operationId);
        } else {
            await this.orderStore.deleteById(chatId, normalizedOrder.id);
        }
        const refreshedOrders = await this.orderStore.list(chatId);

        const updated =
            this.updateWizardState(chatId, (existing) => {
                if (!existing) return undefined;
                return {
                    ...existing,
                    orders: refreshedOrders,
                    activeOrderId: undefined,
                    stage: refreshedOrders.length ? 'ordersList' : 'landing',
                };
            }) ?? aligned;

        const successInfo = [
            `Поставка №${resolvedOrderId} отменена ✅`,
            cancelStatus?.result?.is_order_cancelled ? 'Поставка в ЛК Ozon отменена.' : undefined,
        ].filter((line): line is string => Boolean(line));
        const successText = successInfo.join('\n') || 'Поставка отменена ✅';

        if (updated.stage === 'ordersList') {
            const listText = this.view.renderOrdersList(updated);
            await this.view.updatePrompt(
                ctx,
                chatId,
                updated,
                [successText, '', listText].join('\n'),
                this.view.buildOrdersListKeyboard(updated),
            );
        } else {
            const landingText = this.view.renderLanding(updated);
            await this.view.updatePrompt(
                ctx,
                chatId,
                updated,
                [successText, '', landingText].join('\n'),
                this.view.buildLandingKeyboard(updated),
                { parseMode: 'HTML' },
            );
        }

        await this.notifications.notifyWizard(WizardEvent.OrderCancelled, {
            ctx,
            lines: [
                `operation: ${operationId}`,
                `order_id: ${resolvedOrderId}`,
                `cancel_operation: ${cancelOperationId}`,
            ],
        });

        return 'Поставка отменена';
    }

    private async handleSupplyFailure(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        error: unknown,
    ): Promise<void> {
        this.logger.error(`processSupplyTask failed: ${this.describeError(error)}`);
        await this.view.updatePrompt(ctx, chatId, state, 'Мастер завершён с ошибкой ❌');
        await ctx.reply(`❌ Ошибка при обработке: ${this.describeError(error)}`);
        await this.view.sendErrorDetails(ctx, this.extractErrorPayload(error));
        await this.notifications.notifyWizard(WizardEvent.SupplyError, { ctx, lines: [this.describeError(error)] });
    }

    private async handleSupplySuccess(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        task: OzonSupplyTask,
        result?: OzonSupplyProcessResult,
    ): Promise<void> {
        const operationId = result?.operationId ?? this.extractOperationIdFromMessage(result?.message) ?? task.draftOperationId ?? `draft-${task.draftId ?? task.taskId}`;

        const credentials = await this.resolveCredentials(chatId);
        let orderId: number | undefined;
        let orderDetails: SupplyOrderDetails | undefined;
        if (credentials && operationId) {
            orderId = await this.process.fetchOrderIdWithRetries(operationId, credentials, {
                attempts: this.orderIdPollAttempts,
                delayMs: this.orderIdPollDelayMs,
            });
            if (!orderId) {
                this.logger.warn(`Не удалось получить order_id для ${operationId} после ${this.orderIdPollAttempts} попыток`);
            } else {
                orderDetails = await this.process.fetchSupplyOrderDetails(orderId, credentials);
            }
        }

        const dropOffName =
            orderDetails?.dropOffName ??
            state.selectedDropOffName ??
            state.selectedDropOffId?.toString();

        const dropOffId = orderDetails?.dropOffId ?? state.selectedDropOffId ?? undefined;

        const warehouseId = orderDetails?.storageWarehouseId ?? state.selectedWarehouseId ?? task.warehouseId;

        const warehouseNameDetailed =
            orderDetails?.storageWarehouseName ??
            state.selectedWarehouseName ??
            task.warehouseName ??
            (typeof warehouseId === 'number' ? `Склад ${warehouseId}` : undefined);

        const warehouseDisplay = warehouseNameDetailed ?? dropOffName;

        const timeslotLabel =
            orderDetails?.timeslotLabel ??
            state.selectedTimeslot?.label ??
            this.process.describeTimeslot(task.selectedTimeslot);

        const timeslotFrom = orderDetails?.timeslotFrom ?? task.selectedTimeslot?.from_in_timezone;
        const timeslotTo = orderDetails?.timeslotTo ?? task.selectedTimeslot?.to_in_timezone;

        const items: SupplyWizardSupplyItem[] = task.items.map((item) => ({
            article: item.article,
            quantity: item.quantity,
            sku: item.sku,
        }));

        const entry: SupplyWizardOrderSummary = {
            id: orderId ? String(orderId) : operationId,
            orderId,
            taskId: task.taskId,
            operationId,
            status: 'supply',
            arrival: timeslotLabel ?? undefined,
            warehouse: warehouseDisplay ?? undefined,
            dropOffName: dropOffName,
            clusterName: state.selectedClusterName,
            timeslotLabel: timeslotLabel ?? undefined,
            items,
            createdAt: Date.now(),
        };

        const updated =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                const withoutDuplicate = current.orders.filter((order) => {
                    if (entry.orderId && order.orderId && order.orderId === entry.orderId) {
                        return false;
                    }
                    if (order.operationId && order.operationId === entry.operationId) {
                        return false;
                    }
                    return order.id !== entry.id;
                });
                return {
                    ...current,
                    orders: [...withoutDuplicate, entry],
                    stage: 'landing',
                    readyInDays: undefined,
                    selectedTimeslot: undefined,
                    draftTimeslots: [],
                    draftWarehouses: [],
                    draftStatus: 'idle',
                    draftOperationId: undefined,
                    draftId: undefined,
                    draftCreatedAt: undefined,
                    draftExpiresAt: undefined,
                    draftError: undefined,
                    spreadsheet: undefined,
                };
            }) ?? state;

        this.wizardStore.removeTaskContext(chatId, task.taskId);

        await this.orderStore.completeTask(chatId, {
            taskId: task.taskId,
            operationId,
            orderId,
            arrival: entry.arrival,
            warehouse: entry.warehouse,
            warehouseName: warehouseNameDetailed,
            warehouseId: warehouseId,
            dropOffName: dropOffName,
            dropOffId: dropOffId,
            timeslotFrom,
            timeslotTo,
            items,
            task,
        });

        await this.syncPendingTasks(chatId);

        const refreshed = this.wizardStore.get(chatId) ?? updated;
        const successText = this.view.renderSupplySuccess(entry);
        const landingText = this.view.renderLanding(refreshed);
        const promptText = [successText, '', landingText].join('\n');

        await this.view.updatePrompt(
            ctx,
            chatId,
            refreshed,
            promptText,
            this.view.buildLandingKeyboard(refreshed),
            { parseMode: "HTML" }
        );

        await this.notifications.notifyWizard(WizardEvent.SupplyDone, {
            ctx,
            lines: [
                orderId ? `order: ${orderId}` : `operation: ${operationId}`,
                entry.arrival ? `arrival: ${entry.arrival}` : undefined,
                entry.warehouse ? `warehouse: ${entry.warehouse}` : undefined,
            ],
        });
    }

    private extractOperationIdFromMessage(message?: string): string | undefined {
        if (!message) return undefined;
        const match = /operation_id=([\w-]+)/i.exec(message);
        return match ? match[1] : undefined;
    }

    private async processSpreadsheet(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        source: { buffer?: Buffer; spreadsheet?: string; label: string },
    ): Promise<void> {
        const credentials = await this.resolveCredentials(chatId);
        if (!credentials) {
            await ctx.reply('🔐 Сначала сохраните ключи через /start.');
            return;
        }

        const taskMap = await this.supplyService.prepareTasks({
            credentials,
            buffer: source.buffer,
            spreadsheet: source.spreadsheet,
        });

        const tasks = [...taskMap.values()];
        if (!tasks.length) {
            await ctx.reply('В документе не найдены товары. Проверьте колонки «Артикул» и «Количество».');
            return;
        }

        const clonedTasks = tasks.map((task) => this.cloneTask(task));

        for (const task of clonedTasks) {
            task.clusterId = undefined;
            task.warehouseId = undefined;
            task.draftId = task.draftId ?? 0;
            task.draftOperationId = task.draftOperationId ?? '';
            task.orderFlag = task.orderFlag ?? 0;
            task.selectedTimeslot = undefined;
        }

        await this.process.resolveSkus(clonedTasks[0], credentials);

        const summary = this.view.formatItemsSummary(clonedTasks[0]);
        const createdContexts: SupplyWizardTaskContext[] = [];

        const now = Date.now();
        const newTaskIds = new Set(
            clonedTasks
                .map((task) => task.taskId)
                .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0),
        );
        const existingContexts = this.wizardStore.listTaskContexts(chatId);
        for (const context of existingContexts) {
            if (!newTaskIds.has(context.taskId)) {
                this.wizardStore.removeTaskContext(chatId, context.taskId);
            }
        }

        for (const [index, task] of clonedTasks.entries()) {
            const context = this.createTaskContext({
                task,
                stage: 'awaitDropOffQuery',
                createdAt: now + index,
            });
            if (task.taskId) {
                this.wizardStore.upsertTaskContext(chatId, task.taskId, () => context);
                createdContexts.push(context);
            }
        }

        let clusters: OzonCluster[] = [];
        try {
            const response = await this.ozonApi.listClusters({}, credentials);
            clusters = response.clusters;
        } catch (error) {
            this.logger.error(`listClusters failed: ${this.describeError(error)}`);
            await ctx.reply('Не удалось получить список кластеров. Попробуйте позже.');
            return;
        }

        if (!clusters.length) {
            await ctx.reply('Ozon вернул пустой список кластеров. Попробуйте позже.');
            return;
        }

        const options = this.view.buildOptions(clusters);

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            const selectedTaskId = createdContexts[0]?.taskId ?? current.selectedTaskId;
            return {
                ...current,
                stage: 'awaitDropOffQuery',
                spreadsheet: source.label,
                selectedTaskId,
                clusters: options.clusters,
                warehouses: options.warehouses,
                dropOffs: [],
                dropOffSearchQuery: undefined,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
                selectedClusterId: undefined,
                selectedClusterName: undefined,
                selectedWarehouseId: undefined,
                selectedWarehouseName: undefined,
                selectedDropOffId: undefined,
                selectedDropOffName: undefined,
            };
        });

        if (!updated) {
            await ctx.reply('Мастер закрыт. Запустите заново.');
            return;
        }

        const promptText = [
            summary,
            '',
        ].join('\n');

        await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            promptText,
            this.view.buildDropOffQueryKeyboard(),
            { parseMode: 'HTML' },
        );
    }

    private async onClusterStart(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
    ): Promise<void> {
        if (state.stage !== 'clusterPrompt') {
            await this.safeAnswerCbQuery(ctx, chatId, 'Выбор недоступен.');
            return;
        }

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                stage: 'clusterSelect',
                selectedClusterId: undefined,
                selectedClusterName: undefined,
                selectedWarehouseId: current.selectedWarehouseId,
                selectedWarehouseName: current.selectedWarehouseName,
                draftWarehouses: current.draftWarehouses,
                draftTimeslots: [],
                selectedTimeslot: undefined,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
            };
        });

        if (!updated) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
            return;
        }

        const activeTaskId = this.resolveActiveTaskId(chatId, updated);
        if (activeTaskId) {
            this.updateTaskContext(chatId, activeTaskId, (context) => ({
                ...context,
                stage: 'clusterSelect',
                selectedClusterId: undefined,
                selectedClusterName: undefined,
                selectedWarehouseId: updated.selectedWarehouseId ?? context.selectedWarehouseId,
                selectedWarehouseName: updated.selectedWarehouseName ?? context.selectedWarehouseName,
                draftWarehouses: updated.draftWarehouses.map((item) => ({ ...item })),
                draftTimeslots: [],
                selectedTimeslot: undefined,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
                updatedAt: Date.now(),
            }));
        }

        const message = (ctx.callbackQuery as any)?.message;
        if (message?.chat?.id && message?.message_id) {
            try {
                await ctx.telegram.editMessageReplyMarkup(message.chat.id, message.message_id, undefined, undefined);
            } catch (error) {
                this.logger.debug(`editMessageReplyMarkup failed: ${this.describeError(error)}`);
            }
        }

        await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            '<b>Выберите кластер, в который планируете везти поставку.</>',
            this.view.buildClusterKeyboard(updated),
            { parseMode: 'HTML' },
        );

        await this.safeAnswerCbQuery(ctx, chatId, 'Продолжаем');
    }

    private async onClusterSelect(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        payload: string | undefined,
    ): Promise<void> {

        if (state.stage !== 'clusterSelect') {
            await this.safeAnswerCbQuery(ctx, chatId, 'Сначала загрузите файл');
            return;
        }

        const clusterId = Number(payload);
        if (!Number.isFinite(clusterId)) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Некорректный кластер');
            return;
        }

        const cluster = state.clusters.find((item) => item.id === clusterId);
        if (!cluster) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Кластер не найден');
            return;
        }

        const credentials = await this.resolveCredentials(chatId);
        if (!credentials) {
            await ctx.reply('🔐 Сначала сохраните ключи через /start.');
            return;
        }

        let refreshedWarehouses: SupplyWizardWarehouseOption[] | undefined;
        try {
            const response = await this.ozonApi.listClusters(
                { clusterIds: [cluster.id], clusterType: 'CLUSTER_TYPE_OZON' },
                credentials,
            );
            const buildResult = this.view.buildOptions(response.clusters ?? []);
            refreshedWarehouses = buildResult.warehouses[cluster.id] ?? [];
            if (!refreshedWarehouses.length) {
                this.logger.debug(`[${chatId}] listClusters returned empty warehouses for cluster ${cluster.id}`);
            }
        } catch (error) {
            this.logger.warn(
                `[${chatId}] Не удалось обновить склады для кластера ${cluster.id}: ${this.describeError(error)}`,
            );
        }

        const hasDropOffSelection = Boolean(state.selectedDropOffId);
        const activeTaskId = this.resolveActiveTaskId(chatId, state);

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            const nextWarehouses = { ...current.warehouses };
            if (refreshedWarehouses) {
                nextWarehouses[cluster.id] = refreshedWarehouses;
            }
            return {
                ...current,
                stage: hasDropOffSelection ? 'warehouseSelect' : 'dropOffSelect',
                selectedClusterId: cluster.id,
                selectedClusterName: cluster.name,
                selectedWarehouseId: undefined,
                selectedWarehouseName: undefined,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
                autoWarehouseSelection: false,
                warehouseSearchQuery: undefined,
                warehousePage: 0,
                warehouses: nextWarehouses,
            };
        });

        if (!updated) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
            return;
        }

        if (activeTaskId) {
            this.updateTaskContext(chatId, activeTaskId, (context) => ({
                ...context,
                stage: hasDropOffSelection ? 'warehouseSelect' : 'dropOffSelect',
                selectedClusterId: cluster.id,
                selectedClusterName: cluster.name,
                selectedWarehouseId: undefined,
                selectedWarehouseName: undefined,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
                autoWarehouseSelection: false,
                updatedAt: Date.now(),
            }));
        }

        const dropOffLabel = updated.selectedDropOffName ??
            (updated.selectedDropOffId ? String(updated.selectedDropOffId) : undefined);
        await this.notifications.notifyWizard(WizardEvent.ClusterSelected, {
            ctx,
            lines: [
                `cluster: ${cluster.name} (${cluster.id})`,
                dropOffLabel ? `drop-off: ${dropOffLabel}` : undefined,
            ],
        });

        if (hasDropOffSelection) {
            const nextState = this.wizardStore.get(chatId) ?? updated;
            const dropOffLabelForPrompt =
                nextState.selectedDropOffName ??
                (nextState.selectedDropOffId ? String(nextState.selectedDropOffId) : '—');

            await this.showWarehouseSelection(ctx, chatId, nextState, {
                dropOffLabel: dropOffLabelForPrompt,
            });
        } else {
            await this.view.updatePrompt(
                ctx,
                chatId,
                updated,
                [
                    `Кластер выбран: ${cluster.name}.`,
                    'Теперь выберите пункт сдачи или отправьте новый запрос с городом.',
                ].join('\n'),
                this.view.buildDropOffKeyboard(updated),
            );
        }

        await this.safeAnswerCbQuery(ctx, chatId, 'Кластер выбран');
    }

    private async onWarehouseSelect(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        payloadParts: string[],
    ): Promise<void> {
        if (state.stage !== 'warehouseSelect') {
            await this.safeAnswerCbQuery(ctx, chatId, 'Сначала выберите кластер и пункт сдачи');
            return;
        }

        state = this.wizardStore.get(chatId) ?? state;

        const action = payloadParts?.[0];
        const extra = payloadParts?.[1];

        if (!action) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Склад не найден');
            return;
        }

        if (action === 'noop') {
            await this.safeAnswerCbQuery(ctx, chatId);
            return;
        }

        if (action === 'page') {
            const view = this.computeWarehouseView(chatId, state);
            const delta = extra === 'next' ? 1 : extra === 'prev' ? -1 : 0;
            const target = Math.min(Math.max(0, view.page + delta), Math.max(0, view.pageCount - 1));
            if (target === view.page) {
                await this.safeAnswerCbQuery(ctx, chatId, delta > 0 ? 'Это последняя страница' : 'Это первая страница');
                return;
            }
            const updated =
                this.updateWizardState(chatId, (current) => {
                    if (!current) return undefined;
                    if (current.stage !== 'warehouseSelect') {
                        return current;
                    }
                    return {
                        ...current,
                        warehousePage: target,
                    };
                }) ?? this.wizardStore.get(chatId) ?? view.state;

            await this.showWarehouseSelection(ctx, chatId, updated);
            await this.safeAnswerCbQuery(ctx, chatId, 'Страница обновлена');
            return;
        }

        if (action === 'search' && extra === 'clear') {
            const updated =
                this.updateWizardState(chatId, (current) => {
                    if (!current) return undefined;
                    if (current.stage !== 'warehouseSelect') {
                        return current;
                    }
                    return {
                        ...current,
                        warehouseSearchQuery: undefined,
                        warehousePage: 0,
                    };
                }) ?? this.wizardStore.get(chatId) ?? state;

            await this.showWarehouseSelection(ctx, chatId, updated);
            await this.safeAnswerCbQuery(ctx, chatId, 'Поиск сброшен');
            return;
        }

        if (action === 'backToClusters') {
            const updated = this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                if (current.stage !== 'warehouseSelect') {
                    return current;
                }
                return {
                    ...current,
                    stage: 'clusterSelect',
                    warehouseSearchQuery: undefined,
                    warehousePage: 0,
                };
            }) ?? state;

            const promptLines = ['Выберите кластер, чтобы продолжить.'];
            await this.view.updatePrompt(
                ctx,
                chatId,
                updated,
                promptLines.join('\n'),
                this.view.buildClusterKeyboard(updated),
            );
            await this.safeAnswerCbQuery(ctx, chatId, 'Вернулись к выбору кластера');
            return;
        }

        const selectedClusterId = state.selectedClusterId;
        if (!selectedClusterId) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Сначала выберите кластер');
            return;
        }

        const baseWarehouses = state.warehouses[selectedClusterId] ?? [];
        const requestedAuto = action === 'auto';

        if (requestedAuto) {
            if (!baseWarehouses.length) {
                await this.safeAnswerCbQuery(ctx, chatId, 'Для автоматического выбора нет доступных складов');
                return;
            }
        }

        const warehouseId = requestedAuto ? baseWarehouses[0]?.warehouse_id : Number(action);
        const warehouse = requestedAuto
            ? baseWarehouses[0]
            : baseWarehouses.find((item) => item.warehouse_id === warehouseId);

        if (!warehouse || !Number.isFinite(warehouse.warehouse_id)) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Склад не найден');
            return;
        }

        const hasDropOffSelection = Boolean(state.selectedDropOffId);

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            const selectedWarehouseId = requestedAuto ? undefined : warehouse.warehouse_id;
            const selectedWarehouseName = requestedAuto ? undefined : warehouse.name;
            return {
                ...current,
                stage: hasDropOffSelection ? 'awaitReadyDays' : 'dropOffSelect',
                selectedWarehouseId,
                selectedWarehouseName,
                readyInDays: undefined,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
                autoWarehouseSelection: requestedAuto,
            };
        });

        if (!updated) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
            return;
        }

        const activeTaskId = this.resolveActiveTaskId(chatId, updated);
        if (activeTaskId) {
            this.updateTaskContext(chatId, activeTaskId, (context) => ({
                ...context,
                stage: hasDropOffSelection ? 'awaitReadyDays' : 'dropOffSelect',
                selectedClusterId: updated.selectedClusterId ?? context.selectedClusterId,
                selectedClusterName: updated.selectedClusterName ?? context.selectedClusterName,
                selectedWarehouseId: requestedAuto ? undefined : warehouse.warehouse_id,
                selectedWarehouseName: requestedAuto ? undefined : warehouse.name,
                selectedDropOffId: updated.selectedDropOffId ?? context.selectedDropOffId,
                selectedDropOffName: updated.selectedDropOffName ?? context.selectedDropOffName,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
                autoWarehouseSelection: requestedAuto,
                readyInDays: undefined,
                updatedAt: Date.now(),
            }));
        }

        if (hasDropOffSelection) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Склад выбран');
            const summary = this.buildReadyContext(updated);
            await this.promptReadyDays(ctx, chatId, updated, { summaryLines: summary });
            return;
        }

        const lines: string[] = [
            `Склад выбран: ${warehouse.name} (${warehouse.warehouse_id}).`,
            '',
            'Теперь выберите пункт сдачи (drop-off).',
        ];

        await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            lines.join('\n'),
            this.view.buildDropOffKeyboard(updated),
        );

        await this.safeAnswerCbQuery(ctx, chatId, 'Склад выбран');
    }

    private async onDropOffSelect(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        payload: string | undefined,
    ): Promise<void> {
        if (state.stage !== 'dropOffSelect') {
            await this.safeAnswerCbQuery(ctx, chatId, 'Сначала выберите склад');
            return;
        }

        const dropOffId = Number(payload);
        if (!Number.isFinite(dropOffId)) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Некорректный пункт сдачи');
            return;
        }

        const option = state.dropOffs.find((item) => item.warehouse_id === dropOffId);
        if (!option) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Пункт сдачи не найден');
            return;
        }

        const hasClusterSelection = Boolean(state.selectedClusterId);

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                stage: hasClusterSelection ? 'warehouseSelect' : 'clusterPrompt',
                selectedDropOffId: option.warehouse_id,
                selectedDropOffName: option.name,
                selectedWarehouseId: undefined,
                selectedWarehouseName: undefined,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
                autoWarehouseSelection: false,
                warehouseSearchQuery: undefined,
                warehousePage: 0,
            };
        });

        if (!updated) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
            return;
        }

        const activeTaskId = this.resolveActiveTaskId(chatId, updated);
        if (activeTaskId) {
            this.updateTaskContext(chatId, activeTaskId, (context) => ({
                ...context,
                stage: hasClusterSelection ? 'warehouseSelect' : 'clusterPrompt',
                selectedDropOffId: option.warehouse_id,
                selectedDropOffName: option.name,
                selectedWarehouseId: undefined,
                selectedWarehouseName: undefined,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
                autoWarehouseSelection: false,
                updatedAt: Date.now(),
            }));
        }

        await this.notifications.notifyWizard(WizardEvent.DropOffSelected, {
            ctx,
            lines: [
                `drop-off: ${option.name} (${option.warehouse_id})`,
                option.address ? `address: ${option.address}` : undefined,
            ],
        });

        if (hasClusterSelection) {
            await this.showWarehouseSelection(ctx, chatId, updated, {
                dropOffLabel: option.name,
            });
        } else {
            const lines: string[] = [
                `Пункт сдачи выбран: ${option.name} (${option.warehouse_id}).`,
            ];
            if (option.address) {
                lines.push(`Адрес: ${option.address}.`);
            }
            if (updated.selectedClusterName || updated.selectedClusterId) {
                lines.push(`Кластер: ${updated.selectedClusterName ?? updated.selectedClusterId}.`);
            }
            lines.push(
                '',
                '<b>Нажмите «Выбрать кластер», чтобы выбрать в какой кластер бот будет искать слоты для поставки.</b>',
                '',
                'При необходимости отправьте новый запрос с городом, чтобы сменить пункт сдачи.',
            );

            await this.view.updatePrompt(
                ctx,
                chatId,
                updated,
                lines.join('\n'),
                this.view.withCancel(this.view.buildClusterStartKeyboard()),
                { parseMode: 'HTML' },
            );
        }

        await this.safeAnswerCbQuery(ctx, chatId, 'Пункт сдачи выбран');
    }

    private computeWarehouseView(
        chatId: string,
        state: SupplyWizardState,
    ): {
        state: SupplyWizardState;
        items: SupplyWizardWarehouseOption[];
        total: number;
        filteredTotal: number;
        page: number;
        pageCount: number;
        hasPrev: boolean;
        hasNext: boolean;
        searchQuery?: string;
    } {
        const clusterId = state.selectedClusterId;
        const warehouses = clusterId ? state.warehouses[clusterId] ?? [] : [];
        const searchQuery = state.warehouseSearchQuery?.trim();
        const normalizedSearch = searchQuery ? searchQuery.toLowerCase() : undefined;

        const filtered = normalizedSearch
            ? warehouses.filter((option) => {
                const name = option.name?.toLowerCase() ?? '';
                const idString = String(option.warehouse_id);
                return name.includes(normalizedSearch) || idString.includes(normalizedSearch);
            })
            : warehouses;

        const total = warehouses.length;
        const filteredTotal = filtered.length;
        const pageCount = filteredTotal ? Math.max(1, Math.ceil(filteredTotal / this.warehousePageSize)) : 1;
        let page = state.warehousePage ?? 0;

        if (page >= pageCount) {
            const updated = this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                if (current.stage !== 'warehouseSelect') {
                    return current;
                }
                return {
                    ...current,
                    warehousePage: pageCount - 1,
                };
            });
            if (updated) {
                state = updated;
                page = state.warehousePage ?? 0;
            } else {
                page = Math.max(0, pageCount - 1);
            }
        }

        const start = page * this.warehousePageSize;
        const items = filtered.slice(start, start + this.warehousePageSize);

        return {
            state,
            items,
            total,
            filteredTotal,
            page,
            pageCount,
            hasPrev: page > 0,
            hasNext: page < pageCount - 1,
            searchQuery,
        };
    }

    private async showWarehouseSelection(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        options: { dropOffLabel?: string } = {},
    ): Promise<void> {
        const clusterId = state.selectedClusterId;
        if (!clusterId) {
            return;
        }

        const view = this.computeWarehouseView(chatId, state);
        const nextState = view.state;

        const prompt = this.view.renderWarehouseSelection({
            clusterName: nextState.selectedClusterName,
            dropOffLabel:
                options.dropOffLabel ??
                nextState.selectedDropOffName ??
                (nextState.selectedDropOffId ? String(nextState.selectedDropOffId) : undefined),
            total: view.total,
            filteredTotal: view.filteredTotal,
            page: view.page,
            pageCount: view.pageCount,
            searchQuery: view.searchQuery,
        });

        const keyboard = this.view.buildClusterWarehouseKeyboard({
            items: view.items,
            page: view.page,
            pageCount: view.pageCount,
            hasPrev: view.hasPrev,
            hasNext: view.hasNext,
            includeAuto: view.total > 0,
            searchActive: Boolean(view.searchQuery),
            includeBackToCluster: true,
        });

        await this.view.updatePrompt(ctx, chatId, nextState, prompt, keyboard, { parseMode: 'HTML' });
    }

    async handleWarehouseSearch(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        text: string,
    ): Promise<void> {
        if (state.stage !== 'warehouseSelect') {
            return;
        }

        const query = text.trim();
        const normalized = query.length ? query : undefined;
        const updated =
            this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                if (current.stage !== 'warehouseSelect') {
                    return current;
                }
                return {
                    ...current,
                    warehouseSearchQuery: normalized,
                    warehousePage: 0,
                };
            }) ?? this.wizardStore.get(chatId) ?? state;

        await this.showWarehouseSelection(ctx, chatId, updated);
    }

    private async onDraftWarehouseSelect(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        payload: string | undefined,
    ): Promise<void> {
        if (state.stage !== 'draftWarehouseSelect') {
            await this.safeAnswerCbQuery(ctx, chatId, 'Дождитесь формирования списка складов');
            return;
        }

        const warehousesSource = state.draftWarehouses.length
            ? state.draftWarehouses
            : this.latestDraftWarehouses;

        if (!warehousesSource.length) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Список складов ещё формируется, попробуйте чуть позже');
            return;
        }

        const warehouseId = Number(payload);
        if (!Number.isFinite(warehouseId)) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Некорректный склад');
            return;
        }

        const option = warehousesSource.find((item) => item.warehouseId === warehouseId);
        if (!option) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Склад не найден');
            return;
        }

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                stage: 'timeslotSelect',
                selectedWarehouseId: option.warehouseId,
                selectedWarehouseName: option.name,
                selectedClusterId: option.clusterId ?? current.selectedClusterId,
                selectedClusterName: option.clusterName ?? current.selectedClusterName,
                draftWarehouses: current.draftWarehouses?.length ? current.draftWarehouses : this.latestDraftWarehouses,
                draftTimeslots: [],
                selectedTimeslot: undefined,
            };
        });

        if (!updated) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
            return;
        }

        const targetTaskId = this.resolveActiveTaskId(chatId, updated);
        if (targetTaskId) {
            this.updateTaskContext(chatId, targetTaskId, (context) => ({
                ...context,
                stage: 'timeslotSelect',
                selectedWarehouseId: option.warehouseId,
                selectedWarehouseName: option.name ?? context.selectedWarehouseName,
                selectedClusterId: option.clusterId ?? context.selectedClusterId,
                selectedClusterName: option.clusterName ?? context.selectedClusterName,
                draftWarehouses: (updated.draftWarehouses ?? []).map((item) => ({ ...item })),
                draftTimeslots: [],
                selectedTimeslot: undefined,
                autoWarehouseSelection: false,
                updatedAt: Date.now(),
            }));
        }

        await this.presentDraftWarehouseSelection(ctx, chatId, updated, option);

        await this.safeAnswerCbQuery(ctx, chatId, 'Склад выбран');
    }

    private async presentDraftWarehouseSelection(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        option: SupplyWizardDraftWarehouseOption,
        options: { skipReadyPrompt?: boolean } = {},
    ): Promise<SupplyWizardState | undefined> {
        const skipReadyPrompt = options.skipReadyPrompt ?? false;
        const summaryLines = this.view.describeWarehouseSelection(option, state);

        await this.notifications.notifyWizard(WizardEvent.WarehouseSelected, { ctx, lines: summaryLines });

        if (!skipReadyPrompt) {
            await this.view.updatePrompt(
                ctx,
                chatId,
                state,
                [...summaryLines, '', 'Получаю доступные таймслоты...'].join('\n'),
                this.view.withCancel(),
            );
        }

        const credentials = await this.resolveCredentials(chatId);
        if (!credentials) {
            await ctx.reply('🔐 Сначала сохраните ключи через /start.');
            return undefined;
        }

        const draftId = state.draftId ?? this.latestDraftId;
        if (!draftId) {
            await ctx.reply('Черновик ещё не готов — подождите пару секунд, я пересоздам и повторю попытку.');
            this.resetDraftStateForRetry(chatId);
            const freshState = this.wizardStore.get(chatId);
            if (freshState) {
                await this.ensureDraftCreated(ctx, chatId, freshState);
            }
            return undefined;
        }

        let timeslotOptions: SupplyWizardTimeslotOption[] = [];
        try {
            timeslotOptions = await this.fetchTimeslotsForWarehouse({ ...state, draftId }, option, credentials);
        } catch (error) {
            const message = this.describeError(error);
            this.logger.error(`getDraftTimeslots failed: ${message}`);
            await ctx.reply(`Не удалось получить таймслоты: ${message}`);

            const rollback = this.updateWizardState(chatId, (current) => {
                if (!current) return undefined;
                return {
                    ...current,
                    stage: 'draftWarehouseSelect',
                    draftTimeslots: [],
                    selectedTimeslot: undefined,
                };
            });

            if (rollback) {
                const activeTaskId = this.resolveActiveTaskId(chatId, rollback);
                if (activeTaskId) {
                    this.updateTaskContext(chatId, activeTaskId, (context) => ({
                        ...context,
                        stage: 'draftWarehouseSelect',
                        draftTimeslots: [],
                        selectedTimeslot: undefined,
                        draftStatus: rollback.draftStatus ?? context.draftStatus,
                        draftOperationId: rollback.draftOperationId ?? context.draftOperationId,
                        draftId: rollback.draftId ?? context.draftId,
                        draftCreatedAt: rollback.draftCreatedAt ?? context.draftCreatedAt,
                        draftExpiresAt: rollback.draftExpiresAt ?? context.draftExpiresAt,
                        draftError: rollback.draftError ?? context.draftError,
                        updatedAt: Date.now(),
                    }));
                }

                await this.view.updatePrompt(
                    ctx,
                    chatId,
                    rollback,
                    'Не удалось получить таймслоты. Выберите другой склад или повторите попытку позже.',
                    this.view.buildDraftWarehouseKeyboard(rollback),
                );
            }
            return undefined;
        }

        const { limited, truncated } = this.view.limitTimeslotOptions(timeslotOptions);

        const stored = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;

            if (!limited.length) {
                return {
                    ...current,
                    stage: 'draftWarehouseSelect',
                    draftTimeslots: [],
                    selectedTimeslot: undefined,
                };
            }

            const [firstTimeslot] = limited;

            return {
                ...current,
                stage: 'awaitReadyDays',
                draftTimeslots: limited,
                selectedTimeslot: firstTimeslot,
            };
        });

        if (!stored) {
            return undefined;
        }

        const activeTaskId = this.resolveActiveTaskId(chatId, stored);
        if (activeTaskId) {
            this.updateTaskContext(chatId, activeTaskId, (context) => {
                if (!limited.length) {
                    return {
                        ...context,
                        stage: 'draftWarehouseSelect',
                        draftTimeslots: [],
                        selectedTimeslot: undefined,
                        updatedAt: Date.now(),
                    };
                }

                const [firstTimeslot] = limited;
                return {
                    ...context,
                    stage: 'awaitReadyDays',
                    draftTimeslots: limited.map((item) => ({ ...item })),
                    selectedTimeslot: firstTimeslot ? { ...firstTimeslot, data: firstTimeslot.data ? { ...firstTimeslot.data } : firstTimeslot.data } : undefined,
                    updatedAt: Date.now(),
                };
            });
        }

        if (!limited.length) {
            const fallbackText = [
                ...summaryLines,
                '',
                'Свободных таймслотов для этого склада нет.',
                'Выберите другой склад или попробуйте позже.',
            ].join('\n');
            if (skipReadyPrompt) {
                await ctx.reply(fallbackText);
            } else {
                await this.view.updatePrompt(
                    ctx,
                    chatId,
                    stored,
                    fallbackText,
                    this.view.buildDraftWarehouseKeyboard(stored),
                );
            }
            return undefined;
        }

        const selectedTimeslot = stored.selectedTimeslot;

        if (selectedTimeslot) {
            await this.notifications.notifyWizard(WizardEvent.TimeslotSelected, {
                ctx,
                lines: [`timeslot: ${selectedTimeslot.label}`],
            });
        }

        const readySummary = [
            ...summaryLines,
            '',
            'Доступные таймслоты:',
            ...this.view.formatTimeslotSummary(limited),
        ];
        if (truncated) {
            readySummary.push(`… Показаны первые ${limited.length} из ${timeslotOptions.length} вариантов.`);
        }
        if (selectedTimeslot) {
            readySummary.push('', `Выбрали таймслот: ${selectedTimeslot.label}.`);
        }

        if (skipReadyPrompt) {
            await this.startSupplyProcessing(ctx, chatId, stored, this.readyDaysMin);
            return stored;
        }

        await this.promptReadyDays(ctx, chatId, stored, { summaryLines: readySummary });
        return stored;
    }

    private async onTimeslotSelect(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        payload: string | undefined,
    ): Promise<void> {
        if (state.stage !== 'timeslotSelect') {
            await this.safeAnswerCbQuery(ctx, chatId, 'Таймслоты выбираются автоматически');
            return;
        }

        if (!payload) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Некорректный таймслот');
            return;
        }

        const option = state.draftTimeslots.find((item) => item.id === payload);
        if (!option) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Таймслот не найден');
            return;
        }

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                stage: 'awaitReadyDays',
                selectedTimeslot: option,
                draftTimeslots: current.draftTimeslots,
            };
        });

        if (!updated) {
            await this.safeAnswerCbQuery(ctx, chatId, 'Мастер закрыт');
            return;
        }

        const activeTaskId = this.resolveActiveTaskId(chatId, updated);
        if (activeTaskId) {
            this.updateTaskContext(chatId, activeTaskId, (context) => ({
                ...context,
                stage: 'awaitReadyDays',
                selectedTimeslot: {
                    ...option,
                    data: option.data ? { ...option.data } : option.data,
                },
                draftTimeslots: (updated.draftTimeslots ?? []).map((item) => ({ ...item })),
                updatedAt: Date.now(),
            }));
        }

        await this.notifications.notifyWizard(WizardEvent.TimeslotSelected, { ctx, lines: [`timeslot: ${option.label}`] });
        await this.safeAnswerCbQuery(ctx, chatId, 'Таймслот выбран');

        const summary = [
            ...this.buildReadyContext(updated),
            '',
            `Выбрали таймслот: ${option.label}.`,
        ];
        await this.promptReadyDays(ctx, chatId, updated, { summaryLines: summary });
    }

    private async fetchTimeslotsForWarehouse(
        state: SupplyWizardState,
        option: SupplyWizardDraftWarehouseOption,
        credentials: OzonCredentials,
    ): Promise<SupplyWizardTimeslotOption[]> {
        if (!state.draftId) {
            return [];
        }

        const warehouseIds = this.view.collectTimeslotWarehouseIds(state, option);
        if (!warehouseIds.length) {
            return [];
        }

        const window = this.process.computeTimeslotWindow({
            fromDays: this.readyDaysMin,
            toDays: this.readyDaysMax,
        });
        const from = window.fromIso;
        const to = window.toIso;
        const response = await this.ozonApi.getDraftTimeslots(
            {
                draftId: state.draftId,
                warehouseIds,
                dateFrom: from,
                dateTo: to,
            },
            credentials,
        );

        return this.view.mapTimeslotOptions(response);
    }

    private findSelectedDraftWarehouse(
        state: SupplyWizardState,
    ): SupplyWizardDraftWarehouseOption | undefined {
        if (!state.selectedWarehouseId) {
            return undefined;
        }
        return state.draftWarehouses.find((item) => item.warehouseId === state.selectedWarehouseId);
    }

    private mapDropOffSearchResults(
        items: OzonFboWarehouseSearchItem[],
    ): SupplyWizardDropOffOption[] {
        const seen = new Set<number>();
        const options: SupplyWizardDropOffOption[] = [];

        for (const item of items ?? []) {
            if (!item || typeof item.warehouse_id !== 'number') {
                continue;
            }

            const warehouse_id = Number(item.warehouse_id);
            if (!Number.isFinite(warehouse_id) || seen.has(warehouse_id)) {
                continue;
            }

            seen.add(warehouse_id);
            options.push({
                warehouse_id,
                name: item.name?.trim() || `Пункт ${warehouse_id}`,
                address: item.address?.trim() || undefined,
                type: item.warehouse_type ?? undefined,
            });
        }

        return options;
    }

    private async pollDraftStatus(
        chatId: string,
        operationId: string,
        credentials: OzonCredentials,
    ): Promise<
        | { status: 'success'; draftId?: number; errorDetails?: string; draftInfo?: OzonDraftStatus }
        | { status: 'failed' | 'expired'; errorDetails?: string; draftInfo?: OzonDraftStatus }
        | { status: 'timeout'; errorDetails?: string; draftInfo?: OzonDraftStatus }
        | { status: 'error'; message?: string; errorDetails?: string; draftInfo?: OzonDraftStatus }
    > {
        let lastInfo: OzonDraftStatus | undefined;

        for (let attempt = 0; attempt < this.draftPollMaxAttempts; attempt++) {
            try {
                const info = await this.ozonApi.getDraftInfo(operationId, credentials);
                lastInfo = info;

                const status = info?.status;
                if (status === 'CALCULATION_STATUS_SUCCESS') {
                    return {
                        status: 'success',
                        draftId: info?.draft_id,
                        errorDetails: this.describeDraftErrors(info),
                        draftInfo: info,
                    };
                }

                if (status === 'CALCULATION_STATUS_FAILED' || info?.code === 1) {
                    return {
                        status: 'failed',
                        errorDetails: this.describeDraftErrors(info),
                        draftInfo: info,
                    };
                }

                if (status === 'CALCULATION_STATUS_EXPIRED' || info?.code === 5) {
                    return {
                        status: 'expired',
                        errorDetails: this.describeDraftErrors(info),
                        draftInfo: info,
                    };
                }

                await this.sleep(this.draftPollIntervalMs);
            } catch (error) {
                const message = this.describeError(error);
                this.logger.warn(`getDraftInfo failed для ${operationId}: ${message}`);
                if (attempt === this.draftPollMaxAttempts - 1) {
                    return { status: 'error', message, draftInfo: lastInfo };
                }
                await this.sleep(this.draftPollIntervalMs);
            }
        }

        return {
            status: 'timeout',
            errorDetails: this.describeDraftErrors(lastInfo),
            draftInfo: lastInfo,
        };
    }

    private async handleDraftCreationSuccess(
        ctx: Context,
        chatId: string,
        payload: { operationId: string; draftId?: number; taskId: string; draftInfo?: OzonDraftStatus },
    ): Promise<void> {
        const warehouseOptions = this.view.mapDraftWarehouseOptions(payload.draftInfo);
        const { limited: limitedOptions, truncated } = this.view.limitDraftWarehouseOptions(warehouseOptions);
        this.latestDraftWarehouses = limitedOptions;
        this.latestDraftId = payload.draftId ?? this.latestDraftId;
        this.latestDraftOperationId = payload.operationId;

        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;

            const createdAt = current.draftCreatedAt ?? Date.now();
            const expiresAt = current.draftExpiresAt ?? createdAt + this.draftLifetimeMs;

            return {
                ...current,
                stage: limitedOptions.length ? 'draftWarehouseSelect' : 'awaitReadyDays',
                draftStatus: 'success',
                draftOperationId: payload.operationId,
                draftId: payload.draftId ?? current.draftId,
                draftError: undefined,
                draftCreatedAt: createdAt,
                draftExpiresAt: expiresAt,
                draftWarehouses: limitedOptions,
                draftTimeslots: [],
                selectedTimeslot: undefined,
                ...(limitedOptions.length
                    ? {
                        selectedWarehouseId: undefined,
                        selectedWarehouseName: undefined,
                    }
                    : {}),
            };
        });

        if (!updated || updated.draftOperationId !== payload.operationId) {
            return;
        }

        this.updateTaskContext(chatId, payload.taskId, (context) => ({
            ...context,
            stage: limitedOptions.length ? 'draftWarehouseSelect' : 'awaitReadyDays',
            draftStatus: 'success',
            draftOperationId: payload.operationId,
            draftId: payload.draftId ?? context.draftId,
            draftCreatedAt: updated.draftCreatedAt ?? context.draftCreatedAt ?? Date.now(),
            draftExpiresAt: updated.draftExpiresAt ?? context.draftExpiresAt,
            draftError: undefined,
            draftWarehouses: limitedOptions.map((item) => ({ ...item })),
            draftTimeslots: [],
            selectedTimeslot: undefined,
            selectedClusterId: updated.selectedClusterId ?? context.selectedClusterId,
            selectedClusterName: updated.selectedClusterName ?? context.selectedClusterName,
            selectedWarehouseId: limitedOptions.length
                ? undefined
                : updated.selectedWarehouseId ?? context.selectedWarehouseId,
            selectedWarehouseName: limitedOptions.length
                ? undefined
                : updated.selectedWarehouseName ?? context.selectedWarehouseName,
            autoWarehouseSelection: context.autoWarehouseSelection,
            updatedAt: Date.now(),
        }));

        const headerLines = [
            'Черновик успешно создан ✅',
            `operation_id: ${payload.operationId}`,
        ];
        if (payload.draftId) {
            headerLines.push(`draft_id: ${payload.draftId}`);
        }
        if (updated.draftExpiresAt) {
            headerLines.push(`Действителен примерно до ${this.formatDraftExpiresAt(updated.draftExpiresAt)}.`);
        }

        if (!limitedOptions.length) {
            headerLines.push(
                '',
                'Ozon не вернул список складов. Укажите количество дней до готовности, чтобы продолжить.',
            );
            await this.view.updatePrompt(ctx, chatId, updated, headerLines.join('\n'), this.view.withCancel());
            return;
        }

        const summaryLines = this.view.formatDraftWarehouseSummary(limitedOptions);
        const footerLines = truncated
            ? [`… Показаны первые ${limitedOptions.length} из ${warehouseOptions.length} складов.`]
            : [];

        const promptText = [
            ...headerLines,
            '',
            'Склады, готовые принять поставку (в порядке приоритета):',
            ...summaryLines,
            ...footerLines,
            '',
            'Выберите склад кнопкой ниже, чтобы перейти к выбору даты готовности.',
        ].join('\n');

        await this.view.updatePrompt(
            ctx,
            chatId,
            updated,
            promptText,
            this.view.buildDraftWarehouseKeyboard(updated),
        );
    }

    private resetDraftStateForRetry(chatId: string): void {
        this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
            };
        });
        const contexts = this.wizardStore.listTaskContexts(chatId);
        for (const context of contexts) {
            this.updateTaskContext(chatId, context.taskId, (current) => ({
                ...current,
                draftStatus: 'idle',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: undefined,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
                updatedAt: Date.now(),
            }));
        }
        this.latestDraftOperationId = undefined;
    }

    private async safeAnswerCbQuery(ctx: Context, chatId: string, text?: string): Promise<void> {
        try {
            await ctx.answerCbQuery(text);
        } catch (error) {
            if (this.isExpiredCallbackError(error)) {
                this.logger.warn(`[${chatId}] callback query expired, recreating draft`);
                await this.handleExpiredCallback(ctx, chatId);
            } else {
                this.logger.debug(`[${chatId}] answerCbQuery failed: ${this.describeError(error)}`);
            }
        }
    }

    private isExpiredCallbackError(error: unknown): boolean {
        const description =
            (error as any)?.response?.description ??
            (error as any)?.description ??
            (error as any)?.message ??
            '';
        return typeof description === 'string' && description.includes('query is too old');
    }

    private async handleExpiredCallback(ctx: Context, chatId: string): Promise<void> {
        const current = this.wizardStore.get(chatId);
        if (!current) {
            return;
        }

        await this.notifications.notifyWizard(WizardEvent.CallbackExpired, { ctx, lines: [`stage: ${current.stage}`] });

        if (current.stage === 'warehouseSelect') {
            const view = this.computeWarehouseView(chatId, current);
            const keyboard = this.view.buildClusterWarehouseKeyboard({
                items: view.items,
                page: view.page,
                pageCount: view.pageCount,
                hasPrev: view.hasPrev,
                hasNext: view.hasNext,
                includeAuto: view.filteredTotal > 0,
                searchActive: Boolean(view.searchQuery),
            });
            const prompt = this.view.renderWarehouseSelection({
                clusterName: current.selectedClusterName,
                dropOffLabel: current.selectedDropOffName ?? (current.selectedDropOffId ? String(current.selectedDropOffId) : undefined),
                total: view.total,
                filteredTotal: view.filteredTotal,
                page: view.page,
                pageCount: view.pageCount,
                searchQuery: view.searchQuery,
            });
            await this.view.updatePrompt(ctx, chatId, view.state, prompt, keyboard);
            return;
        }

        await this.view.updatePrompt(
            ctx,
            chatId,
            current,
            '⚠️ Выберите действие',
            this.view.withCancel(),
        );
    }

    private describeDraftErrors(info?: OzonDraftStatus | any): string | undefined {
        if (!info) {
            return undefined;
        }

        const errors = (info as any).errors;
        const parts: string[] = [];

        if (Array.isArray(errors)) {
            for (const error of errors) {
                const baseMessage = error?.error_message ?? error?.message;
                if (baseMessage) {
                    parts.push(String(baseMessage));
                }

                const itemsValidation = error?.items_validation;
                if (Array.isArray(itemsValidation)) {
                    for (const item of itemsValidation) {
                        const sku = item?.sku;
                        const reasons = Array.isArray(item?.reasons) ? item.reasons.join(', ') : undefined;
                        if (sku && reasons) {
                            parts.push(`SKU ${sku}: ${reasons}`);
                        } else if (sku) {
                            parts.push(`SKU ${sku}: отклонён без причины`);
                        } else if (reasons) {
                            parts.push(reasons);
                        }
                    }
                }
            }
        }

        return parts.length ? parts.join('; ') : undefined;
    }

    private async ensureDraftCreated(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        retryAttempt = 0,
    ): Promise<void> {
        if (!['awaitReadyDays', 'draftWarehouseSelect', 'timeslotSelect'].includes(state.stage)) {
            return;
        }

        if (state.draftStatus === 'creating' || (state.draftStatus === 'success' && state.draftOperationId)) {
            return;
        }

        const clusterId = String(state.selectedClusterId);
        const warehouseId = state.selectedWarehouseId;
        const dropOffId = state.selectedDropOffId;
        if (!clusterId || !warehouseId || !dropOffId) {
            return;
        }

        const task = this.getSelectedTask(chatId, state);
        if (!task) {
            this.logger.warn(`[${chatId}] ensureDraftCreated: задача не найдена`);
            return;
        }

        const credentials = await this.resolveCredentials(chatId);
        if (!credentials) {
            await ctx.reply('🔐 Сначала сохраните ключи через /start <CLIENT_ID> <API_KEY>.');
            return;
        }

        const existingOperationId = this.resolveKnownDraftOperationId(state);
        if (existingOperationId) {
            const handled = await this.tryReuseExistingDraft(
                ctx,
                chatId,
                task,
                existingOperationId,
                credentials,
                retryAttempt,
            );
            if (handled) {
                return;
            }
        }

        let items: Array<{ sku: number; quantity: number }>;
        try {
            items = this.process.buildDraftItems(task);
        } catch (error) {
            const message = this.describeError(error);
            await this.handleDraftCreationFailure(ctx, chatId, message);
            return;
        }

        const started = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            if (current.draftStatus === 'creating') {
                return current;
            }
            return {
                ...current,
                draftStatus: 'creating',
                draftError: undefined,
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
            };
        });

        if (!started || started.draftStatus !== 'creating') {
            return;
        }

        await this.view.updatePrompt(
            ctx,
            chatId,
            started,
            'Создаю черновик, подождите...',
            this.view.withCancel(),
        );

        let operationId: string | undefined;
        try {
            operationId = await this.ozonApi.createDraft(
                {
                    clusterIds: [clusterId],
                    dropOffPointWarehouseId: dropOffId,
                    items,
                    type: 'CREATE_TYPE_CROSSDOCK',
                },
                credentials,
            );
        } catch (error) {
            const message = this.describeError(error);
            this.logger.error(`createDraft failed: ${message}`);
            await this.handleDraftCreationFailure(ctx, chatId, message);
            return;
        }

        if (!operationId) {
            await this.handleDraftCreationFailure(ctx, chatId, 'Сервис вернул пустой operation_id.');
            return;
        }

        const withOperation = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            if (current.draftStatus !== 'creating') {
                return current;
            }
            return {
                ...current,
                draftOperationId: operationId,
                draftCreatedAt: Date.now(),
                draftExpiresAt: Date.now() + this.draftLifetimeMs,
            };
        });

        if (!withOperation) {
            return;
        }

        this.latestDraftOperationId = operationId;

        const pollResult = await this.pollDraftStatus(chatId, operationId, credentials);
        await this.handleDraftPollResult(ctx, chatId, task, operationId, pollResult, retryAttempt);
    }

    private resolveKnownDraftOperationId(state: SupplyWizardState): string | undefined {
        const fromState = typeof state.draftOperationId === 'string' ? state.draftOperationId.trim() : '';
        if (fromState) {
            return fromState;
        }
        return this.latestDraftOperationId?.trim() || undefined;
    }

    private async tryReuseExistingDraft(
        ctx: Context,
        chatId: string,
        task: OzonSupplyTask,
        operationId: string,
        credentials: OzonCredentials,
        retryAttempt: number,
    ): Promise<boolean> {
        const normalizedOperationId = operationId.trim();
        if (!normalizedOperationId) {
            return false;
        }

        try {
            const info = await this.ozonApi.getDraftInfo(normalizedOperationId, credentials);
            const status = info?.status;

            if (status === 'CALCULATION_STATUS_SUCCESS') {
                await this.handleDraftCreationSuccess(ctx, chatId, {
                    operationId: normalizedOperationId,
                    draftId: info?.draft_id,
                    taskId: task.taskId,
                    draftInfo: info,
                });
                return true;
            }

            if (status === 'CALCULATION_STATUS_FAILED' || info?.code === 1) {
                await this.handleDraftPollResult(
                    ctx,
                    chatId,
                    task,
                    normalizedOperationId,
                    { status: 'failed', errorDetails: this.describeDraftErrors(info), draftInfo: info },
                    retryAttempt,
                );
                return true;
            }

            if (status === 'CALCULATION_STATUS_EXPIRED' || info?.code === 5) {
                await this.handleDraftPollResult(
                    ctx,
                    chatId,
                    task,
                    normalizedOperationId,
                    { status: 'expired', errorDetails: this.describeDraftErrors(info), draftInfo: info },
                    retryAttempt,
                );
                return true;
            }

            const pollResult = await this.pollDraftStatus(chatId, normalizedOperationId, credentials);
            await this.handleDraftPollResult(
                ctx,
                chatId,
                task,
                normalizedOperationId,
                pollResult,
                retryAttempt,
            );
            return true;
        } catch (error) {
            this.logger.warn(
                `check existing draft ${normalizedOperationId} failed: ${this.describeError(error)}`,
            );
            return false;
        }
    }

    private async handleDraftPollResult(
        ctx: Context,
        chatId: string,
        task: OzonSupplyTask,
        operationId: string,
        pollResult:
            | { status: 'success'; draftId?: number; errorDetails?: string; draftInfo?: OzonDraftStatus }
            | { status: 'failed' | 'expired'; errorDetails?: string; draftInfo?: OzonDraftStatus }
            | { status: 'timeout'; errorDetails?: string; draftInfo?: OzonDraftStatus }
            | { status: 'error'; message?: string; errorDetails?: string; draftInfo?: OzonDraftStatus },
        retryAttempt: number,
    ): Promise<void> {
        const creationAttempt = retryAttempt;

        switch (pollResult.status) {
            case 'success':
                await this.handleDraftCreationSuccess(ctx, chatId, {
                    operationId,
                    draftId: pollResult.draftId,
                    taskId: task.taskId,
                    draftInfo: pollResult.draftInfo,
                });
                return;
            case 'failed':
            case 'expired': {
                const attemptMessage = pollResult.status === 'failed'
                    ? 'Черновик отклонён сервисом Ozon.'
                    : 'Черновик истёк до завершения создания.';
                const errorSummary = pollResult.errorDetails ? ` Причина: ${pollResult.errorDetails}` : '';
                if (creationAttempt < this.draftRecreateMaxAttempts) {
                    await ctx.reply(
                        [
                            `${attemptMessage}${errorSummary}`.trim(),
                            `Пробую создать черновик заново (попытка ${creationAttempt + 2}/${this.draftRecreateMaxAttempts + 1}).`,
                        ].join('\n'),
                    );
                    this.resetDraftStateForRetry(chatId);
                    const nextState = this.wizardStore.get(chatId);
                    if (nextState) {
                        await this.sleep(1_000);
                        await this.ensureDraftCreated(ctx, chatId, nextState, creationAttempt + 1);
                    }
                    return;
                }

                await this.handleDraftCreationFailure(
                    ctx,
                    chatId,
                    `${attemptMessage}${errorSummary ? ` ${errorSummary}` : ''}`,
                );
                return;
            }
            case 'error':
                await this.handleDraftCreationFailure(
                    ctx,
                    chatId,
                    pollResult.message ?? 'Не удалось получить статус черновика.',
                );
                return;
            case 'timeout':
                await this.handleDraftCreationFailure(
                    ctx,
                    chatId,
                    'Черновик не успел перейти в статус «готов» в отведённое время.',
                );
                return;
            default:
                return;
        }
    }

    private getSelectedTask(chatId: string, state: SupplyWizardState): OzonSupplyTask | undefined {
        if (state.selectedTaskId) {
            const context = this.wizardStore.getTaskContext(chatId, state.selectedTaskId);
            if (context) {
                return this.cloneTask(context.task);
            }
        }

        const contexts = this.wizardStore.listTaskContexts(chatId);
        if (contexts.length) {
            return this.cloneTask(contexts[0].task);
        }

        return undefined;
    }

    private async handleDraftCreationFailure(
        ctx: Context,
        chatId: string,
        reason: string,
    ): Promise<void> {
        const updated = this.updateWizardState(chatId, (current) => {
            if (!current) return undefined;
            return {
                ...current,
                draftStatus: 'failed',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: reason,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
            };
        });

        if (!updated) {
            return;
        }

        const targetTaskId = this.resolveActiveTaskId(chatId, updated);
        if (targetTaskId) {
            this.updateTaskContext(chatId, targetTaskId, (context) => ({
                ...context,
                stage: updated.stage,
                draftStatus: 'failed',
                draftOperationId: undefined,
                draftId: undefined,
                draftCreatedAt: undefined,
                draftExpiresAt: undefined,
                draftError: reason,
                draftWarehouses: [],
                draftTimeslots: [],
                selectedTimeslot: undefined,
                updatedAt: Date.now(),
            }));
        }

        const message = [
            `❌ Не удалось создать черновик: ${reason}`,
            'Попробуйте выбрать другие параметры или повторите попытку позже.',
        ].join('\n');

        await this.view.updatePrompt(ctx, chatId, updated, message, this.view.withCancel());
        await this.notifications.notifyWizard(WizardEvent.DraftError, { ctx, lines: [reason] });
        this.latestDraftOperationId = undefined;
    }

    private formatDraftExpiresAt(timestamp: number): string {
        const formatter = new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
        return formatter.format(new Date(timestamp));
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async sendSupplyEvent(ctx: Context, result: OzonSupplyProcessResult): Promise<void> {
        const chatId = this.extractChatId(ctx);
        if (!chatId) return;

        const eventType = result.event?.type ?? OzonSupplyEventType.Error;
        const wizardEvent = this.mapSupplyEvent(eventType);

        const text = this.view.formatSupplyEvent({
            taskId: result.task.taskId,
            event: eventType,
            message: result.message,
        });

        const lines = text ? [text] : [];
        await this.notifications.notifyWizard(wizardEvent, { ctx, lines });
    }

    private mapSupplyEvent(type: OzonSupplyEventType): WizardEvent {
        switch (type) {
            case OzonSupplyEventType.DraftCreated:
                return WizardEvent.DraftCreated;
            case OzonSupplyEventType.DraftValid:
                return WizardEvent.DraftValid;
            case OzonSupplyEventType.DraftExpired:
                return WizardEvent.DraftExpired;
            case OzonSupplyEventType.DraftInvalid:
                return WizardEvent.DraftInvalid;
            case OzonSupplyEventType.DraftError:
                return WizardEvent.DraftError;
            case OzonSupplyEventType.TimeslotMissing:
                return WizardEvent.TimeslotMissing;
            case OzonSupplyEventType.WarehousePending:
                return WizardEvent.WarehousePending;
            case OzonSupplyEventType.WindowExpired:
                return WizardEvent.WindowExpired;
            case OzonSupplyEventType.SupplyCreated:
                return WizardEvent.SupplyCreated;
            case OzonSupplyEventType.SupplyStatus:
                return WizardEvent.SupplyStatus;
            case OzonSupplyEventType.NoCredentials:
                return WizardEvent.NoCredentials;
            case OzonSupplyEventType.Error:
            default:
                return WizardEvent.Error;
        }
    }

    private extractChatId(ctx: Context): string | undefined {
        const chatId = (ctx.chat as any)?.id;
        return typeof chatId === 'undefined' || chatId === null ? undefined : String(chatId);
    }

    private async resolveCredentials(chatId: string): Promise<OzonCredentials | undefined> {
        const stored = await this.credentialsStore.get(chatId);
        if (stored) {
            return { clientId: stored.clientId, apiKey: stored.apiKey };
        }

        const envClientId = process.env.OZON_CLIENT_ID;
        const envApiKey = process.env.OZON_API_KEY;
        if (envClientId && envApiKey) {
            return { clientId: envClientId, apiKey: envApiKey };
        }

        return undefined;
    }

    private registerAbortController(chatId: string, taskId: string): AbortController {
        const existing = this.taskAbortControllers.get(taskId);
        if (existing) {
            existing.controller.abort();
        }
        const controller = new AbortController();
        this.taskAbortControllers.set(taskId, { controller, chatId });
        return controller;
    }

    private abortActiveTask(chatId: string, taskId?: string): void {
        if (taskId) {
            const entry = this.taskAbortControllers.get(taskId);
            if (!entry || entry.chatId !== chatId) {
                return;
            }
            entry.controller.abort();
            this.taskAbortControllers.delete(taskId);
            return;
        }

        for (const [key, entry] of this.taskAbortControllers.entries()) {
            if (entry.chatId === chatId) {
                entry.controller.abort();
                this.taskAbortControllers.delete(key);
            }
        }
    }

    private clearAbortController(taskId: string): void {
        this.taskAbortControllers.delete(taskId);
    }

    private isAbortError(error: unknown): boolean {
        return error instanceof Error && error.name === 'AbortError';
    }

    private cloneTask(task: OzonSupplyTask): OzonSupplyTask {
        return {
            ...task,
            items: task.items.map((item) => ({ ...item })),
            selectedTimeslot: task.selectedTimeslot ? { ...task.selectedTimeslot } : undefined,
        };
    }

    private async downloadTelegramFile(ctx: Context, fileId: string): Promise<Buffer> {
        const link = await ctx.telegram.getFileLink(fileId);
        const url = typeof link === 'string' ? link : link.href ?? link.toString();
        const response = await axios.get<ArrayBuffer>(url, {
            responseType: 'arraybuffer',
            timeout: 60_000,
        });
        return Buffer.from(response.data);
    }

    private describeError(error: unknown): string {
        if (!error) return 'unknown error';
        if (error instanceof Error) return error.message;
        return String(error);
    }

    private extractErrorPayload(error: unknown): string[] | string | undefined {
        const isAxios = (err: any) => err?.isAxiosError && (err.response || err.config);
        if (isAxios(error)) {
            const axiosError = error as any;
            const responseData = this.stringifySafe(axiosError.response?.data);
            const requestData = this.stringifySafe(axiosError.config?.data);
            const meta = [
                `url: ${axiosError.config?.url ?? 'n/a'}`,
                `method: ${axiosError.config?.method ?? 'n/a'}`,
                `status: ${axiosError.response?.status ?? 'n/a'}`,
                requestData ? `request: ${requestData}` : undefined,
                responseData ? `response: ${responseData}` : undefined,
            ]
                .filter(Boolean)
                .join('\n');
            return meta.split('\n');
        }

        if (error instanceof Error) {
            return error.stack ? error.stack.split('\n') : error.message;
        }

        return undefined;
    }

    private stringifySafe(value: unknown): string | undefined {
        if (value === undefined || value === null) {
            return undefined;
        }

        if (typeof value === 'string') {
            return value.length > 1200 ? `${value.slice(0, 1200)}…` : value;
        }

        try {
            const json = JSON.stringify(value, null, 2);
            return json.length > 1200 ? `${json.slice(0, 1200)}…` : json;
        } catch (error) {
            return undefined;
        }
    }
}
