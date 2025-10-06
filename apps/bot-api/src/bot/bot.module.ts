import { Module } from '@nestjs/common';

import { OzonModule } from '../config/ozon.module';
import { BotUpdate } from './bot.update';
import { UserCredentialsStore } from './user-credentials.store';
import { BotSessionStore } from './bot-session.store';

@Module({
  imports: [OzonModule],
  providers: [BotUpdate, UserCredentialsStore, BotSessionStore],
})
export class BotModule {}
