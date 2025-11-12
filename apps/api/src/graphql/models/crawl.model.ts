import { Field, GraphQLISODateTime, ID, ObjectType } from "@nestjs/graphql";
import GraphQLJSON from "graphql-type-json";
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

  @Field({ nullable: true })
  media?: string;

  @Field({ nullable: true })
  markdownWithCitations?: string | null;

  @Field({ nullable: true })
  referencesMarkdown?: string | null;

  @Field({ nullable: true })
  fitMarkdown?: string | null;

  @Field(() => CrawlLinkAnalysisModel, { nullable: true })
  linkAnalysis?: CrawlLinkAnalysisModel | null;

  @Field(() => GraphQLJSON, { nullable: true })
  tables?: unknown;
}

@ObjectType()
export class CrawlLinkModel {
  @Field()
  href!: string;

  @Field({ nullable: true })
  text?: string | null;

  @Field({ nullable: true })
  title?: string | null;

  @Field({ nullable: true })
  baseDomain?: string | null;

  @Field({ nullable: true })
  rel?: string | null;

  @Field({ nullable: true })
  type?: string | null;

  @Field(() => Number, { nullable: true })
  intrinsicScore?: number | null;

  @Field(() => Number, { nullable: true })
  contextualScore?: number | null;

  @Field(() => Number, { nullable: true })
  totalScore?: number | null;
}

@ObjectType()
export class CrawlLinkStatsModel {
  @Field(() => Number)
  totalLinks!: number;

  @Field(() => Number)
  internalLinks!: number;

  @Field(() => Number)
  externalLinks!: number;

  @Field(() => Number, { nullable: true })
  averageIntrinsicScore?: number | null;

  @Field(() => Number, { nullable: true })
  highQualityLinks?: number | null;

  @Field(() => Number, { nullable: true })
  lowQualityLinks?: number | null;
}

@ObjectType()
export class CrawlLinkBucketModel {
  @Field()
  kind!: string;

  @Field(() => [CrawlLinkModel])
  links!: CrawlLinkModel[];
}

@ObjectType()
export class CrawlLinkAnalysisModel {
  @Field(() => CrawlLinkStatsModel)
  stats!: CrawlLinkStatsModel;

  @Field(() => [CrawlLinkBucketModel])
  buckets!: CrawlLinkBucketModel[];

  @Field(() => [CrawlLinkModel])
  topLinks!: CrawlLinkModel[];

  @Field(() => [CrawlLinkModel])
  lowQualityLinks!: CrawlLinkModel[];
}

@ObjectType()
export class CrawlMetadataTagModel {
  @Field()
  name!: string;

  @Field()
  value!: string;
}

@ObjectType()
export class CrawlMetadataResultModel {
  @Field()
  url!: string;

  @Field()
  status!: string;

  @Field(() => Number, { nullable: true })
  httpStatus?: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  fetchedAt?: Date | null;

  @Field({ nullable: true })
  title?: string | null;

  @Field({ nullable: true })
  description?: string | null;

  @Field(() => [String], { nullable: true })
  keywords?: string[] | null;

  @Field({ nullable: true })
  author?: string | null;

  @Field(() => [CrawlMetadataTagModel])
  metaTags!: CrawlMetadataTagModel[];

  @Field(() => [CrawlMetadataTagModel])
  openGraph!: CrawlMetadataTagModel[];

  @Field(() => [String])
  jsonLd!: string[];

  @Field(() => Number, { nullable: true })
  relevanceScore?: number | null;

  @Field({ nullable: true })
  error?: string | null;
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
