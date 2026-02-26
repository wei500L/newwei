import { Field, Float, InputType, Int } from "@nestjs/graphql";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

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

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(5_000)
  @Max(900_000)
  requestTimeoutMs?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(5_000)
  @Max(900_000)
  requestTimeoutHotMs?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(5_000)
  @Max(900_000)
  requestTimeoutNormalMs?: number;

  @Field(() => Int)
  @Min(1)
  @Max(10)
  maxRetries!: number;

  @Field(() => Int)
  @Min(500)
  @Max(600_000)
  retryBackoffMs!: number;

  @Field(() => Int)
  @Min(5_000)
  @Max(600_000)
  queueOverloadCooldownMs!: number;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  adaptiveConcurrencyEnabled?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(1)
  @Max(180)
  adaptiveWindowMinutes?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(1)
  @Max(60)
  adaptiveCooldownMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0.01)
  @Max(0.99)
  adaptiveLatencyThresholdRatio?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0.01)
  @Max(0.99)
  adaptiveErrorRateThreshold?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0.01)
  @Max(0.99)
  adaptiveMemoryHeadroomThreshold?: number;
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

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  minEdgeConfidence?: number;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  dynamicEdgeConfidenceEnabled?: boolean;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  dynamicEdgeConfidenceQuantile?: number;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  multiModelValidationEnabled?: boolean;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  multiModelValidationModels?: string[];

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(2)
  @Max(3)
  multiModelValidationModelCount?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(20)
  multiModelValidationMaxRelationsPerArticle?: number;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  entityDisambiguationEnabled?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(2)
  @Max(20)
  entityDisambiguationMaxCandidates?: number;

  @Field(() => Int)
  @Min(0)
  @Max(3600)
  cacheTtlSeconds!: number;
}

@InputType()
export class UpdateNewsEventSettingsInput {
  @Field(() => Boolean)
  @IsBoolean()
  enabled!: boolean;

  @Field(() => Boolean)
  @IsBoolean()
  ingestionEnabled!: boolean;

  @Field(() => Boolean)
  @IsBoolean()
  timelineEnabled!: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  forceAuthoritativeMode?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(1)
  @Max(5)
  forceMinAuthoritativeSources?: number;

  @Field(() => Int)
  @Min(1)
  @Max(500)
  maxBatchSize!: number;

  @Field(() => Int)
  @Min(1)
  @Max(365)
  backfillDays!: number;

  @Field(() => Int)
  @Min(1)
  @Max(180)
  lookbackDays!: number;

  @Field(() => Int)
  @Min(1)
  @Max(200)
  timelineMaxEventsPerRun!: number;

  @Field(() => Float)
  @Min(0)
  @Max(1)
  vectorMinScore!: number;

  @Field(() => Float)
  @Min(0)
  @Max(1)
  crossLanguagePenalty!: number;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  classificationGateEnabled?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  categoryConflictReject?: boolean;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  categorySoftPenalty?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  minCategoryConfidenceForGate?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  timelineLowConfidenceThreshold?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  timelineHighConfidenceThreshold?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(5)
  timelineDriftKlThreshold?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(1)
  @Max(50)
  timelineMinBucketItemsForDrift?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  timelineCrossCategoryWarningShare?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(4)
  @Max(64)
  timelineMaxCategoryDistributionItems?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(1)
  @Max(20)
  timelineMaxPhaseSummaries?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(7)
  timelinePresetCustomDistanceThreshold?: number;

  @Field(() => Int)
  @Min(0)
  @Max(3600)
  cacheTtlSeconds!: number;
}

@InputType()
export class UpdateNewsEventSourcePolicyInput {
  @Field(() => [String])
  @ArrayMinSize(0)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(180, { each: true })
  authoritativeDomains!: string[];

  @Field(() => [String])
  @ArrayMinSize(0)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(180, { each: true })
  authoritativeLabels!: string[];

  @Field(() => [String])
  @ArrayMinSize(0)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(180, { each: true })
  blogDomains!: string[];

  @Field(() => [String])
  @ArrayMinSize(0)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(180, { each: true })
  blogLabels!: string[];

  @Field(() => [NewsEventSourceCategoryAuthorityRuleInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => NewsEventSourceCategoryAuthorityRuleInput)
  @ArrayMinSize(0)
  @ArrayMaxSize(200)
  categoryAuthority?: NewsEventSourceCategoryAuthorityRuleInput[];

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1_000_000)
  expectedRevision?: number | null;
}

@InputType()
export class UpdateNewsEventSourcePolicyPresetInput {
  @Field(() => [String])
  @ArrayMinSize(0)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(180, { each: true })
  authoritativeDomains!: string[];

  @Field(() => [String])
  @ArrayMinSize(0)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(180, { each: true })
  authoritativeLabels!: string[];

  @Field(() => [String])
  @ArrayMinSize(0)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(180, { each: true })
  blogDomains!: string[];

  @Field(() => [String])
  @ArrayMinSize(0)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(180, { each: true })
  blogLabels!: string[];

  @Field(() => [NewsEventSourceCategoryAuthorityRuleInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => NewsEventSourceCategoryAuthorityRuleInput)
  @ArrayMinSize(0)
  @ArrayMaxSize(200)
  categoryAuthority?: NewsEventSourceCategoryAuthorityRuleInput[];

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  expectedUpdatedAt?: string | null;
}

@InputType()
export class RollbackNewsEventSourcePolicyInput {
  @Field(() => Int)
  @Min(1)
  revision!: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1_000_000)
  expectedRevision?: number | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

@InputType()
export class ResetNewsEventSourcePolicyInput {
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1_000_000)
  expectedRevision?: number | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

@InputType()
export class UpdateNewsIndicatorSettingsInput {
  @Field(() => Boolean)
  @IsBoolean()
  enabled!: boolean;

