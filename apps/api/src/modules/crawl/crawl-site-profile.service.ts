import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { PrismaService } from "../config/prisma.service";

import {
  matchHostPattern,
  normalizeCrawlSiteProfileConfig,
} from "./crawl-frontier.utils";
import type {
  CrawlSiteExecutionMode,
  CrawlSiteProfileConfig,
  CrawlSiteProfileRecord,
} from "./crawl.types";
import {
  CreateCrawlSiteProfileDto,
  ListCrawlSiteProfileDto,
  PreviewCrawlSiteProfileDto,
  UpdateCrawlSiteProfileDto,
} from "./dto/crawl-frontier.dto";

@Injectable()
export class CrawlSiteProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async findShadowProfileForActiveProfile(orgId: string, activeProfileId: string) {
    const profiles = await this.prisma.crawlSiteProfile.findMany({
      where: {
        orgId,
        isActive: false,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
    const matched = profiles.find((profile) => {
      const config = normalizeCrawlSiteProfileConfig(profile.config);
      return config.llmAssist?.shadow?.shadowOfProfileId === activeProfileId;
    });
    return matched ? this.mapProfile(matched) : null;
  }

  async upsertShadowProfileFromSuggestion(options: {
    orgId: string;
    actorId: string;
    activeProfile: CrawlSiteProfileRecord;
    suggestionConfidence: number;
    suggestionReason?: string | null;
    suggestionPatch?: Partial<CrawlSiteProfileConfig>;
    sourceRunId: string;
  }) {
    const existingShadow = await this.findShadowProfileForActiveProfile(
      options.orgId,
      options.activeProfile.id,
    );
    const nextConfig = this.buildShadowProfileConfig({
      activeConfig: options.activeProfile.config,
      existingShadowConfig: existingShadow?.config,
      activeProfileId: options.activeProfile.id,
      activeProfileVersion: options.activeProfile.version,
      suggestionConfidence: options.suggestionConfidence,
      suggestionReason: options.suggestionReason,
      sourceRunId: options.sourceRunId,
      suggestionPatch: options.suggestionPatch,
    });
    if (existingShadow) {
      return this.updateProfile(options.orgId, options.actorId, existingShadow.id, {
        name: existingShadow.name,
        description:
          existingShadow.description ??
          `Shadow profile learned from ${options.activeProfile.name}`,
        matchHost: existingShadow.matchHost,
        isActive: false,
        executionMode: existingShadow.executionMode,
        config: nextConfig as Record<string, unknown>,
      });
    }
    return this.createProfile(options.orgId, options.actorId, {
      name: `${options.activeProfile.name} [shadow]`,
      description:
        options.activeProfile.description ??
        `Shadow profile learned from ${options.activeProfile.name}`,
      matchHost: options.activeProfile.matchHost,
      isActive: false,
      executionMode: options.activeProfile.executionMode,
      config: nextConfig as Record<string, unknown>,
    });
  }

  async recordShadowEvaluation(options: {
    orgId: string;
    actorId: string;
    shadowProfileId: string;
    originRunId: string;
    shadowRunId: string;
    passed: boolean;
    metrics: Record<string, unknown>;
  }) {
    const shadowProfile = await this.getProfile(options.orgId, options.shadowProfileId);
    const shadow = shadowProfile.config.llmAssist?.shadow;
    const updatedShadowConfig = normalizeCrawlSiteProfileConfig({
      ...shadowProfile.config,
      llmAssist: {
        ...shadowProfile.config.llmAssist,
        shadow: {
          ...shadow,
          role: "shadow",
          state: "evaluating",
          evaluationRunsCompleted: (shadow?.evaluationRunsCompleted ?? 0) + 1,
          consecutivePasses: options.passed
            ? (shadow?.consecutivePasses ?? 0) + 1
            : 0,
          lastOriginRunId: options.originRunId,
          lastShadowRunId: options.shadowRunId,
          lastSuggestionReason:
            typeof options.metrics.summary === "string"
              ? options.metrics.summary
              : shadow?.lastSuggestionReason ?? null,
        },
      },
    });
    return this.updateProfile(options.orgId, options.actorId, shadowProfile.id, {
      name: shadowProfile.name,
      description: shadowProfile.description ?? undefined,
      matchHost: shadowProfile.matchHost,
      isActive: false,
      executionMode: shadowProfile.executionMode,
      config: updatedShadowConfig as Record<string, unknown>,
    });
  }

  async publishShadowProfile(options: {
    orgId: string;
    actorId: string;
    activeProfileId: string;
    shadowProfileId: string;
    shadowRunId: string;
    comparison: Record<string, unknown>;
  }) {
    const activeProfile = await this.getProfile(options.orgId, options.activeProfileId);
    const shadowProfile = await this.getProfile(options.orgId, options.shadowProfileId);
    const publishedAt = new Date().toISOString();
    const nextActiveConfig = normalizeCrawlSiteProfileConfig({
      ...shadowProfile.config,
      llmAssist: {
        ...shadowProfile.config.llmAssist,
        shadow: {
          role: "active",
          state: "published",
          lastShadowRunId: options.shadowRunId,
          lastPublishedAt: publishedAt,
        },
      },
    });
    const updatedActive = await this.updateProfile(
      options.orgId,
      options.actorId,
      activeProfile.id,
      {
        name: activeProfile.name,
        description: activeProfile.description ?? undefined,
        matchHost: activeProfile.matchHost,
        isActive: activeProfile.isActive,
        executionMode: shadowProfile.executionMode,
        config: nextActiveConfig as Record<string, unknown>,
      },
    );
    const updatedShadow = await this.updateProfile(
      options.orgId,
      options.actorId,
      shadowProfile.id,
      {
        name: shadowProfile.name,
        description: shadowProfile.description ?? undefined,
        matchHost: shadowProfile.matchHost,
        isActive: false,
        executionMode: shadowProfile.executionMode,
        config: normalizeCrawlSiteProfileConfig({
          ...shadowProfile.config,
          llmAssist: {
            ...shadowProfile.config.llmAssist,
            shadow: {
              ...shadowProfile.config.llmAssist?.shadow,
              role: "shadow",
              state: "published",
              lastShadowRunId: options.shadowRunId,
              lastPublishedAt: publishedAt,
              lastSuggestionReason:
                typeof options.comparison.summary === "string"
                  ? options.comparison.summary
                  : shadowProfile.config.llmAssist?.shadow?.lastSuggestionReason ??
                    null,
            },
          },
        }) as Record<string, unknown>,
      },
    );
    return {
      activeProfile: updatedActive,
      shadowProfile: updatedShadow,
    };
  }

  async listProfiles(orgId: string, query?: ListCrawlSiteProfileDto) {
    const where: Prisma.CrawlSiteProfileWhereInput = { orgId };
    const search = query?.search?.trim();
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { matchHost: { contains: search } },
      ];
    }
    const profiles = await this.prisma.crawlSiteProfile.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
    return profiles.map((profile) => this.mapProfile(profile));
  }

