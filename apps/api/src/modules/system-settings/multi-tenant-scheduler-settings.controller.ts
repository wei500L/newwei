import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateMultiTenantSchedulerSettingsDto } from "./dto/multi-tenant-scheduler-settings.dto";
import { MultiTenantSchedulerSettingsService } from "./multi-tenant-scheduler-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/multi-tenant-schedulers")
export class MultiTenantSchedulerSettingsController {
  constructor(
    private readonly settings: MultiTenantSchedulerSettingsService,
  ) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.settings.getSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateMultiTenantSchedulerSettingsDto,
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }
}
