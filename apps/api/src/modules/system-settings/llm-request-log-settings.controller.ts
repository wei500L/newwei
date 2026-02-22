import { Body, Controller, Delete, Get, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateLlmRequestLogSettingsDto } from "./dto/llm-request-log-settings.dto";
import { LlmRequestLogSettingsService } from "./llm-request-log-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/llm-request-logs")
export class LlmRequestLogSettingsController {
  constructor(private readonly settings: LlmRequestLogSettingsService) {}

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
    return this.settings.updateSettings(user.orgId, user.id, body);
  }

  @Delete()
  @Permissions("settings.manage")
  async reset(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.resetToDefault(user.orgId, user.id);
  }

  @Post("metadata-policy/reset")
  @Permissions("settings.manage")
  async resetMetadataPolicy(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.resetMetadataPolicy(user.orgId, user.id);
  }
}
