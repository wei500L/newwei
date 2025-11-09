import { Field, GraphQLISODateTime, ID, ObjectType } from "@nestjs/graphql";
import { CrawlTaskStatus } from "@prisma/client";
import { PageInfo } from "./page-info.model";

@ObjectType()
export class CrawlMemoryStatsModel {
  @Field(() => Number, { nullable: true })
  serverMemoryMb?: number | null;

  @Field(() => Number, { nullable: true })
  peakMemoryMb?: number | null;

  @Field(() => Number, { nullable: true })
  efficiencyPercent?: number | null;
}

@ObjectType()
export class CrawlResultModel {
  @Field(() => ID)
  id!: string;

  @Field()
  sourceUrl!: string;

  @Field(() => GraphQLISODateTime)
  fetchedAt!: Date;

  @Field()
  markdown!: string;

  @Field({ nullable: true })
  metadata?: string;
}

@ObjectType()
export class CrawlTaskModel {
  @Field(() => ID)
  id!: string;

  @Field()
  targetUrl!: string;

  @Field({ nullable: true })
  displayName?: string | null;

  @Field(() => CrawlTaskStatus)
  status!: CrawlTaskStatus;

  @Field(() => [String])
  keywords!: string[];

  @Field(() => GraphQLISODateTime, { nullable: true })
  timeRangeFrom?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  timeRangeTo?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastRunAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastSuccessAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastResultAt?: Date | null;

  @Field({ nullable: true })
  lastCursor?: string | null;

  @Field({ nullable: true })
  lastError?: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => Number)
  concurrency!: number;

  @Field(() => Number)
  runCount!: number;

  @Field(() => Number)
  resultCount!: number;

  @Field({ nullable: true })
  config?: string | null;

  @Field(() => [CrawlResultModel], { nullable: true })
  results?: CrawlResultModel[];

  @Field(() => CrawlMemoryStatsModel, { nullable: true })
  memoryStats?: CrawlMemoryStatsModel | null;

  @Field(() => Number, { nullable: true })
  lastServerMemoryMb?: number | null;

  @Field(() => Number, { nullable: true })
  lastPeakMemoryMb?: number | null;

  @Field(() => Number, { nullable: true })
  lastMemoryEfficiency?: number | null;
}

@ObjectType()
export class CrawlTaskEdge {
  @Field()
  cursor!: string;

  @Field(() => CrawlTaskModel)
  node!: CrawlTaskModel;
}

@ObjectType()
export class CrawlTaskConnection {
  @Field(() => [CrawlTaskEdge])
  edges!: CrawlTaskEdge[];

  @Field(() => PageInfo)
  pageInfo!: PageInfo;

  @Field(() => Number)
  totalCount!: number;
}
