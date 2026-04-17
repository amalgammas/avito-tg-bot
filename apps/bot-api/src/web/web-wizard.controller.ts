import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentWebUser } from './auth/current-web-user.decorator';
import { WebSessionGuard } from './auth/web-session.guard';
import type { WebSessionUser } from './common/web-auth.types';
import { SearchDropOffDto } from './dto/search-drop-off.dto';
import { SelectClusterDto } from './dto/select-cluster.dto';
import { SelectDropOffDto } from './dto/select-drop-off.dto';
import { SelectWarehouseDto } from './dto/select-warehouse.dto';
import { SubmitWebDraftDto } from './dto/submit-web-draft.dto';
import { UpdateWebDraftClusterTypeDto } from './dto/update-web-draft-cluster-type.dto';
import { UpdateWebDraftSupplyTypeDto } from './dto/update-web-draft-supply-type.dto';
import { WebWizardService } from './services/web-wizard.service';

@Controller('api/web/wizard')
@UseGuards(WebSessionGuard)
export class WebWizardController {
  constructor(private readonly wizardService: WebWizardService) {}

  @Post('parse-spreadsheet')
  @UseInterceptors(FileInterceptor('file'))
  async parseSpreadsheet(
    @CurrentWebUser() user: WebSessionUser,
    @UploadedFile() file: any,
    @Body('spreadsheetUrl') spreadsheetUrl?: string,
  ) {
    const originalName =
      typeof file?.originalname === 'string' && file.originalname.trim()
        ? file.originalname.trim()
        : undefined;

    return this.wizardService.parseSpreadsheet(user, {
      spreadsheetUrl,
      buffer: file?.buffer,
      label: originalName ?? spreadsheetUrl?.trim(),
    });
  }

  @Get('drafts/:id')
  async getDraft(@CurrentWebUser() user: WebSessionUser, @Param('id') id: string) {
    return this.wizardService.getDraft(user, id);
  }

  @Put('drafts/:id/supply-type')
  async updateSupplyType(
    @CurrentWebUser() user: WebSessionUser,
    @Param('id') id: string,
    @Body() body: UpdateWebDraftSupplyTypeDto,
  ) {
    return this.wizardService.updateSupplyType(user, id, body.supplyType);
  }

  @Post('drafts/:id/drop-off-search')
  async searchDropOffs(
    @CurrentWebUser() user: WebSessionUser,
    @Param('id') id: string,
    @Body() body: SearchDropOffDto,
  ) {
    return this.wizardService.searchDropOffs(user, id, body.query);
  }

  @Put('drafts/:id/drop-off')
  async selectDropOff(
    @CurrentWebUser() user: WebSessionUser,
    @Param('id') id: string,
    @Body() body: SelectDropOffDto,
  ) {
    return this.wizardService.selectDropOff(user, id, body.dropOffId);
  }

  @Put('drafts/:id/cluster-type')
  async updateClusterType(
    @CurrentWebUser() user: WebSessionUser,
    @Param('id') id: string,
    @Body() body: UpdateWebDraftClusterTypeDto,
  ) {
    return this.wizardService.updateClusterType(user, id, body.clusterType);
  }

  @Put('drafts/:id/cluster')
  async selectCluster(
    @CurrentWebUser() user: WebSessionUser,
    @Param('id') id: string,
    @Body() body: SelectClusterDto,
  ) {
    return this.wizardService.selectCluster(user, id, body.clusterId);
  }

  @Put('drafts/:id/warehouse')
  async selectWarehouse(
    @CurrentWebUser() user: WebSessionUser,
    @Param('id') id: string,
    @Body() body: SelectWarehouseDto,
  ) {
    return this.wizardService.selectWarehouse(user, id, body);
  }

  @Post('drafts/:id/submit')
  async submitDraft(
    @CurrentWebUser() user: WebSessionUser,
    @Param('id') id: string,
    @Body() body: SubmitWebDraftDto,
  ) {
    return this.wizardService.submitDraft(user, id, body);
  }
}
