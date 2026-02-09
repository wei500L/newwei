import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.service";

import { CrawlQualityMetricsService } from "./crawl-quality-metrics.service";

@ApiTags("crawl")
@ApiBearerAuth()
@Controller("admin/crawl4ai")
export class Crawl4aiQualityController {
  constructor(private readonly metrics: CrawlQualityMetricsService) {}

  @Get("quality")
  @Permissions("crawl.read")
  async getQualitySnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Query("lookbackHours") lookbackHours?: string
  ) {
    const parsedLookback = Number.parseInt(lookbackHours ?? "24", 10);
    const safeLookback = Number.isFinite(parsedLookback) ? parsedLookback : 24;
    return this.metrics.getSnapshot(user.orgId, safeLookback);
  }

  @Get("quality/sources/:sourceId")
  @Permissions("crawl.read")
  async getSourceQualitySnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Param("sourceId") sourceId: string,
    @Query("lookbackHours") lookbackHours?: string
  ) {
    const parsedLookback = Number.parseInt(lookbackHours ?? "24", 10);
    const safeLookback = Number.isFinite(parsedLookback) ? parsedLookback : 24;
    return this.metrics.getSourceSnapshot(user.orgId, sourceId, safeLookback);
  }
}

