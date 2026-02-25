import { createHash } from "node:crypto";

import { createLogger } from "@modular/utils";
import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decryptStringValueV1,
  type EncryptedStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey
} from "../storage/storage-settings.crypto";

import { SystemSecuritySettingsService } from "./system-security-settings.service";

export interface NewsSourceRuntimeSecretsPublicEntry {
  sourceId: string;
  key: string;
  hasValue: boolean;
  fingerprint: string;
  updatedAt: string;
}

export interface NewsSourceRuntimeSecretsPublic {
  source: "none" | "db";
  entries: NewsSourceRuntimeSecretsPublicEntry[];
}

interface NewsSourceRuntimeSecretsUpdateInput {
  upserts?: Array<{ sourceId: string; key: string; value: string }>;
  removes?: Array<{ sourceId: string; key: string }>;
}

interface StoredNewsSourceRuntimeSecretEntry {
  sourceId: string;
  key: string;
  value: string | EncryptedStringValueV1;
  fingerprint: string;
  updatedAt: string;
}

interface StoredNewsSourceRuntimeSecrets {
  version: 1;
  entries: StoredNewsSourceRuntimeSecretEntry[];
}

interface RawStoredNewsSourceRuntimeSecretEntry {
  sourceId?: unknown;
  key?: unknown;
  value?: unknown;
  fingerprint?: unknown;
  updatedAt?: unknown;
}

interface RawStoredNewsSourceRuntimeSecrets {
  version?: unknown;
  entries?: unknown;
}

const SETTINGS_KEY = "news_source_runtime_secrets";
const SETTINGS_DESCRIPTION =
  "Runtime secrets for news aggregator sources (cookie/token/headers), editable in admin UI.";
const CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 2_000;
const SOURCE_ID_PATTERN = /^[a-z0-9_-]+$/i;
const SECRET_KEY_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const INVALID_PERSISTED_SETTINGS_CODE = "NEWS_SOURCE_RUNTIME_SECRETS_INVALID";
const INVALID_PERSISTED_SETTINGS_ERROR =
  "Stored news source runtime secrets are invalid.";

@Injectable()
export class NewsSourceRuntimeSecretsService {
  private readonly logger = createLogger({ name: "news-source-runtime-secrets" });

