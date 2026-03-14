import { Body, Controller, Delete, Get, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { UpdateLlmRuntimeSettingsDto } from "./dto/llm-runtime-settings.dto";
import { LlmRuntimeService } from "./llm-runtime.service";
import { LlmRuntimeSettingsService } from "./llm-runtime-settings.service";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/llm-runtime")
export class LlmRuntimeSettingsController {
  constructor(
    private readonly settings: LlmRuntimeSettingsService,
    private readonly runtime: LlmRuntimeService,
  ) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.settings.getPublicSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateLlmRuntimeSettingsDto,
  ) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }

  @Delete()
  @Permissions("settings.manage")
  async resetSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.resetToDefaults(user.orgId, user.id);
  }

  @Get("status")
  @Permissions("settings.manage")
  async getStatus() {
    return this.runtime.getStatus();
  }

  @Get("summary")
  @Permissions("settings.manage")
  async getSummary(@Query("window") windowRaw?: string) {
    const window = windowRaw === "month" ? "month" : "day";
    return this.runtime.getSummary(window);
  }
}
