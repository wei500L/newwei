import { Field, GraphQLInt, ObjectType } from "@nestjs/graphql";
import { HasPermission } from "../decorators/has-permission.decorator";

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
