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
  avito: {
    clientId: string;
    clientSecret: string;
    authUrl: string;
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
  avito: {
    clientId: process.env.AVITO_CLIENT_ID ?? '',
    clientSecret: process.env.AVITO_CLIENT_SECRET ?? '',
    authUrl: process.env.AVITO_AUTH_URL ?? 'https://api.avito.ru/token',
    apiBaseUrl: process.env.AVITO_API_BASE_URL ?? 'https://api.avito.ru',
  },
});
