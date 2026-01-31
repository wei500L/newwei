import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decryptStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey
} from "../storage/storage-settings.crypto";

import { SystemSecuritySettingsService } from "./system-security-settings.service";

export type OpenAiKeysSettingsSource = "none" | "db";

export interface OpenAiKeysSettingsPublic {
  source: OpenAiKeysSettingsSource;
  keysCount: number;
  hasKeys: boolean;
  keyFingerprints: string[];
  internalTokenConfigured: boolean;
}

interface StoredOpenAiKeysSettings {
  openaiApiKeys?: unknown;
}

interface CachedOpenAiKeysSettings {
  exists: boolean;
  value?: StoredOpenAiKeysSettings;
}

const SETTINGS_KEY = "openai_keys";
const SETTINGS_DESCRIPTION = "OpenAI upstream API keys (used by LiteLLM proxy + moderation guardrails).";
const CACHE_KEY = "openai_keys:settings";
const CACHE_TTL_SECONDS = 30;

interface StoredOpenAiKeyEntryV1 {
  fingerprint: string;
  value: unknown;
}

function isStoredOpenAiKeyEntryV1(value: unknown): value is StoredOpenAiKeyEntryV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.fingerprint === "string" && "value" in record;
}

@Injectable()
export class OpenAiKeysSettingsService {
  private readonly logger = createLogger({ name: "openai-keys-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly securitySettings: SystemSecuritySettingsService
  ) {}

  async getPublicSettings(): Promise<OpenAiKeysSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const keysCount = this.countStoredKeys(stored?.openaiApiKeys);
    const keyFingerprints = this.listKeyFingerprints(stored?.openaiApiKeys);
    return {
      source: stored ? "db" : "none",
      keysCount,
      hasKeys: keysCount > 0,
      keyFingerprints,
      internalTokenConfigured: Boolean(this.env.liteLlmConfigInternalToken)
    };
  }

  async getKeyCount(): Promise<number> {
    const stored = await this.loadStoredSettings();
    return this.countStoredKeys(stored?.openaiApiKeys);
  }

