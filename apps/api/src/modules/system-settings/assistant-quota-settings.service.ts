import { AssistantRunModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { TooManyRequestsException } from "../../common/exceptions/too-many-requests.exception";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { RateLimiterService } from "../cache/rate-limiter.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { LlmRequestLogService } from "../news-pipeline/llm-request-log.service";

export type AssistantQuotaSettingsSource = "env" | "db";

export interface AssistantQuotaSettingsPublic {
  source: AssistantQuotaSettingsSource;
  enabled: boolean;
  submitLimitPerHour: number;
  maxInFlightPerOrg: number;
  monthlyTokenBudget: number;
  usage: {
    monthStart: string;
    totalTokens: number;
    inFlight: number;
  };
}

export interface AssistantQuotaEffectiveConfig {
  enabled: boolean;
  submitLimitPerHour: number;
  maxInFlightPerOrg: number;
  monthlyTokenBudget: number;
}

interface StoredAssistantQuotaSettings {
  enabled?: unknown;
  submitLimitPerHour?: unknown;
  maxInFlightPerOrg?: unknown;
  monthlyTokenBudget?: unknown;
}

interface CachedAssistantQuotaSettings {
  exists: boolean;
  value?: StoredAssistantQuotaSettings;
}

const SETTINGS_KEY = "assistant_quota";
const SETTINGS_DESCRIPTION = "AI Assistant per-organization submit rate and monthly token budget.";
const CACHE_KEY = "assistant_quota:settings";
const CACHE_TTL_SECONDS = 30;
const SUBMIT_WINDOW_SECONDS = 3600;
const ASSISTANT_FEATURE_PREFIX = "assistant";
const SUBMIT_LIMIT_MESSAGE = "Assistant hourly submit limit reached for this organization.";
const IN_FLIGHT_LIMIT_MESSAGE =
  "This organization already has the maximum number of assistant jobs in progress.";
const TOKEN_BUDGET_MESSAGE = "This organization has exceeded its monthly assistant token budget.";

@Injectable()
export class AssistantQuotaSettingsService {
  private readonly logger = createLogger({ name: "assistant-quota-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly rateLimiter: RateLimiterService,
    private readonly llmRequestLog: LlmRequestLogService
  ) {}

  async getPublicSettings(orgId: string): Promise<AssistantQuotaSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);
    const monthStart = startOfUtcMonth();
    const [totalTokens, inFlight] = await Promise.all([
      this.llmRequestLog.getTokenUsageByFeaturePrefix(orgId, ASSISTANT_FEATURE_PREFIX, monthStart),
      this.countInFlight(orgId)
    ]);
    return {
      source: stored ? "db" : "env",
      enabled: effective.enabled,
      submitLimitPerHour: effective.submitLimitPerHour,
      maxInFlightPerOrg: effective.maxInFlightPerOrg,
      monthlyTokenBudget: effective.monthlyTokenBudget,
      usage: {
        monthStart: monthStart.toISOString(),
        totalTokens,
        inFlight
      }
    };
  }

  async assertCanSubmit(orgId: string): Promise<void> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);
    if (!effective.enabled) {
      return;
    }

    if (effective.submitLimitPerHour > 0) {
      const allowed = await this.rateLimiter.consume(
        `assistant:submit:${orgId}`,
        effective.submitLimitPerHour,
        SUBMIT_WINDOW_SECONDS
      );
      if (!allowed) {
        throw new TooManyRequestsException(SUBMIT_LIMIT_MESSAGE);
      }
    }

    if (effective.maxInFlightPerOrg > 0) {
      const inFlight = await this.countInFlight(orgId);
      if (inFlight >= effective.maxInFlightPerOrg) {
        throw new TooManyRequestsException(IN_FLIGHT_LIMIT_MESSAGE);
      }
    }

    if (effective.monthlyTokenBudget > 0) {
      const totalTokens = await this.llmRequestLog.getTokenUsageByFeaturePrefix(
        orgId,
        ASSISTANT_FEATURE_PREFIX,
        startOfUtcMonth()
      );
      if (totalTokens >= effective.monthlyTokenBudget) {
        throw new TooManyRequestsException(TOKEN_BUDGET_MESSAGE);
      }
    }
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      enabled: boolean;
      submitLimitPerHour: number;
      maxInFlightPerOrg: number;
      monthlyTokenBudget: number;
    }
  ): Promise<AssistantQuotaSettingsPublic> {
    const nextStored: StoredAssistantQuotaSettings = {
      enabled: input.enabled,
      submitLimitPerHour: input.submitLimitPerHour,
      maxInFlightPerOrg: input.maxInFlightPerOrg,
      monthlyTokenBudget: input.monthlyTokenBudget
    };
    const effective = this.resolveEffectiveConfig(nextStored);

    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      update: {
        value: this.toPrismaJson(nextStored),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false
      },
      create: {
        key: SETTINGS_KEY,
        value: this.toPrismaJson(nextStored),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false
      }
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "assistant_quota_update",
          metadata: this.toPrismaJson({
            enabled: effective.enabled,
            submitLimitPerHour: effective.submitLimitPerHour,
            maxInFlightPerOrg: effective.maxInFlightPerOrg,
            monthlyTokenBudget: effective.monthlyTokenBudget
          } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "assistant_quota_update" }
    );

    await this.invalidateCache();
    return this.getPublicSettings(orgId);
  }

  async resetToEnv(orgId: string, actorId: string): Promise<AssistantQuotaSettingsPublic> {
    await this.prisma.systemSetting.deleteMany({ where: { key: SETTINGS_KEY } });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "assistant_quota_reset",
          metadata: this.toPrismaJson({ ok: true } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "assistant_quota_reset" }
    );

    await this.invalidateCache();
    return this.getPublicSettings(orgId);
  }

  private async countInFlight(orgId: string): Promise<number> {
    return AssistantRunModel.countDocuments({
      orgId,
      status: { $in: ["pending", "running"] }
    });
  }

  private async loadStoredSettings(): Promise<StoredAssistantQuotaSettings | null> {
    let cached: CachedAssistantQuotaSettings | null = null;
    try {
      cached = await this.cache.get<CachedAssistantQuotaSettings>(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read assistant quota settings cache");
    }

    if (cached) {
      return cached.exists ? cached.value ?? null : null;
    }

    const record = await this.prisma.systemSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const raw = record?.value as unknown;
    const settings = raw && typeof raw === "object" ? (raw as StoredAssistantQuotaSettings) : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        { exists: Boolean(record), value: settings ?? undefined } satisfies CachedAssistantQuotaSettings,
        CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write assistant quota settings cache");
    }

    return settings;
  }

  private resolveEffectiveConfig(
    stored: StoredAssistantQuotaSettings | null
  ): AssistantQuotaEffectiveConfig {
    const envDefaults = this.normalizeEnvDefaults();
    return {
      enabled:
        stored && typeof stored.enabled === "boolean" ? stored.enabled : envDefaults.enabled,
      submitLimitPerHour: this.coerceLimit(
        stored?.submitLimitPerHour,
        envDefaults.submitLimitPerHour,
        10_000
      ),
      maxInFlightPerOrg: this.coerceLimit(
        stored?.maxInFlightPerOrg,
        envDefaults.maxInFlightPerOrg,
        100
      ),
      monthlyTokenBudget: this.coerceLimit(
        stored?.monthlyTokenBudget,
        envDefaults.monthlyTokenBudget,
        1_000_000_000_000
      )
    };
  }

  private normalizeEnvDefaults(): AssistantQuotaEffectiveConfig {
    const cfg = this.env.assistantConfig;
    return {
      enabled: true,
      submitLimitPerHour: cfg.orgSubmitLimitPerHour,
      maxInFlightPerOrg: cfg.orgMaxInFlight,
      monthlyTokenBudget: cfg.orgMonthlyTokenBudget
    };
  }

  private coerceLimit(value: unknown, fallback: number, max: number): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.max(0, Math.min(Math.trunc(numeric), max));
  }

  private async invalidateCache() {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate assistant quota settings cache");
    }
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}

function startOfUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
