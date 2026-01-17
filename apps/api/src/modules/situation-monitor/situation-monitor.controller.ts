import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { SituationMonitorInsightsQueryDto } from "./dto/situation-monitor.dto";
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

@ApiTags("situation-monitor")
@ApiBearerAuth()
@Controller("situation-monitor")
export class SituationMonitorController {
  constructor(private readonly monitor: SituationMonitorService) {}

  @Get("insights")
  @Permissions("items.read")
  async insights(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SituationMonitorInsightsQueryDto
  ) {
    return this.monitor.getInsights(user.orgId, {
      windowHours: query.windowHours,
      maxItems: query.maxItems,
      sections: parseSections(query.sections),
      gdelt: parseBoolean(query.gdelt),
      scope: parseScope(query.scope),
      debug: parseBoolean(query.debug),
    });
  }
}
