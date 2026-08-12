import { Field, GraphQLISODateTime, Int, ObjectType, registerEnumType } from "@nestjs/graphql";
import { DashboardWidgetType } from "@prisma/client";
import GraphQLJSONScalar from "graphql-type-json";

import { HasPermission } from "../decorators/has-permission.decorator";

registerEnumType(DashboardWidgetType, { name: "DashboardWidgetType" });

@ObjectType()
export class QueueCountsModel {
  @Field(() => Int)
  waiting!: number;

  @Field(() => Int)
  active!: number;

  @Field(() => Int)
  completed!: number;

  @Field(() => Int)
  failed!: number;

  @Field(() => Int)
  delayed!: number;
}

@ObjectType()
export class QueueStatsModel {
  @HasPermission("queue.manage")
  @Field(() => QueueCountsModel)
  counts!: QueueCountsModel;

  /** False when the org queue counters could not be read (Redis failure) —
   * consumers must not treat all-zero counts as "queue healthy". */
  @Field(() => Boolean)
  countsAvailable!: boolean;

  @Field(() => Int)
  processedCount!: number;

  @Field(() => Int)
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

  @Field(() => String, { nullable: true })
  data?: string | null;

  @Field()
  timestamp!: string;
}

@ObjectType()
export class DashboardWidgetModel {
  @Field()
  id!: string;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => DashboardWidgetType)
  type!: DashboardWidgetType;

  @Field()
  dataSource!: string;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  dataConfig?: Record<string, unknown> | null;

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

  @Field(() => GraphQLJSONScalar, { nullable: true })
  options?: Record<string, unknown> | null;
}

@ObjectType()
export class DashboardModel {
  @Field()
  id!: string;

  @Field(() => Int)
  version!: number;

  @Field()
  name!: string;

  @Field()
  slug!: string;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => String, { nullable: true })
  theme?: string | null;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  config?: Record<string, unknown> | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => [DashboardWidgetModel])
  widgets!: DashboardWidgetModel[];
}
