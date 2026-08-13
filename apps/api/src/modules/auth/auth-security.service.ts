import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decodeSystemSettingsKey,
  decryptStringValueV1,
  encodeSecretValue,
  isEncryptedStringValueV1,
} from "../storage/storage-settings.crypto";

export type MfaPolicy = "off" | "admins_only" | "all_users";

interface StoredSystemSecuritySettings {
  secretEncryptionEnabled?: unknown;
  mfaPolicy?: unknown;
}

const CACHE_KEY = "auth:system-security";
const CACHE_TTL_SECONDS = 60;
const SETTINGS_KEY = "system_security";

@Injectable()
export class AuthSecurityService {
  private readonly logger = createLogger({ name: "auth-security" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
  ) {}

  async getMfaPolicy(): Promise<MfaPolicy> {
    const settings = await this.getStoredSettings();
    const value = settings?.mfaPolicy;
    if (value === "admins_only" || value === "all_users" || value === "off") {
      return value;
    }
    return "off";
  }

  async encodeSecret(plain: string) {
    const settings = await this.getStoredSettings();
    const configured =
      typeof settings?.secretEncryptionEnabled === "boolean"
        ? settings.secretEncryptionEnabled
        : null;
    const key = this.resolveSettingsKey();

    return encodeSecretValue(plain, {
      configured,
      key,
      isProduction: process.env.NODE_ENV === "production",
      onPlaintextFallback: () =>
        this.logger.warn(
          "SYSTEM_SETTINGS_ENCRYPTION_KEY is missing; storing secret in plaintext (non-production only)"
        ),
    });
  }

  async decodeSecret(value: Prisma.JsonValue | string | null | undefined) {
    if (typeof value === "string") {
      return value;
    }
    if (!value || typeof value !== "object") {
      return null;
    }
    if (!isEncryptedStringValueV1(value)) {
      return null;
    }
    const key = this.resolveSettingsKey();
    if (!key) {
      return null;
    }
    return decryptStringValueV1(value, key);
  }

  async invalidate() {
    await this.cache.del(CACHE_KEY);
  }

  private async getStoredSettings() {
    return this.cache.wrap(
      CACHE_KEY,
      CACHE_TTL_SECONDS,
      async () => {
        const record = await this.prisma.systemSetting.findUnique({
          where: { key: SETTINGS_KEY },
          select: { value: true },
        });
        const raw = record?.value;
        if (!raw || typeof raw !== "object") {
          return null;
        }
        return raw as StoredSystemSecuritySettings;
      },
      {
        lockTtlMs: 5_000,
        maxWaitMs: 5_000,
        retryDelayMs: 50,
      },
    );
  }

  private resolveSettingsKey() {
    const raw = this.env.systemSettingsEncryptionKey;
    if (!raw) {
      return undefined;
    }
    try {
      return decodeSystemSettingsKey(raw);
    } catch {
      return undefined;
    }
  }
}
