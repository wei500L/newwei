import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { SituationMonitorInsightsQueryDto, SituationMonitorSignalFeedbackDto } from "./dto/situation-monitor.dto";
import { CORRELATION_TOPICS, NARRATIVE_PATTERNS } from "./analysis/patterns";
import { SituationMonitorService } from "./situation-monitor.service";
import { SituationMonitorFeedbackService } from "./situation-monitor-feedback.service";
import { SituationMonitorTranslationService } from "./situation-monitor-translation.service";

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
    private readonly feedback: SituationMonitorFeedbackService,
    private readonly translator: SituationMonitorTranslationService,
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

    return response;
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
}
