import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OzonModule } from '../config/ozon.module';
import { SupplyOrderEntity } from '../storage/entities/supply-order.entity';
import { WizardSessionEntity } from '../storage/entities/wizard-session.entity';
import { UserCredentialsEntity } from '../storage/entities/user-credentials.entity';
import { SupplyOrderStore } from '../storage/supply-order.store';
import { BotUpdate } from './bot.update';
import { UserCredentialsStore } from './user-credentials.store';
import { SupplyWizardStore } from './supply-wizard.store';
import { UserSessionService } from './user-session.service';
import { SupplyWizardHandler } from './supply-wizard.handler';
import { AdminNotifierService } from './admin-notifier.service';
import { SupplyWizardViewService } from './supply-wizard/view.service';
import { SupplyTaskRunnerService } from './supply-task-runner.service';
import { WizardFlowService } from './services/wizard-flow.service';
import { SupplyProcessService } from './services/supply-process.service';
import { SupplyRunnerService } from './services/supply-runner.service';
import { SupplyTaskOrchestratorService } from './services/supply-task-orchestrator.service';
import { SupplyProcessingCoordinatorService } from './services/supply-processing-coordinator.service';
import { WizardNotifierService } from './services/wizard-notifier.service';
import { NotificationService } from './services/notification.service';
import { SupplyTaskAbortService } from './services/supply-task-abort.service';

@Module({
  imports: [
    OzonModule,
    TypeOrmModule.forFeature([UserCredentialsEntity, SupplyOrderEntity, WizardSessionEntity]),
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
    WizardFlowService,
    SupplyProcessService,
    SupplyRunnerService,
    SupplyTaskOrchestratorService,
    SupplyProcessingCoordinatorService,
    WizardNotifierService,
    UserSessionService,
    NotificationService,
    SupplyTaskAbortService,
  ],
})
export class BotModule {}
