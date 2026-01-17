import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { AuthCacheSettingsService } from "../../modules/auth/auth-cache-settings.service";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { PrismaService } from "../../modules/config/prisma.service";
import { CrawlSettingsService } from "../../modules/crawl/crawl-settings.service";
import {
  KnowledgeGraphSettingsService,
  type KnowledgeGraphSettingsInput
} from "../../modules/knowledge-graph/knowledge-graph-settings.service";
import {
  NewsEventsSettingsService,
  type NewsEventSettingsInput
} from "../../modules/news-events/news-events-settings.service";
import {
  NewsIndicatorSettingsService,
  type NewsIndicatorAssociationSettingsInput
} from "../../modules/news-indicator/news-indicator-settings.service";
import { NewsPromptConfigService } from "../../modules/news-pipeline/news-prompt-config.service";
import { AuditLogSettingsService } from "../../modules/system-settings/audit-log-settings.service";
import {
  EntityImpactGraphSettingsService,
  type EntityImpactGraphSettingsInput
} from "../../modules/system-settings/entity-impact-graph-settings.service";
import { RateLimitConfigService } from "../../modules/system-settings/rate-limit-config.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import {
  UpdateAuditLogRetentionInput,
  UpdateCrawlClientSettingsInput,
  UpdateAuthCacheSettingsInput,
  UpdateNewsPromptConfigInput,
  UpdateEntityImpactGraphSettingsInput,
  UpdateKnowledgeGraphSettingsInput,
  UpdateRateLimitSettingsInput,
  UpdateNewsEventSettingsInput,
  UpdateNewsIndicatorSettingsInput
} from "../dto/settings.input";
import type { GqlRequest } from "../graphql.types";
import {
  AuditLogRetentionModel,
  CrawlClientSettingsModel,
  EntityImpactGraphSettingsModel,
  KnowledgeGraphSettingsModel,
  NewsEventSettingsModel,
  NewsIndicatorSettingsModel,
  NewsPromptConfigModel,
  AuthCacheSettingsModel,
  RateLimitSettingsModel
} from "../models/settings.model";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class SettingsResolver {
  constructor(
    private readonly rateLimitConfig: RateLimitConfigService,
    private readonly entityImpactGraphSettingsService: EntityImpactGraphSettingsService,
    private readonly knowledgeGraphSettingsService: KnowledgeGraphSettingsService,
    private readonly newsEventSettingsService: NewsEventsSettingsService,
    private readonly newsIndicatorSettingsService: NewsIndicatorSettingsService,
    private readonly newsPromptConfigService: NewsPromptConfigService,
    private readonly auditLogSettings: AuditLogSettingsService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly authCacheSettingsService: AuthCacheSettingsService,
    private readonly prisma: PrismaService
  ) {}

  @HasPermission("settings.manage")
  @Query(() => RateLimitSettingsModel)
  async rateLimitSettings(@Context("req") req: GqlRequest): Promise<RateLimitSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.rateLimitConfig.getRateLimitSettings();
  }

  @HasPermission("settings.manage")
  @Mutation(() => RateLimitSettingsModel)
  async updateRateLimitSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateRateLimitSettingsInput
  ): Promise<RateLimitSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.rateLimitConfig.updateRateLimitSettings(user.orgId, user.id, input);
  }

  @HasPermission("dashboard.read")
  @Query(() => EntityImpactGraphSettingsModel)
  async entityImpactGraphSettings(
    @Context("req") req: GqlRequest
  ): Promise<EntityImpactGraphSettingsModel> {
    const user = this.requireUser(req);
    return this.entityImpactGraphSettingsService.getSettings(user.orgId);
  }

  @HasPermission("settings.manage")
  @Mutation(() => EntityImpactGraphSettingsModel)
  async updateEntityImpactGraphSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateEntityImpactGraphSettingsInput
  ): Promise<EntityImpactGraphSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const settingsInput: EntityImpactGraphSettingsInput = {
      enabled: input.enabled,
      minEntityConfidence: input.minEntityConfidence,
      minCorrelation: input.minCorrelation,
      minCoOccurrence: input.minCoOccurrence,
      maxNodes: input.maxNodes,
      categories: input.categories as EntityImpactGraphSettingsInput["categories"],
      cacheTtlSeconds: input.cacheTtlSeconds
    };
    return this.entityImpactGraphSettingsService.updateSettings(user.orgId, user.id, settingsInput);
  }

  @HasPermission("dashboard.read")
  @Query(() => KnowledgeGraphSettingsModel)
  async knowledgeGraphSettings(@Context("req") req: GqlRequest): Promise<KnowledgeGraphSettingsModel> {
    const user = this.requireUser(req);
    return this.knowledgeGraphSettingsService.getSettings(user.orgId);
  }

  @HasPermission("settings.manage")
  @Mutation(() => KnowledgeGraphSettingsModel)
  async updateKnowledgeGraphSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateKnowledgeGraphSettingsInput
  ): Promise<KnowledgeGraphSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const settingsInput: KnowledgeGraphSettingsInput = {
      enabled: input.enabled,
      ingestionEnabled: input.ingestionEnabled,
      seedIngestionEnabled: input.seedIngestionEnabled,
      seedSwIndustriesPerRun: input.seedSwIndustriesPerRun,
      maxBatchSize: input.maxBatchSize,
      maxRelationsPerArticle: input.maxRelationsPerArticle,
      cacheTtlSeconds: input.cacheTtlSeconds
    };
    return this.knowledgeGraphSettingsService.updateSettings(user.orgId, user.id, settingsInput);
  }

  @HasPermission("dashboard.read")
  @Query(() => NewsEventSettingsModel)
  async newsEventSettings(@Context("req") req: GqlRequest): Promise<NewsEventSettingsModel> {
    const user = this.requireUser(req);
    return this.newsEventSettingsService.getSettings(user.orgId);
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsEventSettingsModel)
  async updateNewsEventSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateNewsEventSettingsInput
  ): Promise<NewsEventSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    const settingsInput: NewsEventSettingsInput = {
      enabled: input.enabled,
      ingestionEnabled: input.ingestionEnabled,
      timelineEnabled: input.timelineEnabled,
      maxBatchSize: input.maxBatchSize,
      backfillDays: input.backfillDays,
      lookbackDays: input.lookbackDays,
      timelineMaxEventsPerRun: input.timelineMaxEventsPerRun,
      vectorMinScore: input.vectorMinScore,
      crossLanguagePenalty: input.crossLanguagePenalty,
      cacheTtlSeconds: input.cacheTtlSeconds
    };
    return this.newsEventSettingsService.updateSettings(user.orgId, user.id, settingsInput);
  }

  @HasPermission("dashboard.read")
  @Query(() => NewsIndicatorSettingsModel)
  async newsIndicatorSettings(@Context("req") req: GqlRequest): Promise<NewsIndicatorSettingsModel> {
    const user = this.requireUser(req);
    return this.newsIndicatorSettingsService.getSettings(user.orgId);
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsIndicatorSettingsModel)
  async updateNewsIndicatorSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateNewsIndicatorSettingsInput
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
      cacheTtlSeconds: input.cacheTtlSeconds
    };

    return this.newsIndicatorSettingsService.updateSettings(user.orgId, user.id, settingsInput);
  }

  @HasPermission("settings.manage")
  @Query(() => AuthCacheSettingsModel)
  async authCacheSettings(@Context("req") req: GqlRequest): Promise<AuthCacheSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.authCacheSettingsService.getSettings();
  }

  @HasPermission("settings.manage")
  @Mutation(() => AuthCacheSettingsModel)
  async updateAuthCacheSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateAuthCacheSettingsInput
  ): Promise<AuthCacheSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.authCacheSettingsService.updateSettings(user.orgId, user.id, input);
  }

  @HasPermission("settings.manage")
  @Query(() => CrawlClientSettingsModel)
  async crawlClientSettings(@Context("req") req: GqlRequest): Promise<CrawlClientSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.crawlSettings.getSettings();
  }

  @HasPermission("settings.manage")
  @Mutation(() => CrawlClientSettingsModel)
  async updateCrawlClientSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateCrawlClientSettingsInput
  ): Promise<CrawlClientSettingsModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.crawlSettings.updateSettings(user.orgId, user.id, input);
  }

  @HasPermission("settings.manage")
  @Query(() => AuditLogRetentionModel)
  async auditLogRetention(@Context("req") req: GqlRequest): Promise<AuditLogRetentionModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return { retentionDays: await this.auditLogSettings.getRetentionDays() };
  }

  @HasPermission("settings.manage")
  @Mutation(() => AuditLogRetentionModel)
  async updateAuditLogRetention(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateAuditLogRetentionInput
  ): Promise<AuditLogRetentionModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return {
      retentionDays: await this.auditLogSettings.updateRetentionDays(
        user.orgId,
        user.id,
        input.retentionDays
      )
    };
  }

  @HasPermission("settings.manage")
  @Query(() => NewsPromptConfigModel)
  async newsPromptConfig(@Context("req") req: GqlRequest): Promise<NewsPromptConfigModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.newsPromptConfigService.getConfig();
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsPromptConfigModel)
  async updateNewsPromptConfig(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateNewsPromptConfigInput
  ): Promise<NewsPromptConfigModel> {
    const user = this.requireUser(req);
    await this.assertAdmin(user);
    return this.newsPromptConfigService.updateConfig(user.orgId, user.id, input);
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
        name: "admin"
      },
      select: { id: true }
    });
    if (!adminRole) {
      throw new ForbiddenException("Admin access required");
    }
  }
}
