import { createLogger } from "@modular/utils";
import { ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService, StorageConfig } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { SystemSecuritySettingsService } from "../system-settings/system-security-settings.service";

import {
  decryptStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey
} from "./storage-settings.crypto";
import {
  CRAWL_IMAGE_STORAGE_PROVIDERS,
  DEFAULT_CRAWL_IMAGE_STORAGE_PROVIDER,
  type CrawlImageStorageProvider
} from "./storage.constants";

/**
 * PATCH payload as it arrives from the controller. Every field is optional and
 * the DTO's `@IsOptional()` lets an explicit `null` through, so the nullable
 * input is modelled in the type instead of being hidden behind `Object.entries`.
 */
export interface StorageSettingsInput {
  crawlImageStorage?: CrawlImageStorageProvider | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  region?: string | null;
  bucket?: string | null;
  endpoint?: string | null;
  publicBaseUrl?: string | null;
  forcePathStyle?: boolean | null;
  presignedUrlTtlSeconds?: number | null;
}

/**
 * Normalized update set. `undefined` means "leave the setting untouched"; an
 * explicit `null` means "clear the value to the JSON literal null" and is only
 * reachable for `endpoint`, `forcePathStyle` and `presignedUrlTtlSeconds` (the
 * fields the original service lets through as a clearing branch).
 */
interface NormalizedStorageSettingsUpdate {
  crawlImageStorage?: CrawlImageStorageProvider;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
  endpoint?: string | null;
  publicBaseUrl?: string;
  forcePathStyle?: boolean | null;
  presignedUrlTtlSeconds?: number | null;
}

/**
 * Value shape accepted by the `SystemSetting.value` Json column. `Prisma.JsonNull`
 * writes the JSON literal null; `Prisma.DbNull` would write SQL NULL and is
 * rejected by the column's NOT NULL constraint.
 */
type StorageJsonWrite = Prisma.InputJsonValue | Prisma.JsonNullValueInput;

const PLATFORM_ADMIN_ROLE = "platform_admin";

export interface StorageSettingsResponse {
  crawlImageStorage: CrawlImageStorageProvider;
  region: string;
  bucket: string;
  endpoint?: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
  presignedUrlTtlSeconds: number;
  accessKeyId?: string;
  hasSecretAccessKey: boolean;
  /**
   * True when a stored encrypted secret exists but could not be decrypted
   * (e.g. after SYSTEM_SETTINGS_ENCRYPTION_KEY rotation). The console should
   * surface this instead of silently reporting "not configured".
   */
  secretDecryptionFailed: boolean;
}

const STORAGE_SETTINGS_CACHE_KEY = "storage:settings";

const STORAGE_SETTING_KEYS = {
  crawlImageStorage: "crawl_image_storage",
  accessKeyId: "storage_s3_access_key_id",
  secretAccessKey: "storage_s3_secret_access_key",
  region: "storage_s3_region",
  bucket: "storage_s3_bucket",
  endpoint: "storage_s3_endpoint",
  publicBaseUrl: "storage_s3_public_base_url",
  forcePathStyle: "storage_s3_force_path_style",
  presignedUrlTtlSeconds: "storage_s3_presigned_url_ttl_seconds"
} as const;

const PUBLIC_SETTING_KEYS = new Set<string>([
  STORAGE_SETTING_KEYS.crawlImageStorage,
  STORAGE_SETTING_KEYS.region,
  STORAGE_SETTING_KEYS.bucket,
  STORAGE_SETTING_KEYS.endpoint,
  STORAGE_SETTING_KEYS.publicBaseUrl,
  STORAGE_SETTING_KEYS.forcePathStyle,
  STORAGE_SETTING_KEYS.presignedUrlTtlSeconds
]);

const SETTINGS_CACHE_TTL_SECONDS = 60;