  async getProfile(orgId: string, id: string) {
    const profile = await this.prisma.crawlSiteProfile.findUnique({
      where: { id },
    });
    if (!profile || profile.orgId !== orgId) {
      throw new NotFoundException("Crawl site profile not found");
    }
    return this.mapProfile(profile);
  }

  async createProfile(
    orgId: string,
    actorId: string,
    input: CreateCrawlSiteProfileDto,
  ) {
    const payload = this.normalizeInput(input);
    const created = await this.prisma.crawlSiteProfile.create({
      data: {
        orgId,
        name: payload.name,
        description: payload.description,
        matchHost: payload.matchHost,
        isActive: payload.isActive,
        executionMode: payload.executionMode,
        config: toPrismaJsonValue(payload.config),
        createdById: actorId,
        updatedById: actorId,
        publishedAt: new Date(),
      },
    });
    await this.createVersion(created.id, orgId, actorId, {
      version: created.version,
      name: created.name,
      description: created.description,
      matchHost: created.matchHost,
      isActive: created.isActive,
      executionMode: created.executionMode,
      config: payload.config,
    });
    return this.mapProfile(created);
  }

  async updateProfile(
    orgId: string,
    actorId: string,
    id: string,
    input: UpdateCrawlSiteProfileDto,
  ) {
    const existing = await this.prisma.crawlSiteProfile.findUnique({
      where: { id },
    });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("Crawl site profile not found");
    }

