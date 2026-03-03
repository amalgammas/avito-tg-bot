import { Injectable } from '@nestjs/common';
import { Context } from 'telegraf';

import { OzonSupplyEventType } from '@bot/ozon/ozon-supply.types';
import { addMoscowDays, MOSCOW_TIMEZONE } from '@bot/utils/time.utils';

import {
    SupplyWizardClusterOption,
    SupplyWizardDraftWarehouseOption,
    SupplyWizardDropOffOption,
    SupplyWizardOrderSummary,
    SupplyWizardState,
    SupplyWizardTimeslotOption,
    SupplyWizardWarehouseOption,
    SupplyWizardStore,
} from '../supply-wizard.store';

@Injectable()
export class SupplyWizardViewService {
    private readonly draftWarehouseOptionsLimit = 20;
    private readonly timeslotOptionsLimit = 10;

    constructor(private readonly wizardStore: SupplyWizardStore) {}

    renderAuthWelcome(): string {
        return [
            '<b>Привет! Я SmartStocker БОТ 🤖</b>',
            '',
            'Я помогаю находить и автоматически бронировать слоты на склады Ozon',
            '',
            '💰 Это бесплатно',
            'Можно пользоваться всеми функциями без ограничений\n',
            '🔐 Это безопасно\n' +
            'Бот работает через официальное API Ozon и использует только ограниченные права:',
            '• управление поставками',
            '• просмотр информации о товарах',
            '',
            '❓ Как выдать доступ боту',
            '📺 Видео-инструкция:',
            'https://youtu.be/asFoMwU65Ag?si=AKs-GArE4hBJeP5R',
            '',
            '🎥 Демонстрация всех функций бота:',
            'https://youtu.be/mXZbEfhp_pg?si=fcug75GIs7W7DQiX',
            '',
            '📄 Почему это безопасно и где взять данные для подключения:',
            'https://smartstocker.ru/help/api',
            '',
            '💬 Вопросы и предложения — в поддержку:',
            'https://t.me/biknazarov'
        ].join('\n');
    }

    renderAuthInstruction(): string {
        return [
            'Предоставление ключей API Ozon боту безопасно, потому что выдаваемые права дают возможность боту взаимодействовать только с разделом поставок.',
            '',
            'Бот работает с помощью официального API Ozon.',
            '',
            'Подробная инструкция о том, где взять данные для авторизации доступна по ссылке  https://smartstocker.ru/help/api',
            '',
            'Подробная инструкция, как работать с ботом    https://smartstocker.ru/help/howto',
            '',
            '🔐 Чтобы авторизоваться, подготовьте Client ID и API Key из кабинета продавца Ozon.',
            '',
            'Client ID — это идентификатор интеграции, а API Key — секретный ключ доступа.',
            'Создайте пару ключей в разделе Инструменты → API и сохраните их в безопасном месте.',
            '',
            'Когда будете готовы, нажмите «Авторизоваться».',
        ].join('\n');
    }

    buildAuthWelcomeKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        const rows = [
            [{ text: 'Авторизоваться', callback_data: 'wizard:auth:login' }],
            [{ text: 'Инструкция', callback_data: 'wizard:auth:info' }],
        ];

