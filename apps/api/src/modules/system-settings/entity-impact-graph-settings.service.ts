import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export type EntityImpactGraphCategory = "person" | "organization" | "stock" | "commodity";

export interface EntityImpactGraphSettings {
  enabled: boolean;
  minEntityConfidence: number;
  minCorrelation: number;
  minCoOccurrence: number;
  maxNodes: number;
  categories: EntityImpactGraphCategory[];
  cacheTtlSeconds: number;
}

export interface EntityImpactGraphSettingsInput {
  enabled: boolean;
  minEntityConfidence: number;
  minCorrelation: number;
  minCoOccurrence: number;
  maxNodes: number;
  categories: EntityImpactGraphCategory[];
  cacheTtlSeconds: number;
}

const ALLOWED_CATEGORIES: EntityImpactGraphCategory[] = [
  "person",
  "organization",
  "stock",
  "commodity"
];

const SETTINGS_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "entityImpactGraph:settings:";
const SYSTEM_SETTING_KEY_PREFIX = "entity_impact_graph_settings:";

const MIN_CONFIDENCE = 0;
const MAX_CONFIDENCE = 1;
const MIN_CORRELATION = 0;
const MAX_CORRELATION = 1;
const MIN_CO_OCCURRENCE = 1;
const MAX_CO_OCCURRENCE = 100;
const MIN_MAX_NODES = 10;
const MAX_MAX_NODES = 500;
const MIN_CACHE_TTL_SECONDS = 0;
const MAX_CACHE_TTL_SECONDS = 3600;

@Injectable()
export class EntityImpactGraphSettingsService {
  private readonly logger = createLogger({ name: "entity-impact-graph-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  async getSettings(orgId: string): Promise<EntityImpactGraphSettings> {
    const cacheKey = this.cacheKey(orgId);

    let cached: EntityImpactGraphSettings | null = null;
    try {
      cached = await this.cache.get<EntityImpactGraphSettings>(cacheKey);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read entity impact graph settings from cache; falling back to database"
      );
    }

    if (cached) {
      return this.normalizeSettings(cached);
    }

    let settings: EntityImpactGraphSettings;
    try {
      settings = await this.loadSettings(orgId);
    } catch (error) {
      settings = this.getFallbackSettings();
      this.logger.warn(
        { err: error, orgId },
        "Failed to load entity impact graph settings from database; using defaults"
      );
    }

    try {
      await this.cache.set(cacheKey, settings, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to write entity impact graph settings to cache"
      );
    }

    return settings;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: EntityImpactGraphSettingsInput
  ): Promise<EntityImpactGraphSettings> {
    const normalized = this.normalizeSettings(input);
    const key = this.systemSettingKey(orgId);

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `Entity impact graph settings (org=${orgId})`
      },
      create: {
        key,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `Entity impact graph settings (org=${orgId})`
      }
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "entity_impact_graph_settings_update",
          metadata: toPrismaJsonValue(normalized)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "entity_impact_graph_settings_update" }
    );

    await this.cache.set(this.cacheKey(orgId), normalized, SETTINGS_CACHE_TTL_SECONDS);

    return normalized;
  }

  async invalidateCache(orgId: string) {
    await this.cache.del(this.cacheKey(orgId));
  }

  private async loadSettings(orgId: string): Promise<EntityImpactGraphSettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.systemSettingKey(orgId) }
    });
    const raw = record?.value as Partial<EntityImpactGraphSettingsInput> | undefined;
    return this.normalizeSettings(raw ?? {}, fallback);
  }

  private getFallbackSettings(): EntityImpactGraphSettings {
    return {
      enabled: true,
      minEntityConfidence: 0.5,
      minCorrelation: 0.3,
      minCoOccurrence: 2,
      maxNodes: 100,
      categories: [...ALLOWED_CATEGORIES],
      cacheTtlSeconds: 60
    };
  }

  private normalizeSettings(
    value: Partial<EntityImpactGraphSettingsInput>,
    fallback?: EntityImpactGraphSettings
  ): EntityImpactGraphSettings {
    const defaults = fallback ?? this.getFallbackSettings();

    const categories = this.normalizeCategories(value.categories) ?? defaults.categories;

    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
      minEntityConfidence: this.clamp(
        this.toNumber(value.minEntityConfidence),
        MIN_CONFIDENCE,
        MAX_CONFIDENCE,
        defaults.minEntityConfidence
      ),
      minCorrelation: this.clamp(
        this.toNumber(value.minCorrelation),
        MIN_CORRELATION,
        MAX_CORRELATION,
        defaults.minCorrelation
      ),
      minCoOccurrence: this.clampInt(
        value.minCoOccurrence,
        MIN_CO_OCCURRENCE,
        MAX_CO_OCCURRENCE,
        defaults.minCoOccurrence
      ),
      maxNodes: this.clampInt(
        value.maxNodes,
        MIN_MAX_NODES,
        MAX_MAX_NODES,
        defaults.maxNodes
      ),
      categories,
      cacheTtlSeconds: this.clampInt(
        value.cacheTtlSeconds,
        MIN_CACHE_TTL_SECONDS,
        MAX_CACHE_TTL_SECONDS,
        defaults.cacheTtlSeconds
      )
    };
  }

  private normalizeCategories(input: unknown): EntityImpactGraphCategory[] | null {
    if (!Array.isArray(input)) {
      return null;
    }
    const normalized = input
      .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
      .filter((entry): entry is EntityImpactGraphCategory =>
        (ALLOWED_CATEGORIES as string[]).includes(entry)
      );

    if (normalized.length === 0) {
      return null;
    }

    return Array.from(new Set(normalized));
  }

  private systemSettingKey(orgId: string) {
    return `${SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private cacheKey(orgId: string) {
    return `${CACHE_KEY_PREFIX}${orgId}`;
  }

  private clamp(value: number | null, min: number, max: number, fallback: number) {
    if (value === null || Number.isNaN(value)) {
      return fallback;
    }
    if (value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return value;
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

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }
}

