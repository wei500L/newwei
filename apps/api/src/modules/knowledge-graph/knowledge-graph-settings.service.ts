import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export interface KnowledgeGraphSettings {
  enabled: boolean;
  ingestionEnabled: boolean;
  maxBatchSize: number;
  maxRelationsPerArticle: number;
  minEdgeConfidence: number;
  dynamicEdgeConfidenceEnabled: boolean;
  dynamicEdgeConfidenceQuantile: number;
  multiModelValidationEnabled: boolean;
  multiModelValidationModels: string[];
  multiModelValidationModelCount: number;
  multiModelValidationMaxRelationsPerArticle: number;
  entityDisambiguationEnabled: boolean;
  entityDisambiguationMaxCandidates: number;
  cacheTtlSeconds: number;
}

export interface KnowledgeGraphSettingsInput {
  enabled: boolean;
  ingestionEnabled: boolean;
  maxBatchSize: number;
  maxRelationsPerArticle: number;
  minEdgeConfidence: number;
  dynamicEdgeConfidenceEnabled: boolean;
  dynamicEdgeConfidenceQuantile: number;
  multiModelValidationEnabled: boolean;
  multiModelValidationModels: string[];
  multiModelValidationModelCount: number;
  multiModelValidationMaxRelationsPerArticle: number;
  entityDisambiguationEnabled: boolean;
  entityDisambiguationMaxCandidates: number;
  cacheTtlSeconds: number;
}

const SETTINGS_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "knowledgeGraph:settings:";
const SYSTEM_SETTING_KEY_PREFIX = "knowledge_graph_settings:";

