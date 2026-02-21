import { Field, Float, GraphQLISODateTime, Int, ObjectType, registerEnumType } from "@nestjs/graphql";
import { NewsEventAssignmentMethod, NewsEventStatus } from "@prisma/client";
import GraphQLJSONScalar from "graphql-type-json";

registerEnumType(NewsEventStatus, { name: "NewsEventStatus" });
registerEnumType(NewsEventAssignmentMethod, { name: "NewsEventAssignmentMethod" });

export enum NewsEventSourceType {
  all = "all",
  authoritative = "authoritative",
  mixed = "mixed",
  blog = "blog",
  unknown = "unknown"
}

export enum NewsEventSortBy {
  latest = "latest",
  heat = "heat",
  credibility = "credibility"
}

registerEnumType(NewsEventSourceType, { name: "NewsEventSourceType" });
registerEnumType(NewsEventSortBy, { name: "NewsEventSortBy" });

@ObjectType()
export class NewsEventArticleModel {
  @Field()
  id!: string;

  @Field()
  url!: string;

  @Field(() => String, { nullable: true })
  sourceLabel?: string | null;

  @Field(() => GraphQLISODateTime)
  crawlAt!: Date;
}

@ObjectType()
export class NewsEventProcessedArticleModel {
  @Field()
  id!: string;

  @Field()
  articleId!: string;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  summary?: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  publishedAt?: Date | null;

  @Field(() => String, { nullable: true })
  language?: string | null;

  @Field(() => GraphQLISODateTime)
  processedAt!: Date;

  @Field(() => NewsEventArticleModel)
  article!: NewsEventArticleModel;
}

@ObjectType()
export class NewsEventItemModel {
  @Field()
  id!: string;

  @Field()
  eventId!: string;

  @Field()
  processedArticleId!: string;

  @Field(() => String, { nullable: true })
  processedItemId?: string | null;

  @Field(() => Float, { nullable: true })
  similarity?: number | null;

  @Field(() => NewsEventAssignmentMethod)
  assignedBy!: NewsEventAssignmentMethod;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => NewsEventProcessedArticleModel)
  processedArticle!: NewsEventProcessedArticleModel;
}

@ObjectType()
export class NewsEventTimelineEntryModel {
  @Field()
  id!: string;

  @Field()
  eventId!: string;

  @Field(() => GraphQLISODateTime)
  bucketStart!: Date;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  summary?: string | null;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  keyPoints?: unknown;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  referencedArticleIds?: unknown;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}

@ObjectType()
export class NewsEventModel {
  @Field()
  id!: string;

  @Field(() => NewsEventStatus)
  status!: NewsEventStatus;

  @Field(() => String, { nullable: true })
  language?: string | null;

  @Field(() => String, { nullable: true })
  primaryTopic?: string | null;

  @Field(() => String, { nullable: true })
  primaryEntity?: string | null;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  summary?: string | null;

  @Field(() => GraphQLISODateTime)
  startAt!: Date;

  @Field(() => GraphQLISODateTime)
  lastAt!: Date;

  @Field(() => Int)
  itemCount!: number;

  @Field(() => String, { nullable: true })
  representativeProcessedArticleId?: string | null;

  @Field(() => String, { nullable: true })
  representativeProcessedItemId?: string | null;

  @Field(() => GraphQLJSONScalar, { nullable: true })
  metadata?: unknown;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => [NewsEventItemModel], { nullable: true })
  items?: NewsEventItemModel[];

  @Field(() => [NewsEventTimelineEntryModel], { nullable: true })
  timeline?: NewsEventTimelineEntryModel[];

  @Field(() => Boolean, { description: "Whether this event is considered breaking news" })
  breaking!: boolean;

  @Field(() => Float, { description: "Heat score indicating event urgency (0-10+)" })
  heatScore!: number;

  @Field(() => Float, { description: "Credibility score based on source corroboration (0-100)" })
  credibilityScore!: number;

  @Field(() => NewsEventSourceType, { description: "Source classification for authority filtering" })
  sourceType!: NewsEventSourceType;
}
