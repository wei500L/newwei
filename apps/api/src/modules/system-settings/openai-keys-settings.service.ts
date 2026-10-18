import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PlatformAccessService } from "../auth/platform-access.service";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decryptStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey,
  type EncryptedStringValueV1
} from "../storage/storage-settings.crypto";

import {
  OPENAI_KEYS_SETTINGS_LOCK_NAME,
  withModelAccessSettingsLock
} from "./model-access-settings.lock";
import { SystemSecuritySettingsService } from "./system-security-settings.service";

export type OpenAiKeysSettingsSource = "none" | "db";

export interface OpenAiKeysSettingsPublic {
  source: OpenAiKeysSettingsSource;
  keysCount: number;
  hasKeys: boolean;
  keyFingerprints: string[];
  internalTokenConfigured: boolean;
  appliedAt: string | null;
  appliedSource: "db" | "env" | "none" | null;
  appliedKeyFingerprints: string[];
  restartRequired: boolean;
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
const MAX_KEYS = 100;

const APPLIED_STATUS_KEY = "litellm_openai_keys_applied";
const APPLIED_STATUS_DESCRIPTION = "LiteLLM Proxy applied OpenAI key fingerprints (reported at startup).";
const APPLIED_CACHE_KEY = "openai_keys:applied_status";
const APPLIED_CACHE_TTL_SECONDS = 30;

interface StoredOpenAiKeysAppliedStatus {
  source?: unknown;
  keyFingerprints?: unknown;
  appliedAt?: unknown;
}

interface CachedOpenAiKeysAppliedStatus {
  exists: boolean;
  value?: StoredOpenAiKeysAppliedStatus;
}

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

/**
 * One stored OpenAI key entry, classified exactly once. The public projection
 * (count + fingerprints) and the plaintext projection both start from this
 * representation, so an entry is decoded once per snapshot instead of once per
 * algorithm and an encrypted entry is decrypted at most once per algorithm.
 */
interface ParsedOpenAiKeyEntry {
  kind: "wrapped" | "legacy-plain" | "legacy-encrypted";
  /** Wrapped entries holding an inline legacy plaintext value. */
  plain: string | null;
  /** system-settings:v1 envelope of a wrapped value or of a bare entry. */
  encrypted: EncryptedStringValueV1 | null;
  /** Wrapped stored fingerprint, trimmed; null when missing or blank. */
  storedFingerprint: string | null;
  /** Wrapped value JS truthiness, used by the structural count. */
  valuePresent: boolean;
}

@Injectable()
export class OpenAiKeysSettingsService {
  private readonly logger = createLogger({ name: "openai-keys-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly securitySettings: SystemSecuritySettingsService,
    private readonly platformAccess: PlatformAccessService
  ) {}

  async getPublicSettings(): Promise<OpenAiKeysSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const appliedStatus = await this.loadAppliedStatus();
    return this.buildPublicSettings(stored, appliedStatus);
  }

  /**
   * Projects one stored snapshot and one applied-status snapshot onto the public
   * response contract. The cached GET path and every write path (which project
   * the just-committed rows instead of the pre-write cache) share it.
   */
  private buildPublicSettings(
    stored: StoredOpenAiKeysSettings | null,
    appliedStatus: StoredOpenAiKeysAppliedStatus | null
  ): OpenAiKeysSettingsPublic {
    // One classification feeds both projections: the structural count and the
    // fingerprint list no longer walk (and parse) the stored array separately.
    const entries = this.parseOpenAiKeyEntries(stored?.openaiApiKeys);
    const keysCount = this.countStoredKeys(entries);
    const keyFingerprints = this.listKeyFingerprints(entries);
    const appliedAt = typeof appliedStatus?.appliedAt === "string" ? appliedStatus.appliedAt : null;
    const appliedKeyFingerprints = this.normalizeFingerprints(appliedStatus?.keyFingerprints);
    const appliedSource = this.normalizeAppliedSource(appliedStatus?.source);

    const restartRequired =
      keysCount > 0
        ? appliedSource !== "db" ||
          keyFingerprints.length === 0 ||
          appliedKeyFingerprints.length === 0 ||
          !this.sameFingerprintSets(keyFingerprints, appliedKeyFingerprints)
        : appliedSource === "db" && appliedKeyFingerprints.length > 0;
    return {
      source: stored ? "db" : "none",
      keysCount,
      hasKeys: keysCount > 0,
      keyFingerprints,
      internalTokenConfigured: Boolean(this.env.liteLlmConfigInternalToken),
      appliedAt,
      appliedSource,
      appliedKeyFingerprints,
      restartRequired
    };
  }

