import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

process.env.TZ = process.env.TZ || 'Europe/Moscow';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();

  const logger = new Logger('Bootstrap');
  const configService = app.get(ConfigService);
  const port = configService.get<number>('http.port') ?? 3000;
  const nodeEnv = configService.get<string>('nodeEnv') ?? 'development';

  await app.listen(port);
  logger.log(`Application is running on port ${port} in ${nodeEnv} mode`);
}

void bootstrap();
