import { Field, Float, GraphQLISODateTime, Int, ObjectType, registerEnumType } from "@nestjs/graphql";
import { EconomicDataFrequency, EconomicDataRunStatus, EconomicDataValueType } from "@prisma/client";
import GraphQLJSONScalar from "graphql-type-json";

export enum TimeGranularity {
  year = "year",
  quarter = "quarter",
  month = "month",
  week = "week",
  day = "day"
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
