export interface AppConfig {
  nodeEnv: string;
  http: {
    port: number;
  };
  telegram: {
    token: string;
    webhookDomain?: string;
    webhookPath?: string;
  };
  ozon: {
    clientId: string;
    apiKey: string;
    apiBaseUrl: string;
  };
  ozonSupply: {
    spreadsheetId: string;
    dropOffPointWarehouseId: string;
    pollIntervalMs: number;
  };
}

export const configuration = (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  http: {
    port: Number(process.env.PORT ?? 3000),
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? '7962972662:AAHYfJa6oasRQULkWwgrbNcpZcp2_opT6NA',
    webhookDomain: process.env.WEBHOOK_DOMAIN,
    webhookPath: process.env.WEBHOOK_PATH,
  },
  ozon: {
    clientId: process.env.OZON_CLIENT_ID ?? '',
    apiKey: process.env.OZON_API_KEY ?? '',
    apiBaseUrl: process.env.OZON_API_BASE_URL ?? 'https://api-seller.ozon.ru',
  },
  ozonSupply: {
    spreadsheetId: process.env.OZON_SUPPLY_SPREADSHEET_ID ?? '',
    dropOffPointWarehouseId: process.env.OZON_SUPPLY_DROP_OFF_ID ?? '',
    pollIntervalMs: Number(process.env.OZON_SUPPLY_POLL_INTERVAL_MS ?? 10000),
  },
});
