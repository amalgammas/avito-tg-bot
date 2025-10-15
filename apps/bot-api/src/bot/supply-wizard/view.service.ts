import { Injectable } from '@nestjs/common';
import { Context } from 'telegraf';

import {
  SupplyWizardClusterOption,
  SupplyWizardDraftWarehouseOption,
  SupplyWizardDropOffOption,
  SupplyWizardState,
  SupplyWizardTimeslotOption,
  SupplyWizardWarehouseOption,
  SupplyWizardStore,
} from '../supply-wizard.store';

@Injectable()
export class SupplyWizardViewService {
  private readonly draftWarehouseOptionsLimit = 10;
  private readonly timeslotOptionsLimit = 10;

  constructor(private readonly wizardStore: SupplyWizardStore) {}

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
    return this.withCancel(rows);
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

  buildClusterKeyboard(state: SupplyWizardState): Array<Array<{ text: string; callback_data: string }>> {
    const rows = state.clusters.map((cluster) => [
      {
        text: `${cluster.name}`,
        callback_data: `wizard:cluster:${cluster.id}`,
      },
    ]);
    return this.withCancel(rows);
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
    return [...rows, [{ text: 'Отмена', callback_data: 'wizard:cancel' }]];
  }

  async updatePrompt(
    ctx: Context,
    chatId: string,
    state: SupplyWizardState,
    text: string,
    keyboard?: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<void> {
    const rawChatId = (ctx.callbackQuery as any)?.message?.chat?.id ?? chatId;
    const messageId = state.promptMessageId;
    const replyMarkup = keyboard ? { inline_keyboard: keyboard } : undefined;

    if (messageId) {
      try {
        await ctx.telegram.editMessageText(rawChatId, messageId, undefined, text, {
          reply_markup: replyMarkup,
        });
        return;
      } catch (error) {
        // fallback to sending new message below
      }
    }

    const sent = await ctx.reply(text, { reply_markup: replyMarkup as any });
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

  formatItemsSummary(task: { items: Array<{ article: string; sku?: number; quantity: number }> }): string {
    const lines = task.items.map((item) => `• ${item.article} → SKU ${item.sku} × ${item.quantity}`);

    return [
      'Товары из файла:',
      ...lines,
      '',
      'Введите ниже город, адрес или название пункта сдачи, чтобы найти место отгрузки.',
    ].join('\n');
  }

  formatSupplyEvent(result: { taskId: string; event: string; message?: string }): string | undefined {
    const prefix = `[${result.taskId}]`;
    switch (result.event) {
      case 'draftCreated':
        return `${prefix} Черновик создан. ${result.message ?? ''}`.trim();
      case 'draftValid':
        return `${prefix} Используем существующий черновик. ${result.message ?? ''}`.trim();
      case 'draftExpired':
        return `${prefix} Черновик устарел, создаём заново.`;
      case 'draftInvalid':
        return `${prefix} Черновик невалидный, пересоздаём.`;
      case 'draftError':
        return `${prefix} Ошибка статуса черновика.${result.message ? ` ${result.message}` : ''}`;
      case 'timeslotMissing':
        return `${prefix} Свободных таймслотов нет.`;
      case 'supplyCreated':
        return `${prefix} ✅ Поставка создана. ${result.message ?? ''}`.trim();
      case 'supplyStatus':
        return `${prefix} ${result.message ?? 'Статус поставки обновлён.'}`.trim();
      case 'noCredentials':
      case 'error':
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
      if (!entry || typeof entry.warehouse_id !== 'number') continue;
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

  private formatDropOffButtonLabel(option: SupplyWizardDropOffOption): string {
    const base = option.name ?? `Пункт ${option.warehouse_id}`;
    return this.truncate(`${base}`, 60);
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
