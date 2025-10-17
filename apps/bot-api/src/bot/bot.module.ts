import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OzonModule } from '../config/ozon.module';
import { SupplyOrderEntity } from '../storage/entities/supply-order.entity';
import { UserCredentialsEntity } from '../storage/entities/user-credentials.entity';
import { SupplyOrderStore } from '../storage/supply-order.store';
import { BotUpdate } from './bot.update';
import { UserCredentialsStore } from './user-credentials.store';
import { SupplyWizardStore } from './supply-wizard.store';
import { SupplyWizardHandler } from './supply-wizard.handler';
import { AdminNotifierService } from './admin-notifier.service';
import { SupplyWizardViewService } from './supply-wizard/view.service';
import { SupplyTaskRunnerService } from './supply-task-runner.service';

@Module({
  imports: [
    OzonModule,
    TypeOrmModule.forFeature([UserCredentialsEntity, SupplyOrderEntity]),
  ],
  providers: [
    BotUpdate,
    UserCredentialsStore,
    SupplyWizardStore,
    SupplyWizardHandler,
    AdminNotifierService,
    SupplyWizardViewService,
    SupplyOrderStore,
    SupplyTaskRunnerService,
  ],
})
export class BotModule {}
