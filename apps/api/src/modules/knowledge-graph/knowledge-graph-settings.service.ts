import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export interface KnowledgeGraphSettings {
  enabled: boolean;
  ingestionEnabled: boolean;
  seedIngestionEnabled: boolean;
  seedSwIndustriesPerRun: number;
  maxBatchSize: number;
  maxRelationsPerArticle: number;
  cacheTtlSeconds: number;
}

export interface KnowledgeGraphSettingsInput {
  enabled: boolean;
  ingestionEnabled: boolean;
  seedIngestionEnabled: boolean;
  seedSwIndustriesPerRun: number;
  maxBatchSize: number;
  maxRelationsPerArticle: number;
  cacheTtlSeconds: number;
}

const SETTINGS_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "knowledgeGraph:settings:";
const SYSTEM_SETTING_KEY_PREFIX = "knowledge_graph_settings:";

const MIN_MAX_BATCH_SIZE = 1;
const MAX_MAX_BATCH_SIZE = 500;
const MIN_MAX_RELATIONS_PER_ARTICLE = 0;
const MAX_MAX_RELATIONS_PER_ARTICLE = 100;
const MIN_SW_INDUSTRIES_PER_RUN = 1;
const MAX_SW_INDUSTRIES_PER_RUN = 50;
const MIN_CACHE_TTL_SECONDS = 0;
const MAX_CACHE_TTL_SECONDS = 3600;

@Injectable()
export class KnowledgeGraphSettingsService {
  private readonly logger = createLogger({ name: "knowledge-graph-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  async getSettings(orgId: string): Promise<KnowledgeGraphSettings> {
    const cacheKey = this.cacheKey(orgId);

    let cached: KnowledgeGraphSettings | null = null;
    try {
      cached = await this.cache.get<KnowledgeGraphSettings>(cacheKey);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read knowledge graph settings from cache; falling back to database"
      );
    }

    if (cached) {
      return this.normalizeSettings(cached);
    }

    let settings: KnowledgeGraphSettings;
    try {
      settings = await this.loadSettings(orgId);
    } catch (error) {
      settings = this.getFallbackSettings();
      this.logger.warn(
        { err: error, orgId },
        "Failed to load knowledge graph settings from database; using defaults"
      );
    }

    try {
      await this.cache.set(cacheKey, settings, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: error, orgId }, "Failed to write knowledge graph settings to cache");
    }

    return settings;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: KnowledgeGraphSettingsInput
  ): Promise<KnowledgeGraphSettings> {
    const normalized = this.normalizeSettings(input);
    const key = this.systemSettingKey(orgId);

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `Knowledge graph settings (org=${orgId})`
      },
      create: {
        key,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `Knowledge graph settings (org=${orgId})`
      }
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "knowledge_graph_settings_update",
          metadata: toPrismaJsonValue(normalized)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "knowledge_graph_settings_update" }
    );

    await this.cache.set(this.cacheKey(orgId), normalized, SETTINGS_CACHE_TTL_SECONDS);

    return normalized;
  }

  async invalidateCache(orgId: string) {
    await this.cache.del(this.cacheKey(orgId));
  }

  private async loadSettings(orgId: string): Promise<KnowledgeGraphSettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.systemSettingKey(orgId) }
    });
    const raw = record?.value as Partial<KnowledgeGraphSettingsInput> | undefined;
    return this.normalizeSettings(raw ?? {}, fallback);
  }

  private getFallbackSettings(): KnowledgeGraphSettings {
    return {
      enabled: false,
      ingestionEnabled: false,
      seedIngestionEnabled: false,
      seedSwIndustriesPerRun: 5,
      maxBatchSize: 100,
      maxRelationsPerArticle: 20,
      cacheTtlSeconds: 60
    };
  }

  private normalizeSettings(
    value: Partial<KnowledgeGraphSettingsInput>,
    fallback?: KnowledgeGraphSettings
  ): KnowledgeGraphSettings {
    const defaults = fallback ?? this.getFallbackSettings();

    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
      ingestionEnabled:
        typeof value.ingestionEnabled === "boolean" ? value.ingestionEnabled : defaults.ingestionEnabled,
      seedIngestionEnabled:
        typeof value.seedIngestionEnabled === "boolean" ? value.seedIngestionEnabled : defaults.seedIngestionEnabled,
      seedSwIndustriesPerRun: this.clampInt(
        value.seedSwIndustriesPerRun,
        MIN_SW_INDUSTRIES_PER_RUN,
        MAX_SW_INDUSTRIES_PER_RUN,
        defaults.seedSwIndustriesPerRun
      ),
      maxBatchSize: this.clampInt(value.maxBatchSize, MIN_MAX_BATCH_SIZE, MAX_MAX_BATCH_SIZE, defaults.maxBatchSize),
      maxRelationsPerArticle: this.clampInt(
        value.maxRelationsPerArticle,
        MIN_MAX_RELATIONS_PER_ARTICLE,
        MAX_MAX_RELATIONS_PER_ARTICLE,
        defaults.maxRelationsPerArticle
      ),
      cacheTtlSeconds: this.clampInt(
        value.cacheTtlSeconds,
        MIN_CACHE_TTL_SECONDS,
        MAX_CACHE_TTL_SECONDS,
        defaults.cacheTtlSeconds
      )
    };
  }

  private systemSettingKey(orgId: string) {
    return `${SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private cacheKey(orgId: string) {
    return `${CACHE_KEY_PREFIX}${orgId}`;
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number) {
    const numeric = this.toNumber(value);
    if (numeric === null || Number.isNaN(numeric)) {
      return fallback;
    }
    const rounded = Math.round(numeric);
    if (rounded < min) {
      return min;
    }
    if (rounded > max) {
      return max;
    }
    return rounded;
  }
}
