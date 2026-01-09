import { Field, InputType, Int } from "@nestjs/graphql";
import {
  AlertChannelType,
  AlertEventStatus,
  AlertMetricProvider,
  AlertOperator,
  AlertSeverity,
  AlertStatus
} from "@prisma/client";
import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from "class-validator";
import GraphQLJSONScalar from "graphql-type-json";

@InputType()
export class AlertChannelInput {
  @Field(() => AlertChannelType)
  @IsEnum(AlertChannelType)
  type!: AlertChannelType;

  @Field()
  @IsString()
  @MaxLength(80)
  name!: string;

  @Field()
  @IsString()
  target!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  @IsOptional()
  config?: Record<string, unknown> | null;
}

@InputType()
export class UpdateAlertChannelInput {
  @Field()
  @IsString()
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  target?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  @IsOptional()
  config?: Record<string, unknown> | null;
}

@InputType()
export class UpsertAlertRuleInput {
  @Field({ nullable: true })
  id?: string;

  @Field()
  @IsString()
  @MaxLength(120)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @Field(() => AlertSeverity, { nullable: true })
  @IsOptional()
  @IsEnum(AlertSeverity)
  severity?: AlertSeverity;

  @Field(() => AlertStatus, { nullable: true })
  @IsOptional()
  @IsEnum(AlertStatus)
  status?: AlertStatus;

  @Field(() => AlertMetricProvider, { nullable: true })
  @IsOptional()
  @IsEnum(AlertMetricProvider)
  metricProvider?: AlertMetricProvider;

  @Field()
  @IsString()
  metricSlug!: string;

  @Field(() => AlertOperator)
  @IsEnum(AlertOperator)
  operator!: AlertOperator;

  @Field({ nullable: true })
  @IsOptional()
  @IsNumber()
  thresholdValue?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsNumber()
  thresholdLower?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsNumber()
  thresholdUpper?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsPositive()
  changeWindowMin?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsPositive()
  cooldownSeconds?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsPositive()
  checkIntervalSec?: number;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channelIds?: string[];

  @Field(() => GraphQLJSONScalar, { nullable: true })
  @IsOptional()
  metadata?: Record<string, unknown>;
}

@InputType()
export class UpdateAlertEventStatusInput {
  @Field()
  @IsString()
  eventId!: string;

  @Field(() => AlertEventStatus)
  @IsEnum(AlertEventStatus)
  status!: AlertEventStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
