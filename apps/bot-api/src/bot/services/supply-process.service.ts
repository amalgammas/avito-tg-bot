import { Injectable, Logger } from '@nestjs/common';

import type {
  OzonCredentials,
  OzonDraftTimeslot,
  OzonSupplyCancelStatus,
  OzonSupplyCreateStatus,
  OzonSupplyOrder,
} from '@bot/config/ozon-api.service';
import type { OzonSupplyItem, OzonSupplyTask } from '@bot/ozon/ozon-supply.types';
import {
  addMoscowDays,
  describeTimeslot as describeTimeslotText,
  formatTimeslotRange as formatTimeslotRangeText,
  toOzonIso,
} from '@bot/utils/time.utils';

import type { SupplyWizardSupplyItem } from '../supply-wizard.store';
import { WizardFlowService } from './wizard-flow.service';

export interface SupplyOrderDetails {
  dropOffId?: number;
  dropOffName?: string;
  dropOffAddress?: string;
  storageWarehouseId?: number;
  storageWarehouseName?: string;
  storageWarehouseAddress?: string;
  timeslotFrom?: string;
  timeslotTo?: string;
  timeslotLabel?: string;
}

export interface TimeslotWindowOptions {
  fromDays: number;
  toDays: number;
  now?: Date;
}

export interface RetryOptions {
  attempts: number;
  delayMs: number;
}

export interface CancelPollOptions {
  maxAttempts: number;
  delayMs: number;
}

@Injectable()
export class SupplyProcessService {
  private readonly logger = new Logger(SupplyProcessService.name);

  constructor(private readonly flow: WizardFlowService) {}

