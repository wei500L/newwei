import {
  Field,
  Float,
  GraphQLISODateTime,
  Int,
  ObjectType,
  registerEnumType,
} from "@nestjs/graphql";

export enum NewsEventSourcePolicyRevisionOperation {
  update = "update",
  rollback = "rollback",
  reset = "reset",
}

registerEnumType(NewsEventSourcePolicyRevisionOperation, {
  name: "NewsEventSourcePolicyRevisionOperation",
});

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
  requestTimeoutHotMs!: number;

  @Field(() => Int)
  requestTimeoutNormalMs!: number;

  @Field(() => Boolean)
  conditionalRequestEnabled!: boolean;

  @Field(() => Int)
  conditionalRequestTimeoutMs!: number;

  @Field(() => Int)
  conditionalRequestMaxRetries!: number;

  @Field(() => Int)
  detailPublishSignalHeadFetchTimeoutMs!: number;

  @Field(() => Int)
  detailPublishSignalHeadFetchConcurrency!: number;

  @Field(() => Int)
  detailPublishSignalHeadFetchMaxReadBytes!: number;

  @Field(() => Int)
  maxRetries!: number;

  @Field(() => Int)
  retryBackoffMs!: number;

  @Field(() => Int)
  queueOverloadCooldownMs!: number;

  @Field(() => Boolean)
  adaptiveConcurrencyEnabled!: boolean;

  @Field(() => Int)
  adaptiveWindowMinutes!: number;

  @Field(() => Int)
  adaptiveCooldownMinutes!: number;

  @Field(() => Float)
  adaptiveLatencyThresholdRatio!: number;

  @Field(() => Float)
  adaptiveErrorRateThreshold!: number;

  @Field(() => Float)
  adaptiveMemoryHeadroomThreshold!: number;
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

  @Field(() => Int)
  maxBatchSize!: number;

  @Field(() => Int)
  maxRelationsPerArticle!: number;

  @Field(() => Float)
  minEdgeConfidence!: number;

  @Field(() => Boolean)
  dynamicEdgeConfidenceEnabled!: boolean;

  @Field(() => Float)
  dynamicEdgeConfidenceQuantile!: number;

  @Field(() => Boolean)
  multiModelValidationEnabled!: boolean;

  @Field(() => [String])
  multiModelValidationModels!: string[];

  @Field(() => Int)
  multiModelValidationModelCount!: number;

  @Field(() => Int)
  multiModelValidationMaxRelationsPerArticle!: number;

  @Field(() => Boolean)
  entityDisambiguationEnabled!: boolean;

  @Field(() => Int)
  entityDisambiguationMaxCandidates!: number;

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

  @Field(() => Boolean)
  forceAuthoritativeMode!: boolean;

  @Field(() => Int)
  forceMinAuthoritativeSources!: number;

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

  @Field(() => Boolean)
  classificationGateEnabled!: boolean;

  @Field(() => Boolean)
  categoryConflictReject!: boolean;

  @Field(() => Float)
  categorySoftPenalty!: number;

  @Field(() => Float)
  minCategoryConfidenceForGate!: number;

  @Field(() => Float)
  timelineLowConfidenceThreshold!: number;

  @Field(() => Float)
  timelineHighConfidenceThreshold!: number;

  @Field(() => Float)
  timelineDriftKlThreshold!: number;

  @Field(() => Int)
  timelineMinBucketItemsForDrift!: number;

  @Field(() => Float)
  timelineCrossCategoryWarningShare!: number;

  @Field(() => Int)
  timelineMaxCategoryDistributionItems!: number;

  @Field(() => Int)
  timelineMaxPhaseSummaries!: number;

  @Field(() => Float)
  timelinePresetCustomDistanceThreshold!: number;

  @Field(() => Int)
  cacheTtlSeconds!: number;
}

@ObjectType()
export class NewsEventSourcePolicyDeltaModel {
  @Field(() => [String])
  authoritativeDomainsAdd!: string[];

