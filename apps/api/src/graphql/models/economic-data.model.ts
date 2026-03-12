import { Field, Float, GraphQLISODateTime, Int, ObjectType, registerEnumType } from "@nestjs/graphql";
import { EconomicDataFrequency, EconomicDataRunStatus, EconomicDataValueType } from "@prisma/client";
import GraphQLJSONScalar from "graphql-type-json";

export enum TimeGranularity {
  year = "year",
  quarter = "quarter",
  month = "month",
  week = "week",
  day = "day",
  hour = "hour",
  minute = "minute",
  realtime = "realtime"
}

export enum EconomicDashboardRefreshPreset {
  keyMonitor = "keyMonitor",
  militaryAlert = "militaryAlert",
  economicAlert = "economicAlert",
  economicShort = "economicShort",
  economicMedium = "economicMedium",
  economicLong = "economicLong",
  livelihoodPrices = "livelihoodPrices"
}

registerEnumType(EconomicDataFrequency, {
  name: "EconomicDataFrequency"
});

registerEnumType(EconomicDataRunStatus, {
  name: "EconomicDataRunStatus"
});

registerEnumType(EconomicDataValueType, {
  name: "EconomicDataValueType"
});

registerEnumType(TimeGranularity, { name: "TimeGranularity" });
registerEnumType(EconomicDashboardRefreshPreset, {
  name: "EconomicDashboardRefreshPreset"
});

@ObjectType()
export class EconomicDataItemModel {
  @Field()
  slug!: string;

  @Field()
  displayName!: string;

  @Field({ nullable: true })
  groupLabel?: string;

  @Field(() => String, { nullable: true })
  defaultUnit?: string | null;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  metadata?: Record<string, unknown> | null;
}

@ObjectType()
export class EconomicDataPointModel {
  @Field(() => GraphQLISODateTime)
  timestamp!: Date;

  @Field(() => TimeGranularity, {
    description:
      "Effective aggregation granularity agreed by the backend and used to produce this time series."
  })
  effectiveGranularity!: TimeGranularity;

  @Field(() => Float)
  value!: number;

  @Field(() => String, { nullable: true })
  unit?: string | null;

  @Field(() => String, { nullable: true })
  sourceField?: string | null;

  @Field(() => EconomicDataValueType)
  dataType!: EconomicDataValueType;

  @Field(() => EconomicDataItemModel)
  item!: EconomicDataItemModel;
}

@ObjectType({ description: "Pagination metadata for cursor-based pagination" })
export class PaginationMetaModel {
  @Field(() => Boolean, { description: "Whether there are more results available" })
  hasMore!: boolean;

  @Field(() => String, { nullable: true, description: "Cursor for fetching the next page" })
  nextCursor?: string;

  @Field(() => Int, { nullable: true, description: "Total count of items (optional)" })
  totalCount?: number;
}

@ObjectType({ description: "Paginated economic data points result" })
export class PaginatedEconomicDataPointsModel {
  @Field(() => [EconomicDataPointModel], { description: "Array of economic data points" })
  data!: EconomicDataPointModel[];

  @Field(() => PaginationMetaModel, { description: "Pagination metadata" })
  pagination!: PaginationMetaModel;
}

@ObjectType()
export class EconomicDataFetchConfigModel {
  @Field()
  id!: string;

  @Field(() => EconomicDataFrequency)
  frequency!: EconomicDataFrequency;

  @Field(() => String, { nullable: true })
  repeatCron?: string | null;

  @Field()
  isEnabled!: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastRunAt?: Date | null;

  @Field(() => EconomicDataRunStatus, { nullable: true })
  lastStatus?: EconomicDataRunStatus | null;

  @Field(() => String, { nullable: true })
  lastError?: string | null;

  @Field(() => EconomicDataItemModel)
  item!: EconomicDataItemModel;
}

@ObjectType()
export class EconomicDataRefreshPresetStatusModel {
  @Field(() => EconomicDashboardRefreshPreset)
  preset!: EconomicDashboardRefreshPreset;

  @Field()
  categoryKey!: string;

  @Field(() => Int)
  totalItems!: number;

  @Field(() => Int)
  enabledItems!: number;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastRunAt?: Date | null;

  @Field(() => EconomicDataRunStatus, { nullable: true })
  lastStatus?: EconomicDataRunStatus | null;

  @Field(() => String, { nullable: true })
  lastError?: string | null;
}
