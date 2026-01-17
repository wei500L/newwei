import { Field, Float, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class RateLimitBucketModel {
  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  windowSeconds!: number;
}

@ObjectType()
export class RateLimitSettingsModel {
  @Field(() => RateLimitBucketModel)
  login!: RateLimitBucketModel;

  @Field(() => RateLimitBucketModel)
  crawlCreate!: RateLimitBucketModel;

  @Field(() => RateLimitBucketModel)
  rbacWrite!: RateLimitBucketModel;
}

@ObjectType()
export class AuthCacheSettingsModel {
  @Field(() => Int)
  profileTtlSeconds!: number;

  @Field(() => Int)
  lockTtlMs!: number;

  @Field(() => Int)
  maxWaitMs!: number;

  @Field(() => Int)
  retryDelayMs!: number;
}

@ObjectType()
export class CrawlClientSettingsModel {
  @Field(() => Int)
  healthCheckTtlMs!: number;

  @Field(() => Int)
  requestTimeoutMs!: number;

  @Field(() => Int)
  maxRetries!: number;

  @Field(() => Int)
  retryBackoffMs!: number;
}

@ObjectType()
export class AuditLogRetentionModel {
  @Field(() => Int)
  retentionDays!: number;
}

@ObjectType()
export class NewsPromptConfigModel {
  @Field()
  version!: string;

  @Field()
  systemPromptTemplate!: string;

  @Field()
  userPromptTemplate!: string;
}

@ObjectType()
export class EntityImpactGraphSettingsModel {
  @Field(() => Boolean)
  enabled!: boolean;

  @Field(() => Float)
  minEntityConfidence!: number;

  @Field(() => Float)
  minCorrelation!: number;

  @Field(() => Int)
  minCoOccurrence!: number;

  @Field(() => Int)
  maxNodes!: number;

  @Field(() => [String])
  categories!: string[];

  @Field(() => Int)
  cacheTtlSeconds!: number;
}

@ObjectType()
export class KnowledgeGraphSettingsModel {
  @Field(() => Boolean)
  enabled!: boolean;

  @Field(() => Boolean)
  ingestionEnabled!: boolean;

  @Field(() => Boolean)
  seedIngestionEnabled!: boolean;

  @Field(() => Int)
  seedSwIndustriesPerRun!: number;

  @Field(() => Int)
  maxBatchSize!: number;

  @Field(() => Int)
  maxRelationsPerArticle!: number;

  @Field(() => Int)
  cacheTtlSeconds!: number;
}

@ObjectType()
export class NewsEventSettingsModel {
  @Field(() => Boolean)
  enabled!: boolean;

  @Field(() => Boolean)
  ingestionEnabled!: boolean;

  @Field(() => Boolean)
  timelineEnabled!: boolean;

  @Field(() => Int)
  maxBatchSize!: number;

  @Field(() => Int)
  backfillDays!: number;

  @Field(() => Int)
  lookbackDays!: number;

  @Field(() => Int)
  timelineMaxEventsPerRun!: number;

  @Field(() => Float)
  vectorMinScore!: number;

  @Field(() => Float)
  crossLanguagePenalty!: number;

  @Field(() => Int)
  cacheTtlSeconds!: number;
}

@ObjectType()
export class NewsIndicatorSettingsModel {
  @Field(() => Boolean)
  enabled!: boolean;

  @Field(() => Boolean)
  ingestionEnabled!: boolean;

  @Field(() => Int)
  windowDays!: number;

  @Field(() => Int)
  maxLagDays!: number;

  @Field(() => Int)
  minSampleSize!: number;

  @Field(() => Float)
  minAbsCorrelation!: number;

  @Field(() => Float)
  maxPValue!: number;

  @Field(() => Int)
  topEntities!: number;

  @Field(() => Int)
  topTopics!: number;

  @Field(() => Int)
  maxAssociationsPerIndicator!: number;

  @Field(() => [String])
  indicatorSlugs!: string[];

  @Field(() => Float)
  backtestTriggerZScore!: number;

  @Field(() => Int)
  backtestBaselineDays!: number;

  @Field(() => Int)
  backtestHoldoutDays!: number;

  @Field(() => Int)
  cacheTtlSeconds!: number;
}
