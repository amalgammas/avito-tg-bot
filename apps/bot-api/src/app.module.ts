import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule, TelegrafModuleOptions } from 'nestjs-telegraf';

import { BotModule } from './bot/bot.module';
import { AvitoModule } from './config/avito.module';
import { configuration } from './config/configuration';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
    }),
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): TelegrafModuleOptions => {
        const token = configService.get<string>('telegram.token');
        if (!token) {
          throw new Error('TELEGRAM_BOT_TOKEN is not configured');
        }

        const nodeEnv = configService.get<string>('nodeEnv') ?? 'development';

        if (nodeEnv === 'production') {
          const webhookDomain = configService.get<string>('telegram.webhookDomain');
          const webhookPath = configService.get<string>('telegram.webhookPath');

          if (!webhookDomain || !webhookPath) {
            throw new Error('WEBHOOK_DOMAIN and WEBHOOK_PATH must be configured in production');
          }

          const normalizedPath = webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`;

          return {
            token,
            launchOptions: {
              webhook: {
                domain: webhookDomain.replace(/\/$/, ''),
                hookPath: normalizedPath,
                path: normalizedPath,
              },
            },
          };
        }

        return {
          token,
        };
      },
    }),
    BotModule,
    AvitoModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
