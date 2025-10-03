import { Module } from '@nestjs/common';

import { OzonModule } from '../config/ozon.module';
import { BotUpdate } from './bot.update';
import { UserCredentialsStore } from './user-credentials.store';

@Module({
  imports: [OzonModule],
  providers: [BotUpdate, UserCredentialsStore],
})
export class BotModule {}
