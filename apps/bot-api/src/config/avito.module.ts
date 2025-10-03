import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AvitoApiService } from './avito-api.service';

@Module({
  imports: [
    ConfigModule,
    HttpModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        baseURL: configService.get<string>('avito.apiBaseUrl') ?? 'https://api.avito.ru',
        timeout: 10_000,
      }),
    }),
  ],
  providers: [AvitoApiService],
  exports: [AvitoApiService],
})
export class AvitoModule {}
