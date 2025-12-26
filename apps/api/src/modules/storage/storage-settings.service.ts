import { BadRequestException, Injectable } from "@nestjs/common";
import { createLogger } from "@modular/utils";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService, StorageConfig } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import {
  decryptStringValueV1,
  encryptStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey
} from "./storage-settings.crypto";

export interface StorageSettingsInput {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
  endpoint?: string | null;
  publicBaseUrl?: string;
  forcePathStyle?: boolean;
  presignedUrlTtlSeconds?: number;
}

export interface StorageSettingsResponse {
  region: string;
  bucket: string;
  endpoint?: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
  presignedUrlTtlSeconds: number;
  accessKeyId?: string;
  hasSecretAccessKey: boolean;
}

const STORAGE_SETTINGS_CACHE_KEY = "storage:settings";

const STORAGE_SETTING_KEYS = {
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
  STORAGE_SETTING_KEYS.region,
  STORAGE_SETTING_KEYS.bucket,
  STORAGE_SETTING_KEYS.endpoint,
  STORAGE_SETTING_KEYS.publicBaseUrl,
  STORAGE_SETTING_KEYS.forcePathStyle,
  STORAGE_SETTING_KEYS.presignedUrlTtlSeconds
]);

const SETTINGS_CACHE_TTL_SECONDS = 60;

@Injectable()
export class StorageSettingsService {
  private readonly logger = createLogger({ name: "storage-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly cache: CacheService
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

  async getAdminSettings(): Promise<StorageSettingsResponse> {
    const recordMap = await this.loadSettings();
    const fallback = this.env.storageConfig;
    return {
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
      hasSecretAccessKey: Boolean(
        recordMap.get(STORAGE_SETTING_KEYS.secretAccessKey) ?? fallback.secretAccessKey
      )
    };
  }

  async updateStorageSettings(
    orgId: string,
    actorId: string,
    input: StorageSettingsInput
  ): Promise<StorageSettingsResponse> {
    const updates = this.normalizeUpdates(input);
    const encryptionKey = resolveSettingsKey(this.env);

    if (updates.secretAccessKey !== undefined) {
      if (!encryptionKey) {
        throw new BadRequestException(
          "SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secret keys"
        );
      }
    }

    const operations = Object.entries(updates).map(([key, value]) => {
      const settingKey = STORAGE_SETTING_KEYS[key as keyof StorageSettingsInput];
      const isPublic = PUBLIC_SETTING_KEYS.has(settingKey);
      const recordValue =
        settingKey === STORAGE_SETTING_KEYS.secretAccessKey && value && encryptionKey
          ? encryptStringValueV1(String(value), encryptionKey)
          : value;

      return this.prisma.systemSetting.upsert({
        where: { key: settingKey },
        update: {
          value: recordValue,
          isPublic,
          updatedById: actorId
        },
        create: {
          key: settingKey,
          value: recordValue,
          isPublic,
          updatedById: actorId,
          description: "Storage configuration"
        }
      });
    });

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

  private normalizeUpdates(input: StorageSettingsInput): StorageSettingsInput {
    const updates: StorageSettingsInput = {};
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
      updates.forcePathStyle = input.forcePathStyle;
    }
    if (input.presignedUrlTtlSeconds !== undefined) {
      updates.presignedUrlTtlSeconds = input.presignedUrlTtlSeconds;
    }
    return updates;
  }

  private buildAuditMetadata(input: StorageSettingsInput) {
    const metadata: Record<string, unknown> = { ...input };
    if (metadata.secretAccessKey) {
      metadata.secretAccessKey = "***";
    }
    return metadata;
  }

  private resolveSecret(value: unknown, fallback: string) {
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
        return fallback;
      }
      try {
        return decryptStringValueV1(value, key);
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to decrypt storage secret");
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
}