  async getKeyCount(): Promise<number> {
    const stored = await this.loadStoredSettings();
    return this.countStoredKeys(this.parseOpenAiKeyEntries(stored?.openaiApiKeys));
  }

  async getPlaintextKeys(): Promise<string[]> {
    const stored = await this.loadStoredSettings();
    return this.resolveKeys(this.parseOpenAiKeyEntries(stored?.openaiApiKeys));
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: { keys: string[] }
  ): Promise<OpenAiKeysSettingsPublic> {
    // MA1: openai_keys is a GLOBAL singleton (no org dimension) that feeds the
    // LiteLLM upstream pool for every tenant, so only platform admins may write
    // it. The gate runs before the lock and before any read/encode/write/audit.
    await this.platformAccess.assertPlatformAdmin(actorId);

    // MA2: all four key writes share one global MySQL session lock and merge
    // inside it, so a cached (stale) collection can never overwrite a newer one.
    return await withModelAccessSettingsLock(OPENAI_KEYS_SETTINGS_LOCK_NAME, async () => {
      return await this.persistKeysLocked(orgId, actorId, this.normalizeKeys(input.keys));
    });
  }

  async appendKeys(orgId: string, actorId: string, input: { keys: string[] }): Promise<OpenAiKeysSettingsPublic> {
    // MA1: same global-singleton boundary as PUT.
    await this.platformAccess.assertPlatformAdmin(actorId);

    // MA2: the merge baseline is the authoritative row read inside the lock, and
    // persistence goes through the private in-lock helper (never the public
    // updateSettings, which would try to take the lock again).
    return await withModelAccessSettingsLock(OPENAI_KEYS_SETTINGS_LOCK_NAME, async () => {
      const stored = await this.readStoredSettingsFromDatabase();
      const existing = this.resolveKeys(this.parseOpenAiKeyEntries(stored.settings?.openaiApiKeys));
      const merged = Array.from(new Set([...existing, ...this.normalizeKeys(input.keys)]));
      return await this.persistKeysLocked(orgId, actorId, merged);
    });
  }

  async removeKeyByFingerprint(orgId: string, actorId: string, fingerprint: string): Promise<OpenAiKeysSettingsPublic> {
    // MA1: same global-singleton boundary as PUT.
    await this.platformAccess.assertPlatformAdmin(actorId);

    // MA2: same lock and the same in-lock authoritative baseline as appendKeys.
    return await withModelAccessSettingsLock(OPENAI_KEYS_SETTINGS_LOCK_NAME, async () => {
      const stored = await this.readStoredSettingsFromDatabase();
      const existing = this.resolveKeys(this.parseOpenAiKeyEntries(stored.settings?.openaiApiKeys));
      const remaining = existing.filter((key) => this.fingerprintKey(key) !== fingerprint);
      return await this.persistKeysLocked(orgId, actorId, remaining);
    });
  }

  async reset(orgId: string, actorId: string): Promise<OpenAiKeysSettingsPublic> {
    // MA1: same global-singleton boundary as PUT.
    await this.platformAccess.assertPlatformAdmin(actorId);

    // MA2: reset shares the key lock so it cannot interleave with append/remove.
    // litellm_openai_keys_applied and its cache are deliberately untouched, so
    // the response may still report restartRequired=true (existing semantics).
    return await withModelAccessSettingsLock(OPENAI_KEYS_SETTINGS_LOCK_NAME, async () => {
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
      const applied = await this.readAppliedStatusFromDatabase();
      return this.buildPublicSettings(null, applied.status);
    });
  }