const MIN_MAX_BATCH_SIZE = 1;
const MAX_MAX_BATCH_SIZE = 500;
const MIN_MAX_RELATIONS_PER_ARTICLE = 0;
const MAX_MAX_RELATIONS_PER_ARTICLE = 100;
const MIN_MIN_EDGE_CONFIDENCE = 0;
const MAX_MIN_EDGE_CONFIDENCE = 1;
const MIN_DYNAMIC_EDGE_CONFIDENCE_QUANTILE = 0;
const MAX_DYNAMIC_EDGE_CONFIDENCE_QUANTILE = 1;
const MIN_MULTI_MODEL_VALIDATION_MODEL_COUNT = 2;
const MAX_MULTI_MODEL_VALIDATION_MODEL_COUNT = 3;
const MIN_MULTI_MODEL_VALIDATION_MAX_RELATIONS_PER_ARTICLE = 0;
const MAX_MULTI_MODEL_VALIDATION_MAX_RELATIONS_PER_ARTICLE = 20;
const MIN_ENTITY_DISAMBIGUATION_MAX_CANDIDATES = 2;
const MAX_ENTITY_DISAMBIGUATION_MAX_CANDIDATES = 20;
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
    const key = this.systemSettingKey(orgId);
    const record = await this.prisma.systemSetting.findUnique({
      where: { key }
    });

    if (!record) {
      const bootstrap = this.getBootstrapSettings();
      const persisted = await this.prisma.systemSetting.upsert({
        where: { key },
        update: {},
        create: {
          key,
          value: toPrismaJsonValue(bootstrap),
          description: `Knowledge graph settings (org=${orgId})`
        }
      });
      const persistedValue = persisted.value as Partial<KnowledgeGraphSettingsInput> | undefined;
      return this.normalizeSettings(persistedValue ?? {}, fallback);
    }

    const raw = record.value as Partial<KnowledgeGraphSettingsInput> | undefined;
    return this.normalizeSettings(raw ?? {}, fallback);
  }

  private getFallbackSettings(): KnowledgeGraphSettings {
    return {
      enabled: false,
      ingestionEnabled: false,
      maxBatchSize: 100,
      maxRelationsPerArticle: 20,
      minEdgeConfidence: 0.55,
      dynamicEdgeConfidenceEnabled: true,
      dynamicEdgeConfidenceQuantile: 0.25,
      multiModelValidationEnabled: false,
      multiModelValidationModels: [],
      multiModelValidationModelCount: 3,
      multiModelValidationMaxRelationsPerArticle: 5,
      entityDisambiguationEnabled: false,
      entityDisambiguationMaxCandidates: 5,
      cacheTtlSeconds: 60
    };
  }

  private getBootstrapSettings(): KnowledgeGraphSettings {
    const fallback = this.getFallbackSettings();
    return {
      ...fallback,
      enabled: true,
      ingestionEnabled: true
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
      maxBatchSize: this.clampInt(value.maxBatchSize, MIN_MAX_BATCH_SIZE, MAX_MAX_BATCH_SIZE, defaults.maxBatchSize),
      maxRelationsPerArticle: this.clampInt(
        value.maxRelationsPerArticle,
        MIN_MAX_RELATIONS_PER_ARTICLE,
        MAX_MAX_RELATIONS_PER_ARTICLE,
        defaults.maxRelationsPerArticle
      ),
      minEdgeConfidence: this.clampFloat(
        value.minEdgeConfidence,
        MIN_MIN_EDGE_CONFIDENCE,
        MAX_MIN_EDGE_CONFIDENCE,
        defaults.minEdgeConfidence
      ),
      dynamicEdgeConfidenceEnabled:
        typeof value.dynamicEdgeConfidenceEnabled === "boolean"
          ? value.dynamicEdgeConfidenceEnabled
          : defaults.dynamicEdgeConfidenceEnabled,
      dynamicEdgeConfidenceQuantile: this.clampFloat(
        value.dynamicEdgeConfidenceQuantile,
        MIN_DYNAMIC_EDGE_CONFIDENCE_QUANTILE,
        MAX_DYNAMIC_EDGE_CONFIDENCE_QUANTILE,
        defaults.dynamicEdgeConfidenceQuantile
      ),
      multiModelValidationEnabled:
        typeof value.multiModelValidationEnabled === "boolean"
          ? value.multiModelValidationEnabled
          : defaults.multiModelValidationEnabled,
      multiModelValidationModels: this.normalizeStringList(
        value.multiModelValidationModels,
        defaults.multiModelValidationModels
      ),
      multiModelValidationModelCount: this.clampInt(
        value.multiModelValidationModelCount,
        MIN_MULTI_MODEL_VALIDATION_MODEL_COUNT,
        MAX_MULTI_MODEL_VALIDATION_MODEL_COUNT,
        defaults.multiModelValidationModelCount
      ),
      multiModelValidationMaxRelationsPerArticle: this.clampInt(
        value.multiModelValidationMaxRelationsPerArticle,
        MIN_MULTI_MODEL_VALIDATION_MAX_RELATIONS_PER_ARTICLE,
        MAX_MULTI_MODEL_VALIDATION_MAX_RELATIONS_PER_ARTICLE,
        defaults.multiModelValidationMaxRelationsPerArticle
      ),
      entityDisambiguationEnabled:
        typeof value.entityDisambiguationEnabled === "boolean"
          ? value.entityDisambiguationEnabled
          : defaults.entityDisambiguationEnabled,
      entityDisambiguationMaxCandidates: this.clampInt(
        value.entityDisambiguationMaxCandidates,
        MIN_ENTITY_DISAMBIGUATION_MAX_CANDIDATES,
        MAX_ENTITY_DISAMBIGUATION_MAX_CANDIDATES,
        defaults.entityDisambiguationMaxCandidates
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

  private clampFloat(value: unknown, min: number, max: number, fallback: number) {
    const numeric = this.toNumber(value);
    if (numeric === null || Number.isNaN(numeric)) {
      return fallback;
    }
    if (numeric < min) {
      return min;
    }
    if (numeric > max) {
      return max;
    }
    return numeric;
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

  private normalizeStringList(value: unknown, fallback: string[]) {
    const list = Array.isArray(value) ? value : [];
    const normalized = new Set<string>();
    for (const entry of list) {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed.length > 0) {
          normalized.add(trimmed);
        }
      }
    }
    const result = Array.from(normalized).slice(0, 10);
    return result.length > 0 ? result : fallback;
  }
}
