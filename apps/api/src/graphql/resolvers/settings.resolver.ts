import { ForbiddenException, UseGuards } from "@nestjs/common";
import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";

import { GqlAuthGuard } from "../../common/guards/gql-auth.guard";
import { GqlPermissionsGuard } from "../../common/guards/gql-permissions.guard";
import { AuthCacheSettingsService } from "../../modules/auth/auth-cache-settings.service";
import type { AuthenticatedUser } from "../../modules/auth/auth.service";
import { PrismaService } from "../../modules/config/prisma.service";
import { CrawlSettingsService } from "../../modules/crawl/crawl-settings.service";
import { NewsPromptConfigService } from "../../modules/news-pipeline/news-prompt-config.service";
import { AuditLogSettingsService } from "../../modules/system-settings/audit-log-settings.service";
import { RateLimitConfigService } from "../../modules/system-settings/rate-limit-config.service";
import { HasPermission } from "../decorators/has-permission.decorator";
import {
  UpdateAuditLogRetentionInput,
  UpdateCrawlClientSettingsInput,
  UpdateAuthCacheSettingsInput,
  UpdateNewsPromptConfigInput,
  UpdateRateLimitSettingsInput
} from "../dto/settings.input";
import type { GqlRequest } from "../graphql.types";
import {
  AuditLogRetentionModel,
  CrawlClientSettingsModel,
  NewsPromptConfigModel,
  AuthCacheSettingsModel,
  RateLimitSettingsModel
} from "../models/settings.model";

@Resolver()
@UseGuards(GqlAuthGuard, GqlPermissionsGuard)
export class SettingsResolver {
  constructor(
    private readonly rateLimitConfig: RateLimitConfigService,
    private readonly newsPromptConfig: NewsPromptConfigService,
    private readonly auditLogSettings: AuditLogSettingsService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly authCacheSettings: AuthCacheSettingsService,
    private readonly prisma: PrismaService
  ) {}

  @HasPermission("settings.manage")
  @Query(() => RateLimitSettingsModel)
  async rateLimitSettings(@Context("req") req: GqlRequest): Promise<RateLimitSettingsModel> {
    const user = req?.user as AuthenticatedUser | undefined;
    await this.assertAdmin(user);
    return this.rateLimitConfig.getRateLimitSettings();
  }

  @HasPermission("settings.manage")
  @Mutation(() => RateLimitSettingsModel)
  async updateRateLimitSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateRateLimitSettingsInput
  ): Promise<RateLimitSettingsModel> {
    const user = req?.user as AuthenticatedUser | undefined;
    await this.assertAdmin(user);
    return this.rateLimitConfig.updateRateLimitSettings(user.orgId, user.id, input);
  }

  @HasPermission("settings.manage")
  @Query(() => AuthCacheSettingsModel)
  async authCacheSettings(@Context("req") req: GqlRequest): Promise<AuthCacheSettingsModel> {
    const user = req?.user as AuthenticatedUser | undefined;
    await this.assertAdmin(user);
    return this.authCacheSettings.getSettings();
  }

  @HasPermission("settings.manage")
  @Mutation(() => AuthCacheSettingsModel)
  async updateAuthCacheSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateAuthCacheSettingsInput
  ): Promise<AuthCacheSettingsModel> {
    const user = req?.user as AuthenticatedUser | undefined;
    await this.assertAdmin(user);
    return this.authCacheSettings.updateSettings(user.orgId, user.id, input);
  }

  @HasPermission("settings.manage")
  @Query(() => CrawlClientSettingsModel)
  async crawlClientSettings(@Context("req") req: GqlRequest): Promise<CrawlClientSettingsModel> {
    const user = req?.user as AuthenticatedUser | undefined;
    await this.assertAdmin(user);
    return this.crawlSettings.getSettings();
  }

  @HasPermission("settings.manage")
  @Mutation(() => CrawlClientSettingsModel)
  async updateCrawlClientSettings(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateCrawlClientSettingsInput
  ): Promise<CrawlClientSettingsModel> {
    const user = req?.user as AuthenticatedUser | undefined;
    await this.assertAdmin(user);
    return this.crawlSettings.updateSettings(user.orgId, user.id, input);
  }

  @HasPermission("settings.manage")
  @Query(() => AuditLogRetentionModel)
  async auditLogRetention(@Context("req") req: GqlRequest): Promise<AuditLogRetentionModel> {
    const user = req?.user as AuthenticatedUser | undefined;
    await this.assertAdmin(user);
    return { retentionDays: await this.auditLogSettings.getRetentionDays() };
  }

  @HasPermission("settings.manage")
  @Mutation(() => AuditLogRetentionModel)
  async updateAuditLogRetention(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateAuditLogRetentionInput
  ): Promise<AuditLogRetentionModel> {
    const user = req?.user as AuthenticatedUser | undefined;
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
    const user = req?.user as AuthenticatedUser | undefined;
    await this.assertAdmin(user);
    return this.newsPromptConfig.getConfig();
  }

  @HasPermission("settings.manage")
  @Mutation(() => NewsPromptConfigModel)
  async updateNewsPromptConfig(
    @Context("req") req: GqlRequest,
    @Args("input") input: UpdateNewsPromptConfigInput
  ): Promise<NewsPromptConfigModel> {
    const user = req?.user as AuthenticatedUser | undefined;
    await this.assertAdmin(user);
    return this.newsPromptConfig.updateConfig(user.orgId, user.id, input);
  }

  private async assertAdmin(user?: AuthenticatedUser) {
    if (!user || !Array.isArray(user.roleIds) || user.roleIds.length === 0) {
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
