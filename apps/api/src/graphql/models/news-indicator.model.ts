import { Field, Float, GraphQLISODateTime, Int, ObjectType, registerEnumType } from "@nestjs/graphql";
import {
  NewsIndicatorBacktestStatus,
  NewsIndicatorFeatureMetric,
  NewsIndicatorScopeType
} from "@prisma/client";
import GraphQLJSONScalar from "graphql-type-json";

import { EconomicDataItemModel } from "./economic-data.model";

registerEnumType(NewsIndicatorScopeType, { name: "NewsIndicatorScopeType" });
registerEnumType(NewsIndicatorFeatureMetric, { name: "NewsIndicatorFeatureMetric" });
registerEnumType(NewsIndicatorBacktestStatus, { name: "NewsIndicatorBacktestStatus" });

@ObjectType()
export class NewsIndicatorAssociationBacktestRunModel {
  @Field()
  id!: string;

  @Field(() => NewsIndicatorBacktestStatus)
  status!: NewsIndicatorBacktestStatus;

  @Field(() => GraphQLISODateTime)
  windowStart!: Date;

  @Field(() => GraphQLISODateTime)
  windowEnd!: Date;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  config?: unknown;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  metrics?: unknown;

  @Field(() => String, { nullable: true })
  error?: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class NewsIndicatorAssociationModel {
  @Field()
  id!: string;

  @Field(() => NewsIndicatorScopeType)
  scopeType!: NewsIndicatorScopeType;

  @Field()
  scopeKey!: string;

  @Field()
  scopeKeyType!: string;

  @Field(() => NewsIndicatorFeatureMetric)
  featureMetric!: NewsIndicatorFeatureMetric;

  @Field(() => EconomicDataItemModel)
  indicator!: EconomicDataItemModel;

  @Field(() => Int)
  windowDays!: number;

  @Field(() => Int)
  lagDays!: number;

  @Field(() => Float)
  correlation!: number;

  @Field(() => Float, { nullable: true })
  pValue?: number | null;

  @Field(() => Int)
  sampleSize!: number;

  @Field(() => GraphQLISODateTime)
  analyzedStartAt!: Date;

  @Field(() => GraphQLISODateTime)
  analyzedEndAt!: Date;

  @Field(() => GraphQLISODateTime)
  lastEvaluatedAt!: Date;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  metadata?: unknown;

  @Field(() => NewsIndicatorAssociationBacktestRunModel, { nullable: true })
  latestBacktest?: NewsIndicatorAssociationBacktestRunModel | null;

  @Field(() => [NewsIndicatorAssociationBacktestRunModel], { nullable: true })
  backtests?: NewsIndicatorAssociationBacktestRunModel[];
}

