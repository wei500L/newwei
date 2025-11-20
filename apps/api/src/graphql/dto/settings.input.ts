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