  @Field(() => [String])
  authoritativeDomainsRemove!: string[];

  @Field(() => [String])
  authoritativeLabelsAdd!: string[];

  @Field(() => [String])
  authoritativeLabelsRemove!: string[];

  @Field(() => [String])
  blogDomainsAdd!: string[];

  @Field(() => [String])
  blogDomainsRemove!: string[];

  @Field(() => [String])
  blogLabelsAdd!: string[];

  @Field(() => [String])
  blogLabelsRemove!: string[];
}

@ObjectType()
export class NewsEventSourcePolicyConflictModel {
  @Field(() => [String])
  domainConflicts!: string[];

  @Field(() => [String])
  labelConflicts!: string[];

  @Field(() => Boolean)
  hasConflicts!: boolean;
}

@ObjectType()
export class NewsEventSourcePolicySettingsModel {
  @Field(() => [String])
  authoritativeDomains!: string[];

  @Field(() => [String])
  authoritativeLabels!: string[];

  @Field(() => [String])
  blogDomains!: string[];

  @Field(() => [String])
  blogLabels!: string[];

  @Field(() => [NewsEventSourceCategoryAuthorityRuleModel])
  categoryAuthority!: NewsEventSourceCategoryAuthorityRuleModel[];

  @Field(() => Int)
  activeRevision!: number;

  @Field(() => GraphQLISODateTime, { nullable: true })
  updatedAt!: Date | null;

  @Field(() => NewsEventSourcePolicyDeltaModel)
  overrides!: NewsEventSourcePolicyDeltaModel;

  @Field(() => NewsEventSourcePolicyConflictModel)
  warnings!: NewsEventSourcePolicyConflictModel;

  @Field(() => [NewsEventSourcePolicyRevisionModel])
  revisions!: NewsEventSourcePolicyRevisionModel[];

  @Field(() => [String])
  syncWarnings!: string[];
}

@ObjectType()
export class NewsEventSourcePolicyPresetSettingsModel {
  @Field(() => [String])
  authoritativeDomains!: string[];

  @Field(() => [String])
  authoritativeLabels!: string[];

  @Field(() => [String])
  blogDomains!: string[];

  @Field(() => [String])
  blogLabels!: string[];

  @Field(() => [NewsEventSourceCategoryAuthorityRuleModel])
  categoryAuthority!: NewsEventSourceCategoryAuthorityRuleModel[];

  @Field(() => GraphQLISODateTime, { nullable: true })
  updatedAt!: Date | null;

  @Field(() => [String])
  syncWarnings!: string[];
}

@ObjectType()
export class NewsEventSourcePolicyRevisionModel {
  @Field(() => Int)
  revision!: number;

  @Field(() => NewsEventSourcePolicyRevisionOperation)
  operation!: NewsEventSourcePolicyRevisionOperation;

  @Field(() => String, { nullable: true })
  actorId!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => String, { nullable: true })
  note!: string | null;

  @Field(() => NewsEventSourcePolicyDeltaModel)
  delta!: NewsEventSourcePolicyDeltaModel;
}

@ObjectType()
export class NewsEventSourcePolicyRevisionDiffModel {
  @Field(() => Int)
  baseRevision!: number;

  @Field(() => Int)
  targetRevision!: number;

  @Field(() => [String])
  authoritativeDomainsAdd!: string[];

  @Field(() => [String])
  authoritativeDomainsRemove!: string[];

  @Field(() => [String])
  authoritativeLabelsAdd!: string[];

  @Field(() => [String])
  authoritativeLabelsRemove!: string[];

  @Field(() => [String])
  blogDomainsAdd!: string[];

  @Field(() => [String])
  blogDomainsRemove!: string[];

  @Field(() => [String])
  blogLabelsAdd!: string[];

  @Field(() => [String])
  blogLabelsRemove!: string[];
}

@ObjectType()
export class NewsEventSourceCategoryAuthorityDomainBoostModel {
  @Field(() => String)
  domain!: string;

