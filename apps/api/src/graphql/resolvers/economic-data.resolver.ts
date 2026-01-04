import { UseGuards } from "@nestjs/common";
import { Args, Mutation, Query, Resolver } from "@nestjs/graphql";
import { EconomicDataFrequency } from "@prisma/client";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { AkshareService } from "../../modules/akshare/akshare.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import { DateRangeInput, TriggerDataFetchInput } from "../dto/economic-data.input";
import { EconomicDataFetchConfigModel, EconomicDataPointModel, TimeGranularity } from "../models/economic-data.model";


@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class EconomicDataResolver {
  constructor(private readonly akshareService: AkshareService) {}

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
    return points.map((point) => ({
      timestamp: point.recordedAt,
      value: Number(point.value),
      unit: point.unit,
      sourceField: point.sourceField,
      dataType: point.dataType,
      item: {
        slug: point.item.slug,
        displayName: point.item.displayName,
        groupLabel: point.item.groupLabel ?? undefined,
        defaultUnit: point.item.defaultUnit ?? null,
        metadata: (point.item.metadata as Record<string, unknown> | null) ?? null
      }
    }));
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
      item: {
        slug: config.item.slug,
        displayName: config.item.displayName,
        groupLabel: config.item.groupLabel ?? undefined,
        defaultUnit: config.item.defaultUnit ?? null,
        metadata: (config.item.metadata as Record<string, unknown> | null) ?? null
      }
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
      item: {
        slug,
        displayName: updated.item?.displayName ?? slug,
        groupLabel: updated.item?.groupLabel ?? undefined,
        defaultUnit: updated.item?.defaultUnit ?? null,
        metadata: (updated.item?.metadata as Record<string, unknown> | null) ?? null
      }
    };
  }

  @HasPermission("economicdata.manage")
  @Mutation(() => Boolean)
  async triggerDataFetch(@Args("input") input: TriggerDataFetchInput): Promise<boolean> {
    await this.akshareService.triggerDataFetch(input.slugs);
    return true;
  }
}
