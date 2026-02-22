import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Int, Mutation, Query, Resolver } from "@nestjs/graphql";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { AuthCacheSettingsService } from "../../modules/auth/auth-cache-settings.service";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { PrismaService } from "../../modules/config/prisma.service";
import { CrawlSettingsService } from "../../modules/crawl/crawl-settings.service";
import {
  KnowledgeGraphSettingsService,
  type KnowledgeGraphSettingsInput,
} from "../../modules/knowledge-graph/knowledge-graph-settings.service";
import {
  NewsEventSourcePolicyService,
  type NewsEventSourcePolicyDetails,
  type NewsEventSourcePolicyInput,
  type NewsEventSourcePolicyPreset,
  type NewsEventSourcePolicyRevisionDiff,
} from "../../modules/news-events/news-event-source-policy.service";
import {
  NewsEventsSettingsService,
  type NewsEventSettingsInput,
} from "../../modules/news-events/news-events-settings.service";
import {
  NewsIndicatorSettingsService,
  type NewsIndicatorAssociationSettingsInput,
} from "../../modules/news-indicator/news-indicator-settings.service";
import {
  NewsClassificationSettingsService,
  type NewsClassificationSettingsInput,
} from "../../modules/news-pipeline/news-classification-settings.service";
import {
  NewsClassificationQualitySettingsService,
  type ClassificationQualitySettingsInput,
} from "../../modules/news-pipeline/news-classification-quality-settings.service";
import {
  NewsDedupeSettingsService,
  type NewsDedupeSettingsInput,
} from "../../modules/news-pipeline/news-dedupe-settings.service";
import { NewsPromptConfigService } from "../../modules/news-pipeline/news-prompt-config.service";
import { AuditLogSettingsService } from "../../modules/system-settings/audit-log-settings.service";
import {
  EntityImpactGraphSettingsService,
  type EntityImpactGraphSettingsInput,
} from "../../modules/system-settings/entity-impact-graph-settings.service";
import { RateLimitConfigService } from "../../modules/system-settings/rate-limit-config.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import { toNewsEventSourcePolicyInput } from "./settings.resolver.helpers";
import {
  UpdateAuditLogRetentionInput,
  UpdateCrawlClientSettingsInput,
  UpdateAuthCacheSettingsInput,
  UpdateNewsPromptConfigInput,
  UpdateEntityImpactGraphSettingsInput,
  UpdateKnowledgeGraphSettingsInput,
  ResetNewsEventSourcePolicyInput,
  RollbackNewsEventSourcePolicyInput,
  UpdateNewsEventSourcePolicyPresetInput,
  UpdateRateLimitSettingsInput,
  UpdateNewsEventSettingsInput,
  UpdateNewsEventSourcePolicyInput,
  UpdateNewsIndicatorSettingsInput,
  UpdateNewsClassificationSettingsInput,
  UpdateClassificationQualitySettingsInput,
  UpdateNewsDedupeSettingsInput,
} from "../dto/settings.input";
import type { GqlRequest } from "../graphql.types";
import {
  AuditLogRetentionModel,
  CrawlClientSettingsModel,
  EntityImpactGraphSettingsModel,
  KnowledgeGraphSettingsModel,
  NewsEventSettingsModel,
  NewsEventSourcePolicyPresetSettingsModel,
  NewsEventSourcePolicyRevisionDiffModel,
  NewsEventSourcePolicyRevisionOperation,
  NewsEventSourcePolicySettingsModel,
  NewsIndicatorSettingsModel,
  ClassificationQualitySettingsModel,
  NewsClassificationSettingsModel,
  NewsDedupeSettingsModel,
  NewsPromptConfigModel,
  AuthCacheSettingsModel,
  RateLimitSettingsModel,
} from "../models/settings.model";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class SettingsResolver {
  constructor(
    private readonly rateLimitConfig: RateLimitConfigService,
    private readonly entityImpactGraphSettingsService: EntityImpactGraphSettingsService,
    private readonly knowledgeGraphSettingsService: KnowledgeGraphSettingsService,
    private readonly newsEventSettingsService: NewsEventsSettingsService,
    private readonly newsEventSourcePolicyService: NewsEventSourcePolicyService,
    private readonly newsIndicatorSettingsService: NewsIndicatorSettingsService,
    private readonly newsClassificationSettingsService: NewsClassificationSettingsService,
    private readonly newsClassificationQualitySettingsService: NewsClassificationQualitySettingsService,
    private readonly newsDedupeSettingsService: NewsDedupeSettingsService,
    private readonly newsPromptConfigService: NewsPromptConfigService,
    private readonly auditLogSettings: AuditLogSettingsService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly authCacheSettingsService: AuthCacheSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  @HasPermission("settings.manage")
  @Query(() => RateLimitSettingsModel)
  async rateLimitSettings(
    @Context("req") req: GqlRequest,
  ): Promise<RateLimitSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.rateLimitConfig.getRateLimitSettings();
  }

  @HasPermission("settings.manage")
  @Mutation(() => RateLimitSettingsModel)
  async updateRateLimitSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateRateLimitSettingsInput,
  ): Promise<RateLimitSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.rateLimitConfig.updateRateLimitSettings(
      user.orgId,
      user.id,
      input,
    );
  }

  @HasPermission("dashboards.read")
  @Query(() => EntityImpactGraphSettingsModel)
  async entityImpactGraphSettings(
    @Context("req") req: GqlRequest,
  ): Promise<EntityImpactGraphSettingsModel> {
    const user = this.requireUser(req);
    return this.entityImpactGraphSettingsService.getSettings(user.orgId);
  }

  @HasPermission("settings.manage")
  @Mutation(() => EntityImpactGraphSettingsModel)
  async updateEntityImpactGraphSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateEntityImpactGraphSettingsInput,
  ): Promise<EntityImpactGraphSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const settingsInput: EntityImpactGraphSettingsInput = {
      enabled: input.enabled,
      minEntityConfidence: input.minEntityConfidence,
      minCorrelation: input.minCorrelation,
      minCoOccurrence: input.minCoOccurrence,
      maxNodes: input.maxNodes,
      categories:
        input.categories as EntityImpactGraphSettingsInput["categories"],
      cacheTtlSeconds: input.cacheTtlSeconds,
    };
    return this.entityImpactGraphSettingsService.updateSettings(
      user.orgId,
      user.id,
      settingsInput,
    );
  }

  @HasPermission("dashboards.read")
  @Query(() => KnowledgeGraphSettingsModel)
  async knowledgeGraphSettings(
    @Context("req") req: GqlRequest,
  ): Promise<KnowledgeGraphSettingsModel> {
    const user = this.requireUser(req);
    return this.knowledgeGraphSettingsService.getSettings(user.orgId);
  }

  @HasPermission("settings.manage")
  @Mutation(() => KnowledgeGraphSettingsModel)
  async updateKnowledgeGraphSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateKnowledgeGraphSettingsInput,
  ): Promise<KnowledgeGraphSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const current = await this.knowledgeGraphSettingsService.getSettings(
      user.orgId,
    );
    const settingsInput: KnowledgeGraphSettingsInput = {
      enabled: input.enabled,
      ingestionEnabled: input.ingestionEnabled,
      seedIngestionEnabled: input.seedIngestionEnabled,
      seedSwIndustriesPerRun: input.seedSwIndustriesPerRun,
      maxBatchSize: input.maxBatchSize,
      maxRelationsPerArticle: input.maxRelationsPerArticle,
      minEdgeConfidence: input.minEdgeConfidence ?? current.minEdgeConfidence,
      dynamicEdgeConfidenceEnabled:
        input.dynamicEdgeConfidenceEnabled ??
        current.dynamicEdgeConfidenceEnabled,
      dynamicEdgeConfidenceQuantile:
        input.dynamicEdgeConfidenceQuantile ??
        current.dynamicEdgeConfidenceQuantile,
      multiModelValidationEnabled:
        input.multiModelValidationEnabled ??
        current.multiModelValidationEnabled,
      multiModelValidationModels:
        input.multiModelValidationModels ?? current.multiModelValidationModels,
      multiModelValidationModelCount:
        input.multiModelValidationModelCount ??
        current.multiModelValidationModelCount,
      multiModelValidationMaxRelationsPerArticle:
        input.multiModelValidationMaxRelationsPerArticle ??
        current.multiModelValidationMaxRelationsPerArticle,
      entityDisambiguationEnabled:
        input.entityDisambiguationEnabled ??
        current.entityDisambiguationEnabled,
      entityDisambiguationMaxCandidates:
        input.entityDisambiguationMaxCandidates ??
        current.entityDisambiguationMaxCandidates,
      cacheTtlSeconds: input.cacheTtlSeconds,
    };
    return this.knowledgeGraphSettingsService.updateSettings(
      user.orgId,
      user.id,
      settingsInput,
    );
  }

  @HasPermission("dashboards.read")
  @Query(() => NewsEventSettingsModel)
  async newsEventSettings(
    @Context("req") req: GqlRequest,
  ): Promise<NewsEventSettingsModel> {
    const user = this.requireUser(req);
    return this.newsEventSettingsService.getSettings(user.orgId);
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsEventSettingsModel)
  async updateNewsEventSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateNewsEventSettingsInput,
  ): Promise<NewsEventSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const current = await this.newsEventSettingsService.getSettings(user.orgId);
    const settingsInput: NewsEventSettingsInput = {
      enabled: input.enabled,
      ingestionEnabled: input.ingestionEnabled,
      timelineEnabled: input.timelineEnabled,
      forceAuthoritativeMode:
        input.forceAuthoritativeMode ?? current.forceAuthoritativeMode,
      forceMinAuthoritativeSources:
        input.forceMinAuthoritativeSources ??
        current.forceMinAuthoritativeSources,
      maxBatchSize: input.maxBatchSize,
      backfillDays: input.backfillDays,
      lookbackDays: input.lookbackDays,
      timelineMaxEventsPerRun: input.timelineMaxEventsPerRun,
      vectorMinScore: input.vectorMinScore,
      crossLanguagePenalty: input.crossLanguagePenalty,
      classificationGateEnabled:
        input.classificationGateEnabled ?? current.classificationGateEnabled,
      categoryConflictReject:
        input.categoryConflictReject ?? current.categoryConflictReject,
      categorySoftPenalty:
        input.categorySoftPenalty ?? current.categorySoftPenalty,
      minCategoryConfidenceForGate:
        input.minCategoryConfidenceForGate ??
        current.minCategoryConfidenceForGate,
      timelineLowConfidenceThreshold:
        input.timelineLowConfidenceThreshold ??
        current.timelineLowConfidenceThreshold,
      timelineHighConfidenceThreshold:
        input.timelineHighConfidenceThreshold ??
        current.timelineHighConfidenceThreshold,
      timelineDriftKlThreshold:
        input.timelineDriftKlThreshold ?? current.timelineDriftKlThreshold,
      timelineMinBucketItemsForDrift:
        input.timelineMinBucketItemsForDrift ??
        current.timelineMinBucketItemsForDrift,
      timelineCrossCategoryWarningShare:
        input.timelineCrossCategoryWarningShare ??
        current.timelineCrossCategoryWarningShare,
      timelineMaxCategoryDistributionItems:
        input.timelineMaxCategoryDistributionItems ??
        current.timelineMaxCategoryDistributionItems,
      timelineMaxPhaseSummaries:
        input.timelineMaxPhaseSummaries ?? current.timelineMaxPhaseSummaries,
      timelinePresetCustomDistanceThreshold:
        input.timelinePresetCustomDistanceThreshold ??
        current.timelinePresetCustomDistanceThreshold,
      cacheTtlSeconds: input.cacheTtlSeconds,
    };
    return this.newsEventSettingsService.updateSettings(
      user.orgId,
      user.id,
      settingsInput,
    );
  }

  @HasPermission("settings.manage")
  @Query(() => NewsEventSourcePolicySettingsModel)
  async newsEventSourcePolicy(
    @Context("req") req: GqlRequest,
  ): Promise<NewsEventSourcePolicySettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const details = await this.newsEventSourcePolicyService.getPolicyDetails(
      user.orgId,
      { limit: 30 },
    );
    return this.toSourcePolicyModel(details);
  }

  @HasPermission("settings.manage")
  @Query(() => NewsEventSourcePolicyPresetSettingsModel)
  async newsEventSourcePolicyPresets(
    @Context("req") req: GqlRequest,
  ): Promise<NewsEventSourcePolicyPresetSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const preset = await this.newsEventSourcePolicyService.getPolicyPreset(
      user.orgId,
    );
    return this.toSourcePolicyPresetModel(preset);
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsEventSourcePolicySettingsModel)
  async updateNewsEventSourcePolicy(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateNewsEventSourcePolicyInput,
  ): Promise<NewsEventSourcePolicySettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const policyInput: NewsEventSourcePolicyInput =
      toNewsEventSourcePolicyInput(input);
    const updateOptions: {
      note?: string | null;
      expectedRevision?: number | null;
    } = { note: input.note ?? null };
    if (input.expectedRevision !== undefined) {
      updateOptions.expectedRevision = input.expectedRevision;
    }
    const details = await this.newsEventSourcePolicyService.updatePolicy(
      user.orgId,
      user.id,
      policyInput,
      updateOptions,
    );
    return this.toSourcePolicyModel(details);
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsEventSourcePolicyPresetSettingsModel)
  async updateNewsEventSourcePolicyPresets(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateNewsEventSourcePolicyPresetInput,
  ): Promise<NewsEventSourcePolicyPresetSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const presetInput: NewsEventSourcePolicyInput =
      toNewsEventSourcePolicyInput(input);
    const updateOptions: {
      note?: string | null;
      expectedUpdatedAt?: string | null;
    } = { note: input.note ?? null };
    if (input.expectedUpdatedAt !== undefined) {
      updateOptions.expectedUpdatedAt = input.expectedUpdatedAt;
    }
    const preset = await this.newsEventSourcePolicyService.updatePolicyPreset(
      user.orgId,
      user.id,
      presetInput,
      updateOptions,
    );
    return this.toSourcePolicyPresetModel(preset);
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsEventSourcePolicySettingsModel)
  async rollbackNewsEventSourcePolicy(
    @Context("req") req: GqlRequest,
    @Args("input") input: RollbackNewsEventSourcePolicyInput,
  ): Promise<NewsEventSourcePolicySettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const updateOptions: {
      note?: string | null;
      expectedRevision?: number | null;
    } = { note: input.note ?? null };
    if (input.expectedRevision !== undefined) {
      updateOptions.expectedRevision = input.expectedRevision;
    }

    const details = await this.newsEventSourcePolicyService.rollbackPolicy(
      user.orgId,
      user.id,
      input.revision,
      updateOptions,
    );
    return this.toSourcePolicyModel(details);
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsEventSourcePolicySettingsModel)
  async resetNewsEventSourcePolicy(
    @Context("req") req: GqlRequest,
    @Args("input") input: ResetNewsEventSourcePolicyInput,
  ): Promise<NewsEventSourcePolicySettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const updateOptions: {
      note?: string | null;
      expectedRevision?: number | null;
    } = { note: input.note ?? null };
    if (input.expectedRevision !== undefined) {
      updateOptions.expectedRevision = input.expectedRevision;
    }

    const details = await this.newsEventSourcePolicyService.resetPolicy(
      user.orgId,
      user.id,
      updateOptions,
    );
    return this.toSourcePolicyModel(details);
  }

  @HasPermission("settings.manage")
  @Query(() => NewsEventSourcePolicyRevisionDiffModel)
  async newsEventSourcePolicyRevisionDiff(
    @Context("req") req: GqlRequest,
    @Args("baseRevision", { type: () => Int }) baseRevision: number,
    @Args("targetRevision", { type: () => Int }) targetRevision: number,
  ): Promise<NewsEventSourcePolicyRevisionDiffModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const diff = await this.newsEventSourcePolicyService.getRevisionDiff(
      user.orgId,
      baseRevision,
      targetRevision,
    );
    return this.toSourcePolicyRevisionDiffModel(diff);
  }

  @HasPermission("settings.manage")
  @Query(() => NewsClassificationSettingsModel)
  async newsClassificationSettings(
    @Context("req") req: GqlRequest,
  ): Promise<NewsClassificationSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.newsClassificationSettingsService.getSettings(user.orgId);
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsClassificationSettingsModel)
  async updateNewsClassificationSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateNewsClassificationSettingsInput,
  ): Promise<NewsClassificationSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);

    const settingsInput: NewsClassificationSettingsInput = {
      enabled: input.enabled,
      strictFail: input.strictFail,
      enableLlm: input.enableLlm,
      enableEmbedding: input.enableEmbedding,
      enableRerank: input.enableRerank,
      llmModel: input.llmModel,
      minConfidence: input.minConfidence,
      embeddingTopK: input.embeddingTopK,
      rerankTopN: input.rerankTopN,
      cacheTtlSeconds: input.cacheTtlSeconds,
      taxonomyVersion: input.taxonomyVersion,
      taxonomy: input.taxonomy?.map((entry) => ({
        path: entry.path,
        displayName: entry.displayName,
        description: entry.description,
        legacyCategory: entry.legacyCategory as
          | "politics"
          | "tech"
          | "finance"
          | "gov"
          | "ai"
          | "intel",
        keywords: entry.keywords ?? [],
        synonyms: entry.synonyms ?? [],
      })),
    };

    return this.newsClassificationSettingsService.updateSettings(
      user.orgId,
      user.id,
      settingsInput,
    );
  }

  @HasPermission("settings.manage")
  @Query(() => ClassificationQualitySettingsModel)
  async classificationQualitySettings(
    @Context("req") req: GqlRequest,
  ): Promise<ClassificationQualitySettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.newsClassificationQualitySettingsService.getSettings(user.orgId);
  }

  @HasPermission("settings.manage")
  @Mutation(() => ClassificationQualitySettingsModel)
  async updateClassificationQualitySettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateClassificationQualitySettingsInput,
  ): Promise<ClassificationQualitySettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const settingsInput: ClassificationQualitySettingsInput = {
      lowConfidenceThreshold: input.lowConfidenceThreshold,
      llmP95LatencyWarnMs: input.llmP95LatencyWarnMs,
      embeddingP95LatencyWarnMs: input.embeddingP95LatencyWarnMs,
      rerankP95LatencyWarnMs: input.rerankP95LatencyWarnMs,
      gateRejectRateWarn: input.gateRejectRateWarn,
      gatePenalizedRateWarn: input.gatePenalizedRateWarn,
      reportMinPairCount: input.reportMinPairCount,
      reportMinPairErrorRate: input.reportMinPairErrorRate,
      cacheTtlSeconds: input.cacheTtlSeconds,
    };
    return this.newsClassificationQualitySettingsService.updateSettings(
      user.orgId,
      user.id,
      settingsInput,
    );
  }

  @HasPermission("settings.manage")
  @Query(() => NewsDedupeSettingsModel)
  async newsDedupeSettings(
    @Context("req") req: GqlRequest,
  ): Promise<NewsDedupeSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.newsDedupeSettingsService.getSettings(user.orgId);
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsDedupeSettingsModel)
  async updateNewsDedupeSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateNewsDedupeSettingsInput,
  ): Promise<NewsDedupeSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const current = await this.newsDedupeSettingsService.getSettings(
      user.orgId,
    );
    const settingsInput: NewsDedupeSettingsInput = {
      defaultThreshold: input.defaultThreshold,
      useEmbeddings: input.useEmbeddings,
      llmJudgeInstructions:
        input.llmJudgeInstructions === undefined
          ? current.llmJudgeInstructions
          : input.llmJudgeInstructions,
      llmJudgeModel:
        input.llmJudgeModel === undefined
          ? current.llmJudgeModel
          : input.llmJudgeModel,
      llmJudgeMaxComparisons:
        input.llmJudgeMaxComparisons === undefined
          ? current.llmJudgeMaxComparisons
          : input.llmJudgeMaxComparisons,
      llmJudgeCandidateChars:
        input.llmJudgeCandidateChars === undefined
          ? current.llmJudgeCandidateChars
          : input.llmJudgeCandidateChars,
      llmJudgePromptVersion:
        input.llmJudgePromptVersion === undefined
          ? current.llmJudgePromptVersion
          : input.llmJudgePromptVersion,
      llmJudgeSystemPromptTemplate:
        input.llmJudgeSystemPromptTemplate === undefined
          ? current.llmJudgeSystemPromptTemplate
          : input.llmJudgeSystemPromptTemplate,
      llmJudgeUserPromptTemplate:
        input.llmJudgeUserPromptTemplate === undefined
          ? current.llmJudgeUserPromptTemplate
          : input.llmJudgeUserPromptTemplate,
      categoryThresholds: input.categoryThresholds.map((entry) => ({
        category: entry.category,
        threshold: entry.threshold,
      })),
    };
    return this.newsDedupeSettingsService.updateSettings(
      user.orgId,
      user.id,
      settingsInput,
    );
  }

  @HasPermission("dashboards.read")
  @Query(() => NewsIndicatorSettingsModel)
  async newsIndicatorSettings(
    @Context("req") req: GqlRequest,
  ): Promise<NewsIndicatorSettingsModel> {
    const user = this.requireUser(req);
    return this.newsIndicatorSettingsService.getSettings(user.orgId);
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsIndicatorSettingsModel)
  async updateNewsIndicatorSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateNewsIndicatorSettingsInput,
  ): Promise<NewsIndicatorSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);

    const settingsInput: NewsIndicatorAssociationSettingsInput = {
      enabled: input.enabled,
      ingestionEnabled: input.ingestionEnabled,
      windowDays: input.windowDays,
      maxLagDays: input.maxLagDays,
      minSampleSize: input.minSampleSize,
      minAbsCorrelation: input.minAbsCorrelation,
      maxPValue: input.maxPValue,
      topEntities: input.topEntities,
      topTopics: input.topTopics,
      maxAssociationsPerIndicator: input.maxAssociationsPerIndicator,
      indicatorSlugs: input.indicatorSlugs,
      backtestTriggerZScore: input.backtestTriggerZScore,
      backtestBaselineDays: input.backtestBaselineDays,
      backtestHoldoutDays: input.backtestHoldoutDays,
      cacheTtlSeconds: input.cacheTtlSeconds,
    };

    return this.newsIndicatorSettingsService.updateSettings(
      user.orgId,
      user.id,
      settingsInput,
    );
  }

  @HasPermission("settings.manage")
  @Query(() => AuthCacheSettingsModel)
  async authCacheSettings(
    @Context("req") req: GqlRequest,
  ): Promise<AuthCacheSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.authCacheSettingsService.getSettings();
  }

  @HasPermission("settings.manage")
  @Mutation(() => AuthCacheSettingsModel)
  async updateAuthCacheSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateAuthCacheSettingsInput,
  ): Promise<AuthCacheSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.authCacheSettingsService.updateSettings(
      user.orgId,
      user.id,
      input,
    );
  }

  @HasPermission("settings.manage")
  @Query(() => CrawlClientSettingsModel)
  async crawlClientSettings(
    @Context("req") req: GqlRequest,
  ): Promise<CrawlClientSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.crawlSettings.getSettings();
  }

  @HasPermission("settings.manage")
  @Mutation(() => CrawlClientSettingsModel)
  async updateCrawlClientSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateCrawlClientSettingsInput,
  ): Promise<CrawlClientSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.crawlSettings.updateSettings(user.orgId, user.id, input);
  }

  @HasPermission("settings.manage")
  @Query(() => AuditLogRetentionModel)
  async auditLogRetention(
    @Context("req") req: GqlRequest,
  ): Promise<AuditLogRetentionModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return { retentionDays: await this.auditLogSettings.getRetentionDays() };
  }

  @HasPermission("settings.manage")
  @Mutation(() => AuditLogRetentionModel)
  async updateAuditLogRetention(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateAuditLogRetentionInput,
  ): Promise<AuditLogRetentionModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return {
      retentionDays: await this.auditLogSettings.updateRetentionDays(
        user.orgId,
        user.id,
        input.retentionDays,
      ),
    };
  }

  @HasPermission("settings.manage")
  @Query(() => NewsPromptConfigModel)
  async newsPromptConfig(
    @Context("req") req: GqlRequest,
  ): Promise<NewsPromptConfigModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.newsPromptConfigService.getConfig();
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsPromptConfigModel)
  async updateNewsPromptConfig(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateNewsPromptConfigInput,
  ): Promise<NewsPromptConfigModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.newsPromptConfigService.updateConfig(
      user.orgId,
      user.id,
      input,
    );
  }

  private requireUser(req: GqlRequest): AuthenticatedUser {
    const user = req?.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new ForbiddenException("Unauthenticated");
    }
    return user;
  }

  private async assertAdmin(user: AuthenticatedUser) {
    if (!Array.isArray(user.roleIds) || user.roleIds.length === 0) {
      throw new ForbiddenException("Unauthenticated");
    }
    const adminRole = await this.prisma.role.findFirst({
      where: {
        id: { in: user.roleIds },
        name: "admin",
      },
      select: { id: true },
    });
    if (!adminRole) {
      throw new ForbiddenException("Admin access required");
    }
  }

  private toSourcePolicyModel(
    details: NewsEventSourcePolicyDetails,
  ): NewsEventSourcePolicySettingsModel {
    return {
      authoritativeDomains: details.authoritativeDomains,
      authoritativeLabels: details.authoritativeLabels,
      blogDomains: details.blogDomains,
      blogLabels: details.blogLabels,
      categoryAuthority: (details.categoryAuthority ?? []).map((entry) => ({
        categoryPrefix: entry.categoryPrefix,
        authoritativeBoost: entry.authoritativeBoost,
        blogPenalty: entry.blogPenalty,
        unknownPenalty: entry.unknownPenalty,
        minConfidenceFloor: entry.minConfidenceFloor,
        mismatchPenalty: entry.mismatchPenalty,
        domainBoosts: (entry.domainBoosts ?? []).map((boost) => ({
          domain: boost.domain,
          delta: boost.delta,
        })),
      })),
      activeRevision: details.activeRevision,
      updatedAt: details.updatedAt ? new Date(details.updatedAt) : null,
      overrides: {
        authoritativeDomainsAdd: details.overrides.authoritativeDomainsAdd,
        authoritativeDomainsRemove:
          details.overrides.authoritativeDomainsRemove,
        authoritativeLabelsAdd: details.overrides.authoritativeLabelsAdd,
        authoritativeLabelsRemove: details.overrides.authoritativeLabelsRemove,
        blogDomainsAdd: details.overrides.blogDomainsAdd,
        blogDomainsRemove: details.overrides.blogDomainsRemove,
        blogLabelsAdd: details.overrides.blogLabelsAdd,
        blogLabelsRemove: details.overrides.blogLabelsRemove,
      },
      warnings: {
        domainConflicts: details.warnings.domainConflicts,
        labelConflicts: details.warnings.labelConflicts,
        hasConflicts: details.warnings.hasConflicts,
      },
      revisions: details.revisions.map((entry) => ({
        revision: entry.revision,
        operation:
          entry.operation === "rollback"
            ? NewsEventSourcePolicyRevisionOperation.rollback
            : entry.operation === "reset"
              ? NewsEventSourcePolicyRevisionOperation.reset
              : NewsEventSourcePolicyRevisionOperation.update,
        actorId: entry.actorId,
        createdAt: new Date(entry.createdAt),
        note: entry.note,
        delta: {
          authoritativeDomainsAdd: entry.delta.authoritativeDomainsAdd,
          authoritativeDomainsRemove: entry.delta.authoritativeDomainsRemove,
          authoritativeLabelsAdd: entry.delta.authoritativeLabelsAdd,
          authoritativeLabelsRemove: entry.delta.authoritativeLabelsRemove,
          blogDomainsAdd: entry.delta.blogDomainsAdd,
          blogDomainsRemove: entry.delta.blogDomainsRemove,
          blogLabelsAdd: entry.delta.blogLabelsAdd,
          blogLabelsRemove: entry.delta.blogLabelsRemove,
        },
      })),
      syncWarnings: Array.isArray(details.syncWarnings)
        ? details.syncWarnings
        : [],
    };
  }

  private toSourcePolicyPresetModel(
    preset: NewsEventSourcePolicyPreset,
  ): NewsEventSourcePolicyPresetSettingsModel {
    return {
      authoritativeDomains: preset.authoritativeDomains,
      authoritativeLabels: preset.authoritativeLabels,
      blogDomains: preset.blogDomains,
      blogLabels: preset.blogLabels,
      categoryAuthority: (preset.categoryAuthority ?? []).map((entry) => ({
        categoryPrefix: entry.categoryPrefix,
        authoritativeBoost: entry.authoritativeBoost,
        blogPenalty: entry.blogPenalty,
        unknownPenalty: entry.unknownPenalty,
        minConfidenceFloor: entry.minConfidenceFloor,
        mismatchPenalty: entry.mismatchPenalty,
        domainBoosts: (entry.domainBoosts ?? []).map((boost) => ({
          domain: boost.domain,
          delta: boost.delta,
        })),
      })),
      updatedAt: preset.updatedAt ? new Date(preset.updatedAt) : null,
      syncWarnings: Array.isArray(preset.syncWarnings)
        ? preset.syncWarnings
        : [],
    };
  }

  private toSourcePolicyRevisionDiffModel(
    diff: NewsEventSourcePolicyRevisionDiff,
  ): NewsEventSourcePolicyRevisionDiffModel {
    return {
      baseRevision: diff.baseRevision,
      targetRevision: diff.targetRevision,
      authoritativeDomainsAdd: diff.authoritativeDomainsAdd,
      authoritativeDomainsRemove: diff.authoritativeDomainsRemove,
      authoritativeLabelsAdd: diff.authoritativeLabelsAdd,
      authoritativeLabelsRemove: diff.authoritativeLabelsRemove,
      blogDomainsAdd: diff.blogDomainsAdd,
      blogDomainsRemove: diff.blogDomainsRemove,
      blogLabelsAdd: diff.blogLabelsAdd,
      blogLabelsRemove: diff.blogLabelsRemove,
    };
  }
}
