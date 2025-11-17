import { Field, InputType, Int } from "@nestjs/graphql";
import { AlertChannelType, AlertOperator, AlertSeverity, AlertStatus } from "@prisma/client";
import GraphQLJSON from "graphql-type-json";

@InputType()
export class AlertChannelInput {
  @Field(() => AlertChannelType)
  type!: AlertChannelType;

  @Field()
  name!: string;

  @Field()
  target!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  config?: Record<string, unknown>;
}

@InputType()
export class UpsertAlertRuleInput {
  @Field({ nullable: true })
  id?: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => AlertSeverity, { nullable: true })
  severity?: AlertSeverity;

  @Field(() => AlertStatus, { nullable: true })
  status?: AlertStatus;

  @Field()
  metricSlug!: string;

  @Field(() => AlertOperator)
  operator!: AlertOperator;

  @Field({ nullable: true })
  thresholdValue?: number;

  @Field({ nullable: true })
  thresholdLower?: number;

  @Field({ nullable: true })
  thresholdUpper?: number;

  @Field(() => Int, { nullable: true })
  changeWindowMin?: number;

  @Field(() => Int, { nullable: true })
  cooldownSeconds?: number;

  @Field(() => Int, { nullable: true })
  checkIntervalSec?: number;

  @Field(() => [String], { nullable: true })
  channelIds?: string[];

  @Field(() => GraphQLJSON, { nullable: true })
  metadata?: Record<string, unknown>;
}
