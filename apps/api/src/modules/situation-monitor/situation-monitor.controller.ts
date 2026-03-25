import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";
import {
  isSituationMonitorLiveHlsProxyChannel,
  SituationMonitorSettingsService,
} from "../system-settings/situation-monitor-settings.service";

import { CORRELATION_TOPICS, NARRATIVE_PATTERNS } from "./analysis/patterns";
import {
  CreateSituationMonitorDto,
  SituationMonitorMonitorIdParamDto,
  SituationMonitorPreviewDto,
  UpdateSituationMonitorDto,
} from "./dto/situation-monitor-monitor.dto";
import { SituationMonitorInsightsQueryDto, SituationMonitorSignalFeedbackDto } from "./dto/situation-monitor.dto";
import { SituationMonitorMonitorsService } from "./situation-monitor-monitors.service";
import { SituationMonitorRefreshService } from "./situation-monitor-refresh.service";
import { SituationMonitorSignalsService } from "./signals/situation-monitor-signals.service";
import { SituationMonitorFeedbackService } from "./situation-monitor-feedback.service";
import { SituationMonitorTranslationService } from "./situation-monitor-translation.service";
import { SituationMonitorService } from "./situation-monitor.service";

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function parseSections(value: unknown): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? Array.from(new Set(parts)) : undefined;
}

function parsePositiveInt(value: unknown, bounds: { min: number; max: number }): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    if (normalized < bounds.min || normalized > bounds.max) {
      return undefined;
    }
    return normalized;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    const normalized = Math.floor(parsed);
    if (normalized < bounds.min || normalized > bounds.max) {
      return undefined;
    }
    return normalized;
  }

  return undefined;
}

function parseScope(value: unknown): "tagged" | "all" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") {
    return "all";
  }
  if (normalized === "tagged") {
    return "tagged";
  }
  return undefined;
}