/**
 * Converts one normalized update into the value written to the
 * `SystemSetting.value` Json column.
 *
 * IS4: an explicitly cleared field (`endpoint`, `forcePathStyle`,
 * `presignedUrlTtlSeconds`) must persist the JSON literal null. `Prisma.JsonNull`
 * produces exactly that; passing a plain JS `null` (or `Prisma.DbNull`) would
 * either fail the required-Json type or try to write SQL NULL into a NOT NULL
 * column. The row itself is never deleted to represent a cleared value.
 */
function toStorageJsonValue(value: unknown): StorageJsonWrite {
  if (value === null) {
    return Prisma.JsonNull;
  }
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

@Injectable()
export class StorageSettingsService {
  private readonly logger = createLogger({ name: "storage-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly cache: CacheService,
    private readonly securitySettings: SystemSecuritySettingsService
  ) {}

  async getStorageConfig(): Promise<StorageConfig> {
    const recordMap = await this.loadSettings();
    const fallback = this.env.storageConfig;
    const accessKeyId =
      this.asString(recordMap.get(STORAGE_SETTING_KEYS.accessKeyId)) ??
      fallback.accessKeyId;
    const secretAccessKey = this.resolveSecret(
      recordMap.get(STORAGE_SETTING_KEYS.secretAccessKey),
      fallback.secretAccessKey
    );
    const region =
      this.asString(recordMap.get(STORAGE_SETTING_KEYS.region)) ?? fallback.region;
    const bucket =
      this.asString(recordMap.get(STORAGE_SETTING_KEYS.bucket)) ?? fallback.bucket;
    const endpoint =
      this.asString(recordMap.get(STORAGE_SETTING_KEYS.endpoint)) ?? fallback.endpoint;
    const publicBaseUrl =
      this.asString(recordMap.get(STORAGE_SETTING_KEYS.publicBaseUrl)) ??
      fallback.publicBaseUrl;
    const forcePathStyle =
      this.asBoolean(recordMap.get(STORAGE_SETTING_KEYS.forcePathStyle)) ??
      fallback.forcePathStyle;
    const presignedUrlTtlSeconds =
      this.asNumber(recordMap.get(STORAGE_SETTING_KEYS.presignedUrlTtlSeconds)) ??
      fallback.presignedUrlTtlSeconds;

    return {
      accessKeyId,
      secretAccessKey,
      region,
      bucket,
      endpoint,
      publicBaseUrl,
      forcePathStyle,
      presignedUrlTtlSeconds
    };
  }

  async getCrawlImageStorageProvider(): Promise<CrawlImageStorageProvider> {
    const recordMap = await this.loadSettings();
    const value = this.asProvider(recordMap.get(STORAGE_SETTING_KEYS.crawlImageStorage));
    return value ?? DEFAULT_CRAWL_IMAGE_STORAGE_PROVIDER;
  }

  async getAdminSettings(): Promise<StorageSettingsResponse> {
    const recordMap = await this.loadSettings();
    const fallback = this.env.storageConfig;
    const crawlImageStorage =
      this.asProvider(recordMap.get(STORAGE_SETTING_KEYS.crawlImageStorage)) ??
      DEFAULT_CRAWL_IMAGE_STORAGE_PROVIDER;
    const secretState: { decryptionFailed?: boolean } = {};
    const secretResolved = this.resolveSecret(
      recordMap.get(STORAGE_SETTING_KEYS.secretAccessKey),
      fallback.secretAccessKey,
      secretState,
    );
    return {
      crawlImageStorage,
      region:
        this.asString(recordMap.get(STORAGE_SETTING_KEYS.region)) ?? fallback.region,
      bucket:
        this.asString(recordMap.get(STORAGE_SETTING_KEYS.bucket)) ?? fallback.bucket,
      endpoint:
        this.asString(recordMap.get(STORAGE_SETTING_KEYS.endpoint)) ?? fallback.endpoint,
      publicBaseUrl:
        this.asString(recordMap.get(STORAGE_SETTING_KEYS.publicBaseUrl)) ??
        fallback.publicBaseUrl,
      forcePathStyle:
        this.asBoolean(recordMap.get(STORAGE_SETTING_KEYS.forcePathStyle)) ??
        fallback.forcePathStyle,
      presignedUrlTtlSeconds:
        this.asNumber(recordMap.get(STORAGE_SETTING_KEYS.presignedUrlTtlSeconds)) ??
        fallback.presignedUrlTtlSeconds,
      accessKeyId:
        this.asString(recordMap.get(STORAGE_SETTING_KEYS.accessKeyId)) ??
        fallback.accessKeyId,
      hasSecretAccessKey: Boolean(secretResolved),
      secretDecryptionFailed: secretState.decryptionFailed === true,
    };
  }

  async updateStorageSettings(
    orgId: string,
    actorId: string,
    input: StorageSettingsInput
  ): Promise<StorageSettingsResponse> {
    // IS1: the nine keys below are GLOBAL singletons (no orgId dimension) that
    // decide where every tenant's uploaded media is written and which S3
    // credentials are used. A plain org admin holding settings.manage could
    // repoint all tenants at a bucket they control, so only platform admins may
    // write them. AuthModule already depends on StorageModule, so importing
    // PlatformAccessService here would create a module cycle; the identical
    // predicate and 403 message are therefore evaluated against
    // GlobalRoleAssignment through the already-injected PrismaService.
    await this.assertPlatformAdmin(actorId);

    const updates = this.normalizeUpdates(input);
    const operations = await this.buildOperations(updates, actorId);

    if (operations.length > 0) {
      await this.prisma.$transaction(operations);
      await writeAuditLogBestEffort(
        this.prisma,
        {
          data: {
            orgId,
            actorId,
            resource: "system_settings",
            action: "storage_settings_update",
            metadata: this.buildAuditMetadata(updates)
          }
        },
        { orgId, actorId, resource: "system_settings", action: "storage_settings_update" }
      );
    }

    try {
      await this.cache.del(STORAGE_SETTINGS_CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate storage settings cache");
    }
    return this.getAdminSettings();
  }

  /**
   * Mirrors PlatformAccessService.assertPlatformAdmin. A machine identity
   * (`machine:<tokenId>`) is never a User row, so it can never hold a
   * GlobalRoleAssignment and is rejected without a query.
   */
  private async assertPlatformAdmin(actorId: string): Promise<void> {
    if (typeof actorId !== "string" || !actorId || actorId.startsWith("machine:")) {
      throw new ForbiddenException("Platform admin access required");
    }
    const assignment = await this.prisma.globalRoleAssignment.findFirst({
      where: { userId: actorId, role: PLATFORM_ADMIN_ROLE },
      select: { id: true }
    });
    if (!assignment) {
      throw new ForbiddenException("Platform admin access required");
    }
  }

  /**
   * Builds the upserts for one PATCH. Every effective field lands in the same
   * transaction, so a mixed payload either commits completely or not at all and
   * concurrent updates to disjoint fields never overwrite each other.
   */
  private async buildOperations(
    updates: NormalizedStorageSettingsUpdate,
    actorId: string
  ): Promise<Prisma.PrismaPromise<unknown>[]> {
    const operations: Prisma.PrismaPromise<unknown>[] = [];
    const add = (settingKey: string, isPublic: boolean, value: StorageJsonWrite) => {
      operations.push(
        this.prisma.systemSetting.upsert({
          where: { key: settingKey },
          update: {
            value,
            isPublic,
            updatedById: actorId
          },
          create: {
            key: settingKey,
            value,
            isPublic,
            updatedById: actorId,
            description: "Storage configuration"
          }
        })
      );
    };

    if (updates.crawlImageStorage !== undefined) {
      add(
        STORAGE_SETTING_KEYS.crawlImageStorage,
        PUBLIC_SETTING_KEYS.has(STORAGE_SETTING_KEYS.crawlImageStorage),
        updates.crawlImageStorage
      );
    }
    if (updates.accessKeyId !== undefined) {
      add(
        STORAGE_SETTING_KEYS.accessKeyId,
        PUBLIC_SETTING_KEYS.has(STORAGE_SETTING_KEYS.accessKeyId),
        updates.accessKeyId
      );
    }
    if (updates.secretAccessKey !== undefined) {
      const encoded = await this.securitySettings.encodeSecretForStorage(updates.secretAccessKey);
      add(
        STORAGE_SETTING_KEYS.secretAccessKey,
        PUBLIC_SETTING_KEYS.has(STORAGE_SETTING_KEYS.secretAccessKey),
        toStorageJsonValue(encoded)
      );
    }
    if (updates.region !== undefined) {
      add(
        STORAGE_SETTING_KEYS.region,
        PUBLIC_SETTING_KEYS.has(STORAGE_SETTING_KEYS.region),
        updates.region
      );
    }
    if (updates.bucket !== undefined) {
      add(
        STORAGE_SETTING_KEYS.bucket,
        PUBLIC_SETTING_KEYS.has(STORAGE_SETTING_KEYS.bucket),
        updates.bucket
      );
    }
    if (updates.endpoint !== undefined) {
      add(
        STORAGE_SETTING_KEYS.endpoint,
        PUBLIC_SETTING_KEYS.has(STORAGE_SETTING_KEYS.endpoint),
        toStorageJsonValue(updates.endpoint)
      );
    }
    if (updates.publicBaseUrl !== undefined) {
      add(
        STORAGE_SETTING_KEYS.publicBaseUrl,
        PUBLIC_SETTING_KEYS.has(STORAGE_SETTING_KEYS.publicBaseUrl),
        updates.publicBaseUrl
      );
    }
    if (updates.forcePathStyle !== undefined) {
      add(
        STORAGE_SETTING_KEYS.forcePathStyle,
        PUBLIC_SETTING_KEYS.has(STORAGE_SETTING_KEYS.forcePathStyle),
        toStorageJsonValue(updates.forcePathStyle)
      );
    }
    if (updates.presignedUrlTtlSeconds !== undefined) {
      add(
        STORAGE_SETTING_KEYS.presignedUrlTtlSeconds,
        PUBLIC_SETTING_KEYS.has(STORAGE_SETTING_KEYS.presignedUrlTtlSeconds),
        toStorageJsonValue(updates.presignedUrlTtlSeconds)
      );
    }

    return operations;
  }

  private async loadSettings(): Promise<Map<string, unknown>> {
    let cached: Record<string, unknown> | null = null;
    try {
      cached = await this.cache.get<Record<string, unknown>>(STORAGE_SETTINGS_CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to read storage settings from cache; falling back to database"
      );
    }
    if (cached) {
      return new Map(Object.entries(cached));
    }

    const records = await this.prisma.systemSetting.findMany({
      where: { key: { in: Object.values(STORAGE_SETTING_KEYS) } }
    });
    const recordMap = new Map(records.map((record) => [record.key, record.value]));
    try {
      await this.cache.set(
        STORAGE_SETTINGS_CACHE_KEY,
        Object.fromEntries(recordMap),
        SETTINGS_CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write storage settings to cache");
    }
    return recordMap;
  }

  private normalizeUpdates(input: StorageSettingsInput): NormalizedStorageSettingsUpdate {
    const updates: NormalizedStorageSettingsUpdate = {};
    if (input.crawlImageStorage !== undefined) {
      const normalized = this.asProvider(input.crawlImageStorage);
      if (normalized) {
        updates.crawlImageStorage = normalized;
      }
    }
    if (input.accessKeyId !== undefined) {
      const normalized = this.normalizeString(input.accessKeyId);
      if (normalized) {
        updates.accessKeyId = normalized;
      }
    }
    if (input.secretAccessKey !== undefined) {
      const normalized = this.normalizeString(input.secretAccessKey);
      if (normalized) {
        updates.secretAccessKey = normalized;
      }
    }
    if (input.region !== undefined) {
      const normalized = this.normalizeString(input.region);
      if (normalized) {
        updates.region = normalized;
      }
    }
    if (input.bucket !== undefined) {
      const normalized = this.normalizeString(input.bucket);
      if (normalized) {
        updates.bucket = normalized;
      }
    }
    if (input.endpoint !== undefined) {
      updates.endpoint = this.normalizeString(input.endpoint) ?? null;
    }
    if (input.publicBaseUrl !== undefined) {
      const normalized = this.normalizeString(input.publicBaseUrl);
      if (normalized) {
        updates.publicBaseUrl = normalized;
      }
    }
    if (input.forcePathStyle !== undefined) {
      // `false` is a real value and must be persisted; `null` is the clearing
      // branch the original service already expressed.
      updates.forcePathStyle = input.forcePathStyle;
    }
    if (input.presignedUrlTtlSeconds !== undefined) {
      updates.presignedUrlTtlSeconds = input.presignedUrlTtlSeconds;
    }
    return updates;
  }

  private buildAuditMetadata(input: NormalizedStorageSettingsUpdate): Prisma.InputJsonObject {
    // Values are written in the same order the previous Object.entries loop
    // produced, so the JSON column content is byte-compatible.
    // Record<> rather than an index signature: the repo's eslint config
    // enforces @typescript-eslint/consistent-indexed-object-style.
    const metadata: Record<string, Prisma.InputJsonValue | null> = {};

    if (input.crawlImageStorage !== undefined) {
      metadata.crawlImageStorage = input.crawlImageStorage;
    }
    if (input.accessKeyId !== undefined) {
      // Never persist credential material in audit logs: mask the secret
      // entirely and keep only a fingerprint (first 4 characters) of the access
      // key id so operators can still tell WHICH key was changed. String.slice
      // counts UTF-16 code units, which is the fingerprint contract the Go
      // takeover reproduces.
      metadata.accessKeyIdFingerprint = `${input.accessKeyId.slice(0, 4)}***`;
    }
    if (input.secretAccessKey !== undefined && input.secretAccessKey) {
      metadata.secretAccessKey = "***";
    }
    if (input.region !== undefined) {
      metadata.region = input.region;
    }
    if (input.bucket !== undefined) {
      metadata.bucket = input.bucket;
    }
    if (input.endpoint !== undefined) {
      // A cleared endpoint is the JSON literal null, which is a perfectly valid
      // audit value. Only the Prisma *write* sentinel (Prisma.JsonNull) must
      // never be serialized.
      metadata.endpoint = input.endpoint;
    }
    if (input.publicBaseUrl !== undefined) {
      metadata.publicBaseUrl = input.publicBaseUrl;
    }
    if (input.forcePathStyle !== undefined) {
      metadata.forcePathStyle = input.forcePathStyle;
    }
    if (input.presignedUrlTtlSeconds !== undefined) {
      metadata.presignedUrlTtlSeconds = input.presignedUrlTtlSeconds;
    }

    return metadata;
  }

  private resolveSecret(
    value: unknown,
    fallback: string,
    state?: { decryptionFailed?: boolean },
  ) {
    if (!value) {
      return fallback;
    }
    if (typeof value === "string") {
      return value;
    }
    if (isEncryptedStringValueV1(value)) {
      const key = resolveSettingsKey(this.env);
      if (!key) {
        this.logger.warn("Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for storage secret");
        if (state) {
          state.decryptionFailed = true;
        }
        return fallback;
      }
      try {
        return decryptStringValueV1(value, key);
      } catch (error) {
        // Key rotation or tampering: surface the failure explicitly instead
        // of silently falling back to the env value (which may be empty).
        this.logger.warn({ err: error }, "Failed to decrypt storage secret");
        if (state) {
          state.decryptionFailed = true;
        }
        return fallback;
      }
    }
    return fallback;
  }

  private normalizeString(value: string | null | undefined): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private asString(value: unknown): string | undefined {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : undefined;
    }
    return undefined;
  }

  private asBoolean(value: unknown): boolean | undefined {
    if (typeof value === "boolean") {
      return value;
    }
    return undefined;
  }

  private asNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    return undefined;
  }

  private asProvider(value: unknown): CrawlImageStorageProvider | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim().toLowerCase();
    return CRAWL_IMAGE_STORAGE_PROVIDERS.includes(normalized as CrawlImageStorageProvider)
      ? (normalized as CrawlImageStorageProvider)
      : undefined;
  }
}
