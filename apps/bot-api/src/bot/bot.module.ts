import { Module } from '@nestjs/common';

import { OzonModule } from '../config/ozon.module';
import { BotUpdate } from './bot.update';
import { UserCredentialsStore } from './user-credentials.store';
import { SupplyWizardStore } from './supply-wizard.store';
import { SupplyWizardHandler } from './supply-wizard.handler';
import { AdminNotifierService } from './admin-notifier.service';

@Module({
  imports: [OzonModule],
  providers: [BotUpdate, UserCredentialsStore, SupplyWizardStore, SupplyWizardHandler, AdminNotifierService],
})
export class BotModule {}
