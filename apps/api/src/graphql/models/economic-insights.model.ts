import { Field, Float, Int, ObjectType, registerEnumType } from "@nestjs/graphql";

export enum EconomicInsightDirection {
  up = "up",
  down = "down",
  flat = "flat"
}

export enum EconomicInsightClassification {
  insufficient_data = "insufficient_data",
  stable = "stable",
  trend = "trend",
  volatility = "volatility",
  anomaly = "anomaly"
}

registerEnumType(EconomicInsightDirection, { name: "EconomicInsightDirection" });
registerEnumType(EconomicInsightClassification, { name: "EconomicInsightClassification" });

@ObjectType()
export class EconomicSeriesInsightModel {
  @Field()
  itemSlug!: string;

  @Field()
  seriesKey!: string;

  @Field(() => String, { nullable: true })
  sourceField?: string | null;

  @Field(() => String, { nullable: true })
  unit?: string | null;

  @Field(() => Int)
  sampleCount!: number;

  @Field(() => Float, { nullable: true })
  currentValue?: number | null;

  @Field(() => Float, { nullable: true })
  previousValue?: number | null;

  @Field(() => Float, { nullable: true })
  change?: number | null;

  @Field(() => Float, { nullable: true })
  percentChange?: number | null;

  @Field(() => Float, { nullable: true })
  mean?: number | null;

  @Field(() => Float, { nullable: true })
  stdDev?: number | null;

  @Field(() => Float, { nullable: true })
  zScore?: number | null;

  @Field(() => EconomicInsightDirection)
  direction!: EconomicInsightDirection;

  @Field(() => EconomicInsightClassification)
  classification!: EconomicInsightClassification;

  @Field()
  message!: string;
}

