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
}

export const configuration = (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  http: {
    port: Number(process.env.PORT ?? 3000),
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? '',
    webhookDomain: process.env.WEBHOOK_DOMAIN,
    webhookPath: process.env.WEBHOOK_PATH,
  },
  ozon: {
    clientId: process.env.OZON_CLIENT_ID ?? '',
    apiKey: process.env.OZON_API_KEY ?? '',
    apiBaseUrl: process.env.OZON_API_BASE_URL ?? 'https://api-seller.ozon.ru',
  },
});
