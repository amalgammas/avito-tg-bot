// apps/bot-api/src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule, TelegrafModuleOptions } from 'nestjs-telegraf';

import { BotModule } from './bot/bot.module';
import { OzonModule } from './config/ozon.module';
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
            useFactory: (config: ConfigService): TelegrafModuleOptions => {
                const token = config.get<string>('telegram.token');
                if (!token) {
                    throw new Error('TELEGRAM_BOT_TOKEN (telegram.token) is not configured');
                }

                const nodeEnv = config.get<string>('nodeEnv') ?? 'development';

                if (nodeEnv === 'production') {
                    const webhookDomain = config.get<string>('telegram.webhookDomain');
                    const webhookPath = config.get<string>('telegram.webhookPath');

                    if (!webhookDomain || !webhookPath) {
                        throw new Error(
                            'WEBHOOK_DOMAIN and WEBHOOK_PATH must be configured in production',
                        );
                    }

                    const normalizedPath = webhookPath.startsWith('/')
                        ? webhookPath
                        : `/${webhookPath}`;

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

                // dev-режим
                return {
                    token,
                };
            },
        }),
        BotModule,
        OzonModule,
    ],
    controllers: [HealthController],
})
export class AppModule {}
