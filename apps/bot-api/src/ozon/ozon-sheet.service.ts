import axios from 'axios';
import * as XLSX from 'xlsx';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  OzonSupplyItem,
  OzonSupplySheetItemRow,
  OzonSupplySheetSkuRow,
  OzonSupplySheetTaskRow,
  OzonSupplyTask,
} from './ozon-supply.types';

@Injectable()
export class OzonSheetService {
  private readonly logger = new Logger(OzonSheetService.name);
  private readonly spreadsheetId: string;

  constructor(private readonly configService: ConfigService) {
    this.spreadsheetId = this.configService.get<string>('ozonSupply.spreadsheetId') ?? '';
  }

  async loadTasks(spreadsheet?: string): Promise<OzonSupplyTask[]> {
    const identifier = (spreadsheet ?? this.spreadsheetId).trim();
    if (!identifier) {
      throw new Error('Spreadsheet id or url is not configured');
    }

    const workbook = await this.downloadWorkbook(identifier);
    const skuSheet = workbook.Sheets['sku'];
    const searchSheet = workbook.Sheets['поиск'];

    if (!skuSheet || !searchSheet) {
      throw new Error('Spreadsheet must contain sheets "sku" and "поиск"');
    }

    const skuRows = XLSX.utils.sheet_to_json<OzonSupplySheetSkuRow>(skuSheet, {
      defval: '',
    });
    const searchRows = XLSX.utils.sheet_to_json<OzonSupplySheetTaskRow>(searchSheet, {
      defval: '',
    });

    const skuMap = new Map<string, number>();
    for (const row of skuRows) {
      const article = String(row['Артикул']).trim();
      const sku = Number(row['sku']);
      if (!article || Number.isNaN(sku)) {
        continue;
      }
      skuMap.set(article, sku);
    }

    const tasks: OzonSupplyTask[] = [];

    for (const row of searchRows) {
      const taskIdRaw = row.task_id;
      const taskId = String(taskIdRaw ?? '').trim();
      if (!taskId) {
        continue;
      }

      const sheetName = row.task_id;
      const taskSheet = workbook.Sheets[sheetName];
      if (!taskSheet) {
        this.logger.warn(`Sheet for task ${taskId} not found`);
        continue;
      }

      const items = this.mapItems(taskSheet, skuMap);

      tasks.push({
        taskId,
        city: String(row.city ?? '').trim(),
        warehouseName: String(row.warehouse_name ?? '').trim(),
        lastDay: String(row.lastday ?? '').trim(),
        draftId: Number(row.draft_id ?? 0) || 0,
        draftOperationId: String(row.draft_operation_id ?? '').trim(),
        orderFlag: Number(row.order_flag ?? 0) || 0,
        items,
      });
    }

    return tasks;
  }

  private async downloadWorkbook(identifier: string): Promise<XLSX.WorkBook> {
    const url = this.resolveSpreadsheetUrl(identifier);
    this.logger.debug(`Downloading spreadsheet from ${url}`);
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
    });

    const data = Buffer.from(response.data);
    return XLSX.read(data, { type: 'buffer' });
  }

  private resolveSpreadsheetUrl(identifier: string): string {
    const trimmed = identifier.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
      if (match?.[1]) {
        return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=xlsx`;
      }
      // если это уже ссылка на export — используем как есть
      if (/export\?format=xlsx/i.test(trimmed)) {
        return trimmed;
      }
      return trimmed.includes('?')
        ? `${trimmed}&format=xlsx`
        : `${trimmed}?format=xlsx`;
    }

    return `https://docs.google.com/spreadsheets/d/${trimmed}/export?format=xlsx`;
  }

  private mapItems(sheet: XLSX.WorkSheet, skuMap: Map<string, number>): OzonSupplyItem[] {
    const rows = XLSX.utils.sheet_to_json<OzonSupplySheetItemRow>(sheet, { defval: '' });
    const items: OzonSupplyItem[] = [];
    const missingSkus: string[] = [];

    for (const row of rows) {
      const article = String(row['Артикул']).trim();
      if (!article) continue;

      const quantity = Number(row['Количество']);
      if (!quantity || Number.isNaN(quantity)) {
        continue;
      }

      const sku = skuMap.get(article);
      if (sku === undefined) {
        missingSkus.push(article);
        continue;
      }

      items.push({ sku, quantity });
    }

    if (missingSkus.length) {
      throw new Error(`Не найдены SKU для артикулов: ${missingSkus.join(', ')}`);
    }

    return items;
  }
}
