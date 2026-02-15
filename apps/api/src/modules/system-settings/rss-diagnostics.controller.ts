import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { RssDiagnosticsService } from "./rss-diagnostics.service";

interface RssBackfillRequestBody {
  dryRun?: boolean;
  limit?: number;
}

@ApiTags("system-settings")
@ApiBearerAuth()
@Controller("system-settings/rss-diagnostics")
export class RssDiagnosticsController {
  constructor(private readonly diagnostics: RssDiagnosticsService) {}

  @Get("chain")
  @Permissions("settings.manage")
  async getChainSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query("windowDays") windowDaysRaw: string | undefined,
    @Query("lookbackHours") lookbackHoursRaw: string | undefined
  ) {
    return this.diagnostics.getChainSummary(user.orgId, {
      windowDays: this.parseNumber(windowDaysRaw),
      lookbackHours: this.parseNumber(lookbackHoursRaw)
    });
  }

  @Get("sources")
  @Permissions("settings.manage")
  async getSourceDetails(
    @CurrentUser() user: AuthenticatedUser,
    @Query("windowDays") windowDaysRaw: string | undefined,
    @Query("lookbackHours") lookbackHoursRaw: string | undefined
  ) {
    return this.diagnostics.listSourceDetails(user.orgId, {
      windowDays: this.parseNumber(windowDaysRaw),
      lookbackHours: this.parseNumber(lookbackHoursRaw)
    });
  }

  @Post("backfill-source-id")
  @Permissions("settings.manage")
  async backfillSourceId(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RssBackfillRequestBody | undefined
  ) {
    return this.diagnostics.backfillProcessedItemSourceId(user.orgId, {
      dryRun: body?.dryRun,
      limit: body?.limit
    });
  }

  private parseNumber(raw: string | undefined): number | undefined {
    if (typeof raw !== "string") {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
