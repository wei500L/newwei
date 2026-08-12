import {
  computeEconomicSeriesInsights,
  type EconomicDashboardRefreshPreset as EconomicDashboardRefreshPresetValue,
} from "@modular/utils";
import { ForbiddenException, UseGuards } from "@nestjs/common";
import {
  Args,
  Context,
  Info,
  Mutation,
  Query,
  Resolver,
} from "@nestjs/graphql";
import { EconomicDataFrequency, EconomicDataValueType } from "@prisma/client";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { resolveRequestIp } from "../../common/request-ip";
import { AkshareService } from "../../modules/akshare/akshare.service";
import { PaginatedResult } from "../../modules/akshare/akshare.types";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { ActionRateLimitService } from "../../modules/cache/action-rate-limit.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import {
  DateRangeInput,
  PaginationInput,
  TriggerDataFetchInput,
} from "../dto/economic-data.input";
import type { GqlRequest } from "../graphql.types";
import { EconomicDataWithInsightsModel } from "../models/economic-data-with-insights.model";
import {
  EconomicDashboardRefreshPreset,
  EconomicDataFetchConfigModel,
  EconomicDataPointModel,
  EconomicDataRefreshPresetStatusModel,
  PaginatedEconomicDataPointsModel,
  TimeGranularity,
} from "../models/economic-data.model";
import {
  EconomicInsightClassification,
  EconomicInsightDirection,
  EconomicSeriesInsightModel,
} from "../models/economic-insights.model";
import {
  type CacheableResolveInfo,
  setPrivateResponseCacheHint,
} from "../response-cache-hints";
import { parseMetadata } from "../schemas/economic-data.schema";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class EconomicDataResolver {
  constructor(
    private readonly akshareService: AkshareService,
    private readonly actionRateLimit: ActionRateLimitService,
  ) {}

  private requireUser(req: GqlRequest): AuthenticatedUser {
    const user = req?.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new ForbiddenException("Unauthenticated");
    }
    return user;
  }

  private resolveDefaultGranularityForRange(
    start: Date,
    end: Date,
  ): TimeGranularity {
    const diffMs = Math.max(0, end.getTime() - start.getTime());
    const minuteMs = 60 * 1000;
    const hourMs = 60 * minuteMs;
    const dayMs = 24 * hourMs;
    const diffDays = Math.max(1, Math.round(diffMs / dayMs));

    if (diffMs <= 6 * hourMs) return TimeGranularity.minute;
    if (diffMs <= 2 * dayMs) return TimeGranularity.hour;
    if (diffDays > 1095) return TimeGranularity.year;
    if (diffDays > 365) return TimeGranularity.quarter;
    if (diffDays > 120) return TimeGranularity.month;
    if (diffDays > 45) return TimeGranularity.week;
    return TimeGranularity.day;
  }

  private timeGranularityRank(granularity: TimeGranularity): number {
    switch (granularity) {
      case TimeGranularity.realtime:
        return 0;
      case TimeGranularity.minute:
        return 1;
      case TimeGranularity.hour:
        return 2;
      case TimeGranularity.day:
        return 3;
      case TimeGranularity.week:
        return 4;
      case TimeGranularity.month:
        return 5;
      case TimeGranularity.quarter:
        return 6;
      case TimeGranularity.year:
        return 7;
      default:
        return 99;
    }
  }

  private coarsestTimeGranularity(
    a: TimeGranularity,
    b: TimeGranularity,
  ): TimeGranularity {
    return this.timeGranularityRank(a) >= this.timeGranularityRank(b) ? a : b;
  }

  private defaultFrequencyToTimeGranularity(
    frequency: EconomicDataFrequency | null | undefined,
  ): TimeGranularity | null {
    switch (frequency) {
      case EconomicDataFrequency.realtime:
        return TimeGranularity.realtime;
      case EconomicDataFrequency.hourly:
        return TimeGranularity.hour;
      case EconomicDataFrequency.weekly:
        return TimeGranularity.week;
      case EconomicDataFrequency.monthly:
        return TimeGranularity.month;
      case EconomicDataFrequency.daily:
      default:
        return TimeGranularity.day;
    }
  }

  private resolveEffectiveGranularity(
    requested: TimeGranularity | null | undefined,
    defaultFrequency: EconomicDataFrequency | null | undefined,
  ): TimeGranularity {
    const base =
      this.defaultFrequencyToTimeGranularity(defaultFrequency) ??
      TimeGranularity.day;
    if (!requested) {
      return base;
    }
    return this.coarsestTimeGranularity(requested, base);
  }

  private mapItemToModel(item: {
    slug: string;
    displayName?: string | null;
    groupLabel?: string | null;
    defaultUnit?: string | null;
    metadata?: unknown;
  }): {
    slug: string;
    displayName: string;
    groupLabel?: string;
    defaultUnit: string | null;
    metadata: Record<string, unknown> | null;
  } {
    return {
      slug: item.slug,
      displayName: item.displayName ?? item.slug,
      groupLabel: item.groupLabel ?? undefined,
      defaultUnit: item.defaultUnit ?? null,
      metadata: parseMetadata(item.metadata),
    };
  }

  @HasPermission("economicdata.read")
  @Query(() => [EconomicDataPointModel])
  async getEconomicData(
    @Args("category") category: string,
    @Args("timeRange") timeRange: DateRangeInput,
    @Args("granularity", { type: () => TimeGranularity, nullable: true })
    granularity?: TimeGranularity,
    @Info() info?: CacheableResolveInfo,
  ): Promise<EconomicDataPointModel[]> {
    setPrivateResponseCacheHint(info);
    const start = new Date(timeRange.start);
    const end = new Date(timeRange.end);
    // Granularity is derived from the query window only. Bucketing happens
    // per-series in the service (coarsest of the requested granularity and
    // each item's own frequency), so mixed-frequency categories keep their
    // realtime/daily series intact on short windows instead of collapsing.
    const appliedGranularity =
      granularity ?? this.resolveDefaultGranularityForRange(start, end);

    const points = await this.akshareService.getDataByCategory(
      category,
      start,
      end,
      appliedGranularity,
    );
    const dataPoints = Array.isArray(points) ? points : points.data;
    return dataPoints.map((point) => ({
      timestamp: point.recordedAt,
      effectiveGranularity: appliedGranularity,
      value: Number(point.value),
      unit: point.unit,
      sourceField: point.sourceField,
      dataType: point.dataType,
      item: this.mapItemToModel(point.item),
    }));
  }

  @HasPermission("economicdata.read")
  @Query(() => EconomicDataWithInsightsModel)
  async getEconomicDataWithInsights(
    @Args("category") category: string,
    @Args("timeRange") timeRange: DateRangeInput,
    @Args("granularity", { type: () => TimeGranularity, nullable: true })
    granularity?: TimeGranularity,
    @Info() info?: CacheableResolveInfo,
  ): Promise<EconomicDataWithInsightsModel> {
    setPrivateResponseCacheHint(info);
    const start = new Date(timeRange.start);
    const end = new Date(timeRange.end);
    const appliedGranularity =
      granularity ?? this.resolveDefaultGranularityForRange(start, end);
    const points = await this.akshareService.getDataByCategory(
      category,
      start,
      end,
      appliedGranularity,
    );
    const dataPoints = Array.isArray(points) ? points : points.data;

    const mappedPoints = dataPoints.map((point) => ({
      timestamp: point.recordedAt,
      effectiveGranularity: this.resolveEffectiveGranularity(
        appliedGranularity,
        point.item?.defaultFrequency,
      ),
      value: Number(point.value),
      unit: point.unit,
      sourceField: point.sourceField,
      dataType: point.dataType,
      item: this.mapItemToModel(point.item),
    }));

    const insights = computeEconomicSeriesInsights(
      dataPoints.map((point) => ({
        recordedAt: point.recordedAt,
        value:
          typeof point.value === "number" ? point.value : Number(point.value),
        unit: point.unit,
        sourceField: point.sourceField,
        item: {
          slug: point.item.slug,
          defaultUnit: point.item.defaultUnit,
        },
      })),
    ).map((insight) => ({
      itemSlug: insight.itemSlug,
      seriesKey: insight.seriesKey,
      sourceField: insight.sourceField,
      unit: insight.unit,
      sampleCount: insight.sampleCount,
      currentValue: insight.currentValue,
      previousValue: insight.previousValue,
      change: insight.change,
      percentChange: insight.percentChange,
      mean: insight.mean,
      stdDev: insight.stdDev,
      zScore: insight.zScore,
      direction: insight.direction as EconomicInsightDirection,
      classification: insight.classification as EconomicInsightClassification,
      message: insight.message,
    }));

    return {
      points: mappedPoints,
      insights,
    };
  }

  @HasPermission("economicdata.read")
  @Query(() => [EconomicSeriesInsightModel])
  async getEconomicDataInsights(
    @Args("category") category: string,
    @Args("timeRange") timeRange: DateRangeInput,
    @Args("granularity", { type: () => TimeGranularity, nullable: true })
    granularity?: TimeGranularity,
  ): Promise<EconomicSeriesInsightModel[]> {
    const start = new Date(timeRange.start);
    const end = new Date(timeRange.end);
    const points = await this.akshareService.getDataByCategory(
      category,
      start,
      end,
      granularity,
    );
    const dataPoints = Array.isArray(points) ? points : points.data;

    const insights = computeEconomicSeriesInsights(
      dataPoints.map((point) => ({
        recordedAt: point.recordedAt,
        value:
          typeof point.value === "number" ? point.value : Number(point.value),
        unit: point.unit,
        sourceField: point.sourceField,
        item: {
          slug: point.item.slug,
          defaultUnit: point.item.defaultUnit,
        },
      })),
    );

    return insights.map((insight) => ({
      itemSlug: insight.itemSlug,
      seriesKey: insight.seriesKey,
      sourceField: insight.sourceField,
      unit: insight.unit,
      sampleCount: insight.sampleCount,
      currentValue: insight.currentValue,
      previousValue: insight.previousValue,
      change: insight.change,
      percentChange: insight.percentChange,
      mean: insight.mean,
      stdDev: insight.stdDev,
      zScore: insight.zScore,
      direction: insight.direction as EconomicInsightDirection,
      classification: insight.classification as EconomicInsightClassification,
      message: insight.message,
    }));
  }

  @HasPermission("economicdata.read")
  @Query(() => PaginatedEconomicDataPointsModel)
  async getEconomicDataPaginated(
    @Args("category") category: string,
    @Args("timeRange") timeRange: DateRangeInput,
    @Args("granularity", { type: () => TimeGranularity, nullable: true })
    granularity?: TimeGranularity,
    @Args("pagination", { type: () => PaginationInput, nullable: true })
    pagination?: PaginationInput,
  ): Promise<PaginatedEconomicDataPointsModel> {
    const start = new Date(timeRange.start);
    const end = new Date(timeRange.end);
    const result = (await this.akshareService.getDataByCategory(
      category,
      start,
      end,
      granularity,
      pagination ?? { limit: 100 },
    )) as PaginatedResult<{
      recordedAt: Date;
      value: { toNumber(): number } | number;
      unit: string | null;
      sourceField: string;
      dataType: EconomicDataValueType;
      item: {
        slug: string;
        displayName: string;
        groupLabel: string | null;
        defaultUnit: string | null;
        defaultFrequency: EconomicDataFrequency;
        metadata: unknown;
      };
    }>;

    const dataPoints = result.data.map((point) => ({
      timestamp: point.recordedAt,
      effectiveGranularity: this.resolveEffectiveGranularity(
        granularity,
        point.item?.defaultFrequency,
      ),
      value:
        typeof point.value === "number" ? point.value : Number(point.value),
      unit: point.unit,
      sourceField: point.sourceField,
      dataType: point.dataType,
      item: this.mapItemToModel(point.item),
    }));

    return {
      data: dataPoints,
      pagination: {
        hasMore: result.pagination.hasMore,
        nextCursor: result.pagination.nextCursor,
        totalCount: result.pagination.totalCount,
      },
    };
  }

  @HasPermission("economicdata.manage")
  @Query(() => [EconomicDataFetchConfigModel])
  async economicDataFetchConfigs(): Promise<EconomicDataFetchConfigModel[]> {
    const configs = await this.akshareService.listFetchConfigs();
    return configs.map((config) => ({
      id: config.id,
      frequency: config.frequency,
      repeatCron: config.repeatCron,
      isEnabled: config.isEnabled,
      lastRunAt: config.lastRunAt ?? undefined,
      lastStatus: config.lastStatus ?? undefined,
      lastError: config.lastError ?? undefined,
      item: this.mapItemToModel(config.item),
    }));
  }

  @HasPermission("economicdata.manage")
  @Query(() => EconomicDataRefreshPresetStatusModel)
  async economicDataRefreshPresetStatus(
    @Args("preset", { type: () => EconomicDashboardRefreshPreset })
    preset: EconomicDashboardRefreshPreset,
  ): Promise<EconomicDataRefreshPresetStatusModel> {
    const summary = await this.akshareService.getRefreshPresetStatus(
      preset as unknown as EconomicDashboardRefreshPresetValue,
    );
    return {
      ...summary,
      preset,
    };
  }

  @HasPermission("economicdata.manage")
  @Mutation(() => EconomicDataFetchConfigModel)
  async updateEconomicDataFetchConfig(
    @Args("slug") slug: string,
    @Args("frequency", { type: () => EconomicDataFrequency, nullable: true })
    frequency?: EconomicDataFrequency,
    @Args("repeatCron", { nullable: true }) repeatCron?: string,
    @Args("isEnabled", { nullable: true }) isEnabled?: boolean,
  ): Promise<EconomicDataFetchConfigModel> {
    const updated = await this.akshareService.updateFetchConfig(slug, {
      frequency,
      repeatCron: repeatCron ?? null,
      isEnabled,
    });
    const rawItem = updated.item ?? { slug };
    const itemSlug =
      typeof rawItem?.slug === "string" && rawItem.slug.trim()
        ? rawItem.slug
        : slug;
    return {
      id: updated.id,
      frequency: updated.frequency,
      repeatCron: updated.repeatCron,
      isEnabled: updated.isEnabled,
      lastRunAt: updated.lastRunAt ?? undefined,
      lastStatus: updated.lastStatus ?? undefined,
      lastError: updated.lastError ?? undefined,
      item: this.mapItemToModel({ ...rawItem, slug: itemSlug }),
    };
  }

  @HasPermission("economicdata.manage")
  @Mutation(() => Boolean)
  async triggerDataFetch(
    @Args("input") input: TriggerDataFetchInput,
  ): Promise<boolean> {
    await this.akshareService.triggerDataFetch(input.slugs);
    return true;
  }

  @HasPermission("economicdata.manage")
  @Mutation(() => Boolean)
  async triggerEconomicDataRefreshPreset(
    @Context("req") req: GqlRequest,
    @Args("preset", { type: () => EconomicDashboardRefreshPreset })
    preset: EconomicDashboardRefreshPreset,
  ): Promise<boolean> {
    const requester = this.requireUser(req);
    await this.actionRateLimit.enforceEconomicDataRefreshPreset(
      requester.orgId,
      preset as unknown as EconomicDashboardRefreshPresetValue,
    );
    await this.akshareService.triggerDataFetchForPreset(
      preset as unknown as EconomicDashboardRefreshPresetValue,
      {
        actorId: requester.id,
        orgId: requester.orgId,
        ipAddress: resolveRequestIp(req) ?? null,
      },
    );
    return true;
  }
}