        return this.withNavigation(rows);
    }

    buildAuthInstructionKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        return this.withNavigation([], { back: 'wizard:auth:back:welcome' });
    }

    renderAuthApiKeyPrompt(): string {
        return [
            'Введите API Key Ozon одним сообщением.',
            '',
            'Выглядит так jhg6tyr7-8j26-5kp9-bb0b-35y32kl46f07',
        ].join('\n');
    }

    buildAuthApiKeyKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        return this.withNavigation([], { back: 'wizard:auth:back:welcome' });
    }

    renderAuthClientIdPrompt(maskedApiKey?: string): string {
        const lines = [
            'Отлично! Теперь отправьте Client ID.',
        ];
        if (maskedApiKey) {
            lines.push(`API Key: ${maskedApiKey}`);
        }
        lines.push(
            '',
            'Теперь отправьте Client ID. Client ID, выглядит так 2191549',
        );
        return lines.join('\n');
    }

    buildAuthClientIdKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        return this.withNavigation([], { back: 'wizard:auth:back:apiKey' });
    }

    renderLanding(state: SupplyWizardState): string {
        const lines = ['<b>Главное меню.</b>'];

        const pendingTasks = state.pendingTasks ?? [];
        if (pendingTasks.length) {
            lines.push(
                '',
                `В обработке ${pendingTasks.length} ${pendingTasks.length === 1 ? 'задача' : 'задачи'}.`,
            );
        }

        if (state.orders.length) {
            lines.push(
                '',
                'Созданные поставки доступны в разделе «Мои поставки».',
            );
        } else {
            lines.push(
                '',
                '<b>Нажмите «Новая поставка», чтобы начать поиск слотов.</b>'
            );
        }
        return lines.join('\n');
    }

    buildLandingKeyboard(state: SupplyWizardState): Array<Array<{ text: string; callback_data: string }>> {
        const rows: Array<Array<{ text: string; callback_data: string }>> = [
            [{ text: 'Новая поставка', callback_data: 'wizard:landing:start' }],
            [{ text: 'Мои задачи', callback_data: 'wizard:tasks:list' }]
        ];

        if (state.orders.length) {
            rows.push([{ text: 'Мои поставки', callback_data: 'wizard:orders:list' }]);
        }

        rows.push([{ text: 'Сбросить авторизацию', callback_data: 'wizard:authReset:prompt' }]);
        rows.push([{ text: 'Поддержка', callback_data: 'wizard:support' }]);
        return rows;
    }

    renderSupportInfo(): string {
        return [
            '<b>Поддержка</b>',
            '',
            'Вопросы, замечания, предложения пишите в Telegram  https://t.me/dmitry_smartstocker',
        ].join('\n');
    }

    buildSupportKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        return this.withNavigation([], { back: 'wizard:landing:back' });
    }

    renderUploadPrompt(): string {
        return [
            '<b>📦 Загрузите Excel-файл или пришлите ссылку на Google Sheets с товарами.</b>',
            '',
            'Бот использует формат Ozon для создания поставок.',
            '',
            '<a href="https://disk.yandex.ru/i/a0vDXZdlImtPUA">Скачать шаблон поставки</a>',
            '',
            'На листе 3 столбца: артикул, имя (необязательно), количество',
            '',
            'После загрузки покажу список товаров и их количество, и перейдём к следующему шагу.'
        ].join('\n');
    }

    buildUploadKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        return this.withNavigation([], { back: 'wizard:landing:back' });
    }

    renderSupplyTypePrompt(summary: string): string {
        return [
            summary,
            '',
            '<b>Выберите тип поставки:</b>',
            '• Кросс-докинг — сдаете поставку на точку отгрузки Ozon, Ozon доставляет на целевой склад',
            '• Прямая поставка — сами отвезёте товар на склад Ozon',
        ].join('\n');
    }

    buildSupplyTypeKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        return [
            [{ text: 'Кросс-докинг', callback_data: 'wizard:supplyType:crossdock' }],
            [{ text: 'Прямая поставка', callback_data: 'wizard:supplyType:direct' }],
            [{ text: 'Назад', callback_data: 'wizard:supplyType:back' }],
            [{ text: 'Отмена', callback_data: 'wizard:cancel' }],
        ];
    }

    buildDropOffQueryKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        return [
            [{ text: 'Назад', callback_data: 'wizard:upload:restart' }],
            [{ text: 'Отмена', callback_data: 'wizard:cancel' }],
        ];
    }

    renderReadyDaysPrompt(): string {
        return [
            '<b>Выберите, через сколько дней будете готовы к отгрузке.</b>',
            '',
            'Введите количество дней на подготовку поставки. Тайм слот будет забронирован с учетом времени на подготовку. Выберите один из предложенных вариантов или введите одно целое число от 0 до 28.',
            '',
            '0 дней - значит готов отгрузиться день в день, и бот может ловить слот на текущий день.',
            '1 день - бот будет ловить слот на завтра, и т.д.',
        ].join('\n');
    }

    buildReadyDaysKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        const rows: Array<Array<{ text: string; callback_data: string }>> = [
            [
                { text: '0 дней', callback_data: 'wizard:ready:select:0' },
                { text: '1 день', callback_data: 'wizard:ready:select:1' },
                { text: '2 дня', callback_data: 'wizard:ready:select:2' },
            ],
            [
                { text: '3 дня', callback_data: 'wizard:ready:select:3' },
                { text: '5 дней', callback_data: 'wizard:ready:select:5' },
                { text: '7 дней', callback_data: 'wizard:ready:select:7' },
            ],
            [
                { text: '14 дней', callback_data: 'wizard:ready:select:14' },
                { text: '21 день', callback_data: 'wizard:ready:select:21' },
                { text: '28 дней', callback_data: 'wizard:ready:select:28' },
            ],
        ];

        const keyboard = this.withNavigation(rows, { back: 'wizard:ready:back' });
        keyboard.push([{ text: 'Отмена', callback_data: 'wizard:cancel' }]);
        return keyboard;
    }

    renderDeadlinePrompt(): string {
        return [
            '<b>Укажите дату, не позже которой должен быть найден слот.</b>',
            '',
            'Например, вам нужно отгрузиться не позднее 30 декабря.',
            '',
            'Если бот не найдёт слот до указанной даты, задача будет отменена и вы получите уведомление.',
        ].join('\n');
    }

    buildDeadlineKeyboard(readyInDays: number, maxDays: number): Array<Array<{ text: string; callback_data: string }>> {
        const offsets: number[] = [];
        const end = Math.min(readyInDays + 27, maxDays);
        for (let offset = readyInDays; offset <= end; offset += 1) {
            offsets.push(offset);
        }

        const rows: Array<Array<{ text: string; callback_data: string }>> = [];
        for (let index = 0; index < offsets.length; index += 4) {
            const chunk = offsets.slice(index, index + 4);
            rows.push(
                chunk.map((days) => ({
                    text: this.formatDeadlineOption(days),
                    callback_data: `wizard:deadline:select:${days}`,
                })),
            );
        }

        const keyboard = this.withNavigation(rows, { back: 'wizard:deadline:back' });
        keyboard.push([{ text: 'Отмена', callback_data: 'wizard:cancel' }]);
        return keyboard;
    }

    renderTimeslotWindowPrompt(options: { phase: 'from' | 'to'; fromHour?: number }): string {
        const border = options?.phase === 'to' ? ' нижнюю ' : ' верхнюю ';

        const lines = [
            `<b>Укажите ${ border } границу часового диапазона для поиска тайм-слота. Или выберите “Первый доступный”</b>`,
            'Бот будет искать тайм слот не раньше указанного часа. Например для поиска слота 12:00 - 13:00, нужно выбрать 12',
            '',
        ];

        if (typeof options.fromHour === 'number') {
            lines.push(`Начало: ${this.formatHour(options.fromHour)}`);
        }

        return lines.join('\n');
    }

    buildTimeslotWindowKeyboard(params: {
        phase: 'from' | 'to';
        fromHour?: number;
        backAction: string;
        includeFirstAvailable?: boolean;
    }): Array<Array<{ text: string; callback_data: string }>> {
        const rows: Array<Array<{ text: string; callback_data: string }>> = [];
        const includeFirstAvailable = params.phase === 'from' && params.includeFirstAvailable !== false;
        const prefix = params.phase === 'from' ? 'wizard:timeWindow:start' : 'wizard:timeWindow:end';

        if (includeFirstAvailable) {
            rows.push([{ text: 'Первый доступный', callback_data: `${prefix}:any` }]);
        }

        const startHour =
            params.phase === 'to' && typeof params.fromHour === 'number'
                ? Math.max(0, Math.min(24, Math.floor(params.fromHour) + 1))
                : 0;
        const hours = Array.from({ length: Math.max(0, 24 - startHour) }, (_, index) => index + startHour);
        for (let i = 0; i < hours.length; i += 4) {
            const chunk = hours.slice(i, i + 4);
            rows.push(
                chunk.map((hour) => ({
                    text: this.formatHour(hour, { short: true }),
                    callback_data: `${prefix}:${hour.toString().padStart(2, '0')}`,
                })),
            );
        }

        rows.push([{ text: 'Назад', callback_data: params.backAction }]);
        rows.push([{ text: 'Отмена', callback_data: 'wizard:cancel' }]);
        return rows;
    }

    private formatDeadlineOption(daysOffset: number): string {
        const target = addMoscowDays(new Date(), daysOffset);
        const formatter = new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit',
            month: 'short',
            timeZone: MOSCOW_TIMEZONE,
        });
        const label = formatter.format(target).replace('.', '');
        return label;
    }

    renderAuthResetPrompt(): string {
        return [
            '<b>Сбросить авторизацию?</b>',
        '',
            'Это удалит все сохранённые ключи пользователя. Продолжить?'
        ].join('\n');
    }

    buildAuthResetKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        return [
            [
                { text: 'Да, удалить', callback_data: 'wizard:authReset:confirm' },
                { text: 'Нет', callback_data: 'wizard:authReset:cancel' },
            ],
        ];
    }

    renderOrdersList(state: SupplyWizardState): string {
        if (!state.orders.length) {
            return 'Список поставок пуст. Создайте новую поставку.';
        }

        const lines = ['Мои поставки:'];

        // state.orders.forEach((order, index) => {
        //     const arrival = order.arrival ? ` — ${order.arrival}` : '';
        //     const label = order.orderId ?? order.operationId ?? order.id;
        //     lines.push(`${index + 1}. №${label}${arrival}`);
        // });
        //lines.push('', 'Выберите поставку, чтобы посмотреть детали.');
        return lines.join('\n');
    }

    buildOrdersListKeyboard(state: SupplyWizardState): Array<Array<{ text: string; callback_data: string }>> {
        const rows = state.orders.map((order) => [
            {
                text: `№${order.orderId ?? order.operationId ?? order.id}`,
                callback_data: `wizard:orders:details:${order.id}`,
            },
        ]);

        rows.push([{ text: 'Создать новую поставку', callback_data: 'wizard:landing:start' }]);
        return this.withNavigation(rows, { back: 'wizard:orders:back' });
    }

    renderOrderDetails(order: SupplyWizardOrderSummary): string {
        const searchWindowLine = this.buildSearchDeadlineLine(order.searchDeadlineAt);
        const supplyTypeLabel = this.formatSupplyType(order.supplyType);
        const hasOrderId = typeof order.orderId === 'number' && Number.isFinite(order.orderId);
        const lkLines = hasOrderId
            ? [
                '\n',
                'Посмотреть поставку в ЛК Ozon 👇🏻',
                `https://seller.ozon.ru/app/supply/orders/${order.orderId}`,
            ]
            : [
                '\n',
                'Ссылка на поставку в ЛК Ozon появится после подтверждения order_id.',
            ];

        const lines = [
            `Поставка №${order.orderId ?? order.operationId ?? order.id}`,
            '',
            supplyTypeLabel ? `Тип: ${supplyTypeLabel}.` : undefined,
            order.clusterName ? `Кластер: ${order.clusterName}` : undefined,
            order.dropOffName ? `Пункт сдачи: ${order.dropOffName}` : undefined,
            order.warehouse ? `Склад: ${order.warehouse}` : undefined,
            typeof order.readyInDays === 'number' ? `Готовность: ${order.readyInDays} дн.` : undefined,
            searchWindowLine,
            order.timeslotLabel
                ? `Таймслот: ${order.timeslotLabel}`
                : order.arrival
                    ? `Время отгрузки: ${order.arrival}`
                    : undefined,
            '',
            'Товары:',
            ...order.items.map((item) => `• ${item.article} × ${item.quantity}`),
            ...lkLines,
        ].filter((value): value is string => Boolean(value));
        return lines.join('\n');
    }

    buildOrderDetailsKeyboard(order: SupplyWizardOrderSummary): Array<Array<{ text: string; callback_data: string }>> {
        const rows = [
            [
                {
                    text: 'Отменить поставку',
                    callback_data: `wizard:orders:cancel:${order.id}`,
                },
            ],
        ];
        return this.withNavigation(rows, { back: 'wizard:orders:list' });
    }

    renderTasksList(state: SupplyWizardState): string {
        const pendingTasks = state.pendingTasks ?? [];
        if (!pendingTasks.length) {
            return 'Тут будет список задач на поиск слотов.' +
                '\n' +
                'Создайте новую задачу на поиск.';
        }

        const lines = ['Мои задачи:'];
        // pendingTasks.forEach((task, index) => {
        //     let items = 0;
        //     task.items.map((item) => items += item.quantity)
        //
        //     const desc = `${this.formatTaskName(task.id)}: ${items}шт. ${task.items.length} товаров`
        //     const dropOff = task.dropOffName ? task.dropOffName : '';
        //     const cluster = task.clusterName ? task.clusterName : '';
        //     const warehouse = task.warehouse ? task.warehouse : '';
        //
        //     lines.push(`${index + 1}. ${desc}. ${dropOff} → ${cluster} → ${warehouse}`);
        // });
        // lines.push(
        //     '',
        //     'Выберите задачу, чтобы посмотреть детали или отменить её.'
        // );

        return lines.join('\n');
    }

    buildTasksListKeyboard(state: SupplyWizardState): Array<Array<{ text: string; callback_data: string }>> {
        const pendingTasks = state.pendingTasks ?? [];
        const rows = pendingTasks.map((task) => {
            const baseName =
                this.formatTaskName(task.operationId ?? task.id) ?? task.operationId ?? task.id ?? '—';
            const createdAt = this.formatCreatedAt(task.createdAt);
            const label = createdAt ? `${baseName} · ${createdAt}` : baseName;
            return [
                {
                    text: label,
                    callback_data: `wizard:tasks:details:${task.taskId ?? task.id}`,
                },
            ];
        });
        rows.push([{ text: 'Назад', callback_data: 'wizard:tasks:back' }]);
        return rows;
    }

    renderTaskDetails(task: SupplyWizardOrderSummary): string {
        const limit = 20;
        const totalItems = task.items.length;
        const displayedItems = task.items.slice(0, limit);
        const searchWindowLine = this.buildSearchDeadlineLine(task.searchDeadlineAt);
        const createdLine = this.buildCreatedLine(task.createdAt);
        const supplyTypeLabel = this.formatSupplyType(task.supplyType);

        const lines = [
            `Задача ${this.formatTaskName(task.operationId || task.id)}`,
            '\n',
            supplyTypeLabel ? `Тип: ${supplyTypeLabel}.` : undefined,
            task.dropOffName ? `Пункт сдачи: ${task.dropOffName}` : undefined,
            task.clusterName ? `Кластер: ${task.clusterName}` : undefined,
            task.warehouse ? `Склад: ${task.warehouse}` : undefined,
            createdLine,
            searchWindowLine,
            '',
            task.timeslotLabel ? `Таймслот: ${task.timeslotLabel}` : undefined,
            '\n',
            'Товары:',
            ...displayedItems.map((item) => `• ${item.article} × ${item.quantity}`),
            ...(totalItems > limit
                ? [`… и ещё ${totalItems - limit} позиций`]
                : []),
        ].filter((value): value is string => Boolean(value));
        return lines.join('\n');
    }

    buildTaskDetailsKeyboard(task: SupplyWizardOrderSummary): Array<Array<{ text: string; callback_data: string }>> {
        const rows = [
            [{ text: 'Отменить задачу', callback_data: `wizard:tasks:cancel:${task.taskId ?? task.id}` }],
        ];
        rows.push([{ text: 'Назад', callback_data: 'wizard:tasks:list' }]);

        return rows;
    }

    renderSupplySuccess(order: SupplyWizardOrderSummary): string {
        const searchWindowLine = this.buildSearchDeadlineLine(order.searchDeadlineAt);
        const createdLine = this.buildCreatedLine(order.createdAt);
        const supplyTypeLabel = this.formatSupplyType(order.supplyType);

        const lines = [
            'Поставка создана ✅',
            `ID: ${order.orderId ?? order.id}`,
            supplyTypeLabel ? `Тип: ${supplyTypeLabel}.` : undefined,
            order.timeslotLabel ? `Таймслот: ${order.timeslotLabel}` : order.arrival ? `Время отгрузки: ${order.arrival}` : undefined,
            order.warehouse ? `Склад: ${order.warehouse}` : undefined,
            createdLine,
            searchWindowLine,
        ].filter((value): value is string => Boolean(value));
        return lines.join('\n');
    }

    buildOptions(
        clusters: OzonClusterLike[],
    ): {
        clusters: SupplyWizardClusterOption[];
        warehouses: Record<number, SupplyWizardWarehouseOption[]>;
    } {
        const clusterOptions: SupplyWizardClusterOption[] = [];
        const clusterWarehouses = new Map<number, SupplyWizardWarehouseOption[]>();

        for (const cluster of clusters) {
            if (typeof cluster.id !== 'number') continue;
            const clusterId = Number(cluster.id);
            const clusterName = cluster.name?.trim() || `Кластер ${clusterId}`;

            const rawWarehouses: SupplyWizardWarehouseOption[] = [];
            for (const logistic of cluster.logistic_clusters ?? []) {
                for (const warehouse of logistic.warehouses ?? []) {
                    if (typeof warehouse?.warehouse_id !== 'number') continue;
                    const warehouseId = Number(warehouse.warehouse_id);
                    if (!Number.isFinite(warehouseId)) continue;

                    rawWarehouses.push({
                        warehouse_id: warehouseId,
                        name: warehouse.name?.trim() || `Склад ${warehouseId}`,
                    });
                }
            }

            const uniqueWarehouses = this.deduplicateWarehouseOptions(rawWarehouses);
            clusterWarehouses.set(clusterId, uniqueWarehouses);

            clusterOptions.push({
                id: clusterId,
                name: clusterName,
                logistic_clusters: {
                    warehouses: uniqueWarehouses.map((item) => ({ ...item })),
                },
            });
        }

        const sortedClusters = clusterOptions.sort((a, b) =>
            a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }),
        );

        const warehousesByCluster = Object.fromEntries(clusterWarehouses.entries()) as Record<
            number,
            SupplyWizardWarehouseOption[]
        >;

        return {
            clusters: sortedClusters,
            warehouses: warehousesByCluster,
        };
    }

    mapDraftWarehouseOptions(info?: DraftStatusLike): SupplyWizardDraftWarehouseOption[] {
        if (!info?.clusters?.length) {
            return [];
        }

        const byWarehouse = new Map<number, SupplyWizardDraftWarehouseOption>();

        for (const cluster of info.clusters ?? []) {
            const parsedClusterId = this.parseNumber(cluster?.cluster_id);
            const clusterId = parsedClusterId ? Math.round(parsedClusterId) : undefined;
            const clusterName = cluster?.cluster_name?.trim() || undefined;

            for (const warehouseInfo of cluster?.warehouses ?? []) {
                if (!warehouseInfo) continue;
                const supplyWarehouse = warehouseInfo.supply_warehouse;
                const rawId = supplyWarehouse?.warehouse_id;
                const parsedId = this.parseNumber(rawId);
                if (!parsedId || parsedId <= 0) continue;
                const warehouseId = Math.round(parsedId);

                const totalRankRaw = this.parseNumber(warehouseInfo.total_rank);
                const totalRank = typeof totalRankRaw === 'number' ? totalRankRaw : undefined;
                const totalScore = this.parseNumber(warehouseInfo.total_score);
                const travelTimeDays = this.parseNullableNumber(warehouseInfo.travel_time_days);
                const bundle = warehouseInfo.bundle_ids?.[0];

                const option: SupplyWizardDraftWarehouseOption = {
                    warehouseId,
                    name: supplyWarehouse?.name?.trim() || `Склад ${warehouseId}`,
                    address: supplyWarehouse?.address?.trim() || undefined,
                    clusterId: clusterId,
                    clusterName,
                    totalRank,
                    totalScore,
                    travelTimeDays: typeof travelTimeDays === 'number' ? travelTimeDays : null,
                    isAvailable: warehouseInfo.status?.is_available,
                    statusState: warehouseInfo.status?.state,
                    statusReason: warehouseInfo.status?.invalid_reason,
                    bundleId: bundle?.bundle_id || undefined,
                    restrictedBundleId: warehouseInfo.restricted_bundle_id || undefined,
                };

                const existing = byWarehouse.get(warehouseId);
                if (!existing) {
                    byWarehouse.set(warehouseId, option);
                    continue;
                }

                const existingRank = existing.totalRank ?? Number.POSITIVE_INFINITY;
                const candidateRank = option.totalRank ?? Number.POSITIVE_INFINITY;
                if (candidateRank < existingRank) {
                    byWarehouse.set(warehouseId, option);
                }
            }
        }

        return [...byWarehouse.values()].sort((a, b) => {
            const rankA = a.totalRank ?? Number.POSITIVE_INFINITY;
            const rankB = b.totalRank ?? Number.POSITIVE_INFINITY;
            if (rankA !== rankB) return rankA - rankB;

            const scoreA = a.totalScore ?? -Number.POSITIVE_INFINITY;
            const scoreB = b.totalScore ?? -Number.POSITIVE_INFINITY;
            if (scoreA !== scoreB) return scoreB - scoreA;

            return (a.name ?? '').localeCompare(b.name ?? '', 'ru', { sensitivity: 'base' });
        });
    }

    limitDraftWarehouseOptions(options: SupplyWizardDraftWarehouseOption[]): {
        limited: SupplyWizardDraftWarehouseOption[];
        truncated: boolean;
    } {
        const limited = options.slice(0, this.draftWarehouseOptionsLimit);
        return {
            limited,
            truncated: limited.length < options.length,
        };
    }

    formatDraftWarehouseSummary(options: SupplyWizardDraftWarehouseOption[]): string[] {
        const lines: string[] = [];

        options.forEach((option, index) => {
            const rank = option.totalRank ?? index + 1;
            const icon = option.isAvailable === false ? '⚠️' : option.isAvailable === true ? '✅' : 'ℹ️';
            const name = option.name ?? `Склад ${option.warehouseId}`;
            const travelPart =
                typeof option.travelTimeDays === 'number' ? `, путь ≈ ${option.travelTimeDays} дн.` : '';
            const scorePart = typeof option.totalScore === 'number' ? `, score ${option.totalScore.toFixed(3)}` : '';
            const statusPart = option.isAvailable === false && option.statusReason ? ` — ${option.statusReason}` : '';

            lines.push(`${rank}. ${icon} ${name} (${option.warehouseId})${travelPart}${scorePart}${statusPart}`);

            if (option.address) {
                lines.push(`   Адрес: ${option.address}`);
            }
        });

        return lines;
    }

    formatTimeslotSummary(options: SupplyWizardTimeslotOption[]): string[] {
        return options.map((option, index) => this.formatTimeslotButtonLabel(option, index));
    }

    buildTimeslotKeyboard(
        state: SupplyWizardState,
    ): Array<Array<{ text: string; callback_data: string }>> {
        const rows = state.draftTimeslots.slice(0, this.timeslotOptionsLimit).map((option, index) => [
            {
                text: this.formatTimeslotButtonLabel(option, index),
                callback_data: `wizard:timeslot:${option.id}`,
            },
        ]);
        return this.withCancel(rows);
    }

    describeWarehouseSelection(
        option: SupplyWizardDraftWarehouseOption,
        state: SupplyWizardState,
    ): string[] {
        const lines = [`Склад выбран: ${option.name} (${option.warehouseId}).`];
        if (option.address) {
            lines.push(`Адрес: ${option.address}.`);
        }

        const dropOffLabel =
            state.selectedDropOffName ?? (state.selectedDropOffId ? String(state.selectedDropOffId) : undefined);
        if (dropOffLabel) {
            lines.push(`Пункт сдачи: ${dropOffLabel}.`);
        }

        const clusterLabel =
            option.clusterName ??
            state.selectedClusterName ??
            (state.selectedClusterId ? `Кластер ${state.selectedClusterId}` : undefined);
        if (clusterLabel) {
            lines.push(`Кластер: ${clusterLabel}.`);
        }

        const metaParts: string[] = [];
        if (typeof option.totalRank === 'number') {
            metaParts.push(`ранг ${option.totalRank}`);
        }

        if (typeof option.totalScore === 'number') {
            metaParts.push(`score ${option.totalScore.toFixed(3)}`);
        }

        if (option.travelTimeDays !== undefined && option.travelTimeDays !== null) {
            metaParts.push(`путь ≈ ${option.travelTimeDays} дн.`);
        }

        if (metaParts.length) {
            lines.push(`Оценка Ozon: ${metaParts.join(', ')}.`);
        }

        if (option.restrictedBundleId) {
            lines.push(`Ограничение: bundle ${option.restrictedBundleId}.`);
        }

        if (option.isAvailable === false && option.statusReason) {
            lines.push(`⚠️ Статус Ozon: ${option.statusReason}.`);
        } else if (option.isAvailable === false) {
            lines.push('⚠️ Ozon пометил склад как недоступный.');
        } else if (option.isAvailable === true) {
            lines.push('✅ Ozon отмечает склад как доступный.');
        }

        return lines;
    }

    buildDropOffKeyboard(
        state: SupplyWizardState,
    ): Array<Array<{ text: string; callback_data: string }>> {
        const rows = state.dropOffs.map((option) => [
            {
                text: this.formatDropOffButtonLabel(option),
                callback_data: `wizard:dropoff:${option.warehouse_id}`,
            },
        ]);
        return [
            ...rows,
            [{ text: 'Назад', callback_data: 'wizard:upload:restart' }],
            [{ text: 'Отмена', callback_data: 'wizard:cancel' }],
        ];
    }

    buildDraftWarehouseKeyboard(
        state: SupplyWizardState,
    ): Array<Array<{ text: string; callback_data: string }>> {
        const source = state.draftWarehouses.slice(0, this.draftWarehouseOptionsLimit);
        const rows = source.map((option, index) => [
            {
                text: this.formatDraftWarehouseButtonLabel(option, index),
                callback_data: `wizard:draftWarehouse:${option.warehouseId}`,
            },
        ]);
        return this.withCancel(rows);
    }

    renderWarehouseSelection(params: {
        clusterName?: string;
        dropOffLabel?: string;
        total: number;
        filteredTotal: number;
        page: number;
        pageCount: number;
        searchQuery?: string;
    }): string {
        const lines: string[] = [];

        if (params.clusterName) {
            lines.push(`Кластер: ${params.clusterName}.`);
        }
        if (params.dropOffLabel) {
            lines.push(`Пункт сдачи: ${params.dropOffLabel}.`);
        }

        const search = params.searchQuery?.trim();
        if (search) {
            lines.push(`Поиск: «${search}».`);
        }

        if (params.filteredTotal > 0) {
            lines.push(
                '',
                '<b>Выберите склад для поиска слотов.</b>',
                '',
                '<b>Если вы хотите отправить поставку в любой доступный склад в кластере, то выберите пункт “Первый доступный”.</b>',
                '',
                'Если вы хотите отправить поставку на <b>конкретный</b> склад в кластере, выберите его в списке ниже. Выберите склад кнопкой или введите часть названия / номера, чтобы отфильтровать список.',
                ''
            );

            const totalInfo = params.total !== params.filteredTotal
                ? `${params.filteredTotal} из ${params.total}`
                : `${params.filteredTotal}`;
            lines.push(`Всего складов в кластере: ${totalInfo}`);
        } else {
            lines.push(
                '',
                'Склады не найдены. Введите часть названия или ID, чтобы попробовать другой вариант.',
            );
        }

        return lines.join('\n');
    }

    buildClusterWarehouseKeyboard(params: {
        items: SupplyWizardWarehouseOption[];
        page: number;
        pageCount: number;
        hasPrev: boolean;
        hasNext: boolean;
        includeAuto: boolean;
        searchActive: boolean;
        includeBackToCluster?: boolean;
    }): Array<Array<{ text: string; callback_data: string }>> {
        const rows: Array<Array<{ text: string; callback_data: string }>> = [];

        if (params.includeAuto) {
            rows.push([{ text: 'Первый доступный 🥇', callback_data: 'wizard:warehouse:auto' }]);
        }

        params.items.forEach((warehouse) => {
            rows.push([
                {
                    text: `${warehouse.name} (${warehouse.warehouse_id})`,
                    callback_data: `wizard:warehouse:${warehouse.warehouse_id}`,
                },
            ]);
        });

        if (params.searchActive) {
            rows.push([{ text: 'Сбросить поиск', callback_data: 'wizard:warehouse:search:clear' }]);
        }

        if (params.pageCount > 1) {
            const navRow: Array<{ text: string; callback_data: string }> = [];
            navRow.push({
                text: '⬅️',
                callback_data: params.hasPrev ? 'wizard:warehouse:page:prev' : 'wizard:warehouse:noop',
            });
            navRow.push({
                text: `${params.page + 1}/${params.pageCount}`,
                callback_data: 'wizard:warehouse:noop',
            });
            navRow.push({
                text: '➡️',
                callback_data: params.hasNext ? 'wizard:warehouse:page:next' : 'wizard:warehouse:noop',
            });
            rows.push(navRow);
        }

        if (params.includeBackToCluster) {
            rows.push([
                {
                    text: '← Выбрать другой кластер',
                    callback_data: 'wizard:warehouse:backToClusters',
                },
            ]);
        }

        return this.withCancel(rows);
    }

    buildClusterKeyboard(state: SupplyWizardState): Array<Array<{ text: string; callback_data: string }>> {
        const rows = state.clusters.map((cluster) => [
            {
                text: `${cluster.name}`,
                callback_data: `wizard:cluster:${cluster.id}`,
            },
        ]);
        return this.withNavigation(rows, { cancel: 'wizard:cancel' });
    }

    buildClusterTypeKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        return [
            [{ text: 'РОССИЯ', callback_data: 'wizard:clusterType:ozon' }],
            [{ text: 'СНГ', callback_data: 'wizard:clusterType:cis' }],
            [{ text: 'Назад', callback_data: 'wizard:clusterType:back' }],
            [{ text: 'Отмена', callback_data: 'wizard:cancel' }],
        ];
    }

    buildWarehouseKeyboard(
        state: SupplyWizardState,
        clusterId: number,
    ): Array<Array<{ text: string; callback_data: string }>> {
        const warehouses = state.warehouses[clusterId] ?? [];
        const rows = warehouses.map((warehouse) => [
            {
                text: warehouse.name,
                callback_data: `wizard:warehouse:${warehouse.warehouse_id}`,
            },
        ]);
        return this.withCancel(rows);
    }

    buildClusterStartKeyboard(): Array<Array<{ text: string; callback_data: string }>> {
        return [[{ text: 'Выбрать кластер', callback_data: 'wizard:clusterStart' }]];
    }

    withCancel(
        rows: Array<Array<{ text: string; callback_data: string }>> = [],
    ): Array<Array<{ text: string; callback_data: string }>> {
        return this.withNavigation(rows);
    }

    withNavigation(
        rows: Array<Array<{ text: string; callback_data: string }>> = [],
        options: { back?: string, cancel?: string } = {},
    ): Array<Array<{ text: string; callback_data: string }>> {
        const keyboard = [...rows];
        if (options.back) {
            keyboard.push([{ text: 'Назад', callback_data: options.back }]);
        } else if (options.cancel) {
            keyboard.push([{ text: 'Отмена', callback_data: 'wizard:cancel' }]);
        }

        return keyboard;
    }

    private formatHour(hour: number, options: { short?: boolean } = {}): string {
        const normalized = Math.max(0, Math.min(23, Math.floor(hour)));
        const label = normalized.toString().padStart(2, '0');
        return options.short ? label : `${label}:00`;
    }

    async updatePrompt(
        ctx: Context,
        chatId: string,
        state: SupplyWizardState,
        text: string,
        keyboard?: Array<Array<{ text: string; callback_data: string }>>,
        options: { parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML' } = {},
    ): Promise<void> {
        const rawChatId = (ctx.callbackQuery as any)?.message?.chat?.id ?? chatId;
        const messageId = state.promptMessageId;
        const replyMarkup = keyboard ? { inline_keyboard: keyboard } : undefined;
        const replyOptions: Record<string, unknown> = {};

        if (replyMarkup) {
            replyOptions.reply_markup = replyMarkup;
        }

        if (options.parseMode) {
            replyOptions.parse_mode = options.parseMode;
        }

        if (messageId) {
            try {
                await ctx.telegram.deleteMessage(rawChatId, messageId);
            } catch (error) {
                // игнорируем ошибку удаления и отправим новое сообщение ниже
            }
            this.wizardStore.update(chatId, (current) => {
                if (!current) return undefined;
                if (current.promptMessageId !== messageId) {
                    return current;
                }
                return { ...current, promptMessageId: undefined };
            });
        }

        const sent = await ctx.reply(text, replyOptions as any);
        this.wizardStore.update(chatId, (current) => {
            if (!current) return undefined;
            return { ...current, promptMessageId: (sent as any)?.message_id ?? current.promptMessageId };
        });
    }

    async sendErrorDetails(ctx: Context, payload: string[] | string | undefined): Promise<void> {
        if (!payload) return;

        const lines = Array.isArray(payload) ? payload : payload.split(/\r?\n/);
        await ctx.reply(['Детали ошибки:', '```', ...lines, '```'].join('\n'), {
            parse_mode: 'Markdown',
        });
    }

    formatItemsSummary(
        task: { items: Array<{ article: string; sku?: number; quantity: number }> },
        options: { supplyType?: SupplyWizardState['supplyType'] } = {},
    ): string {
        const summary = [];

        if (options.supplyType === 'CREATE_TYPE_CROSSDOCK') {
            summary.push(
                '',
                '<b>Необходимо выбрать точку для сдачи поставки по кросс-докингу</b>',
                '',
                'Введите ниже город, адрес или название пункта сдачи поставок кросс-докинг'
            );
        }

        return summary.join('\n');
    }

    formatSupplyEvent(result: { taskId: string; event: OzonSupplyEventType; message?: string }): string | undefined {
        const prefix = `[${result.taskId}]`;
        switch (result.event) {
            case OzonSupplyEventType.DraftCreated:
                return `${prefix} Черновик создан. ${result.message ?? ''}`.trim();
            case OzonSupplyEventType.DraftValid:
                return `${prefix} Используем существующий черновик. ${result.message ?? ''}`.trim();
            case OzonSupplyEventType.DraftExpired:
                return `${prefix} Черновик устарел, создаём заново.`;
            case OzonSupplyEventType.DraftInvalid:
                return `${prefix} Черновик невалидный, пересоздаём.`;
            case OzonSupplyEventType.DraftError:
                return `${prefix} Ошибка статуса черновика.${result.message ? ` ${result.message}` : ''}`;
            case OzonSupplyEventType.WarehousePending:
                return result.message ? `${prefix} ${result.message}` : undefined;
            case OzonSupplyEventType.WindowExpired:
                return `${prefix} Временное окно истекло, задача остановлена.`;
            case OzonSupplyEventType.TimeslotMissing:
                //return `${prefix} Свободных таймслотов нет.`;
                return ``;
            case OzonSupplyEventType.SupplyCreated:
                return `${prefix} ✅ Поставка создана. ${result.message ?? ''}`.trim();
            case OzonSupplyEventType.SupplyStatus:
                return `${prefix} ${result.message ?? 'Статус поставки обновлён.'}`.trim();
            case OzonSupplyEventType.NoCredentials:
            case OzonSupplyEventType.Error:
                return `${prefix} ❌ ${result.message ?? 'Ошибка'}`;
            default:
                return result.message ? `${prefix} ${result.message}` : undefined;
        }
    }

    mapTimeslotOptions(response?: TimeslotResponseLike): SupplyWizardTimeslotOption[] {
        const options: SupplyWizardTimeslotOption[] = [];
        if (!response?.drop_off_warehouse_timeslots?.length) {
            return options;
        }

        const seen = new Set<string>();
        for (const bucket of response.drop_off_warehouse_timeslots ?? []) {
            const timezone = bucket?.warehouse_timezone;
            for (const day of bucket?.days ?? []) {
                for (const slot of day?.timeslots ?? []) {
                    const from = slot?.from_in_timezone;
                    const to = slot?.to_in_timezone;
                    if (!from || !to) {
                        continue;
                    }
                    const fingerprint = `${from}|${to}|${timezone ?? ''}`;
                    if (seen.has(fingerprint)) {
                        continue;
                    }
                    seen.add(fingerprint);
                    const id = `${options.length}`;
                    options.push({
                        id,
                        from,
                        to,
                        label: this.formatTimeslotLabel(from, to, timezone),
                        data: {
                            from_in_timezone: from,
                            to_in_timezone: to,
                        },
                    });
                }
            }
        }

        return options;
    }

    limitTimeslotOptions(options: SupplyWizardTimeslotOption[]): {
        limited: SupplyWizardTimeslotOption[];
        truncated: boolean;
    } {
        const limited = options.slice(0, this.timeslotOptionsLimit);
        return {
            limited,
            truncated: limited.length < options.length,
        };
    }

    collectTimeslotWarehouseIds(
        state: SupplyWizardState,
        option: SupplyWizardDraftWarehouseOption,
    ): string[] {
        const warehouseId = option?.warehouseId ?? state.selectedWarehouseId;
        return warehouseId ? [String(warehouseId)] : [];
    }

    private deduplicateWarehouseOptions(
        entries: SupplyWizardWarehouseOption[],
    ): SupplyWizardWarehouseOption[] {
        const map = new Map<number, SupplyWizardWarehouseOption>();
        for (const entry of entries) {
            if (!entry) continue;
            if (!map.has(entry.warehouse_id)) {
                map.set(entry.warehouse_id, entry);
            }
        }
        return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }));
    }

    private formatTimeslotButtonLabel(option: SupplyWizardTimeslotOption, index: number): string {
        return this.truncate(`${index + 1}. ${option.label}`, 60);
    }

    private formatTimeslotLabel(fromIso: string, toIso: string, timezone?: string): string {
        const fromDate = new Date(fromIso);
        const toDate = new Date(toIso);

        if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
            return `${fromIso} → ${toIso}${timezone ? ` (${timezone})` : ''}`;
        }

        const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit',
            month: '2-digit',
        });
        const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
        });

        const datePart = dateFormatter.format(fromDate);
        const fromPart = timeFormatter.format(fromDate);
        const toPart = timeFormatter.format(toDate);
        const timezonePart = timezone ? ` (${timezone})` : '';

        return `${datePart} ${fromPart}–${toPart}${timezonePart}`;
    }

    private formatTaskName(name: string | undefined): string | undefined {
        if (name) {
            const names = name.split('-');
            return names[1];
        }
    }

    private formatDropOffButtonLabel(option: SupplyWizardDropOffOption): string {
        const base = option.name ?? `Пункт ${option.warehouse_id}`;
        return this.truncate(`${base}`, 60);
    }

    private formatSupplyType(type?: 'CREATE_TYPE_CROSSDOCK' | 'CREATE_TYPE_DIRECT'): string | undefined {
        if (type === 'CREATE_TYPE_DIRECT') {
            return 'Прямая поставка';
        }
        if (type === 'CREATE_TYPE_CROSSDOCK') {
            return 'Кросс-докинг';
        }
        return undefined;
    }

    private formatCreatedAt(value: number | undefined): string | undefined {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return undefined;
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return undefined;
        }
        return new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(date);
    }

    private buildCreatedLine(value: number | undefined): string | undefined {
        const formatted = this.formatCreatedAt(value);
        return formatted ? `Создана: ${formatted}` : undefined;
    }

    private buildSearchDeadlineLine(value: number | undefined): string {
        const formatted = this.formatSearchDeadline(value);
        return `Диапазон поиска: ${formatted ? `до ${formatted}` : '—'}`;
    }

    private formatSearchDeadline(value: number | undefined): string | undefined {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return undefined;
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return undefined;
        }
        return new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit',
            month: '2-digit',
        }).format(date);
    }

    private formatDraftWarehouseButtonLabel(
        option: SupplyWizardDraftWarehouseOption,
        index: number,
    ): string {
        const rank = option.totalRank ?? index + 1;
        const icon = option.isAvailable === false ? '⚠️' : option.isAvailable === true ? '✅' : 'ℹ️';
        const base = `${rank}. ${icon} ${option.name ?? option.warehouseId}`;
        return this.truncate(base, 60);
    }

    private truncate(value: string, maxLength = 60): string {
        if (value.length <= maxLength) {
            return value;
        }
        return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
    }

    private parseNumber(value: unknown): number | undefined {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) {
                return undefined;
            }
            const parsed = Number(trimmed);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
        return undefined;
    }

    private parseNullableNumber(value: unknown): number | null | undefined {
        if (value === null) {
            return null;
        }
        return this.parseNumber(value);
    }

}

export interface OzonClusterLike {
    id?: number;
    name?: string;
    logistic_clusters?: Array<{
        warehouses?: Array<{
            warehouse_id?: number;
            name?: string;
            type?: string | number;
        }>;
    }>;
}

export interface DraftStatusLike {
    clusters?: Array<{
        cluster_id?: number | string;
        cluster_name?: string;
        warehouses?: Array<{
            bundle_ids?: Array<{ bundle_id?: string; is_docless?: boolean }>;
            supply_warehouse?: {
                warehouse_id?: number | string;
                name?: string;
                address?: string;
            };
            total_rank?: number | string;
            total_score?: number | string;
            travel_time_days?: number | string | null;
            status?: {
                state?: string;
                invalid_reason?: string;
                is_available?: boolean;
            };
            restricted_bundle_id?: string;
        }>;
    }>;
}

export interface TimeslotResponseLike {
    drop_off_warehouse_timeslots?: Array<{
        drop_off_warehouse_id?: number | string;
        warehouse_timezone?: string;
        current_time_in_timezone?: string;
        days?: Array<{
            timeslots?: Array<{
                from_in_timezone?: string;
                to_in_timezone?: string;
            }>;
        }>;
    }>;
}