  async getPlaintextKeys(): Promise<string[]> {
    const stored = await this.loadStoredSettings();
    return this.resolveKeys(stored?.openaiApiKeys);
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: { keys: string[] }
  ): Promise<OpenAiKeysSettingsPublic> {
    const normalized = this.normalizeKeys(input.keys);

    const encoded: StoredOpenAiKeyEntryV1[] = [];
    for (const key of normalized) {
      try {
        const storedValue = await this.securitySettings.encodeSecretForStorage(key);
        encoded.push({ fingerprint: this.fingerprintKey(key), value: storedValue });
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to encode OpenAI key for storage");
        throw error;
      }
    }

    const stored: StoredOpenAiKeysSettings = {
      openaiApiKeys: encoded
    };

    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      update: {
        value: this.toPrismaJson(stored),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false
      },
      create: {
        key: SETTINGS_KEY,
        value: this.toPrismaJson(stored),
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
          action: "openai_keys_update",
          metadata: this.toPrismaJson({
            keysCount: normalized.length
          } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "openai_keys_update" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  async appendKeys(orgId: string, actorId: string, input: { keys: string[] }): Promise<OpenAiKeysSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const existing = this.resolveKeys(stored?.openaiApiKeys);
    const merged = Array.from(new Set([...existing, ...this.normalizeKeys(input.keys)]));
    return this.updateSettings(orgId, actorId, { keys: merged });
  }

  async removeKeyByFingerprint(orgId: string, actorId: string, fingerprint: string): Promise<OpenAiKeysSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const existing = this.resolveKeys(stored?.openaiApiKeys);
    const remaining = existing.filter((key) => this.fingerprintKey(key) !== fingerprint);
    return this.updateSettings(orgId, actorId, { keys: remaining });
  }

  async reset(orgId: string, actorId: string): Promise<OpenAiKeysSettingsPublic> {
    await this.prisma.systemSetting.deleteMany({ where: { key: SETTINGS_KEY } });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "openai_keys_reset",
          metadata: this.toPrismaJson({ ok: true } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "openai_keys_reset" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  private normalizeKeys(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const normalized = raw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => this.stripBearerPrefix(entry))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return Array.from(new Set(normalized));
  }

  private stripBearerPrefix(value: string) {
    return value.replace(/^bearer\s+/i, "").trim();
  }

  private countStoredKeys(raw: unknown): number {
    if (!Array.isArray(raw)) {
      return 0;
    }
    let count = 0;
    for (const entry of raw) {
      if (!entry) {
        continue;
      }
      if (typeof entry === "string") {
        count += 1;
        continue;
      }
      if (isEncryptedStringValueV1(entry)) {
        count += 1;
        continue;
      }
      if (isStoredOpenAiKeyEntryV1(entry)) {
        if (entry.value) {
          count += 1;
        }
      }
    }
    return count;
  }

  private resolveKeys(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    const key = resolveSettingsKey(this.env);
    const out: string[] = [];

    for (const entry of raw) {
      if (!entry) {
        continue;
      }
      if (isStoredOpenAiKeyEntryV1(entry)) {
        const storedValue = entry.value;
        if (typeof storedValue === "string") {
          const trimmed = this.stripBearerPrefix(storedValue);
          if (trimmed) {
            out.push(trimmed);
          }
        } else if (isEncryptedStringValueV1(storedValue)) {
          if (!key) {
            this.logger.warn("Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for OpenAI keys");
            continue;
          }
          try {
            const decrypted = decryptStringValueV1(storedValue, key);
            const trimmed = this.stripBearerPrefix(decrypted);
            if (trimmed) {
              out.push(trimmed);
            }
          } catch (error) {
            this.logger.warn({ err: error }, "Failed to decrypt OpenAI key");
          }
        }
        continue;
      }
      if (typeof entry === "string") {
        const trimmed = this.stripBearerPrefix(entry);
        if (trimmed) {
          out.push(trimmed);
        }
        continue;
      }
      if (isEncryptedStringValueV1(entry)) {
        if (!key) {
          this.logger.warn("Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for OpenAI keys");
          continue;
        }
        try {
          const decrypted = decryptStringValueV1(entry, key);
          const trimmed = this.stripBearerPrefix(decrypted);
          if (trimmed) {
            out.push(trimmed);
          }
        } catch (error) {
          this.logger.warn({ err: error }, "Failed to decrypt OpenAI key");
        }
      }
    }

    return Array.from(new Set(out));
  }

  private listKeyFingerprints(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    const out: string[] = [];
    const settingsKey = resolveSettingsKey(this.env);

    for (const entry of raw) {
      if (!entry) {
        continue;
      }
      if (isStoredOpenAiKeyEntryV1(entry)) {
        if (typeof entry.fingerprint === "string" && entry.fingerprint.trim()) {
          out.push(entry.fingerprint.trim());
        }
        continue;
      }
      if (typeof entry === "string") {
        out.push(this.fingerprintKey(this.stripBearerPrefix(entry)));
        continue;
      }
      if (isEncryptedStringValueV1(entry)) {
        if (!settingsKey) {
          continue;
        }
        try {
          const decrypted = decryptStringValueV1(entry, settingsKey);
          out.push(this.fingerprintKey(this.stripBearerPrefix(decrypted)));
        } catch {
          continue;
        }
      }
    }

    return Array.from(new Set(out));
  }

  private fingerprintKey(key: string): string {
    const trimmed = this.stripBearerPrefix(key).trim();
    return createHash("sha256").update(trimmed).digest("hex");
  }

  private async loadStoredSettings(): Promise<StoredOpenAiKeysSettings | null> {
    let cached: CachedOpenAiKeysSettings | null = null;
    try {
      cached = await this.cache.get<CachedOpenAiKeysSettings>(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read OpenAI keys settings cache");
    }

    if (cached) {
      return cached.exists ? cached.value ?? null : null;
    }

    const record = await this.prisma.systemSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const raw = record?.value as unknown;
    const settings = raw && typeof raw === "object" ? (raw as StoredOpenAiKeysSettings) : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        { exists: Boolean(record), value: settings ?? undefined } satisfies CachedOpenAiKeysSettings,
        CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write OpenAI keys settings cache");
    }

    return settings;
  }

  private async invalidateCache() {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate OpenAI keys settings cache");
    }
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