  private cachedSettings: StoredNewsSourceRuntimeSecrets | null | undefined;
  private cachedAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly securitySettings: SystemSecuritySettingsService
  ) {}

  async getPublicSettings(): Promise<NewsSourceRuntimeSecretsPublic> {
    const settings = await this.loadStoredSettingsStrict();
    if (!settings) {
      return {
        source: "none",
        entries: []
      };
    }

    return {
      source: "db",
      entries: settings.entries
        .map((entry) => ({
          sourceId: entry.sourceId,
          key: entry.key,
          hasValue: true,
          fingerprint: entry.fingerprint,
          updatedAt: entry.updatedAt
        }))
        .sort((a, b) => this.sortEntries(a, b))
    };
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: NewsSourceRuntimeSecretsUpdateInput
  ): Promise<NewsSourceRuntimeSecretsPublic> {
    const normalizedUpserts = this.normalizeUpserts(input.upserts ?? []);
    const normalizedRemoves = this.normalizeRemoves(input.removes ?? []);

    if (normalizedUpserts.length === 0 && normalizedRemoves.length === 0) {
      return this.getPublicSettings();
    }

    const currentSettings = await this.loadStoredSettingsStrict();
    const map = new Map<string, StoredNewsSourceRuntimeSecretEntry>();
    for (const entry of currentSettings?.entries ?? []) {
      map.set(this.makeCompositeKey(entry.sourceId, entry.key), entry);
    }

    for (const item of normalizedRemoves) {
      map.delete(this.makeCompositeKey(item.sourceId, item.key));
    }

    const updatedAt = new Date().toISOString();
    for (const item of normalizedUpserts) {
      const storedValue = await this.securitySettings.encodeSecretForStorage(item.value);
      map.set(this.makeCompositeKey(item.sourceId, item.key), {
        sourceId: item.sourceId,
        key: item.key,
        value: storedValue,
        fingerprint: this.fingerprintSecret(item.value),
        updatedAt
      });
    }

    if (map.size > MAX_ENTRIES) {
      throw new BadRequestException(`Too many runtime secrets entries (max ${MAX_ENTRIES})`);
    }

    const nextEntries = [...map.values()].sort((a, b) => this.sortEntries(a, b));

    if (nextEntries.length === 0) {
      await this.prisma.systemSetting.deleteMany({ where: { key: SETTINGS_KEY } });
    } else {
      const nextValue: StoredNewsSourceRuntimeSecrets = {
        version: 1,
        entries: nextEntries
      };
      await this.prisma.systemSetting.upsert({
        where: { key: SETTINGS_KEY },
        update: {
          value: toPrismaJsonValue(nextValue),
          updatedById: actorId,
          description: SETTINGS_DESCRIPTION,
          isPublic: false
        },
        create: {
          key: SETTINGS_KEY,
          value: toPrismaJsonValue(nextValue),
          updatedById: actorId,
          description: SETTINGS_DESCRIPTION,
          isPublic: false
        }
      });
    }

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "news_source_runtime_secrets_update",
          metadata: toPrismaJsonValue({
            upserts: normalizedUpserts.length,
            removes: normalizedRemoves.length,
            entriesAfter: nextEntries.length
          } satisfies Prisma.InputJsonObject)
        }
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "news_source_runtime_secrets_update"
      }
    );

    this.invalidateCache();
    return this.getPublicSettings();
  }

  async getSecretsForSource(sourceId: string, overrideSourceId?: string): Promise<Record<string, string>> {
    if (!sourceId.trim()) {
      return {};
    }

    let settings: StoredNewsSourceRuntimeSecrets | null = null;
    try {
      settings = await this.loadStoredSettingsStrict();
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to load runtime secrets for source");
      return {};
    }

    if (!settings) {
      return {};
    }

    const key = resolveSettingsKey(this.env);
    const result: Record<string, string> = {};
    this.applySourceSecrets(result, settings.entries, sourceId, key);
    if (overrideSourceId && overrideSourceId !== sourceId) {
      this.applySourceSecrets(result, settings.entries, overrideSourceId, key);
    }
    return result;
  }

  private applySourceSecrets(
    target: Record<string, string>,
    entries: StoredNewsSourceRuntimeSecretEntry[],
    sourceId: string,
    key: Buffer | undefined
  ) {
    for (const entry of entries) {
      if (entry.sourceId !== sourceId) {
        continue;
      }
      try {
        const decoded = this.decodeSecretValue(entry.value, key);
        if (decoded.length > 0) {
          target[entry.key] = decoded;
        }
      } catch (error) {
        this.logger.warn(
          { err: error, sourceId: entry.sourceId, key: entry.key },
          "Failed to decode runtime secret entry"
        );
      }
    }
  }

  private decodeSecretValue(value: string | EncryptedStringValueV1, key: Buffer | undefined): string {
    if (typeof value === "string") {
      return value.trim();
    }
    if (!isEncryptedStringValueV1(value)) {
      throw new Error("invalid runtime secret entry format");
    }
    if (!key) {
      throw new Error("encrypted runtime secret requires SYSTEM_SETTINGS_ENCRYPTION_KEY");
    }
    return decryptStringValueV1(value, key).trim();
  }

  private normalizeUpserts(
    raw: Array<{ sourceId: string; key: string; value: string }>
  ): Array<{ sourceId: string; key: string; value: string }> {
    const map = new Map<string, { sourceId: string; key: string; value: string }>();
    for (const item of raw) {
      const sourceId = this.normalizeSourceId(item.sourceId);
      const key = this.normalizeSecretKey(item.key);
      const value = this.normalizeSecretValue(item.value);
      map.set(this.makeCompositeKey(sourceId, key), { sourceId, key, value });
    }
    return [...map.values()];
  }

  private normalizeRemoves(raw: Array<{ sourceId: string; key: string }>): Array<{ sourceId: string; key: string }> {
    const map = new Map<string, { sourceId: string; key: string }>();
    for (const item of raw) {
      const sourceId = this.normalizeSourceId(item.sourceId);
      const key = this.normalizeSecretKey(item.key);
      map.set(this.makeCompositeKey(sourceId, key), { sourceId, key });
    }
    return [...map.values()];
  }

  private normalizeSourceId(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (!normalized || !SOURCE_ID_PATTERN.test(normalized)) {
      throw new BadRequestException("sourceId must match /^[a-z0-9_-]+$/i");
    }
    return normalized;
  }

  private normalizeSecretKey(value: string): string {
    const normalized = value.trim();
    if (!normalized || !SECRET_KEY_PATTERN.test(normalized) || normalized.length > 128) {
      throw new BadRequestException("key must match /^[a-zA-Z0-9._:-]+$/ and be <= 128 chars");
    }
    return normalized;
  }

  private normalizeSecretValue(value: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException("value is required");
    }
    if (normalized.length > 8192) {
      throw new BadRequestException("value must be <= 8192 chars");
    }
    return normalized;
  }

  private fingerprintSecret(secret: string): string {
    return createHash("sha256").update(secret).digest("hex").slice(0, 16);
  }

  private makeCompositeKey(sourceId: string, key: string): string {
    return `${sourceId}::${key}`;
  }

  private sortEntries(
    a: { sourceId: string; key: string },
    b: { sourceId: string; key: string }
  ) {
    if (a.sourceId === b.sourceId) {
      return a.key.localeCompare(b.key);
    }
    return a.sourceId.localeCompare(b.sourceId);
  }

  private async loadStoredSettingsStrict(): Promise<StoredNewsSourceRuntimeSecrets | null> {
    if (this.cachedSettings !== undefined && Date.now() - this.cachedAt <= CACHE_TTL_MS) {
      return this.cachedSettings;
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY },
      select: { value: true }
    });

    const parsed = this.parseStoredSettingsStrict(record?.value ?? null);
    this.cachedSettings = parsed;
    this.cachedAt = Date.now();
    return parsed;
  }

  private parseStoredSettingsStrict(raw: unknown): StoredNewsSourceRuntimeSecrets | null {
    if (raw === null || raw === undefined) {
      return null;
    }
    if (!raw || typeof raw !== "object") {
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail: "Expected object with entries array."
      });
    }

    const record = raw as RawStoredNewsSourceRuntimeSecrets;
    if (record.version !== undefined && record.version !== 1) {
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail: "Unsupported version for runtime secrets settings."
      });
    }

    if (!Array.isArray(record.entries)) {
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail: "entries must be an array."
      });
    }

    const entriesMap = new Map<string, StoredNewsSourceRuntimeSecretEntry>();
    for (const item of record.entries) {
      const entry = this.parseStoredEntryStrict(item as RawStoredNewsSourceRuntimeSecretEntry);
      entriesMap.set(this.makeCompositeKey(entry.sourceId, entry.key), entry);
    }

    return {
      version: 1,
      entries: [...entriesMap.values()].sort((a, b) => this.sortEntries(a, b))
    };
  }

  private parseStoredEntryStrict(raw: RawStoredNewsSourceRuntimeSecretEntry): StoredNewsSourceRuntimeSecretEntry {
    if (!raw || typeof raw !== "object") {
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail: "entries contains invalid object."
      });
    }

    const sourceId = this.normalizeSourceId(String(raw.sourceId ?? ""));
    const key = this.normalizeSecretKey(String(raw.key ?? ""));

    const value = raw.value;
    if (typeof value !== "string" && !isEncryptedStringValueV1(value)) {
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail: `Invalid value type for ${sourceId}.${key}.`
      });
    }

    let fingerprint = typeof raw.fingerprint === "string" ? raw.fingerprint.trim() : "";
    if (!fingerprint) {
      fingerprint = typeof value === "string" ? this.fingerprintSecret(value) : "encrypted";
    }

    const updatedAtRaw = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
    const updatedAtDate = new Date(updatedAtRaw);
    const updatedAt = Number.isNaN(updatedAtDate.valueOf())
      ? new Date().toISOString()
      : updatedAtDate.toISOString();

    return {
      sourceId,
      key,
      value,
      fingerprint,
      updatedAt
    };
  }

  private invalidateCache() {
    this.cachedSettings = undefined;
    this.cachedAt = 0;
  }
}
