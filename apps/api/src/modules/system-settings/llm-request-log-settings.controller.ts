import { Body, Controller, Delete, Get, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { PlatformAccessService } from "../auth/platform-access.service";

import { UpdateLlmRequestLogSettingsDto } from "./dto/llm-request-log-settings.dto";
import { LlmRequestLogSettingsService } from "./llm-request-log-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/llm-request-logs")
export class LlmRequestLogSettingsController {
  constructor(
    private readonly settings: LlmRequestLogSettingsService,
    private readonly platformAccess: PlatformAccessService,
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
    @Body() body: UpdateLlmRequestLogSettingsDto,
  ) {
    // SEC-05: `llm_request_log_settings` is a GLOBAL singleton (single key, no
    // org dimension) and drives a Mongo TTL index over llmrequestlogs. An
    // ordinary org admin could otherwise set retentionDays=1 and delete every
    // tenant's request logs.
    await this.platformAccess.assertPlatformAdmin(user.id);
    return this.settings.updateSettings(user.orgId, user.id, body);
  }

  @Delete()
  @Permissions("settings.manage")
  async reset(@CurrentUser() user: AuthenticatedUser) {
    // Same SEC-05 boundary as PUT: reset restores the platform-wide retention
    // and metadata whitelist defaults.
    await this.platformAccess.assertPlatformAdmin(user.id);
    return this.settings.resetToDefault(user.orgId, user.id);
  }

  @Post("metadata-policy/reset")
  @Permissions("settings.manage")
  async resetMetadataPolicy(@CurrentUser() user: AuthenticatedUser) {
    // Same SEC-05 boundary: the metadata whitelist is global.
    await this.platformAccess.assertPlatformAdmin(user.id);
    return this.settings.resetMetadataPolicy(user.orgId, user.id);
  }
}
