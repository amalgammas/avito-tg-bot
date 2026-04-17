export interface AppConfig {
  nodeEnv: string;

  http: {
    port: number;
    webOrigin?: string;
  };

  web: {
    appUrl: string;
    sessionCookieName: string;
    sessionTtlDays: number;
    magicLinkTtlMinutes: number;
  };

  telegram: {
    token: string;
    webhookDomain?: string;
    webhookPath?: string;
    adminIds: string[];
    botAdminId?: string;
    useWebhook?: boolean;
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

  database: {
    path: string;
    logging: boolean;
  };

  email: {
    resendApiKey?: string;
    from: string;
  };
}

export const configuration = (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  http: {
    port: Number(process.env.PORT ?? 3000),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:4200',
  },
  web: {
    appUrl: process.env.WEB_APP_URL ?? 'http://localhost:4200',
    sessionCookieName: process.env.WEB_SESSION_COOKIE ?? 'ozon_web_session',
    sessionTtlDays: Number(process.env.WEB_SESSION_TTL_DAYS ?? 30),
    magicLinkTtlMinutes: Number(process.env.WEB_MAGIC_LINK_TTL_MINUTES ?? 20),
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? '',
    webhookDomain: process.env.WEBHOOK_DOMAIN,
    webhookPath: process.env.WEBHOOK_PATH,
    adminIds: (process.env.TELEGRAM_ADMIN_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    botAdminId: process.env.TELEGRAM_BOT_ADMIN ?? undefined,
    useWebhook:
      process.env.TELEGRAM_USE_WEBHOOK && process.env.TELEGRAM_USE_WEBHOOK.length
        ? !/^false$/i.test(process.env.TELEGRAM_USE_WEBHOOK)
        : undefined,
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
  database: {
    path: process.env.DATABASE_PATH ?? 'data/bot.sqlite',
    logging: /^true$/i.test(process.env.DATABASE_LOGGING ?? ''),
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY || undefined,
    from: process.env.EMAIL_FROM ?? 'no-reply@example.com',
  },
});