    const existingConfig = normalizeCrawlSiteProfileConfig(existing.config);
    const data: Prisma.CrawlSiteProfileUpdateInput = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new BadRequestException("name is required");
      }
      data.name = name;
    }
    if (input.description !== undefined) {
      data.description = this.normalizeOptionalString(input.description);
    }
    if (input.matchHost !== undefined) {
      data.matchHost = this.normalizeMatchHost(input.matchHost);
    }
    if (input.isActive !== undefined) {
      data.isActive = input.isActive;
    }
    if (input.executionMode !== undefined) {
      data.executionMode = input.executionMode;
    }
    if (input.config !== undefined) {
      const config = normalizeCrawlSiteProfileConfig(input.config);
      data.config = toPrismaJsonValue(config);
    }

    data.version = { increment: 1 };
    data.updatedById = actorId;
    data.publishedAt = new Date();

    const updated = await this.prisma.crawlSiteProfile.update({
      where: { id },
      data,
    });

    await this.createVersion(updated.id, orgId, actorId, {
      version: updated.version,
      name: updated.name,
      description: updated.description,
      matchHost: updated.matchHost,
      isActive: updated.isActive,
      executionMode: updated.executionMode,
      config:
        input.config !== undefined
          ? normalizeCrawlSiteProfileConfig(input.config)
          : existingConfig,
    });

    return this.mapProfile(updated);
  }

  async listVersions(orgId: string, profileId: string) {
    const existing = await this.prisma.crawlSiteProfile.findUnique({
      where: { id: profileId },
      select: { id: true, orgId: true },
    });
    if (!existing || existing.orgId !== orgId) {
      throw new NotFoundException("Crawl site profile not found");
    }
    return this.prisma.crawlSiteProfileVersion.findMany({
      where: { orgId, profileId },
      orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    });
  }

  async rollbackProfile(
    orgId: string,
    actorId: string,
    profileId: string,
    version: number,
  ) {
    const snapshot = await this.prisma.crawlSiteProfileVersion.findFirst({
      where: { orgId, profileId, version },
    });
    if (!snapshot) {
      throw new NotFoundException("Crawl site profile version not found");
    }

    const updated = await this.prisma.crawlSiteProfile.update({
      where: { id: profileId },
      data: {
        name: snapshot.name,
        description: snapshot.description,
        matchHost: snapshot.matchHost,
        isActive: snapshot.isActive,
        executionMode: snapshot.executionMode,
        config: toPrismaJsonValue(normalizeCrawlSiteProfileConfig(snapshot.config)),
        version: { increment: 1 },
        updatedById: actorId,
        publishedAt: new Date(),
      },
    });

    await this.createVersion(updated.id, orgId, actorId, {
      version: updated.version,
      name: updated.name,
      description: updated.description,
      matchHost: updated.matchHost,
      isActive: updated.isActive,
      executionMode: updated.executionMode,
      config: normalizeCrawlSiteProfileConfig(snapshot.config),
    });

    return this.mapProfile(updated);
  }

  async matchProfileForUrl(orgId: string, url: string) {
    const parsed = this.parseUrl(url);
    const activeProfiles = await this.prisma.crawlSiteProfile.findMany({
      where: { orgId, isActive: true },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });

    const matches = activeProfiles
      .filter((profile) => matchHostPattern(profile.matchHost, parsed.hostname))
      .map((profile) => this.mapProfile(profile));

    return {
      url,
      host: parsed.hostname,
      match: matches[0] ?? null,
      candidates: matches,
    };
  }

  async findProfileForUrl(orgId: string, url: string) {
    const matched = await this.matchProfileForUrl(orgId, url);
    return matched.match;
  }

  async previewProfileDraft(orgId: string, input: PreviewCrawlSiteProfileDto) {
    const parsed = this.parseUrl(input.url);
    const activeMatch = await this.matchProfileForUrl(orgId, input.url);
    const draft = {
      id: "draft",
      orgId,
      name: input.name?.trim() || "Draft profile",
      description: null,
      matchHost: this.normalizeMatchHost(input.matchHost),
      isActive: typeof input.isActive === "boolean" ? input.isActive : true,
      executionMode:
        (input.executionMode as CrawlSiteExecutionMode | undefined) ?? "layered",
      version: 0,
      config: normalizeCrawlSiteProfileConfig(input.config),
      createdById: "draft",
      updatedById: null,
      publishedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } satisfies CrawlSiteProfileRecord;
    const draftMatches = matchHostPattern(draft.matchHost, parsed.hostname);

    return {
      url: input.url,
      host: parsed.hostname,
      draft,
      draftMatches,
      draftMatchReason: draftMatches
        ? `draft host pattern ${draft.matchHost} matches ${parsed.hostname}`
        : `draft host pattern ${draft.matchHost} does not match ${parsed.hostname}`,
      activeMatch: activeMatch.match,
      activeCandidates: activeMatch.candidates,
    };
  }

  private async createVersion(
    profileId: string,
    orgId: string,
    actorId: string,
    input: {
      version: number;
      name: string;
      description?: string | null;
      matchHost: string;
      isActive: boolean;
      executionMode: CrawlSiteExecutionMode;
      config: CrawlSiteProfileConfig;
    },
  ) {
    await this.prisma.crawlSiteProfileVersion.create({
      data: {
        profileId,
        orgId,
        version: input.version,
        name: input.name,
        description: input.description,
        matchHost: input.matchHost,
        isActive: input.isActive,
        executionMode: input.executionMode,
        config: toPrismaJsonValue(input.config),
        createdById: actorId,
      },
    });
  }

  private normalizeInput(
    input: CreateCrawlSiteProfileDto | UpdateCrawlSiteProfileDto,
  ) {
    const name = "name" in input && input.name !== undefined
      ? input.name.trim()
      : undefined;
    if (name !== undefined && !name) {
      throw new BadRequestException("name is required");
    }
    return {
      name: name ?? "",
      description: this.normalizeOptionalString(input.description),
      matchHost:
        "matchHost" in input && input.matchHost !== undefined
          ? this.normalizeMatchHost(input.matchHost)
          : "",
      isActive:
        typeof input.isActive === "boolean" ? input.isActive : true,
      executionMode:
        (input.executionMode as CrawlSiteExecutionMode | undefined) ??
        "layered",
      config: normalizeCrawlSiteProfileConfig(input.config ?? {}),
    };
  }

  private normalizeOptionalString(value?: string | null) {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeMatchHost(value: string) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      throw new BadRequestException("matchHost is required");
    }
    return trimmed;
  }

  private parseUrl(value: string) {
    try {
      return new URL(value);
    } catch {
      throw new BadRequestException("url must be a valid absolute URL");
    }
  }

  private buildShadowProfileConfig(options: {
    activeConfig: CrawlSiteProfileConfig;
    existingShadowConfig?: CrawlSiteProfileConfig;
    activeProfileId: string;
    activeProfileVersion: number;
    suggestionConfidence: number;
    suggestionReason?: string | null;
    sourceRunId: string;
    suggestionPatch?: Partial<CrawlSiteProfileConfig>;
  }): CrawlSiteProfileConfig {
    const mergedPatch = this.mergeProfilePatch(
      options.activeConfig,
      options.suggestionPatch,
    );
    return normalizeCrawlSiteProfileConfig({
      ...mergedPatch,
      llmAssist: {
        ...options.activeConfig.llmAssist,
        ...options.existingShadowConfig?.llmAssist,
        enabled: true,
        shadowEvaluationRuns:
          options.activeConfig.llmAssist?.shadowEvaluationRuns ?? 3,
        autoPublishThresholds:
          options.activeConfig.llmAssist?.autoPublishThresholds ?? {
            minArticleLift: 0.15,
            minNoiseReduction: 0.2,
            minJudgeConfidence: 0.75,
          },
        shadow: {
          ...options.existingShadowConfig?.llmAssist?.shadow,
          role: "shadow",
          shadowOfProfileId: options.activeProfileId,
          originProfileVersion: options.activeProfileVersion,
          state: "evaluating",
          lastOriginRunId: options.sourceRunId,
          lastSuggestedAt: new Date().toISOString(),
          lastSuggestionConfidence: options.suggestionConfidence,
          lastSuggestionReason: options.suggestionReason ?? null,
        },
      },
    });
  }

  private mergeProfilePatch(
    base: CrawlSiteProfileConfig,
    patch?: Partial<CrawlSiteProfileConfig>,
  ): CrawlSiteProfileConfig {
    if (!patch) {
      return base;
    }
    return normalizeCrawlSiteProfileConfig({
      ...base,
      ...patch,
      urlPatterns: {
        ...(base.urlPatterns ?? {}),
        ...(patch.urlPatterns ?? {}),
      },
      pageTypeSignals: {
        ...(base.pageTypeSignals ?? {}),
        ...(patch.pageTypeSignals ?? {}),
      },
      localeScope: {
        ...(base.localeScope ?? {}),
        ...(patch.localeScope ?? {}),
      },
      seedDiscovery: {
        ...(base.seedDiscovery ?? {}),
        ...(patch.seedDiscovery ?? {}),
        qualityThresholds: {
          ...(base.seedDiscovery?.qualityThresholds ?? {}),
          ...(patch.seedDiscovery?.qualityThresholds ?? {}),
        },
      },
      llmAssist: {
        ...(base.llmAssist ?? {}),
        ...(patch.llmAssist ?? {}),
      },
    });
  }

  private mapProfile(
    profile: {
      id: string;
      orgId: string;
      name: string;
      description: string | null;
      matchHost: string;
      isActive: boolean;
      executionMode: CrawlSiteExecutionMode;
      version: number;
      config: Prisma.JsonValue;
      createdById: string;
      updatedById: string | null;
      publishedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
  ) {
    return {
      ...profile,
      config: normalizeCrawlSiteProfileConfig(profile.config),
    };
  }
}
