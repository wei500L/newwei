import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { AuthSecurityService } from "../auth/auth-security.service";
import {
  decodeSystemSettingsKey,
  encryptStringValueV1,
  type EncryptedStringValueV1
} from "../storage/storage-settings.crypto";

export interface SystemSecuritySettingsPublic {
  secretEncryptionEnabled: boolean;
  mfaPolicy: "off" | "admins_only" | "all_users";
  encryptionKeyPresent: boolean;
  encryptionKeyValid: boolean;
  encryptionKeyError: string | null;
}

interface StoredSystemSecuritySettings {
  secretEncryptionEnabled?: unknown;
  mfaPolicy?: unknown;
}

interface CachedSystemSecuritySettings {
  exists: boolean;
  value?: StoredSystemSecuritySettings;
}

const SETTINGS_KEY = "system_security";
const SETTINGS_DESCRIPTION = "System security settings (secret encryption toggle).";
const CACHE_KEY = "system_security:settings";
const CACHE_TTL_SECONDS = 60;

@Injectable()
export class SystemSecuritySettingsService {
  private readonly logger = createLogger({ name: "system-security-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly authSecurity: AuthSecurityService,
  ) {}

  async getPublicSettings(): Promise<SystemSecuritySettingsPublic> {
    const stored = await this.loadStoredSettings();
    const keyStatus = this.resolveEnvKeyStatus();
    const secretEncryptionEnabled = this.asBoolean(stored?.secretEncryptionEnabled, false);
    const mfaPolicy = this.asMfaPolicy(stored?.mfaPolicy);

    return {
      secretEncryptionEnabled,
      mfaPolicy,
      encryptionKeyPresent: keyStatus.present,
      encryptionKeyValid: keyStatus.valid,
      encryptionKeyError: keyStatus.error ?? null
    };
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: { secretEncryptionEnabled: boolean; mfaPolicy: "off" | "admins_only" | "all_users" }
  ): Promise<SystemSecuritySettingsPublic> {
    const keyStatus = this.resolveEnvKeyStatus();
    if (input.secretEncryptionEnabled && !keyStatus.valid) {
      const details = keyStatus.error ? ` (${keyStatus.error})` : "";
      throw new BadRequestException(
        `SYSTEM_SETTINGS_ENCRYPTION_KEY is required to enable secret encryption${details}`
      );
    }

    const nextStored: StoredSystemSecuritySettings = {
      secretEncryptionEnabled: input.secretEncryptionEnabled,
      mfaPolicy: input.mfaPolicy,
    };

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
          action: "system_security_update",
          metadata: this.toPrismaJson({
            secretEncryptionEnabled: input.secretEncryptionEnabled,
            mfaPolicy: input.mfaPolicy,
            encryptionKeyPresent: keyStatus.present,
            encryptionKeyValid: keyStatus.valid
          } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "system_security_update" }
    );

    await this.invalidateCache();
    await this.authSecurity.invalidate();
    return this.getPublicSettings();
  }

  async encodeSecretForStorage(plain: string): Promise<string | EncryptedStringValueV1> {
    const stored = await this.loadStoredSettings();
    const keyStatus = this.resolveEnvKeyStatus();
    const enabled = this.asBoolean(stored?.secretEncryptionEnabled, false);

    if (!enabled) {
      return plain;
    }

    if (!keyStatus.key) {
      const details = keyStatus.error ? ` (${keyStatus.error})` : "";
      throw new BadRequestException(
        `Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid${details}`
      );
    }

    return encryptStringValueV1(plain, keyStatus.key);
  }

  private async loadStoredSettings(): Promise<StoredSystemSecuritySettings | null> {
    let cached: CachedSystemSecuritySettings | null = null;
    try {
      cached = await this.cache.get<CachedSystemSecuritySettings>(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read system security settings cache");
    }

    if (cached) {
      return cached.exists ? cached.value ?? null : null;
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY }
    });
    const raw = record?.value as unknown;
    const settings = raw && typeof raw === "object" ? (raw as StoredSystemSecuritySettings) : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        { exists: Boolean(record), value: settings ?? undefined } satisfies CachedSystemSecuritySettings,
        CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write system security settings cache");
    }

    return settings;
  }

  private resolveEnvKeyStatus(): {
    present: boolean;
    valid: boolean;
    key?: Buffer;
    error?: string;
  } {
    const raw = this.env.systemSettingsEncryptionKey;
    if (!raw) {
      return { present: false, valid: false };
    }

    try {
      const key = decodeSystemSettingsKey(raw);
      return { present: true, valid: true, key };
    } catch (error) {
      return {
        present: true,
        valid: false,
        error: error instanceof Error ? error.message : "Invalid SYSTEM_SETTINGS_ENCRYPTION_KEY"
      };
    }
  }

  private async invalidateCache() {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate system security settings cache");
    }
  }

  private asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private asMfaPolicy(value: unknown): "off" | "admins_only" | "all_users" {
    if (value === "admins_only" || value === "all_users" || value === "off") {
      return value;
    }
    return "off";
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
