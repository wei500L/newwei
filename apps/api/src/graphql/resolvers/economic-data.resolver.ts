import { UseGuards } from "@nestjs/common";
import { Args, Mutation, Query, Resolver } from "@nestjs/graphql";
import { EconomicDataFrequency, EconomicDataValueType } from "@prisma/client";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { AkshareService } from "../../modules/akshare/akshare.service";
import { PaginatedResult } from "../../modules/akshare/akshare.types";
import { HasPermission } from "../decorators/has-permission.decorator";
import { DateRangeInput, PaginationInput, TriggerDataFetchInput } from "../dto/economic-data.input";
import { EconomicDataFetchConfigModel, EconomicDataPointModel, PaginatedEconomicDataPointsModel, TimeGranularity } from "../models/economic-data.model";
import { parseMetadata } from "../schemas/economic-data.schema";


@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class EconomicDataResolver {
  constructor(private readonly akshareService: AkshareService) {}

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
      metadata: parseMetadata(item.metadata)
    };
  }

  @HasPermission("economicdata.read")
  @Query(() => [EconomicDataPointModel])
  async getEconomicData(
    @Args("category") category: string,
    @Args("timeRange") timeRange: DateRangeInput,
    @Args("granularity", { type: () => TimeGranularity, nullable: true }) granularity?: TimeGranularity
  ): Promise<EconomicDataPointModel[]> {
    const start = new Date(timeRange.start);
    const end = new Date(timeRange.end);
    const points = await this.akshareService.getDataByCategory(category, start, end, granularity);
    // Handle both legacy array return and paginated result
    const dataPoints = Array.isArray(points) ? points : points.data;
    return dataPoints.map((point) => ({
      timestamp: point.recordedAt,
      value: Number(point.value),
      unit: point.unit,
      sourceField: point.sourceField,
      dataType: point.dataType,
      item: this.mapItemToModel(point.item)
    }));
  }

  @HasPermission("economicdata.read")
  @Query(() => PaginatedEconomicDataPointsModel)
  async getEconomicDataPaginated(
    @Args("category") category: string,
    @Args("timeRange") timeRange: DateRangeInput,
    @Args("granularity", { type: () => TimeGranularity, nullable: true }) granularity?: TimeGranularity,
    @Args("pagination", { type: () => PaginationInput, nullable: true }) pagination?: PaginationInput
  ): Promise<PaginatedEconomicDataPointsModel> {
    const start = new Date(timeRange.start);
    const end = new Date(timeRange.end);
    const result = await this.akshareService.getDataByCategory(
      category,
      start,
      end,
      granularity,
      pagination ?? { limit: 100 }
    ) as PaginatedResult<{
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
        metadata: unknown;
      };
    }>;

    const dataPoints = result.data.map((point) => ({
      timestamp: point.recordedAt,
      value: typeof point.value === "number" ? point.value : Number(point.value),
      unit: point.unit,
      sourceField: point.sourceField,
      dataType: point.dataType,
      item: this.mapItemToModel(point.item)
    }));

    return {
      data: dataPoints,
      pagination: {
        hasMore: result.pagination.hasMore,
        nextCursor: result.pagination.nextCursor,
        totalCount: result.pagination.totalCount
      }
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
      item: this.mapItemToModel(config.item)
    }));
  }

  @HasPermission("economicdata.manage")
  @Mutation(() => EconomicDataFetchConfigModel)
  async updateEconomicDataFetchConfig(
    @Args("slug") slug: string,
    @Args("frequency", { type: () => EconomicDataFrequency, nullable: true }) frequency?: EconomicDataFrequency,
    @Args("repeatCron", { nullable: true }) repeatCron?: string,
    @Args("isEnabled", { nullable: true }) isEnabled?: boolean
  ): Promise<EconomicDataFetchConfigModel> {
    const updated = await this.akshareService.updateFetchConfig(slug, {
      frequency,
      repeatCron: repeatCron ?? null,
      isEnabled
    });
    return {
      id: updated.id,
      frequency: updated.frequency,
      repeatCron: updated.repeatCron,
      isEnabled: updated.isEnabled,
      lastRunAt: updated.lastRunAt ?? undefined,
      lastStatus: updated.lastStatus ?? undefined,
      lastError: updated.lastError ?? undefined,
      item: this.mapItemToModel(updated.item ?? { slug })
    };
  }

  @HasPermission("economicdata.manage")
  @Mutation(() => Boolean)
  async triggerDataFetch(@Args("input") input: TriggerDataFetchInput): Promise<boolean> {
    await this.akshareService.triggerDataFetch(input.slugs);
    return true;
  }
}
