import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import type { OzonDraftTimeslot } from '@bot/config/ozon-api.service';
import type {
  OzonSupplyItem,
  OzonSupplyProcessResult,
  OzonSupplyTask,
} from '@bot/ozon/ozon-supply.types';
import { OzonSupplyService } from '@bot/ozon/ozon-supply.service';
import type { SupplyWizardSupplyItem } from './supply-wizard.store';
import { SupplyOrderStore } from '../storage/supply-order.store';
import type { SupplyOrderEntity } from '../storage/entities/supply-order.entity';
import { UserCredentialsStore } from './user-credentials.store';
import { AdminNotifierService } from './admin-notifier.service';
import { OzonApiService, OzonCredentials, OzonSupplyCreateStatus } from '@bot/config/ozon-api.service';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { Context, TelegramError } from 'telegraf';

interface SupplyOrderDetails {
  dropOffId?: number;
  dropOffName?: string;
  storageWarehouseId?: number;
  storageWarehouseName?: string;
  timeslotFrom?: string;
  timeslotTo?: string;
  timeslotLabel?: string;
}

@Injectable()
export class SupplyTaskRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupplyTaskRunnerService.name);

  constructor(
    private readonly orderStore: SupplyOrderStore,
    private readonly credentialsStore: UserCredentialsStore,
    private readonly supplyService: OzonSupplyService,
    private readonly adminNotifier: AdminNotifierService,
    private readonly ozonApi: OzonApiService,
    @InjectBot() private readonly bot: Telegraf<Context>,
  ) {}

  onApplicationBootstrap(): void {
    void this.resumePendingTasks();
  }

  private async resumePendingTasks(): Promise<void> {
    try {
      const pending = await this.orderStore.listTasks({ status: 'task' });
      if (!pending.length) {
        this.logger.debug('No supply tasks waiting for resume');
        return;
      }

      this.logger.log(`Resuming ${pending.length} pending supply task(s)`);
      for (const record of pending) {
        await this.resumeSingleTask(record);
      }
    } catch (error) {
      this.logger.error(`Failed to resume supply tasks: ${this.describeError(error)}`);
    }
  }

  private async resumeSingleTask(record: SupplyOrderEntity): Promise<void> {
    if (!record.taskPayload) {
      this.logger.warn(`Skip task ${record.taskId ?? record.id}: payload not found`);
      return;
    }
    if (!record.dropOffId) {
      this.logger.warn(`Skip task ${record.taskId ?? record.id}: drop-off warehouse is not stored`);
      return;
    }

    const credentials = await this.credentialsStore.get(record.chatId);
    if (!credentials) {
      this.logger.warn(`Skip task ${record.taskId ?? record.id}: credentials missing for chat ${record.chatId}`);
      return;
    }

    const clonedTask = this.cloneTask(record.taskPayload);
    const readyInDays = record.readyInDays ?? 0;

    try {
      await this.supplyService.runSingleTask(clonedTask, {
        credentials,
        readyInDays,
        dropOffWarehouseId: record.dropOffId,
        skipDropOffValidation: true,
        onEvent: async (result) => this.handleTaskEvent(record, result, credentials),
      });
    } catch (error) {
      this.logger.error(`Task ${record.taskId ?? record.id} resume failed: ${this.describeError(error)}`);
      await this.adminNotifier.notifyWizardEvent({
        event: 'task.resumeFailed',
        lines: [
          `task: ${record.taskId ?? record.id}`,
          `chat: ${record.chatId}`,
          this.describeError(error),
        ],
      });
    }
  }

  private async handleTaskEvent(
    record: SupplyOrderEntity,
    result: OzonSupplyProcessResult,
    credentials: OzonCredentials,
  ): Promise<void> {
    const taskLabel = record.taskId ?? record.id;
    switch (result.event) {
      case 'supplyCreated': {
        const operationId =
          result.operationId ??
          record.operationId ??
          `draft-${result.task.draftId ?? result.task.taskId ?? taskLabel}`;
        let orderId: number | undefined;
        let orderDetails: SupplyOrderDetails | undefined;

        if (operationId) {
          try {
            const status = await this.ozonApi.getSupplyCreateStatus(operationId, credentials);
            orderId = this.extractOrderIdsFromStatus(status)[0];
            if (orderId) {
              orderDetails = await this.fetchSupplyOrderDetails(orderId, credentials);
            }
          } catch (error) {
            this.logger.warn(
              `Failed to resolve order_id for ${operationId}: ${this.describeError(error)}`,
            );
          }
        }

        const dropOffName = orderDetails?.dropOffName ?? record.dropOffName;
        const dropOffId = orderDetails?.dropOffId ?? record.dropOffId;
        const warehouseId = orderDetails?.storageWarehouseId ?? result.task.warehouseId ?? record.warehouseId;
        const warehouseName = orderDetails?.storageWarehouseName ?? result.task.warehouseName ?? record.warehouseName;
        const warehouseDisplay = warehouseName ?? dropOffName ?? record.warehouse ?? record.dropOffName;
        const arrival = orderDetails?.timeslotLabel ?? record.arrival ?? this.describeTimeslot(result.task.selectedTimeslot);
        const timeslotFrom = orderDetails?.timeslotFrom ?? record.timeslotFrom ?? result.task.selectedTimeslot?.from_in_timezone;
        const timeslotTo = orderDetails?.timeslotTo ?? record.timeslotTo ?? result.task.selectedTimeslot?.to_in_timezone;

        const entity = await this.orderStore.completeTask(record.chatId, {
          taskId: taskLabel,
          operationId,
          orderId,
          arrival,
          warehouse: warehouseDisplay,
          warehouseName,
          warehouseId,
          dropOffName,
          dropOffId,
          timeslotFrom,
          timeslotTo,
          items: this.mapTaskItems(result.task.items),
          task: result.task,
        });

        await this.notifyUser(
          record.chatId,
          this.formatSupplyCreated(entity),
        );

        const notifyLines = [
          `task: ${taskLabel}`,
          `operation: ${operationId}`,
          orderId ? `order_id: ${orderId}` : undefined,
          `chat: ${record.chatId}`,
        ].filter((value): value is string => Boolean(value));

        await this.adminNotifier.notifyWizardEvent({
          event: 'task.resumedSupplyCreated',
          lines: notifyLines,
        });
        break;
      }
      case 'error':
        this.logger.error(
          `Task ${taskLabel} resume error: ${result.message ?? 'unknown error'}`,
        );
        await this.notifyUser(
          record.chatId,
          this.formatSupplyError(result.message),
        );
        break;
      default:
        this.logger.debug(`Task ${taskLabel} resume event: ${result.event}`);
    }
  }

  private mapTaskItems(items: OzonSupplyItem[]): SupplyWizardSupplyItem[] {
    return items.map((item) => ({
      article: item.article,
      quantity: item.quantity,
      sku: item.sku,
    }));
  }

  private describeTimeslot(slot?: OzonDraftTimeslot): string | undefined {
    if (!slot) {
      return undefined;
    }
    const from = slot.from_in_timezone;
    const to = slot.to_in_timezone;
    if (!from || !to) {
      return undefined;
    }
    return `${from} — ${to}`;
  }

  private cloneTask(task: OzonSupplyTask): OzonSupplyTask {
    return {
      ...task,
      items: task.items.map((item) => ({ ...item })),
      selectedTimeslot: task.selectedTimeslot ? { ...task.selectedTimeslot } : undefined,
    };
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    return String(error);
  }

  private async notifyUser(chatId: string, text?: string): Promise<void> {
    if (!text) {
      return;
    }
    const target = chatId?.toString().trim();
    if (!target.length) {
      return;
    }

    try {
      await this.bot.telegram.sendMessage(target, text, { parse_mode: 'HTML' });
    } catch (error) {
      if (error instanceof TelegramError && error.code === 403) {
        this.logger.warn(`User ${target} blocked the bot, message skipped`);
        return;
      }
      this.logger.warn(`Failed to notify user ${target}: ${this.describeError(error)}`);
    }
  }

  private formatSupplyCreated(entity: SupplyOrderEntity): string {
    const timeslotLabel = entity.arrival ?? this.formatTimeslotRange(entity.timeslotFrom, entity.timeslotTo);

    const lines = [
      '<b>Поставка создана ✅</b>',
      `ID: ${entity.orderId ?? entity.operationId ?? entity.taskId ?? '—'}`,
      timeslotLabel ? `Таймслот: ${timeslotLabel}` : undefined,
      entity.warehouse ? `Склад: ${entity.warehouse}` : undefined,
      entity.dropOffName ? `Пункт сдачи: ${entity.dropOffName}` : undefined,
    ].filter((value): value is string => Boolean(value));

    return lines.join('\n');
  }

  private formatSupplyError(message?: string): string {
    const lines = ['<b>❌ Ошибка при обработке поставки</b>'];
    if (message) {
      lines.push(message);
    }
    return lines.join('\n');
  }

  private extractOrderIdsFromStatus(status: OzonSupplyCreateStatus | undefined): number[] {
    if (!status) return [];

    const collected: Array<number | string> = [];
    const direct = (status as any)?.order_ids;
    if (Array.isArray(direct)) {
      collected.push(...direct);
    }
    const nested = status.result?.order_ids;
    if (Array.isArray(nested)) {
      collected.push(...nested);
    }

    return collected
      .map((value) => {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          return Math.trunc(value);
        }
        if (typeof value === 'string') {
          const parsed = Number(value.trim());
          return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
        }
        return undefined;
      })
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  }

  private async fetchSupplyOrderDetails(
    orderId: number,
    credentials: OzonCredentials,
  ): Promise<SupplyOrderDetails | undefined> {
    try {
      const orders = await this.ozonApi.getSupplyOrders([orderId], credentials);
      const order = orders?.[0];
      if (!order) {
        return undefined;
      }

      const dropOff = order.drop_off_warehouse;
      const supply = order.supplies?.[0];
      const storage = supply?.storage_warehouse;
      const timeslot = order.timeslot?.timeslot;
      const timezone = order.timeslot?.timezone_info?.iana_name;

      const timeslotFrom = timeslot?.from ?? undefined;
      const timeslotTo = timeslot?.to ?? undefined;

      return {
        dropOffId: this.parseWarehouseId(dropOff?.warehouse_id),
        dropOffName: dropOff?.name ?? dropOff?.address,
        storageWarehouseId: this.parseWarehouseId(storage?.warehouse_id),
        storageWarehouseName: storage?.name ?? storage?.address,
        timeslotFrom,
        timeslotTo,
        timeslotLabel: this.formatTimeslotRange(timeslotFrom, timeslotTo, timezone),
      };
    } catch (error) {
      this.logger.warn(`getSupplyOrders failed for ${orderId}: ${this.describeError(error)}`);
      return undefined;
    }
  }

  private formatTimeslotRange(fromIso?: string, toIso?: string, timezone?: string): string | undefined {
    if (!fromIso || !toIso) {
      return undefined;
    }

    try {
      const options: Intl.DateTimeFormatOptions = {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      };
      const formatter = new Intl.DateTimeFormat('ru-RU', timezone ? { ...options, timeZone: timezone } : options);
      const fromText = formatter.format(new Date(fromIso));
      const toText = formatter.format(new Date(toIso));
      return timezone ? `${fromText} — ${toText} (${timezone})` : `${fromText} — ${toText}`;
    } catch (error) {
      this.logger.debug(`formatTimeslotRange failed: ${this.describeError(error)}`);
      return `${fromIso} — ${toIso}`;
    }
  }

  private parseWarehouseId(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === 'string' && value.trim().length) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return Math.trunc(parsed);
      }
    }
    return undefined;
  }
}
