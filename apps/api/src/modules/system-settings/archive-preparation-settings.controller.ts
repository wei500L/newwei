import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

import { ArchivePreparationSettingsService } from './archive-preparation-settings.service';
import { UpdateArchivePreparationSettingsDto } from './dto/archive-preparation-settings.dto';

@ApiTags('system-settings')
@ApiBearerAuth()
@Controller('system-settings/archive-preparation')
export class ArchivePreparationSettingsController {
  constructor(
    private readonly settings: ArchivePreparationSettingsService,
  ) {}

  @Get()
  @Permissions('settings.manage')
  async getSettings() {
    return this.settings.getPublicSettings();
  }

  @Put()
  @Permissions('settings.manage')
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateArchivePreparationSettingsDto,
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }

  @Delete()
  @Permissions('settings.manage')
  async resetSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.resetToDefaults(user.orgId, user.id);
  }
}
