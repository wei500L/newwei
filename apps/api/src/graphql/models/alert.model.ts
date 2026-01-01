import { Field, GraphQLISODateTime, ObjectType, registerEnumType } from "@nestjs/graphql";
import {
  AlertChannelType,
  AlertDeliveryStatus,
  AlertEventStatus,
  AlertMetricProvider,
  AlertOperator,
  AlertSeverity,
  AlertStatus
} from "@prisma/client";
import GraphQLJSONScalar from "graphql-type-json";

registerEnumType(AlertSeverity, { name: "AlertSeverity" });
registerEnumType(AlertStatus, { name: "AlertStatus" });
registerEnumType(AlertOperator, { name: "AlertOperator" });
registerEnumType(AlertMetricProvider, { name: "AlertMetricProvider" });
registerEnumType(AlertChannelType, { name: "AlertChannelType" });
registerEnumType(AlertEventStatus, { name: "AlertEventStatus" });
registerEnumType(AlertDeliveryStatus, { name: "AlertDeliveryStatus" });

@ObjectType()
export class AlertChannelModel {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field(() => AlertChannelType)
  type!: AlertChannelType;

  @Field()
  target!: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class AlertDeliveryModel {
  @Field()
  id!: string;

  @Field(() => AlertDeliveryStatus)
  status!: AlertDeliveryStatus;

  @Field({ nullable: true })
  error?: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  sentAt?: Date;

  @Field(() => AlertChannelType)
  channelType!: AlertChannelType;
}

@ObjectType()
export class AlertEventModel {
  @Field()
  id!: string;

  @Field(() => GraphQLISODateTime)
  triggeredAt!: Date;

  @Field()
  metricValue!: number;

  @Field(() => Number, { nullable: true })
  changePercent?: number | null;

  @Field(() => AlertSeverity)
  severity!: AlertSeverity;

  @Field(() => AlertEventStatus)
  status!: AlertEventStatus;

  @Field({ nullable: true })
  message?: string;

  @Field({ nullable: true })
  ruleId?: string;

  @Field({ nullable: true })
  ruleName?: string;

  @Field(() => AlertMetricProvider, { nullable: true })
  metricProvider?: AlertMetricProvider;

  @Field({ nullable: true })
  metricSlug?: string;

  @Field(() => AlertOperator, { nullable: true })
  operator?: AlertOperator;

  @Field(() => Number, { nullable: true })
  thresholdValue?: number | null;

  @Field(() => Number, { nullable: true })
  thresholdLower?: number | null;

  @Field(() => Number, { nullable: true })
  thresholdUpper?: number | null;

  @Field(() => Number, { nullable: true })
  changeWindowMin?: number | null;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  context?: Record<string, unknown>;

  @Field(() => [AlertDeliveryModel])
  deliveries!: AlertDeliveryModel[];
}

@ObjectType()
export class AlertRuleModel {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  @Field(() => AlertSeverity)
  severity!: AlertSeverity;

  @Field(() => AlertStatus)
  status!: AlertStatus;

  @Field(() => AlertMetricProvider)
  metricProvider!: AlertMetricProvider;

  @Field()
  metricSlug!: string;

  @Field(() => AlertOperator)
  operator!: AlertOperator;

  @Field(() => Number, { nullable: true })
  thresholdValue?: number | null;

  @Field(() => Number, { nullable: true })
  thresholdLower?: number | null;

  @Field(() => Number, { nullable: true })
  thresholdUpper?: number | null;

  @Field(() => Number, { nullable: true })
  changeWindowMin?: number | null;

  @Field()
  cooldownSeconds!: number;

  @Field()
  checkIntervalSec!: number;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastTriggeredAt?: Date | null;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  metadata?: Record<string, unknown>;

  @Field(() => [AlertChannelModel])
  channels!: AlertChannelModel[];
}