  @Field(() => Float)
  delta!: number;
}

@ObjectType()
export class NewsEventSourceCategoryAuthorityRuleModel {
  @Field(() => String)
  categoryPrefix!: string;

  @Field(() => Float)
  authoritativeBoost!: number;

  @Field(() => Float)
  blogPenalty!: number;

  @Field(() => Float)
  unknownPenalty!: number;

  @Field(() => Float)
  minConfidenceFloor!: number;

  @Field(() => Float)
  mismatchPenalty!: number;

  @Field(() => [NewsEventSourceCategoryAuthorityDomainBoostModel])
  domainBoosts!: NewsEventSourceCategoryAuthorityDomainBoostModel[];
}

@ObjectType()
export class NewsDedupeScopedThresholdModel {
  @Field(() => String, { nullable: true })
  sourceId!: string | null;

  @Field(() => String, { nullable: true })
  language!: string | null;

  @Field(() => String, { nullable: true })
  categoryPath!: string | null;

  @Field(() => Float)
  threshold!: number;
}

@ObjectType()
export class NewsDedupeSettingsModel {
  @Field(() => Float)
  defaultThreshold!: number;

  @Field(() => [NewsDedupeScopedThresholdModel])
  scopedThresholds!: NewsDedupeScopedThresholdModel[];

  @Field(() => Boolean)
  useEmbeddings!: boolean;

  @Field(() => String, { nullable: true })
  llmJudgeInstructions!: string | null;

  @Field(() => String, { nullable: true })
  llmJudgeModel!: string | null;

  @Field(() => Int)
  llmJudgeMaxComparisons!: number;

  @Field(() => Int)
  llmJudgeCandidateChars!: number;

  @Field(() => String)
  llmJudgePromptVersion!: string;

  @Field(() => String)
  llmJudgeSystemPromptTemplate!: string;

  @Field(() => String)
  llmJudgeUserPromptTemplate!: string;
}

@ObjectType()
export class NewsClassificationTaxonomyNodeModel {
  @Field(() => String)
  path!: string;

  @Field(() => String)
  displayName!: string;

  @Field(() => String)
  description!: string;

  @Field(() => String)
  legacyCategory!: string;

  @Field(() => [String])
  keywords!: string[];

  @Field(() => [String])
  synonyms!: string[];
}

@ObjectType()
export class NewsClassificationSettingsModel {
  @Field(() => Boolean)
  enabled!: boolean;

  @Field(() => Boolean)
  strictFail!: boolean;

  @Field(() => Boolean)
  enableLlm!: boolean;

  @Field(() => Boolean)
  enableEmbedding!: boolean;

  @Field(() => Boolean)
  enableRerank!: boolean;

  @Field(() => String, { nullable: true })
  llmModel!: string | null;

  @Field(() => Float)
  minConfidence!: number;

  @Field(() => Int)
  embeddingTopK!: number;

  @Field(() => Int)
  rerankTopN!: number;

  @Field(() => Int)
  cacheTtlSeconds!: number;

  @Field(() => String)
  taxonomyVersion!: string;

  @Field(() => [NewsClassificationTaxonomyNodeModel])
  taxonomy!: NewsClassificationTaxonomyNodeModel[];
}

@ObjectType()
export class ClassificationQualitySettingsModel {
  @Field(() => Float)
  lowConfidenceThreshold!: number;

  @Field(() => Int)
  llmP95LatencyWarnMs!: number;

  @Field(() => Int)
  embeddingP95LatencyWarnMs!: number;

  @Field(() => Int)
  rerankP95LatencyWarnMs!: number;

  @Field(() => Float)
  gateRejectRateWarn!: number;

  @Field(() => Float)
  gatePenalizedRateWarn!: number;

  @Field(() => Int)
  reportMinPairCount!: number;

  @Field(() => Float)
  reportMinPairErrorRate!: number;

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
