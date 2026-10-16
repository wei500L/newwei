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
    // 缺陷 1：非空的工作流绑定必须存在且属于本组织（清空 null 仍允许）。
    if (payload.workflowId) {
      await this.assertWorkflowInOrg(orgId, payload.workflowId);
    }
    if (payload.workflowVersionId) {
      await this.assertWorkflowVersionInOrg(orgId, payload.workflowVersionId);
    }
    // 缺陷 2：画像插入与第一条版本快照在同一事务。
    const created = await this.prisma.$transaction(async (tx) => {
      const profile = await tx.crawlSiteProfile.create({
        data: {
          orgId,
          name: payload.name,
          description: payload.description,
          matchHost: payload.matchHost,
          isActive: payload.isActive,
          executionMode: payload.executionMode,
          workflowId: payload.workflowId,
          workflowVersionId: payload.workflowVersionId,
          workflowBindingMode: payload.workflowBindingMode,
          config: toPrismaJsonValue(payload.config),
          createdById: actorId,
          updatedById: actorId,
          publishedAt: new Date(),
        },
      });
      await this.createVersion(tx, profile.id, orgId, actorId, {
        version: profile.version,
        name: profile.name,
        description: profile.description,
        matchHost: profile.matchHost,
        isActive: profile.isActive,
        executionMode: profile.executionMode,
        workflowId: profile.workflowId,
        workflowVersionId: profile.workflowVersionId,
        workflowBindingMode: profile.workflowBindingMode,
        config: payload.config,
      });
      return profile;
    });
    return this.mapProfile(created);
  }

  async updateProfile(
    orgId: string,
    actorId: string,
    id: string,
    input: UpdateCrawlSiteProfileDto,
  ) {
    // 缺陷 2：单事务 + 行锁。第一条是 SELECT id ... FOR UPDATE；没有行
    // 就 404（跨组织与不存在一致）。UPDATE 的 WHERE 同时包含 id 与 orgId，
    // 版本快照与画像更新在同一事务内完成。
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM CrawlSiteProfile WHERE id = ${id} AND orgId = ${orgId} FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException("Crawl site profile not found");
      }

      const existingRow = await tx.crawlSiteProfile.findUnique({
        where: { id },
        select: { config: true },
      });
      const existingConfig = normalizeCrawlSiteProfileConfig(
        existingRow?.config ?? {},
      );
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
      if (input.workflowId !== undefined) {
        // 缺陷 1：非空值必须存在且属于本组织；null（含 trim 后空白）清空。
        const workflowId = input.workflowId?.trim() || null;
        if (workflowId) {
          await this.assertWorkflowInOrg(orgId, workflowId);
        }
        data.workflow = workflowId
          ? { connect: { id: workflowId } }
          : { disconnect: true };
      }
      if (input.workflowVersionId !== undefined) {
        const workflowVersionId = input.workflowVersionId?.trim() || null;
        if (workflowVersionId) {
          await this.assertWorkflowVersionInOrg(orgId, workflowVersionId);
        }
        data.workflowVersion = workflowVersionId
          ? { connect: { id: workflowVersionId } }
          : { disconnect: true };
      }
      if (input.workflowBindingMode !== undefined) {
        data.workflowBindingMode = input.workflowBindingMode;
      }
      if (input.config !== undefined) {
        const config = normalizeCrawlSiteProfileConfig(input.config);
        data.config = toPrismaJsonValue(config);
      }

      data.version = { increment: 1 };
      data.updatedById = actorId;
      data.publishedAt = new Date();

      const updated = await tx.crawlSiteProfile.update({
        where: { id, orgId },
        data,
      });

      await this.createVersion(tx, updated.id, orgId, actorId, {
        version: updated.version,
        name: updated.name,
        description: updated.description,
        matchHost: updated.matchHost,
        isActive: updated.isActive,
        executionMode: updated.executionMode,
        workflowId: updated.workflowId,
        workflowVersionId: updated.workflowVersionId,
        workflowBindingMode: updated.workflowBindingMode,
        config:
          input.config !== undefined
            ? normalizeCrawlSiteProfileConfig(input.config)
            : existingConfig,
      });

      return this.mapProfile(updated);
    });
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
    // 缺陷 2：单事务 + 行锁。第一条是 SELECT id ... FOR UPDATE；没有行
    // 就 404（跨组织与不存在一致）。快照写回与版本插入在同一事务。
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM CrawlSiteProfile WHERE id = ${profileId} AND orgId = ${orgId} FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException("Crawl site profile not found");
      }
      // 控制器传入 Number.parseInt(version, 10)：NaN（如 "abc"）找不到版本。
      if (!Number.isInteger(version)) {
        throw new NotFoundException("Crawl site profile version not found");
      }

      const snapshot = await tx.crawlSiteProfileVersion.findFirst({
        where: { orgId, profileId, version },
      });
      if (!snapshot) {
        throw new NotFoundException("Crawl site profile version not found");
      }
      const config = normalizeCrawlSiteProfileConfig(snapshot.config);

      const updated = await tx.crawlSiteProfile.update({
        where: { id: profileId, orgId },
        data: {
          name: snapshot.name,
          description: snapshot.description,
          matchHost: snapshot.matchHost,
          isActive: snapshot.isActive,
          executionMode: snapshot.executionMode,
          workflowId: snapshot.workflowId,
          workflowVersionId: snapshot.workflowVersionId,
          workflowBindingMode: snapshot.workflowBindingMode,
          config: toPrismaJsonValue(config),
          version: { increment: 1 },
          updatedById: actorId,
          publishedAt: new Date(),
        },
      });

      await this.createVersion(tx, updated.id, orgId, actorId, {
        version: updated.version,
        name: updated.name,
        description: updated.description,
        matchHost: updated.matchHost,
        isActive: updated.isActive,
        executionMode: updated.executionMode,
        workflowId: updated.workflowId,
        workflowVersionId: updated.workflowVersionId,
        workflowBindingMode: updated.workflowBindingMode,
        config,
      });

      return this.mapProfile(updated);
    });
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
      workflowId: input.workflowId?.trim() || null,
      workflowVersionId: input.workflowVersionId?.trim() || null,
      workflowBindingMode: input.workflowBindingMode ?? "published",
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
    client: Prisma.TransactionClient,
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
      workflowId?: string | null;
      workflowVersionId?: string | null;
      workflowBindingMode?: "published" | "pinned";
      config: CrawlSiteProfileConfig;
    },
  ) {
    await client.crawlSiteProfileVersion.create({
      data: {
        profileId,
        orgId,
        version: input.version,
        name: input.name,
        description: input.description,
        matchHost: input.matchHost,
        isActive: input.isActive,
        executionMode: input.executionMode,
        workflowId: input.workflowId,
        workflowVersionId: input.workflowVersionId,
        workflowBindingMode: input.workflowBindingMode ?? "published",
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
      workflowId:
        "workflowId" in input && input.workflowId !== undefined
          ? input.workflowId?.trim() || null
          : undefined,
      workflowVersionId:
        "workflowVersionId" in input && input.workflowVersionId !== undefined
          ? input.workflowVersionId?.trim() || null
          : undefined,
      workflowBindingMode:
        "workflowBindingMode" in input && input.workflowBindingMode !== undefined
          ? input.workflowBindingMode
          : "published",
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

  // 缺陷 1：跨组织工作流绑定。文案与 news-source.service.ts 的
  // assertWorkflowInOrg / assertWorkflowVersionInOrg 一致。
  private async assertWorkflowInOrg(orgId: string, workflowId: string) {
    const workflow = await this.prisma.crawlStrategyWorkflow.findUnique({
      where: { id: workflowId },
      select: { orgId: true },
    });
    if (!workflow || workflow.orgId !== orgId) {
      throw new BadRequestException("Invalid workflowId");
    }
  }

  private async assertWorkflowVersionInOrg(
    orgId: string,
    workflowVersionId: string,
  ) {
    const version = await this.prisma.crawlStrategyWorkflowVersion.findUnique({
      where: { id: workflowVersionId },
      select: { orgId: true },
    });
    if (!version || version.orgId !== orgId) {
      throw new BadRequestException("Invalid workflowVersionId");
    }
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
      workflowId?: string | null;
      workflowVersionId?: string | null;
      workflowBindingMode?: "published" | "pinned";
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
