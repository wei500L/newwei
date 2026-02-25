import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

import { UpdateNewsnowPersonalizationSettingsDto } from './dto/newsnow-personalization-settings.dto';
import { NewsnowPersonalizationSettingsService } from './newsnow-personalization-settings.service';

@ApiTags('system-settings')
@ApiBearerAuth()
@Controller('system-settings/newsnow-personalization')
export class NewsnowPersonalizationSettingsController {
  constructor(
    private readonly settings: NewsnowPersonalizationSettingsService,
  ) {}

  @Get()
  @Permissions('settings.manage')
  async getSettings() {
    return this.settings.getSettings();
  }

  @Get('metrics')
  @Permissions('settings.manage')
  async getRuntimeMetrics(@Query('days') daysRaw: string | undefined) {
    const parsed = Number(daysRaw);
    const days = Number.isFinite(parsed) ? parsed : undefined;
    return this.settings.getRuntimeMetricsSnapshot(days);
  }

  @Put()
  @Permissions('settings.manage')
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateNewsnowPersonalizationSettingsDto,
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }
}