  /**
   * Persists one already-normalized key list and returns the public projection of
   * the committed snapshot.
   *
   * Callers MUST hold OPENAI_KEYS_SETTINGS_LOCK_NAME: this helper never acquires
   * the lock and never calls a public locking method, so append/remove cannot
   * deadlock against themselves. Encoding happens for the whole list before the
   * upsert so a mid-list encryption failure leaves the stored configuration
   * untouched (no half-written list). The lock is released only after the upsert,
   * the audit handling and the cache invalidation.
   */
  private async persistKeysLocked(
    orgId: string,
    actorId: string,
    keys: string[]
  ): Promise<OpenAiKeysSettingsPublic> {
    if (keys.length > MAX_KEYS) {
      throw new BadRequestException(`Too many OpenAI API keys (max ${MAX_KEYS})`);
    }

    const encoded: StoredOpenAiKeyEntryV1[] = [];
    for (const key of keys) {
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
            keysCount: keys.length
          } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "openai_keys_update" }
    );

    await this.invalidateCache();
    // The applied-status projection is read back from MySQL, not from the
    // pre-write Redis envelope, so the response describes the committed state.
    const applied = await this.readAppliedStatusFromDatabase();
    return this.buildPublicSettings(stored, applied.status);
  }

  async reportAppliedKeyFingerprints(input: { source: "db" | "env" | "none"; keyFingerprints: string[] }) {
    const normalized = this.normalizeFingerprints(input.keyFingerprints);
    await this.prisma.systemSetting.upsert({
      where: { key: APPLIED_STATUS_KEY },
      update: {
        value: this.toPrismaJson({
          source: input.source,
          keyFingerprints: normalized,
          appliedAt: new Date().toISOString()
        } satisfies StoredOpenAiKeysAppliedStatus),
        updatedById: null,
        description: APPLIED_STATUS_DESCRIPTION,
        isPublic: false
      },
      create: {
        key: APPLIED_STATUS_KEY,
        value: this.toPrismaJson({
          source: input.source,
          keyFingerprints: normalized,
          appliedAt: new Date().toISOString()
        } satisfies StoredOpenAiKeysAppliedStatus),
        updatedById: null,
        description: APPLIED_STATUS_DESCRIPTION,
        isPublic: false
      }
    });

    await this.invalidateAppliedCache();
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

  private normalizeFingerprints(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const normalized = raw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return Array.from(new Set(normalized));
  }

  private sameFingerprintSets(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    const set = new Set(a);
    if (set.size !== a.length) {
      // Should not happen, but treat as mismatch.
      return false;
    }
    return b.every((fingerprint) => set.has(fingerprint));
  }

  /**
   * Classifies every stored key entry exactly once, in stored order:
   * `{fingerprint, value}` first, then a legacy plaintext string, then a bare
   * system-settings:v1 envelope. Anything else (null, false, an unrecognized
   * object) is skipped by every algorithm.
   */
  private parseOpenAiKeyEntries(raw: unknown): ParsedOpenAiKeyEntry[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    const parsed: ParsedOpenAiKeyEntry[] = [];

    for (const entry of raw) {
      if (!entry) {
        continue;
      }

      if (isStoredOpenAiKeyEntryV1(entry)) {
        const storedValue = entry.value;
        const storedFingerprint =
          typeof entry.fingerprint === "string" ? entry.fingerprint.trim() : "";
        parsed.push({
          kind: "wrapped",
          plain: typeof storedValue === "string" ? storedValue : null,
          encrypted: isEncryptedStringValueV1(storedValue) ? storedValue : null,
          storedFingerprint: storedFingerprint || null,
          valuePresent: Boolean(storedValue)
        });
        continue;
      }

      if (typeof entry === "string") {
        parsed.push({
          kind: "legacy-plain",
          plain: entry,
          encrypted: null,
          storedFingerprint: null,
          valuePresent: false
        });
        continue;
      }

      if (isEncryptedStringValueV1(entry)) {
        parsed.push({
          kind: "legacy-encrypted",
          plain: null,
          encrypted: entry,
          storedFingerprint: null,
          valuePresent: false
        });
      }
    }

    return parsed;
  }

  private countStoredKeys(entries: ParsedOpenAiKeyEntry[]): number {
    let count = 0;
    for (const entry of entries) {
      if (entry.kind === "wrapped") {
        if (entry.valuePresent) {
          count += 1;
        }
        continue;
      }
      count += 1;
    }
    return count;
  }

  private resolveKeys(entries: ParsedOpenAiKeyEntry[]): string[] {
    const key = resolveSettingsKey(this.env);
    const out: string[] = [];

    for (const entry of entries) {
      if (entry.kind === "wrapped") {
        if (entry.plain !== null) {
          const trimmed = this.stripBearerPrefix(entry.plain);
          if (trimmed) {
            out.push(trimmed);
          }
          continue;
        }
        if (entry.encrypted) {
          if (!key) {
            this.logger.warn("Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for OpenAI keys");
            continue;
          }
          try {
            const decrypted = decryptStringValueV1(entry.encrypted, key);
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

      if (entry.kind === "legacy-plain") {
        const trimmed = this.stripBearerPrefix(entry.plain ?? "");
        if (trimmed) {
          out.push(trimmed);
        }
        continue;
      }

      if (entry.encrypted) {
        if (!key) {
          this.logger.warn("Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for OpenAI keys");
          continue;
        }
        try {
          const decrypted = decryptStringValueV1(entry.encrypted, key);
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

  private listKeyFingerprints(entries: ParsedOpenAiKeyEntry[]): string[] {
    const out: string[] = [];
    const settingsKey = resolveSettingsKey(this.env);

    for (const entry of entries) {
      if (entry.kind === "wrapped") {
        // A wrapped entry exposes its stored fingerprint: its value is never
        // decrypted just to recompute one.
        if (entry.storedFingerprint) {
          out.push(entry.storedFingerprint);
        }
        continue;
      }

      if (entry.kind === "legacy-plain") {
        out.push(this.fingerprintKey(this.stripBearerPrefix(entry.plain ?? "")));
        continue;
      }

      if (entry.encrypted) {
        if (!settingsKey) {
          continue;
        }
        try {
          const decrypted = decryptStringValueV1(entry.encrypted, settingsKey);
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

  private async loadAppliedStatus(): Promise<StoredOpenAiKeysAppliedStatus | null> {
    let cached: CachedOpenAiKeysAppliedStatus | null = null;
    try {
      cached = await this.cache.get<CachedOpenAiKeysAppliedStatus>(APPLIED_CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read OpenAI keys applied status cache");
    }

    if (cached) {
      return cached.exists ? cached.value ?? null : null;
    }

    const { exists, status } = await this.readAppliedStatusFromDatabase();

    try {
      await this.cache.set(
        APPLIED_CACHE_KEY,
        { exists, value: status ?? undefined } satisfies CachedOpenAiKeysAppliedStatus,
        APPLIED_CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write OpenAI keys applied status cache");
    }

    return status;
  }

  /**
   * Reads SystemSetting.key=litellm_openai_keys_applied straight from MySQL. The
   * write paths project this authoritative value; the GET path keeps its 30s
   * best-effort cache.
   */
  private async readAppliedStatusFromDatabase(): Promise<{
    exists: boolean;
    status: StoredOpenAiKeysAppliedStatus | null;
  }> {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: APPLIED_STATUS_KEY }
    });
    const raw = record?.value as unknown;
    const status = raw && typeof raw === "object" ? (raw as StoredOpenAiKeysAppliedStatus) : null;
    return { exists: Boolean(record), status };
  }

  /**
   * Reads SystemSetting.key=openai_keys straight from MySQL. The write paths must
   * use this instead of the cached reader so a stale 30s envelope can never be
   * used as a read-modify-write baseline.
   */
  private async readStoredSettingsFromDatabase(): Promise<{
    exists: boolean;
    settings: StoredOpenAiKeysSettings | null;
  }> {
    const record = await this.prisma.systemSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const raw = record?.value as unknown;
    const settings = raw && typeof raw === "object" ? (raw as StoredOpenAiKeysSettings) : null;
    return { exists: Boolean(record), settings };
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

    const { exists, settings } = await this.readStoredSettingsFromDatabase();

    try {
      await this.cache.set(
        CACHE_KEY,
        { exists, value: settings ?? undefined } satisfies CachedOpenAiKeysSettings,
        CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write OpenAI keys settings cache");
    }

    return settings;
  }

  private normalizeAppliedSource(raw: unknown): "db" | "env" | "none" | null {
    if (raw === "db" || raw === "env" || raw === "none") {
      return raw;
    }
    return null;
  }

  private async invalidateCache() {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate OpenAI keys settings cache");
    }
  }

  private async invalidateAppliedCache() {
    try {
      await this.cache.del(APPLIED_CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate OpenAI keys applied status cache");
    }
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
