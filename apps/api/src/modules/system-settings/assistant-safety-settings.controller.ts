import { Body, Controller, Delete, Get, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { AssistantSafetyDiagnosticsService } from "./assistant-safety-diagnostics.service";
import { AssistantSafetyMetricsService } from "./assistant-safety-metrics.service";
import { AssistantSafetySettingsService } from "./assistant-safety-settings.service";
import { UpdateAssistantSafetySettingsDto } from "./dto/assistant-safety-settings.dto";

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/assistant-safety")
export class AssistantSafetySettingsController {
  constructor(
    private readonly settings: AssistantSafetySettingsService,
    private readonly diagnostics: AssistantSafetyDiagnosticsService,
    private readonly metrics: AssistantSafetyMetricsService
  ) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.settings.getPublicSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateAssistantSafetySettingsDto) {
    return this.settings.updateSettings(user.orgId, user.id, body);
  }

  @Get("diagnostics")
  @Permissions("settings.manage")
  async runDiagnostics() {
    return this.diagnostics.run();
  }

  @Get("metrics")
  @Permissions("settings.manage")
  async getMetrics(
    @CurrentUser() user: AuthenticatedUser,
    @Query("days") daysRaw: string | undefined
  ) {
    const parsed = Number(daysRaw);
    const days = Number.isFinite(parsed) ? parsed : 14;
    return this.metrics.getDailyMetrics(user.orgId, days);
  }

  @Delete()
  @Permissions("settings.manage")
  async reset(@CurrentUser() user: AuthenticatedUser) {
    return this.settings.resetToEnv(user.orgId, user.id);
  }
}
