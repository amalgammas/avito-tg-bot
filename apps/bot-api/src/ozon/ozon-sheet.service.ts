import axios from 'axios';
import * as XLSX from 'xlsx';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OzonSupplyItem, OzonSupplyTask } from './ozon-supply.types';

@Injectable()
export class OzonSheetService {
  private readonly logger = new Logger(OzonSheetService.name);
  private readonly spreadsheetId: string;

  constructor(private readonly configService: ConfigService) {
    this.spreadsheetId = this.configService.get<string>('ozonSupply.spreadsheetId') ?? '';
  }

  async loadTasks(input: { spreadsheet?: string; buffer?: Buffer } = {}): Promise<OzonSupplyTask[]> {
    let workbook: XLSX.WorkBook;
    if (input.buffer) {
      workbook = this.readWorkbookFromBuffer(input.buffer);
    } else {
      const identifier = (input.spreadsheet ?? this.spreadsheetId).trim();
      if (!identifier) {
        throw new Error('Spreadsheet id or url is not configured');
      }
      workbook = await this.downloadWorkbook(identifier);
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error('Файл не содержит листов');
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
    });

    const items: OzonSupplyItem[] = [];
    const missingSku: string[] = [];

    for (const row of rows) {
      const articleRaw = this.pickColumn(row, ['артикул', 'sku', 'код', 'product', 'товар']);
      const quantityRaw = this.pickColumn(row, ['количество', 'quantity', 'qty', 'amount']);

      const article = this.normalizeArticle(articleRaw);
      const quantity = this.parseQuantity(quantityRaw);

      if (!article) {
        if (articleRaw !== undefined && articleRaw !== null && articleRaw !== '') {
          missingSku.push(String(articleRaw).trim());
        }
        continue;
      }

      if (quantity === undefined || quantity <= 0) {
        continue;
      }

      items.push({ article, quantity });
    }

    if (!items.length) {
      throw new Error('Не удалось найти строки с колонками «Артикул» и «Количество».');
    }

    if (missingSku.length) {
      this.logger.warn(`Пропущены строки без корректного артикула: ${missingSku.slice(0, 5).join(', ')}`);
    }

    const task: OzonSupplyTask = {
      taskId: `sheet-${Date.now()}`,
      city: '',
      warehouseName: '',
      lastDay: '',
      supplyType: 'CREATE_TYPE_CROSSDOCK',
      draftId: 0,
      draftOperationId: '',
      orderFlag: 0,
      items,
    };

    return [task];
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

  private readWorkbookFromBuffer(buffer: Buffer): XLSX.WorkBook {
    return XLSX.read(buffer, { type: 'buffer' });
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

  private pickColumn(row: Record<string, unknown>, aliases: string[]): unknown {
    if (!row) return undefined;
    const normalizedAliases = aliases.map((alias) => alias.trim().toLowerCase());
    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = key.trim().toLowerCase();
      if (normalizedAliases.includes(normalizedKey)) {
        return typeof value === 'string' ? value.trim() : value;
      }
    }
    return undefined;
  }

  private normalizeArticle(value: unknown): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    const text = String(value).trim();
    return text ? text : undefined;
  }

  private parseQuantity(value: unknown): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.round(value) : undefined;
    }

    const normalized = String(value)
      .trim()
      .replace(/\s+/g, '')
      .replace(',', '.');
    if (!normalized) {
      return undefined;
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
  }

}
