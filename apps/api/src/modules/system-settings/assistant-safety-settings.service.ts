import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

export type AssistantSafetySettingsSource = "env" | "db";

export interface AssistantSafetySettingsPublic {
  source: AssistantSafetySettingsSource;
  enabled: boolean;
  outputModerationEnabled: boolean;
  guardrails: string[];
}

export interface AssistantSafetyEffectiveConfig {
  enabled: boolean;
  guardrails?: string[];
  outputModerationEnabled: boolean;
}

interface StoredAssistantSafetySettings {
  enabled?: unknown;
  outputModerationEnabled?: unknown;
}

interface CachedAssistantSafetySettings {
  exists: boolean;
  value?: StoredAssistantSafetySettings;
}

const SETTINGS_KEY = "assistant_safety";
const SETTINGS_DESCRIPTION = "AI Assistant content safety (LiteLLM guardrails) configuration.";
const CACHE_KEY = "assistant_safety:settings";
const CACHE_TTL_SECONDS = 30;

const OPENAI_MODERATION_PRE_GUARDRAIL = "openai-moderation-pre";
const OPENAI_MODERATION_POST_GUARDRAIL = "openai-moderation-post";

@Injectable()
export class AssistantSafetySettingsService {
  private readonly logger = createLogger({ name: "assistant-safety-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService
  ) {}

  async getPublicSettings(): Promise<AssistantSafetySettingsPublic> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);
    return {
      source: stored ? "db" : "env",
      enabled: effective.enabled,
      outputModerationEnabled: effective.outputModerationEnabled,
      guardrails: effective.guardrails ?? []
    };
  }

  async getEffectiveConfig(): Promise<AssistantSafetyEffectiveConfig> {
    const stored = await this.loadStoredSettings();
    return this.resolveEffectiveConfig(stored);
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: { enabled: boolean; outputModerationEnabled: boolean }
  ): Promise<AssistantSafetySettingsPublic> {
    const nextStored: StoredAssistantSafetySettings = {
      enabled: input.enabled,
      outputModerationEnabled: input.outputModerationEnabled
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
          action: "assistant_safety_update",
          metadata: this.toPrismaJson({
            enabled: effective.enabled,
            outputModerationEnabled: effective.outputModerationEnabled,
            guardrails: effective.guardrails ?? []
          } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "assistant_safety_update" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  async resetToEnv(orgId: string, actorId: string): Promise<AssistantSafetySettingsPublic> {
    await this.prisma.systemSetting.deleteMany({ where: { key: SETTINGS_KEY } });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "assistant_safety_reset",
          metadata: this.toPrismaJson({ ok: true } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "assistant_safety_reset" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  private async loadStoredSettings(): Promise<StoredAssistantSafetySettings | null> {
    let cached: CachedAssistantSafetySettings | null = null;
    try {
      cached = await this.cache.get<CachedAssistantSafetySettings>(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read assistant safety settings cache");
    }

    if (cached) {
      return cached.exists ? cached.value ?? null : null;
    }

    const record = await this.prisma.systemSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const raw = record?.value as unknown;
    const settings = raw && typeof raw === "object" ? (raw as StoredAssistantSafetySettings) : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        { exists: Boolean(record), value: settings ?? undefined } satisfies CachedAssistantSafetySettings,
        CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write assistant safety settings cache");
    }

    return settings;
  }

  private resolveEffectiveConfig(stored: StoredAssistantSafetySettings | null): AssistantSafetyEffectiveConfig {
    const envDefaults = this.normalizeEnvDefaults();
    const enabled =
      stored && typeof stored.enabled === "boolean" ? stored.enabled : envDefaults.enabled;
    const outputModerationEnabled =
      stored && typeof stored.outputModerationEnabled === "boolean"
        ? stored.outputModerationEnabled
        : envDefaults.outputModerationEnabled;

    if (!enabled) {
      return { enabled: false, guardrails: undefined, outputModerationEnabled };
    }

    return {
      enabled: true,
      outputModerationEnabled,
      guardrails: [
        OPENAI_MODERATION_PRE_GUARDRAIL,
        ...(outputModerationEnabled ? [OPENAI_MODERATION_POST_GUARDRAIL] : [])
      ]
    };
  }

  private normalizeEnvDefaults(): { enabled: boolean; outputModerationEnabled: boolean } {
    const cfg = this.env.assistantConfig as unknown as {
      guardrailsEnabled?: boolean;
      guardrails?: unknown;
    };
    const enabled = cfg.guardrailsEnabled !== false;
    const list = Array.isArray(cfg.guardrails)
      ? cfg.guardrails.filter((entry): entry is string => typeof entry === "string")
      : [];
    const outputModerationEnabled = list.some((name) => name.trim() === OPENAI_MODERATION_POST_GUARDRAIL);
    return { enabled, outputModerationEnabled };
  }

  private async invalidateCache() {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate assistant safety settings cache");
    }
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}

