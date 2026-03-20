import { Field, Float, InputType, Int } from "@nestjs/graphql";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min
} from "class-validator";

import { AnalysisType, GeoTransportKind } from "../models/analysis.model";

@InputType()
export class CorrelationAnalysisInput {
  @Field()
  @IsString()
  indicatorName!: string;

  @Field(() => Float)
  @IsNumber()
  value!: number;

  @Field(() => Float)
  @IsNumber()
  changePercent!: number;

  @Field()
  @IsString()
  startDate!: string;

  @Field()
  @IsString()
  endDate!: string;

  @Field(() => [String])
  @IsArray()
  @IsString({ each: true })
  newsSummaries!: string[];
}

@InputType()
export class SeriesPointInput {
  @Field()
  @IsString()
  timestamp!: string;

  @Field(() => Float)
  @IsNumber()
  value!: number;
}

@InputType()
export class AnomalyAnalysisInput {
  @Field()
  @IsString()
  metric!: string;

  @Field()
  @IsString()
  timestamp!: string;

  @Field(() => Float)
  @IsNumber()
  value!: number;

  @Field(() => Float)
  @IsNumber()
  deviationPercent!: number;

  @Field(() => [String])
  @IsArray()
  @IsString({ each: true })
  newsList!: string[];

  @Field(() => [String])
  @IsArray()
  @IsString({ each: true })
  policyList!: string[];

  @Field(() => [SeriesPointInput], { nullable: true })
  @IsOptional()
  @IsArray()
  series?: SeriesPointInput[];
}

@InputType()
export class GeoTransportAnalysisInput {
  @Field(() => [GeoTransportKind])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @IsEnum(GeoTransportKind, { each: true })
  transportKinds!: GeoTransportKind[];

  @Field()
  @IsString()
  startDate!: string;

  @Field()
  @IsString()
  endDate!: string;

  @Field(() => [Float], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(4)
  @ArrayMaxSize(4)
  @IsNumber({}, { each: true })
  bbox?: number[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  objectKeys?: string[];
}

@InputType()
export class AnalysisFilterInput {
  @Field(() => AnalysisType, { nullable: true })
  @IsOptional()
  @IsEnum(AnalysisType)
  type?: AnalysisType;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
