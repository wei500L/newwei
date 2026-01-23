import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateSystemSecuritySettingsDto } from "./dto/system-security-settings.dto";
import { SystemSecuritySettingsService } from "./system-security-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/security")
export class SystemSecuritySettingsController {
  constructor(private readonly securitySettings: SystemSecuritySettingsService) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.securitySettings.getPublicSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateSystemSecuritySettingsDto
  ) {
    return this.securitySettings.updateSettings(user.orgId, user.id, body);
  }
}

