import { Body, Controller, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { PlatformAccessService } from "../auth/platform-access.service";

import { UpdateSystemSecuritySettingsDto } from "./dto/system-security-settings.dto";
import { SystemSecuritySettingsService } from "./system-security-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/security")
export class SystemSecuritySettingsController {
  constructor(
    private readonly securitySettings: SystemSecuritySettingsService,
    private readonly platformAccess: PlatformAccessService,
  ) {}

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
    // SEC-05: `system_security` is a GLOBAL singleton (single key, no org
    // dimension) and `mfaPolicy` is the platform-wide MFA policy. An ordinary
    // org admin with settings.manage must not be able to change it, so the
    // write requires a platform admin — the same boundary task-log and
    // vector-service already enforce.
    await this.platformAccess.assertPlatformAdmin(user.id);
    return this.securitySettings.updateSettings(user.orgId, user.id, body);
  }
}

