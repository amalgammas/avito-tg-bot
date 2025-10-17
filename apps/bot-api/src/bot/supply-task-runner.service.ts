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

@Injectable()
export class SupplyTaskRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupplyTaskRunnerService.name);

  constructor(
    private readonly orderStore: SupplyOrderStore,
    private readonly credentialsStore: UserCredentialsStore,
    private readonly supplyService: OzonSupplyService,
    private readonly adminNotifier: AdminNotifierService,
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
        onEvent: async (result) => this.handleTaskEvent(record, result),
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
  ): Promise<void> {
    const taskLabel = record.taskId ?? record.id;
    switch (result.event) {
      case 'supplyCreated': {
        const operationId =
          result.operationId ??
          record.operationId ??
          `draft-${result.task.draftId ?? result.task.taskId ?? taskLabel}`;
        const arrival = record.arrival ?? this.describeTimeslot(result.task.selectedTimeslot);
        const warehouse = record.warehouse ?? record.warehouseName ?? record.dropOffName;

        await this.orderStore.completeTask(record.chatId, {
          taskId: taskLabel,
          operationId,
          arrival,
          warehouse,
          dropOffName: record.dropOffName,
          items: this.mapTaskItems(result.task.items),
          task: result.task,
        });

        await this.adminNotifier.notifyWizardEvent({
          event: 'task.resumedSupplyCreated',
          lines: [
            `task: ${taskLabel}`,
            `operation: ${operationId}`,
            `chat: ${record.chatId}`,
          ],
        });
        break;
      }
      case 'error':
        this.logger.error(
          `Task ${taskLabel} resume error: ${result.message ?? 'unknown error'}`,
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
}
