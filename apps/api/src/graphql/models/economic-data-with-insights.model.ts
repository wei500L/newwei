import { Field, ObjectType } from "@nestjs/graphql";

import { EconomicDataPointModel } from "./economic-data.model";
import { EconomicSeriesInsightModel } from "./economic-insights.model";

@ObjectType()
export class EconomicDataWithInsightsModel {
  @Field(() => [EconomicDataPointModel])
  points!: EconomicDataPointModel[];

  @Field(() => [EconomicSeriesInsightModel])
  insights!: EconomicSeriesInsightModel[];
}

