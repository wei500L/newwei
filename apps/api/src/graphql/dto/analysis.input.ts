import { Field, Float, InputType, Int } from "@nestjs/graphql";
import { AnalysisType } from "../models/analysis.model";

@InputType()
export class CorrelationAnalysisInput {
  @Field()
  indicatorName!: string;

  @Field(() => Float)
  value!: number;

  @Field(() => Float)
  changePercent!: number;

  @Field()
  startDate!: string;

  @Field()
  endDate!: string;

  @Field(() => [String])
  newsSummaries!: string[];
}

@InputType()
export class SeriesPointInput {
  @Field()
  timestamp!: string;

  @Field(() => Float)
  value!: number;
}

@InputType()
export class AnomalyAnalysisInput {
  @Field()
  metric!: string;

  @Field()
  timestamp!: string;

  @Field(() => Float)
  value!: number;

  @Field(() => Float)
  deviationPercent!: number;

  @Field(() => [String])
  newsList!: string[];

  @Field(() => [String])
  policyList!: string[];

  @Field(() => [SeriesPointInput], { nullable: true })
  series?: SeriesPointInput[];
}

@InputType()
export class AnalysisFilterInput {
  @Field(() => AnalysisType, { nullable: true })
  type?: AnalysisType;

  @Field(() => Int, { nullable: true })
  limit?: number;
}