function parseTranslateTarget(value: unknown): "zh-CN" | undefined {
  const bool = parseBoolean(value);
  if (bool === true) {
    return "zh-CN";
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const zh = new Set(["zh", "zh-cn", "zh-hans", "zh-hans-cn", "cn", "chs"]);
  if (zh.has(normalized)) {
    return "zh-CN";
  }
  return undefined;
}

function formatIdTitle(id: string): string {
  return id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

@ApiTags("situation-monitor")
@ApiBearerAuth()
@Controller("situation-monitor")
export class SituationMonitorController {
  constructor(
    private readonly monitor: SituationMonitorService,
    private readonly monitors: SituationMonitorMonitorsService,
    private readonly feedback: SituationMonitorFeedbackService,
    private readonly translator: SituationMonitorTranslationService,
    private readonly signals: SituationMonitorSignalsService,
    private readonly settings: SituationMonitorSettingsService,
    private readonly refreshService: SituationMonitorRefreshService,
  ) {}

  @Get("insights")
  @Permissions("items.read")
  async insights(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SituationMonitorInsightsQueryDto
  ) {
    const response = await this.monitor.getInsights(user.orgId, {
      windowHours: query.windowHours,
      maxItems: query.maxItems,
      sections: parseSections(query.sections),
      gdelt: parseBoolean(query.gdelt),
      scope: parseScope(query.scope),
      debug: parseBoolean(query.debug),
    });

    const translateTarget = parseTranslateTarget(query.translate);
    if (translateTarget === "zh-CN") {
      const result = await this.translator.applyZhTranslationsBestEffort(response);
      response.translation = { target: translateTarget, ...result };
    }

    return await this.monitors.augmentInsights(user.orgId, user.id, response);
  }

  @Get('monitors')
  @Permissions('items.read')
  async listMonitors(@CurrentUser() user: AuthenticatedUser) {
    return await this.monitors.listMonitors(user.orgId, user.id);
  }

  @Post('monitors/preview')
  @Permissions('items.read')
  async previewMonitor(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SituationMonitorPreviewDto,
  ) {
    return await this.monitors.previewMonitor(user.orgId, body);
  }

  @Post('monitors')
  @Permissions('items.read')
  async createMonitor(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateSituationMonitorDto,
  ) {
    return await this.monitors.createMonitor(user.orgId, user.id, body);
  }

  @Patch('monitors/:id')
  @Permissions('items.read')
  async updateMonitor(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: SituationMonitorMonitorIdParamDto,
    @Body() body: UpdateSituationMonitorDto,
  ) {
    return await this.monitors.updateMonitor(user.orgId, user.id, params.id, body);
  }

  @Delete('monitors/:id')
  @Permissions('items.read')
  async deleteMonitor(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: SituationMonitorMonitorIdParamDto,
  ) {
    await this.monitors.deleteMonitor(user.orgId, user.id, params.id);
    return { ok: true };
  }

  @Get("catalog")
  @Permissions("items.read")
  async catalog(@CurrentUser() user: AuthenticatedUser) {
    void user;
    return {
      narratives: NARRATIVE_PATTERNS.map((entry) => ({
        id: entry.id,
        name: formatIdTitle(entry.id),
        category: entry.category,
        severity: entry.severity,
      })),
      correlations: CORRELATION_TOPICS.map((entry) => ({
        id: entry.id,
        name: formatIdTitle(entry.id),
        category: entry.category,
      })),
    };
  }

  @Post("feedback")
  @Permissions("items.write")
  async recordFeedback(@CurrentUser() user: AuthenticatedUser, @Body() body: SituationMonitorSignalFeedbackDto) {
    return await this.feedback.recordFeedback({
      orgId: user.orgId,
      userId: user.id,
      signalType: body.signalType,
      signalId: body.signalId,
      label: body.label,
      itemMetaId: body.itemMetaId,
      itemLink: body.itemLink,
      itemTitle: body.itemTitle,
      itemSource: body.itemSource,
      note: body.note,
    });
  }

  @Post("refresh")
  @Permissions("items.read")
  async refresh(@CurrentUser() user: AuthenticatedUser) {
    return await this.refreshService.refresh(user.orgId, user.permissions ?? []);
  }

  @Get("refresh-runs/:refreshId")
  @Permissions("items.read")
  async getRefreshRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param("refreshId") refreshId: string,
  ) {
    const run = await this.refreshService.getRefreshRun(user.orgId, refreshId);
    if (!run) {
      throw new NotFoundException("Situation Monitor refresh run not found.");
    }
    return run;
  }

  @Get("telegram-feed")
  @Permissions("items.read")
  async telegramFeed(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
  ) {
    const response = await this.signals.getTelegramFeed({
      limit: parsePositiveInt(query.limit, { min: 1, max: 200 }),
      topic: typeof query.topic === "string" ? query.topic : undefined,
      channel: typeof query.channel === "string" ? query.channel : undefined,
    });
    return await this.monitors.augmentTelegramFeed(user.orgId, user.id, response);
  }

  @Get("oref-alerts")
  @Permissions("items.read")
  async orefAlerts(@CurrentUser() user: AuthenticatedUser) {
    const response = await this.signals.getOrefAlerts();
    return await this.monitors.augmentOrefAlerts(user.orgId, user.id, response);
  }

  @Get("oref-history")
  @Permissions("items.read")
  async orefHistory(@CurrentUser() user: AuthenticatedUser) {
    const response = await this.signals.getOrefHistory();
    return await this.monitors.augmentOrefHistory(user.orgId, user.id, response);
  }

  @Get("live-hls-proxy-config")
  @Permissions("items.read")
  async liveHlsProxyConfig(
    @CurrentUser() user: AuthenticatedUser,
    @Query("channel") channel: string,
  ) {
    void user;
    const normalized = channel?.trim().toLowerCase();
    if (!normalized || !isSituationMonitorLiveHlsProxyChannel(normalized)) {
      return {
        channel: normalized ?? "",
        configured: false,
        upstreamUrl: null,
        referer: null,
        allowedHosts: [],
      };
    }
    return this.settings.getLiveHlsProxyRuntimeConfig(normalized);
  }
}
