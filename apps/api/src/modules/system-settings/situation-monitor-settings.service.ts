import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export type SituationMonitorSettingsSource = "env" | "db";

export interface SituationMonitorSettingsPublic {
  source: SituationMonitorSettingsSource;
  translationMaxConcurrency: number;
}

interface StoredSituationMonitorSettings {
  translationMaxConcurrency?: unknown;
}

interface CachedSituationMonitorSettings {
  exists: boolean;
  value?: StoredSituationMonitorSettings;
}

const SETTINGS_KEY = "situation_monitor_settings";
const SETTINGS_DESCRIPTION = "Situation monitor LLM translation tuning settings.";
const CACHE_KEY = "situation_monitor:settings";
const CACHE_TTL_SECONDS = 30;
const DEFAULT_TRANSLATION_MAX_CONCURRENCY = 2;

@Injectable()
export class SituationMonitorSettingsService {
  private readonly logger = createLogger({ name: "situation-monitor-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  async getPublicSettings(): Promise<SituationMonitorSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);

    return {
      source: stored ? "db" : "env",
      translationMaxConcurrency: effective.translationMaxConcurrency
    };
  }

  async getTranslationMaxConcurrency(): Promise<number> {
    const stored = await this.loadStoredSettings();
    return this.resolveEffectiveConfig(stored).translationMaxConcurrency;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: { translationMaxConcurrency: number }
  ): Promise<SituationMonitorSettingsPublic> {
    const nextStored: StoredSituationMonitorSettings = {
      translationMaxConcurrency: input.translationMaxConcurrency
    };

    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      create: {
        key: SETTINGS_KEY,
        description: SETTINGS_DESCRIPTION,
        value: this.toPrismaJson(nextStored)
      },
      update: {
        description: SETTINGS_DESCRIPTION,
        value: this.toPrismaJson(nextStored)
      }
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "situation_monitor_update",
          metadata: this.toPrismaJson({ ok: true } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "situation_monitor_update" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  async resetToEnv(orgId: string, actorId: string): Promise<SituationMonitorSettingsPublic> {
    await this.prisma.systemSetting.deleteMany({ where: { key: SETTINGS_KEY } });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "situation_monitor_reset",
          metadata: this.toPrismaJson({ ok: true } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "situation_monitor_reset" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  private resolveEffectiveConfig(stored: StoredSituationMonitorSettings | null) {
    return {
      translationMaxConcurrency: this.asBoundedInt(
        stored?.translationMaxConcurrency,
        DEFAULT_TRANSLATION_MAX_CONCURRENCY,
        1,
        10
      )
    };
  }

  private asBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  private async loadStoredSettings(): Promise<StoredSituationMonitorSettings | null> {
    let cached: CachedSituationMonitorSettings | null = null;
    try {
      cached = await this.cache.get<CachedSituationMonitorSettings>(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read situation monitor settings cache");
    }

    if (cached) {
      return cached.exists ? cached.value ?? null : null;
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY }
    });
    const raw = record?.value as unknown;
    const settings = raw && typeof raw === "object" ? (raw as StoredSituationMonitorSettings) : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        { exists: Boolean(record), value: settings ?? undefined } satisfies CachedSituationMonitorSettings,
        CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write situation monitor settings cache");
    }

    return settings;
  }

  private async invalidateCache() {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate situation monitor settings cache");
    }
  }

  private toPrismaJson(value: unknown) {
    return value as Prisma.InputJsonValue;
  }
}

