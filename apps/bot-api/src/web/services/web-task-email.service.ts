import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SupplyOrderEntity } from '../../storage/entities/supply-order.entity';
import { WebUserEntity } from '../../storage/entities/web-user.entity';
import { SupplyProcessService } from '../../bot/services/supply-process.service';
import { WebMailerService } from './web-mailer.service';

@Injectable()
export class WebTaskEmailService {
  private readonly logger = new Logger(WebTaskEmailService.name);

  constructor(
    @InjectRepository(WebUserEntity)
    private readonly webUsers: Repository<WebUserEntity>,
    private readonly process: SupplyProcessService,
    private readonly mailer: WebMailerService,
  ) {}

  async sendSupplyCreated(actorId: string, entity: SupplyOrderEntity): Promise<void> {
    if (!actorId.startsWith('web:')) {
      return;
    }

    const userId = actorId.slice(4).trim();
    if (!userId) {
      return;
    }

    const user = await this.webUsers.findOne({ where: { id: userId } });
    if (!user?.email) {
      this.logger.warn(`Skip supply-created email: web user ${userId} has no email`);
      return;
    }

    const timeslotLabel =
      entity.arrival ?? this.process.formatTimeslotRange(entity.timeslotFrom, entity.timeslotTo);

    try {
      await this.mailer.sendSupplyCreatedEmail(user.email, {
        orderId: entity.orderId,
        operationId: entity.operationId,
        warehouse: entity.warehouse ?? entity.warehouseName,
        dropOffName: entity.dropOffName,
        timeslotLabel,
      });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.error(`Failed to send supply-created email for ${actorId}: ${message}`);
    }
  }
}
