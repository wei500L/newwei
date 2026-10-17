import { Body, Controller, Delete, Get, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import { PlatformAccessService } from "../auth/platform-access.service";

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
    private readonly metrics: AssistantSafetyMetricsService,
    private readonly platformAccess: PlatformAccessService
  ) {}

  @Get()
  @Permissions("settings.manage")
  async getSettings() {
    return this.settings.getPublicSettings();
  }

  @Put()
  @Permissions("settings.manage")
  async updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateAssistantSafetySettingsDto) {
    // SEC-05: `assistant_safety` is a GLOBAL singleton (single key, no org
    // dimension). An ordinary org admin could otherwise switch off the
    // platform-wide LiteLLM content-moderation guardrails for every tenant.
    await this.platformAccess.assertPlatformAdmin(user.id);
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
    // Same SEC-05 boundary as PUT: reset re-enables the environment-default
    // guardrails for every tenant.
    await this.platformAccess.assertPlatformAdmin(user.id);
    return this.settings.resetToEnv(user.orgId, user.id);
  }
}
