import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';

import { CurrentWebUser } from './auth/current-web-user.decorator';
import { WebSessionGuard } from './auth/web-session.guard';
import { UpdateOzonCredentialsDto } from './dto/update-ozon-credentials.dto';
import type { WebSessionUser } from './common/web-auth.types';
import { WebAccountService } from './services/web-account.service';
import { WebSupplyService } from './services/web-supply.service';

@Controller('api/web')
@UseGuards(WebSessionGuard)
export class WebController {
  constructor(
    private readonly accountService: WebAccountService,
    private readonly supplyService: WebSupplyService,
  ) {}

  @Get('me')
  async me(@CurrentWebUser() user: WebSessionUser) {
    return this.accountService.getProfile(user);
  }

  @Get('ozon-credentials')
  async getOzonCredentials(@CurrentWebUser() user: WebSessionUser) {
    return this.accountService.getOzonCredentials(user);
  }

  @Put('ozon-credentials')
  async updateOzonCredentials(@CurrentWebUser() user: WebSessionUser, @Body() body: UpdateOzonCredentialsDto) {
    return this.accountService.updateOzonCredentials(user, body);
  }

  @Delete('ozon-credentials')
  async clearOzonCredentials(@CurrentWebUser() user: WebSessionUser) {
    return this.accountService.clearOzonCredentials(user);
  }

  @Get('supplies')
  async listSupplies(@CurrentWebUser() user: WebSessionUser, @Query('status') status?: string) {
    return this.supplyService.list(user, status);
  }

  @Get('supplies/:id')
  async getSupply(@CurrentWebUser() user: WebSessionUser, @Param('id') id: string) {
    return this.supplyService.get(user, id);
  }

  @Post('supplies/:id/cancel')
  async cancelSupply(@CurrentWebUser() user: WebSessionUser, @Param('id') id: string) {
    return this.supplyService.cancel(user, id);
  }
}