  @Field(() => Boolean)
  @IsBoolean()
  ingestionEnabled!: boolean;

  @Field(() => Int)
  @Min(7)
  @Max(3650)
  windowDays!: number;

  @Field(() => Int)
  @Min(0)
  @Max(30)
  maxLagDays!: number;

  @Field(() => Int)
  @Min(10)
  @Max(2000)
  minSampleSize!: number;

  @Field(() => Float)
  @Min(0)
  @Max(1)
  minAbsCorrelation!: number;

  @Field(() => Float)
  @Min(0)
  @Max(1)
  maxPValue!: number;

  @Field(() => Int)
  @Min(0)
  @Max(500)
  topEntities!: number;

  @Field(() => Int)
  @Min(0)
  @Max(500)
  topTopics!: number;

  @Field(() => Int)
  @Min(1)
  @Max(1000)
  maxAssociationsPerIndicator!: number;

  @Field(() => [String])
  @ArrayMaxSize(50)
  @ArrayMinSize(0)
  @MaxLength(128, { each: true })
  indicatorSlugs!: string[];

  @Field(() => Float)
  @Min(0)
  @Max(10)
  backtestTriggerZScore!: number;

  @Field(() => Int)
  @Min(5)
  @Max(365)
  backtestBaselineDays!: number;

  @Field(() => Int)
  @Min(0)
  @Max(365)
  backtestHoldoutDays!: number;

  @Field(() => Int)
  @Min(0)
  @Max(3600)
  cacheTtlSeconds!: number;
}

@InputType()
export class NewsDedupeCategoryThresholdInput {
  @Field(() => String)
  @IsString()
  @MaxLength(120)
  category!: string;

  @Field(() => Float)
  @Min(0)
  @Max(1)
  threshold!: number;
}

@InputType()
export class UpdateNewsDedupeSettingsInput {
  @Field(() => Float)
  @Min(0)
  @Max(1)
  defaultThreshold!: number;

  @Field(() => Boolean)
  @IsBoolean()
  useEmbeddings!: boolean;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  llmJudgeInstructions?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  llmJudgeModel?: string | null;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(1)
  @Max(30)
  llmJudgeMaxComparisons?: number | null;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(200)
  @Max(5000)
  llmJudgeCandidateChars?: number | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  llmJudgePromptVersion?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(12000)
  llmJudgeSystemPromptTemplate?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(12000)
  llmJudgeUserPromptTemplate?: string | null;

  @Field(() => [NewsDedupeCategoryThresholdInput])
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => NewsDedupeCategoryThresholdInput)
  categoryThresholds!: NewsDedupeCategoryThresholdInput[];
}

@InputType()
export class NewsClassificationTaxonomyNodeInput {
  @Field(() => String)
  @IsString()
  @MaxLength(160)
  path!: string;

  @Field(() => String)
  @IsString()
  @MaxLength(200)
  displayName!: string;

  @Field(() => String)
  @IsString()
  @MaxLength(500)
  description!: string;

  @Field(() => String)
  @IsIn(["politics", "tech", "finance", "gov", "ai", "intel"])
  legacyCategory!: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @ArrayMinSize(0)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  keywords?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @ArrayMinSize(0)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  synonyms?: string[];
}

@InputType()
export class UpdateNewsClassificationSettingsInput {
  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  strictFail?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  enableLlm?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  enableEmbedding?: boolean;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  enableRerank?: boolean;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  llmModel?: string | null;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  minConfidence?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(1)
  @Max(100)
  embeddingTopK?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(1)
  @Max(30)
  rerankTopN?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(3600)
  cacheTtlSeconds?: number;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxonomyVersion?: string | null;

  @Field(() => [NewsClassificationTaxonomyNodeInput], { nullable: true })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => NewsClassificationTaxonomyNodeInput)
  @ArrayMinSize(1)
  @ArrayMaxSize(512)
  taxonomy?: NewsClassificationTaxonomyNodeInput[];
}

@InputType()
export class UpdateClassificationQualitySettingsInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  lowConfidenceThreshold?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(100)
  @Max(120_000)
  llmP95LatencyWarnMs?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(100)
  @Max(120_000)
  embeddingP95LatencyWarnMs?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(100)
  @Max(120_000)
  rerankP95LatencyWarnMs?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  gateRejectRateWarn?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  gatePenalizedRateWarn?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(1)
  @Max(1000)
  reportMinPairCount?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  reportMinPairErrorRate?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(3600)
  cacheTtlSeconds?: number;
}

@InputType()
export class NewsEventSourceCategoryAuthorityDomainBoostInput {
  @Field(() => String)
  @IsString()
  @MaxLength(180)
  domain!: string;

  @Field(() => Float)
  @Min(-1)
  @Max(1)
  delta!: number;
}

@InputType()
export class NewsEventSourceCategoryAuthorityRuleInput {
  @Field(() => String)
  @IsString()
  @MaxLength(160)
  categoryPrefix!: string;

  @Field(() => Float)
  @Min(-1)
  @Max(1)
  authoritativeBoost!: number;

  @Field(() => Float)
  @Min(-1)
  @Max(1)
  blogPenalty!: number;

  @Field(() => Float)
  @Min(-1)
  @Max(1)
  unknownPenalty!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  minConfidenceFloor?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @Min(0)
  @Max(1)
  mismatchPenalty?: number;

  @Field(() => [NewsEventSourceCategoryAuthorityDomainBoostInput], {
    nullable: true,
  })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => NewsEventSourceCategoryAuthorityDomainBoostInput)
  @ArrayMinSize(0)
  @ArrayMaxSize(100)
  domainBoosts?: NewsEventSourceCategoryAuthorityDomainBoostInput[];
}
