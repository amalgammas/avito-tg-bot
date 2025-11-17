import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import type { OzonSupplyProcessResult, OzonSupplyTask } from '@bot/ozon/ozon-supply.types';
import { OzonSupplyEventType } from '@bot/ozon/ozon-supply.types';
import { OzonSupplyService } from '@bot/ozon/ozon-supply.service';
import { SupplyOrderStore } from '../storage/supply-order.store';
import type { SupplyOrderEntity } from '../storage/entities/supply-order.entity';
import { UserCredentialsStore } from './user-credentials.store';
import { NotificationService } from './services/notification.service';
import { WizardEvent } from './services/wizard-event.types';
import { OzonCredentials } from '@bot/config/ozon-api.service';
import { SupplyProcessService, SupplyOrderDetails } from './services/supply-process.service';
import { SupplyTaskAbortService } from './services/supply-task-abort.service';

@Injectable()
export class SupplyTaskRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupplyTaskRunnerService.name);
  private readonly summaryIntervalMs = 5 * 60 * 1000;
  private summaryTimer?: NodeJS.Timeout;
  private summaryRunning = false;
  private readonly orderIdPollAttempts = 5;
  private readonly orderIdPollDelayMs = 1_000;

  constructor(
    private readonly orderStore: SupplyOrderStore,
    private readonly credentialsStore: UserCredentialsStore,
    private readonly supplyService: OzonSupplyService,
    private readonly notifications: NotificationService,
    private readonly process: SupplyProcessService,
    private readonly taskAbortService: SupplyTaskAbortService,
  ) {}

  onApplicationBootstrap(): void {
    void this.resumePendingTasks();
    this.startSummaryLoop();
  }

  private async resumePendingTasks(): Promise<void> {
    try {
      const pending = await this.orderStore.listTasks({ status: 'task' });
      if (!pending.length) {
        this.logger.debug('No supply tasks waiting for resume');
        return;
      }

      this.logger.log(`Resuming ${pending.length} pending supply task(s)`);
      await Promise.all(pending.map((record) => this.resumeSingleTask(record)));
    } catch (error) {
      this.logger.error(`Failed to resume supply tasks: ${this.describeError(error)}`);
    }
  }

  private startSummaryLoop(): void {
    const handler = async () => {
      if (this.summaryRunning) return;
      this.summaryRunning = true;
      try {
        await this.publishTasksSummary();
      } catch (error) {
        this.logger.warn(`Failed to publish tasks summary: ${this.describeError(error)}`);
      } finally {
        this.summaryRunning = false;
      }
    };

    void handler();
    this.summaryTimer = setInterval(handler, this.summaryIntervalMs);
  }

  private async publishTasksSummary(): Promise<void> {
    const tasks = await this.orderStore.listTasks({ status: 'task' });
    const lines: string[] = [];

    if (!tasks.length) {
      lines.push('Активных задач нет.');
    } else {
      lines.push(`Всего активных задач: ${tasks.length}`);
      const limit = 20;
      const sample = tasks.slice(0, limit);
      sample.forEach((task, index) => {
        const parts: string[] = [];
        parts.push(`#${index + 1}`);
        parts.push(`chat: ${task.chatId}`);
        const taskLabel = this.formatTaskName(task.taskId ?? task.id);
        if (taskLabel) parts.push(`task: ${taskLabel}`);
        if (task.dropOffName) parts.push(`drop-off: ${task.dropOffName}`);
        if (task.clusterName) parts.push(`cluster: ${task.clusterName}`);
        if (task.warehouseName) parts.push(`склад: ${task.warehouseName}`);
        if (task.readyInDays !== undefined) parts.push(`готовность ${task.readyInDays}д`);
        lines.push(parts.join('\n • '));
      });
      if (tasks.length > sample.length) {
        lines.push(`… и ещё ${tasks.length - sample.length} задач`);
      }
    }

    await this.notifications.notifyWizard(WizardEvent.TaskSummary, { lines });
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

    const taskKey = record.taskId ?? record.id ?? `task-${record.chatId}-${Date.now()}`;
    const abortController = new AbortController();
    this.taskAbortService.register(record.chatId, taskKey, abortController);

    try {
      await this.supplyService.runSingleTask(clonedTask, {
        credentials,
        readyInDays,
        dropOffWarehouseId: record.dropOffId,
        skipDropOffValidation: true,
        abortSignal: abortController.signal,
        onEvent: async (result) => this.handleTaskEvent(record, result, credentials),
      });
    } catch (error) {
      if (this.isAbortError(error)) {
        this.logger.warn(`Task ${taskKey} aborted`);
      } else {
        this.logger.error(`Task ${record.taskId ?? record.id} resume failed: ${this.describeError(error)}`);
        await this.notifications.notifyWizard(WizardEvent.TaskResumeFailed, {
          lines: [
            `task: ${record.taskId ?? record.id}`,
            `chat: ${record.chatId}`,
            this.describeError(error),
          ],
        });
      }
    } finally {
      this.taskAbortService.clear(taskKey);
    }
  }

  private async handleTaskEvent(
    record: SupplyOrderEntity,
    result: OzonSupplyProcessResult,
    credentials: OzonCredentials,
  ): Promise<void> {
    const taskLabel = record.taskId ?? record.id;
    const eventType = result.event?.type ?? OzonSupplyEventType.Error;

    switch (eventType) {
      case OzonSupplyEventType.SupplyCreated: {
        const operationId =
          result.operationId ??
          record.operationId ??
          `draft-${result.task.draftId ?? result.task.taskId ?? taskLabel}`;
        let orderId: number | undefined;
        let orderDetails: SupplyOrderDetails | undefined;

        if (operationId) {
          orderId = await this.process.fetchOrderIdWithRetries(operationId, credentials, {
            attempts: this.orderIdPollAttempts,
            delayMs: this.orderIdPollDelayMs,
          });
          if (orderId) {
            orderDetails = await this.process.fetchSupplyOrderDetails(orderId, credentials);
          } else {
            this.logger.warn(`Failed to resolve order_id for ${operationId}: order id not returned`);
          }
        }

        const dropOffName = orderDetails?.dropOffName ?? record.dropOffName;
        const dropOffId = orderDetails?.dropOffId ?? record.dropOffId;
        const warehouseId = orderDetails?.storageWarehouseId ?? result.task.warehouseId ?? record.warehouseId;
        const warehouseName = orderDetails?.storageWarehouseName ?? result.task.warehouseName ?? record.warehouseName;
        const warehouseDisplay = warehouseName ?? dropOffName ?? record.warehouse ?? record.dropOffName;
        const arrival =
          orderDetails?.timeslotLabel ??
          record.arrival ??
          this.process.describeTimeslot(result.task.selectedTimeslot);
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
          items: this.process.mapTaskItems(result.task.items),
          task: result.task,
        });

        await this.notifications.notifyUser(record.chatId, this.formatSupplyCreated(entity), { parseMode: 'HTML' });

        const notifyLines = [
          `task: ${taskLabel}`,
          `operation: ${operationId}`,
          orderId ? `order_id: ${orderId}` : undefined,
          `chat: ${record.chatId}`,
        ].filter((value): value is string => Boolean(value));

        await this.notifications.notifyWizard(WizardEvent.TaskResumedSupplyCreated, { lines: notifyLines });
        break;
      }
      case OzonSupplyEventType.Error:
        this.logger.error(
          `Task ${taskLabel} resume error: ${result.message ?? 'unknown error'}`,
        );
        await this.notifications.notifyWizard(WizardEvent.SupplyError, {
          lines: [
            `task: ${taskLabel}`,
            `chat: ${record.chatId}`,
            result.message ?? 'unknown error',
          ],
        });
        break;
      default:
        this.logger.debug(`Task ${taskLabel} resume event: ${eventType}`);
    }
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

    private formatTaskName(name: string | undefined): string | undefined {
        if (name) {
            const names = name.split('-');
            return names[1];
        }
    }

  private formatSupplyCreated(entity: SupplyOrderEntity): string {
    const timeslotLabel =
      entity.arrival ?? this.process.formatTimeslotRange(entity.timeslotFrom, entity.timeslotTo);

    const lines = [
      '<b>Поставка создана ✅</b>',
      `ID: ${entity.orderId ?? entity.operationId ?? entity.taskId ?? '—'}`,
      timeslotLabel ? `Таймслот: ${timeslotLabel}` : undefined,
      entity.warehouse ? `Склад: ${entity.warehouse}` : undefined,
      entity.dropOffName ? `Пункт сдачи: ${entity.dropOffName}` : undefined,
    ].filter((value): value is string => Boolean(value));

    return lines.join('\n');
  }


  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }
}
