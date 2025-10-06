// apps/bot-api/src/config/ozon.module.ts
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

import { OzonApiService } from './ozon-api.service';
import { OzonSheetService } from '../ozon/ozon-sheet.service';
import { OzonSupplyService } from '../ozon/ozon-supply.service';

@Module({
    imports: [
        // В корневом AppModule сделай ConfigModule.forRoot({ isGlobal: true })
        ConfigModule,
        HttpModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const baseURL =
                    config.get<string>('ozon.apiBaseUrl') ??
                    config.get<string>('OZON_API_BASE_URL') ??
                    'https://api-seller.ozon.ru';

                return {
                    baseURL,
                    timeout: 10_000, // 10s
                    maxRedirects: 0,
                    httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 50 }),
                    httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 50 }),
                    // Чтобы 4xx/5xx шли в catch — наш сервис умеет ретраить 429/5xx
                    validateStatus: (status: number) => status >= 200 && status < 300,
                };
            },
        }),
    ],
    providers: [OzonApiService, OzonSheetService, OzonSupplyService],
    exports: [OzonApiService, OzonSheetService, OzonSupplyService],
})
export class OzonModule {}