  buildDraftItems(task: OzonSupplyTask): Array<{ sku: number; quantity: number }> {
    const items: Array<{ sku: number; quantity: number }> = [];
    for (const item of task.items) {
      if (!item.sku) {
        throw new Error(`Для артикула «${item.article}» не найден SKU.`);
      }
      if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
        throw new Error(`Количество должно быть положительным числом (артикул ${item.article}).`);
      }
      items.push({ sku: Math.round(item.sku), quantity: Math.round(item.quantity) });
    }
    return items;
  }

  mapTaskItems(items: OzonSupplyItem[]): SupplyWizardSupplyItem[] {
    return items.map((item) => ({
      article: item.article,
      quantity: item.quantity,
      sku: item.sku,
    }));
  }

  async resolveSkus(task: OzonSupplyTask, credentials: OzonCredentials): Promise<void> {
    const unresolvedOffers: string[] = [];

    for (const item of task.items) {
      const article = item.article?.trim();
      if (!article) {
        throw new Error('Есть строки с пустым артикулом. Исправьте файл и загрузите заново.');
      }

      const numericCandidate = Number(article);
      if (Number.isFinite(numericCandidate) && numericCandidate > 0) {
        item.sku = Math.round(numericCandidate);
        continue;
      }

      unresolvedOffers.push(article);
    }

    if (!unresolvedOffers.length) {
      return;
    }

    const skuMap = await this.flow.getProductsByOfferIds(unresolvedOffers, credentials);
    const missing: string[] = [];

    for (const article of unresolvedOffers) {
      const sku = skuMap.get(article);
      if (!sku) {
        missing.push(article);
        continue;
      }

      const target = task.items.find((entry) => entry.article.trim() === article);
      if (target) {
        target.sku = sku;
      }
    }

    if (!missing.length) {
      return;
    }

    const limit = 20;
    const sample = missing.slice(0, limit);
    const suffix = missing.length > limit ? `, и ещё ${missing.length - limit} артикулов` : '';
    throw new Error(`Не удалось найти SKU в Ozon для артикулов: ${sample.join(', ')}${suffix}`);
  }

  computeTimeslotWindow(options: TimeslotWindowOptions): { fromIso: string; toIso: string } {
    const { fromDays, toDays, now = new Date() } = options;
    const start = addMoscowDays(now, fromDays);
    const end = addMoscowDays(now, toDays);
    return {
      fromIso: toOzonIso(start),
      toIso: toOzonIso(end),
    };
  }

  describeTimeslot(slot?: OzonDraftTimeslot): string | undefined {
    return describeTimeslotText({
      from: slot?.from_in_timezone,
      to: slot?.to_in_timezone,
    });
  }

  formatTimeslotRange(fromIso?: string, toIso?: string, timezone?: string): string | undefined {
    return formatTimeslotRangeText(fromIso, toIso, timezone);
  }

  extractOrderIdsFromStatus(status: OzonSupplyCreateStatus | undefined): number[] {
    if (!status) {
      return [];
    }

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
      })
      .filter((value): value is number => typeof value === 'number');
  }

  async fetchOrderIdWithRetries(
    operationId: string,
    credentials: OzonCredentials,
    options: RetryOptions,
  ): Promise<number | undefined> {
    const attempts = Math.max(1, options.attempts);
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const status = await this.flow.getSupplyCreateStatus(operationId, credentials);
        const orderId = this.extractOrderIdsFromStatus(status)[0];
        if (orderId) {
          return orderId;
        }
      } catch (error) {
        this.logger.warn(
          `Не удалось получить order_id для ${operationId} (попытка ${attempt + 1}/${attempts}): ${String(error)}`,
        );
      }

      if (attempt < attempts - 1) {
        await this.sleep(options.delayMs);
      }
    }

    return undefined;
  }

  async waitForCancelStatus(
    operationId: string,
    credentials: OzonCredentials,
    options: CancelPollOptions,
  ): Promise<OzonSupplyCancelStatus | undefined> {
    let lastStatus: OzonSupplyCancelStatus | undefined;

    for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
      try {
        lastStatus = await this.flow.getSupplyCancelStatus(operationId, credentials);
      } catch (error) {
        this.logger.warn(
          `cancel status ${operationId} attempt ${attempt + 1}/${options.maxAttempts} failed: ${String(error)}`,
        );
      }

      if (this.isCancelSuccessful(lastStatus)) {
        return lastStatus;
      }

      if (attempt < options.maxAttempts - 1) {
        await this.sleep(options.delayMs);
      }
    }

    return lastStatus;
  }

  isCancelSuccessful(status?: OzonSupplyCancelStatus): boolean {
    if (!status) {
      return false;
    }

    if ((status.status ?? '').toUpperCase() === 'SUCCESS') {
      return true;
    }

    if (status.result?.is_order_cancelled) {
      return true;
    }

    return (status.result?.supplies ?? []).some((item) => item?.is_supply_cancelled);
  }

  describeCancelStatus(status?: OzonSupplyCancelStatus): string {
    if (!status) {
      return 'Ответ сервиса пустой';
    }

    const parts: string[] = [];

    if (status.status) {
      parts.push(`status=${status.status}`);
    }

    if (typeof status.result?.is_order_cancelled === 'boolean') {
      parts.push(`is_order_cancelled=${status.result.is_order_cancelled ? 'true' : 'false'}`);
    }

    const supplies = status.result?.supplies ?? [];
    if (supplies.length) {
      const supplyParts = supplies.map((entry) => {
        const supplyId = entry?.supply_id ?? 'n/a';
        const state = entry?.is_supply_cancelled ? 'cancelled' : 'active';
        const errors = (entry?.error_reasons ?? [])
          .map((reason) => `${reason?.code ?? 'n/a'}:${reason?.message ?? '—'}`)
          .join(',');
        return errors ? `${supplyId}:${state}(${errors})` : `${supplyId}:${state}`;
      });
      parts.push(`supplies=${supplyParts.join(';')}`);
    }

    if (status.error_reasons?.length) {
      const errors = status.error_reasons
        .map((reason) => `${reason?.code ?? 'n/a'}:${reason?.message ?? '—'}`)
        .join(', ');
      parts.push(`errors=${errors}`);
    }

    return parts.length ? parts.join(', ') : 'Ответ без подробностей';
  }

  async fetchSupplyOrderDetails(
    orderId: number,
    credentials: OzonCredentials,
  ): Promise<SupplyOrderDetails | undefined> {
    try {
      const orders = await this.flow.getSupplyOrders([orderId], credentials);
      const order = orders?.[0];
      if (!order) {
        return undefined;
      }

      return this.mapOrderDetails(order);
    } catch (error) {
      this.logger.warn(`getSupplyOrders failed for ${orderId}: ${String(error)}`);
      return undefined;
    }
  }

  private mapOrderDetails(order: OzonSupplyOrder): SupplyOrderDetails {
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
      dropOffAddress: dropOff?.address,
      storageWarehouseId: this.parseWarehouseId(storage?.warehouse_id),
      storageWarehouseName: storage?.name ?? storage?.address,
      storageWarehouseAddress: storage?.address,
      timeslotFrom,
      timeslotTo,
      timeslotLabel: this.formatTimeslotRange(timeslotFrom, timeslotTo, timezone),
    };
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

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
