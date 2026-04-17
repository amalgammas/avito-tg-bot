import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BotModule } from '../bot/bot.module';
import { OzonModule } from '../config/ozon.module';
import { WizardSessionEntity } from '../storage/entities/wizard-session.entity';
import { WebAuthTokenEntity } from '../storage/entities/web-auth-token.entity';
import { WebSessionEntity } from '../storage/entities/web-session.entity';
import { WebUserEntity } from '../storage/entities/web-user.entity';
import { WebAuthController } from './auth/web-auth.controller';
import { WebAuthService } from './auth/web-auth.service';
import { WebSessionGuard } from './auth/web-session.guard';
import { WebWizardDraftStore } from './drafts/web-wizard-draft.store';
import { WebController } from './web.controller';
import { WebWizardController } from './web-wizard.controller';
import { WebMailerService } from './services/web-mailer.service';
import { WebAccountService } from './services/web-account.service';
import { WebSupplyService } from './services/web-supply.service';
import { WebWizardService } from './services/web-wizard.service';
import { WebTaskEmailService } from './services/web-task-email.service';

@Module({
  imports: [
    OzonModule,
    BotModule,
    TypeOrmModule.forFeature([WebUserEntity, WebAuthTokenEntity, WebSessionEntity, WizardSessionEntity]),
  ],
  controllers: [WebAuthController, WebController, WebWizardController],
  providers: [
    WebAuthService,
    WebSessionGuard,
    WebMailerService,
    WebTaskEmailService,
    WebAccountService,
    WebSupplyService,
    WebWizardService,
    WebWizardDraftStore,
  ],
})
export class WebModule {}
