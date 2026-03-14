import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export interface LlmRuntimeSettings {
  mode: "observe_only";
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  maxConcurrency: number;
  alertCooldownSeconds: number;
  requestLeaseTtlSeconds: number;
}

export interface LlmRuntimeSettingsPublic extends LlmRuntimeSettings {
  source: "default" | "db";
}

interface StoredLlmRuntimeSettings {
  mode?: unknown;
  dailyBudgetUsd?: unknown;
  monthlyBudgetUsd?: unknown;
  maxConcurrency?: unknown;
  alertCooldownSeconds?: unknown;
  requestLeaseTtlSeconds?: unknown;
}

const SETTINGS_KEY = "llm_runtime_settings";
const SETTINGS_DESCRIPTION =
  "Global LiteLLM runtime observe-only thresholds for spend and concurrency.";
const CACHE_KEY = "llm_runtime:settings";
const CACHE_TTL_SECONDS = 30;
const DEFAULT_SETTINGS: LlmRuntimeSettings = {
  mode: "observe_only",
  dailyBudgetUsd: 25,
  monthlyBudgetUsd: 500,
  maxConcurrency: 16,
  alertCooldownSeconds: 300,
  requestLeaseTtlSeconds: 120,
};

@Injectable()
export class LlmRuntimeSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getPublicSettings(): Promise<LlmRuntimeSettingsPublic> {
    const record = await this.loadStoredSettings();
    const settings = this.normalize(record ?? {});
    return {
      source: record ? "db" : "default",
      ...settings,
    };
  }

  async getEffectiveSettings(): Promise<LlmRuntimeSettings> {
    const record = await this.loadStoredSettings();
    return this.normalize(record ?? {});
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: Partial<LlmRuntimeSettings>,
  ): Promise<LlmRuntimeSettingsPublic> {
    const settings = this.normalize(input);
    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      update: {
        value: toPrismaJsonValue(settings),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false,
      },
      create: {
        key: SETTINGS_KEY,
        value: toPrismaJsonValue(settings),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false,
      },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "llm_runtime_update",
          metadata: toPrismaJsonValue(
            settings as unknown as Prisma.InputJsonObject,
          ),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "llm_runtime_update",
      },
    );

    await this.cache.del(CACHE_KEY);
    return this.getPublicSettings();
  }

  async resetToDefaults(
    orgId: string,
    actorId: string,
  ): Promise<LlmRuntimeSettingsPublic> {
    await this.prisma.systemSetting.deleteMany({
      where: { key: SETTINGS_KEY },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "llm_runtime_reset",
          metadata: toPrismaJsonValue({
            ok: true,
          } satisfies Prisma.InputJsonObject),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "llm_runtime_reset",
      },
    );

    await this.cache.del(CACHE_KEY);
    return this.getPublicSettings();
  }

  private async loadStoredSettings(): Promise<StoredLlmRuntimeSettings | null> {
    return this.cache.wrap<StoredLlmRuntimeSettings | null>(
      CACHE_KEY,
      CACHE_TTL_SECONDS,
      async () => {
        const record = await this.prisma.systemSetting.findUnique({
          where: { key: SETTINGS_KEY },
          select: { value: true },
        });
        return (record?.value as StoredLlmRuntimeSettings | null) ?? null;
      },
    );
  }

  private normalize(
    raw: StoredLlmRuntimeSettings | Partial<LlmRuntimeSettings>,
  ): LlmRuntimeSettings {
    return {
      mode: "observe_only",
      dailyBudgetUsd: this.clampNumber(
        raw.dailyBudgetUsd,
        0,
        1_000_000,
        DEFAULT_SETTINGS.dailyBudgetUsd,
      ),
      monthlyBudgetUsd: this.clampNumber(
        raw.monthlyBudgetUsd,
        0,
        1_000_000,
        DEFAULT_SETTINGS.monthlyBudgetUsd,
      ),
      maxConcurrency: this.clampInt(
        raw.maxConcurrency,
        1,
        1_024,
        DEFAULT_SETTINGS.maxConcurrency,
      ),
      alertCooldownSeconds: this.clampInt(
        raw.alertCooldownSeconds,
        10,
        86_400,
        DEFAULT_SETTINGS.alertCooldownSeconds,
      ),
      requestLeaseTtlSeconds: this.clampInt(
        raw.requestLeaseTtlSeconds,
        15,
        3_600,
        DEFAULT_SETTINGS.requestLeaseTtlSeconds,
      ),
    };
  }

  private clampInt(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, Math.round(parsed)));
  }

  private clampNumber(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, Number(parsed.toFixed(4))));
  }
}
