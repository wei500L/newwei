import { Field, GraphQLInt, GraphQLISODateTime, ObjectType, registerEnumType } from "@nestjs/graphql";
import { HasPermission } from "../decorators/has-permission.decorator";
import { DashboardWidgetType } from "@prisma/client";
import GraphQLJSON from "graphql-type-json";

registerEnumType(DashboardWidgetType, { name: "DashboardWidgetType" });

@ObjectType()
export class QueueCountsModel {
  @Field(() => GraphQLInt)
  waiting!: number;

  @Field(() => GraphQLInt)
  active!: number;

  @Field(() => GraphQLInt)
  completed!: number;

  @Field(() => GraphQLInt)
  failed!: number;

  @Field(() => GraphQLInt)
  delayed!: number;
}

@ObjectType()
export class QueueStatsModel {
  @HasPermission("queue.manage")
  @Field(() => QueueCountsModel)
  counts!: QueueCountsModel;

  @Field(() => GraphQLInt)
  processedCount!: number;

  @Field(() => GraphQLInt)
  itemCount!: number;

  @HasPermission("queue.manage")
  @Field(() => [QueueEventModel])
  recentLogs!: QueueEventModel[];
}

@ObjectType()
export class QueueEventModel {
  @Field()
  event!: string;

  @Field()
  jobId!: string;

  @Field({ nullable: true })
  data?: string;

  @Field()
  timestamp!: string;
}

@ObjectType()
export class DashboardWidgetModel {
  @Field()
  id!: string;

  @Field({ nullable: true })
  title?: string;

  @Field(() => DashboardWidgetType)
  type!: DashboardWidgetType;

  @Field()
  dataSource!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  dataConfig?: Record<string, unknown>;

  @Field()
  layoutX!: number;

  @Field()
  layoutY!: number;

  @Field()
  layoutW!: number;

  @Field()
  layoutH!: number;

  @Field()
  sortOrder!: number;

  @Field(() => GraphQLJSON, { nullable: true })
  options?: Record<string, unknown>;
}

@ObjectType()
export class DashboardModel {
  @Field()
  id!: string;

  @Field()
  name!: string;

  @Field()
  slug!: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  theme?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  config?: Record<string, unknown>;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => [DashboardWidgetModel])
  widgets!: DashboardWidgetModel[];
}
