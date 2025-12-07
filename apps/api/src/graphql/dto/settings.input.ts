import { Field, InputType, Int } from "@nestjs/graphql";
import { Max, MaxLength, Min } from "class-validator";

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
