// apps/bot-api/src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { TelegrafModule, TelegrafModuleOptions } from 'nestjs-telegraf';

import { BotModule } from './bot/bot.module';
import { OzonModule } from './config/ozon.module';
import { configuration } from './config/configuration';
import { HealthController } from './health/health.controller';
import { UserCredentialsEntity } from './storage/entities/user-credentials.entity';
import { SupplyOrderEntity } from './storage/entities/supply-order.entity';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            cache: true,
            load: [configuration],
        }),
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const databasePath = config.get<string>('database.path') ?? 'data/bot.sqlite';
                const targetDir = dirname(databasePath);
                if (targetDir && !existsSync(targetDir)) {
                    mkdirSync(targetDir, { recursive: true });
                }

                const nodeEnv = config.get<string>('nodeEnv') ?? 'development';
                const logging = config.get<boolean>('database.logging') ?? false;

                return {
                    type: 'sqlite' as const,
                    database: databasePath,
                    entities: [UserCredentialsEntity, SupplyOrderEntity],
                    synchronize: nodeEnv !== 'production',
                    autoLoadEntities: false,
                    logging,
                };
            },
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

                const useWebhook = config.get<boolean>('telegram.useWebhook');

                if (nodeEnv === 'production' && useWebhook !== false) {
                    const webhookDomain = config.get<string>('telegram.webhookDomain');
                    const webhookPath = config.get<string>('telegram.webhookPath');

                    if (!webhookDomain || !webhookPath) {
                        throw new Error(
                            'WEBHOOK_DOMAIN and WEBHOOK_PATH must be configured in production when telegram.useWebhook != false',
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
