import { Field, Float, InputType, Int, registerEnumType } from "@nestjs/graphql";
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min } from "class-validator";

import { AssistantRunType } from "../models/assistant.model";

@InputType()
export class AssistantQueryInput {
  @Field()
  @IsString()
  message!: string;
}

export enum AssistantReportPeriod {
  daily = "daily",
  weekly = "weekly"
}

registerEnumType(AssistantReportPeriod, { name: "AssistantReportPeriod" });

@InputType()
export class AssistantReportInput {
  @Field(() => AssistantReportPeriod)
  @IsEnum(AssistantReportPeriod)
  period!: AssistantReportPeriod;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  topic?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

export enum AssistantForecastModelKind {
  ets = "ets",
  arima = "arima"
}

registerEnumType(AssistantForecastModelKind, { name: "AssistantForecastModelKind" });

@InputType()
export class AssistantForecastInput {
  @Field()
  @IsString()
  series!: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(7)
  lookbackDays?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  sourceField?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  seasonalPeriod?: number;

  @Field(() => AssistantForecastModelKind, { nullable: true })
  @IsOptional()
  @IsEnum(AssistantForecastModelKind)
  modelKind?: AssistantForecastModelKind;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(0.999)
  confidenceLevel?: number;
}

@InputType()
export class AssistantFilterInput {
  @Field(() => AssistantRunType, { nullable: true })
  @IsOptional()
  @IsEnum(AssistantRunType)
  type?: AssistantRunType;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
