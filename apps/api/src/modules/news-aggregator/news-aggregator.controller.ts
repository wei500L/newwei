import { BadRequestException, Body, Controller, Get, Post, Query } from "@nestjs/common"

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Permissions } from "../../common/decorators/permissions.decorator";
import { Public } from "../../common/decorators/public.decorator"
import type { AuthenticatedUser } from "../auth/auth.service";

import { NewsAggregatorService } from "./news-aggregator.service"
import { NewsnowDomesticOpinionIndexService } from "./newsnow-domestic-opinion-index.service";
import { NewsnowHottestAnalysisService } from "./newsnow-hottest-analysis.service";
import { NewsnowRecommendedService } from "./newsnow-recommended.service";

interface BatchFetchDto {
  sources?: string[]
}

interface PersonalizedOrderDto {
  column?: string
  sources?: string[]
  settings?: Record<string, unknown>
}

interface RecommendedFeedQueryDto {
  limit?: string;
  latest?: string;
}

const SOURCE_ID_PATTERN = /^[a-z0-9_-]+$/i
const COLUMN_ID_PATTERN = /^[a-z0-9_-]{1,64}$/i
const MAX_PERSONALIZED_ORDER_SOURCES = 240

@Controller("news-aggregator")
export class NewsAggregatorController {
  constructor(
    private readonly newsAggregatorService: NewsAggregatorService,
    private readonly hottestAnalysisService: NewsnowHottestAnalysisService,
    private readonly domesticOpinionIndexService: NewsnowDomesticOpinionIndexService,
    private readonly recommendedService: NewsnowRecommendedService,
  ) {}

  @Public()
  @Get("source")
  getSource(@Query("id") id: string, @Query("latest") latest?: string) {
    const sourceId = this.validateSourceId(id)
    return this.newsAggregatorService.fetchSource(sourceId, this.parseBooleanFlag(latest))
  }

  @Public()
  @Post("sources/batch")
  getSourcesBatch(@Body() body: BatchFetchDto, @Query("latest") latest?: string) {
    if (!Array.isArray(body?.sources)) {
      throw new BadRequestException("sources must be an array of source ids")
    }

    const validated = body.sources
      .filter((s): s is string => typeof s === "string" && SOURCE_ID_PATTERN.test(s.trim()))
      .map((s) => s.trim())

    return this.newsAggregatorService.fetchBatch(
      validated,
      this.parseBooleanFlag(latest),
    )
  }

  @Post("sources/order")
  @Permissions("items.read")
  getPersonalizedSourcesOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PersonalizedOrderDto,
  ) {
    const columnKey = this.validateColumnKey(body?.column)
    const sourceIds = this.normalizeSourceIds(body?.sources)
    if (body?.settings !== undefined && !this.isRecord(body.settings)) {
      throw new BadRequestException("settings must be an object")
    }
    return this.newsAggregatorService.getPersonalizedSourceOrderForUser({
      orgId: user.orgId,
      userId: user.id,
      columnKey,
      sourceIds,
      settingsOverride: body?.settings,
    })
  }

  @Public()
  @Get("metadata")
  getMetadata() {
    return this.newsAggregatorService.getMetadata()
  }

  @Public()
  @Get("resolve")
  resolveByUrl(@Query("url") url: string) {
    const normalizedUrl = this.validateHttpUrl(url)
    return this.newsAggregatorService.resolveByUrl(normalizedUrl)
  }

  @Permissions("items.read")
  @Get("hottest-analysis")
  getHottestAnalysis(
    @CurrentUser() user: AuthenticatedUser,
    @Query("latest") latest?: string,
  ) {
    return this.hottestAnalysisService.getHottestAnalysis({
      orgId: user.orgId,
      userId: user.id,
      forceRefresh: this.parseBooleanFlag(latest),
      allowAutoBridge: user.permissions.includes("items.write"),
    })
  }

  @Permissions("items.read")
  @Get("domestic-opinion-index")
  getDomesticOpinionIndex(
    @CurrentUser() user: AuthenticatedUser,
    @Query("hours") hours?: string,
  ) {
    return this.domesticOpinionIndexService.getDomesticOpinionIndex(user.orgId, {
      hours: this.parseOptionalPositiveInt(hours, "hours", 1, 168),
    })
  }

  @Permissions("items.read")
  @Get("recommended")
  getRecommendedFeed(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RecommendedFeedQueryDto,
  ) {
    return this.recommendedService.getRecommendedFeed({
      orgId: user.orgId,
      userId: user.id,
      limit: this.parseOptionalPositiveInt(query?.limit, "limit", 1, 100),
      forceRefresh: this.parseBooleanFlag(query?.latest),
    })
  }

  private validateSourceId(id: unknown): string {
    if (typeof id !== "string" || !id.trim()) {
      throw new BadRequestException("id query is required")
    }
    const trimmed = id.trim()
    if (!SOURCE_ID_PATTERN.test(trimmed)) {
      throw new BadRequestException("invalid source id format")
    }
    return trimmed
  }

  private validateColumnKey(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new BadRequestException("column is required")
    }
    const normalized = value.trim().toLowerCase()
    if (!COLUMN_ID_PATTERN.test(normalized)) {
      throw new BadRequestException("invalid column format")
    }
    return normalized
  }

  private normalizeSourceIds(value: unknown): string[] {
    if (value === undefined || value === null) {
      return []
    }
    if (!Array.isArray(value)) {
      throw new BadRequestException("sources must be an array of source ids")
    }
    const out: string[] = []
    const seen = new Set<string>()
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue
      }
      const sourceId = entry.trim()
      if (!sourceId || !SOURCE_ID_PATTERN.test(sourceId) || seen.has(sourceId)) {
        continue
      }
      seen.add(sourceId)
      out.push(sourceId)
      if (out.length >= MAX_PERSONALIZED_ORDER_SOURCES) {
        break
      }
    }
    return out
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value))
  }

  private parseBooleanFlag(value: unknown): boolean {
    if (value === undefined || value === null || value === "") {
      return false
    }
    if (typeof value !== "string") {
      throw new BadRequestException("latest must be a boolean string")
    }

    const normalized = value.trim().toLowerCase()
    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true
    }
    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false
    }

    throw new BadRequestException("latest must be one of true/false, 1/0, yes/no, y/n, on/off")
  }

  private parseOptionalPositiveInt(
    value: unknown,
    fieldName: string,
    min: number,
    max: number,
  ): number | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined
    }
    if (typeof value !== "string") {
      throw new BadRequestException(`${fieldName} must be an integer string`)
    }
    const parsed = Number.parseInt(value.trim(), 10)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException(`${fieldName} must be an integer between ${min} and ${max}`)
    }
    return parsed
  }

  private validateHttpUrl(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new BadRequestException("url query is required")
    }

    const raw = value.trim()
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new BadRequestException("url must be a valid absolute URL")
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new BadRequestException("url protocol must be http or https")
    }

    return parsed.toString()
  }
}
