import { Body, Controller, Delete, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { PlatformAccessService } from "../auth/platform-access.service";

import { AssistantQuotaSettingsService } from "./assistant-quota-settings.service";
import { UpdateAssistantQuotaSettingsDto } from "./dto/assistant-quota-settings.dto";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/assistant-quota")
export class AssistantQuotaSettingsController {
  constructor(
    private readonly settings: AssistantQuotaSettingsService,
    private readonly platformAccess: PlatformAccessService,
  ) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.getPublicSettings(user.orgId);
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateAssistantQuotaSettingsDto
  ) {
    // SEC-05: `assistant_quota` is a GLOBAL singleton (single key, no org
    // dimension): the hourly submit cap, in-flight cap and monthly token
    // budget apply to every tenant. Only a platform admin may change them.
    await this.platformAccess.assertPlatformAdmin(user.id);
    return this.settings.updateSettings(user.orgId, user.id, body);
  }

  @Delete()
  @Permissions("settings.manage")
  async reset(@CurrentUser() user: AuthenticatedUser) {
    // Same SEC-05 boundary as PUT: reset deletes the global row, reverting
    // every tenant to the environment default.
    await this.platformAccess.assertPlatformAdmin(user.id);
    return this.settings.resetToEnv(user.orgId, user.id);
  }
}
