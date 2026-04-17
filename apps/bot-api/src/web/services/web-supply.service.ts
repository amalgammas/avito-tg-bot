import { Injectable, NotFoundException } from '@nestjs/common';

import { SupplyOrderEntity } from '../../storage/entities/supply-order.entity';
import { SupplyOrderStore } from '../../storage/supply-order.store';
import { WizardFlowService } from '../../bot/services/wizard-flow.service';
import { SupplyProcessService } from '../../bot/services/supply-process.service';
import { SupplyTaskAbortService } from '../../bot/services/supply-task-abort.service';
import { UserCredentialsStore } from '../../bot/user-credentials.store';
import type { WebSessionUser } from '../common/web-auth.types';

@Injectable()
export class WebSupplyService {
  private readonly cancelStatusMaxAttempts = 10;
  private readonly cancelStatusPollDelayMs = 1_000;

  constructor(
    private readonly orderStore: SupplyOrderStore,
    private readonly credentialsStore: UserCredentialsStore,
    private readonly wizardFlow: WizardFlowService,
    private readonly process: SupplyProcessService,
    private readonly abortService: SupplyTaskAbortService,
  ) {}

  async list(user: WebSessionUser, status?: string) {
    const actorId = this.toActorId(user);
    const tasks = await this.orderStore.listTasks({ chatId: actorId });
    return tasks
      .map((item) => this.toResponse(item))
      .filter((item) => !status || item.groupStatus === status);
  }

  async get(user: WebSessionUser, id: string) {
    const actorId = this.toActorId(user);
    const entity = await this.orderStore.findByAnyIdentifier(actorId, id);
    if (!entity) {
      throw new NotFoundException('Задача не найдена.');
    }
    return this.toResponse(entity, true);
  }

  async cancel(user: WebSessionUser, id: string) {
    const actorId = this.toActorId(user);
    const entity = await this.orderStore.findByAnyIdentifier(actorId, id);
    if (!entity) {
      throw new NotFoundException('Задача не найдена.');
    }

    if (entity.status === 'task' && entity.taskId) {
      this.abortService.abort(actorId, entity.taskId);
      await this.orderStore.deleteByTaskId(actorId, entity.taskId);
      return { cancelled: true, mode: 'task' as const };
    }

    if (entity.status !== 'supply' || !entity.orderId) {
      throw new NotFoundException('Эту запись нельзя отменить через web API.');
    }

    const credentials = await this.credentialsStore.get(actorId);
    if (!credentials) {
      throw new NotFoundException('Сначала подключите Ozon ключи.');
    }

    const cancelOperationId = await this.wizardFlow.cancelSupplyOrder(entity.orderId, credentials);
    if (!cancelOperationId) {
      throw new NotFoundException('Ozon не вернул operation_id отмены.');
    }

    const cancelStatus = await this.process.waitForCancelStatus(cancelOperationId, credentials, {
      maxAttempts: this.cancelStatusMaxAttempts,
      delayMs: this.cancelStatusPollDelayMs,
    });

    if (!this.process.isCancelSuccessful(cancelStatus)) {
      throw new NotFoundException(`Не удалось подтвердить отмену. ${this.process.describeCancelStatus(cancelStatus)}`);
    }

    if (entity.operationId) {
      await this.orderStore.deleteByOperationId(actorId, entity.operationId);
      await this.orderStore.deleteById(actorId, entity.operationId);
    } else {
      await this.orderStore.deleteById(actorId, entity.id);
    }

    return { cancelled: true, mode: 'supply' as const };
  }

  private toActorId(user: WebSessionUser): string {
    return `web:${user.id}`;
  }

  private toResponse(entity: SupplyOrderEntity, includePayload = false) {
    const groupStatus =
      entity.status === 'task'
        ? 'in_progress'
        : entity.status === 'supply'
          ? 'completed'
          : 'failed';

    return {
      id: entity.orderId ? String(entity.orderId) : entity.operationId ?? entity.taskId ?? entity.id,
      status: entity.status,
      groupStatus,
      orderId: entity.orderId ?? null,
      taskId: entity.taskId ?? null,
      operationId: entity.operationId ?? null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt ?? null,
      completedAt: entity.completedAt ?? null,
      failedAt: entity.failedAt ?? null,
      warehouse: entity.warehouse ?? entity.warehouseName ?? null,
      clusterName: entity.clusterName ?? null,
      dropOffName: entity.dropOffName ?? null,
      arrival: entity.arrival ?? null,
      readyInDays: entity.readyInDays ?? null,
      failureReason: entity.failureReason ?? null,
      lastErrorCode: entity.lastErrorCode ?? null,
      lastErrorMessage: entity.lastErrorMessage ?? null,
      items: entity.items ?? [],
      taskPayload: includePayload ? entity.taskPayload ?? null : undefined,
    };
  }
}
