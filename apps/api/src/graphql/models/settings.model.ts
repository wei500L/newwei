import { Field, Int, ObjectType } from "@nestjs/graphql";

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
