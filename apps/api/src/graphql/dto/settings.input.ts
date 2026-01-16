import { Field, Float, InputType, Int } from "@nestjs/graphql";
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsIn, Max, MaxLength, Min } from "class-validator";

@InputType()
export class RateLimitBucketInput {
  @Field(() => Int)
  @Min(1)
  @Max(1_000)
  limit!: number;

  @Field(() => Int)
  @Min(5)
  @Max(86_400)
  windowSeconds!: number;
}

@InputType()
export class UpdateRateLimitSettingsInput {
  @Field(() => RateLimitBucketInput)
  login!: RateLimitBucketInput;

  @Field(() => RateLimitBucketInput)
  crawlCreate!: RateLimitBucketInput;

  @Field(() => RateLimitBucketInput)
  rbacWrite!: RateLimitBucketInput;
}

@InputType()
export class UpdateAuthCacheSettingsInput {
  @Field(() => Int)
  @Min(60)
  @Max(86_400)
  profileTtlSeconds!: number;

  @Field(() => Int)
  @Min(100)
  @Max(60_000)
  lockTtlMs!: number;

  @Field(() => Int)
  @Min(50)
  @Max(120_000)
  maxWaitMs!: number;

  @Field(() => Int)
  @Min(10)
  @Max(1_000)
  retryDelayMs!: number;
}

@InputType()
export class UpdateCrawlClientSettingsInput {
  @Field(() => Int)
  @Min(5_000)
  @Max(900_000)
  healthCheckTtlMs!: number;

  @Field(() => Int)
  @Min(5_000)
  @Max(300_000)
  requestTimeoutMs!: number;

  @Field(() => Int)
  @Min(1)
  @Max(10)
  maxRetries!: number;

  @Field(() => Int)
  @Min(500)
  @Max(600_000)
  retryBackoffMs!: number;
}

@InputType()
export class UpdateAuditLogRetentionInput {
  @Field(() => Int)
  @Min(1)
  @Max(3650)
  retentionDays!: number;
}

@InputType()
export class UpdateNewsPromptConfigInput {
  @Field()
  @MaxLength(120)
  version!: string;

  @Field()
  @MaxLength(6000)
  systemPromptTemplate!: string;

  @Field()
  @MaxLength(12000)
  userPromptTemplate!: string;
}

@InputType()
export class UpdateEntityImpactGraphSettingsInput {
  @Field(() => Boolean)
  @IsBoolean()
  enabled!: boolean;

  @Field(() => Float)
  @Min(0)
  @Max(1)
  minEntityConfidence!: number;

  @Field(() => Float)
  @Min(0)
  @Max(1)
  minCorrelation!: number;

  @Field(() => Int)
  @Min(1)
  @Max(100)
  minCoOccurrence!: number;

  @Field(() => Int)
  @Min(10)
  @Max(500)
  maxNodes!: number;

  @Field(() => [String])
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsIn(["person", "organization", "stock", "commodity"], { each: true })
  categories!: string[];

  @Field(() => Int)
  @Min(0)
  @Max(3600)
  cacheTtlSeconds!: number;
}

@InputType()
export class UpdateKnowledgeGraphSettingsInput {
  @Field(() => Boolean)
  @IsBoolean()
  enabled!: boolean;

  @Field(() => Boolean)
  @IsBoolean()
  ingestionEnabled!: boolean;

  @Field(() => Boolean)
  @IsBoolean()
  seedIngestionEnabled!: boolean;

  @Field(() => Int)
  @Min(1)
  @Max(50)
  seedSwIndustriesPerRun!: number;

  @Field(() => Int)
  @Min(1)
  @Max(500)
  maxBatchSize!: number;

  @Field(() => Int)
  @Min(0)
  @Max(100)
  maxRelationsPerArticle!: number;

  @Field(() => Int)
  @Min(0)
  @Max(3600)
  cacheTtlSeconds!: number;
}
