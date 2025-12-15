import { Field, Float, GraphQLISODateTime, ObjectType, registerEnumType } from "@nestjs/graphql";
import { EconomicDataFrequency, EconomicDataRunStatus, EconomicDataValueType } from "@prisma/client";

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
