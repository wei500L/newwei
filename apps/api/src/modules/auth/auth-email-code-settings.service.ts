import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

export interface AuthEmailCodeSettings {
  ttlSeconds: number;
  cooldownSeconds: number;
  maxAttempts: number;
}

const AUTH_EMAIL_CODE_SETTINGS_KEY = "auth_email_code_settings";
const AUTH_EMAIL_CODE_SETTINGS_CACHE_KEY = "auth_email_code:settings";
const CACHE_TTL_SECONDS = 60;

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 1_800;
const MIN_COOLDOWN_SECONDS = 10;
const MAX_COOLDOWN_SECONDS = 3_600;
const MIN_MAX_ATTEMPTS = 1;
const MAX_MAX_ATTEMPTS = 10;

@Injectable()
export class AuthEmailCodeSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly cache: CacheService
  ) {}

  async getSettings(): Promise<AuthEmailCodeSettings> {
    const cached = await this.cache.get<AuthEmailCodeSettings>(
      AUTH_EMAIL_CODE_SETTINGS_CACHE_KEY
    );
    if (cached) {
      return this.normalize(cached);
    }

    const settings = await this.loadSettings();
    await this.cache.set(AUTH_EMAIL_CODE_SETTINGS_CACHE_KEY, settings, CACHE_TTL_SECONDS);
    return settings;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: AuthEmailCodeSettings
  ): Promise<AuthEmailCodeSettings> {
    const normalized = this.normalize(input);
    await this.prisma.systemSetting.upsert({
      where: { key: AUTH_EMAIL_CODE_SETTINGS_KEY },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId
      },
      create: {
        key: AUTH_EMAIL_CODE_SETTINGS_KEY,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: "Auth email code settings"
      }
    });

    void writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "auth_email_code_settings_update",
          metadata: toPrismaJsonValue(normalized)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "auth_email_code_settings_update" }
    ).catch(() => undefined);

    await this.cache.set(AUTH_EMAIL_CODE_SETTINGS_CACHE_KEY, normalized, CACHE_TTL_SECONDS);
    return normalized;
  }

  async invalidateCache(): Promise<void> {
    await this.cache.del(AUTH_EMAIL_CODE_SETTINGS_CACHE_KEY);
  }

  private async loadSettings(): Promise<AuthEmailCodeSettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: AUTH_EMAIL_CODE_SETTINGS_KEY }
    });
    if (!record) {
      return fallback;
    }
    const value = record.value as Partial<AuthEmailCodeSettings>;
    return this.normalize({ ...fallback, ...value });
  }

  private getFallbackSettings(): AuthEmailCodeSettings {
    return this.normalize(this.env.authEmailCodeConfig);
  }

  private normalize(value: Partial<AuthEmailCodeSettings>): AuthEmailCodeSettings {
    const fallback = this.env.authEmailCodeConfig;
    const ttlSeconds = this.clamp(
      this.toInt(value.ttlSeconds, fallback.ttlSeconds),
      MIN_TTL_SECONDS,
      MAX_TTL_SECONDS
    );
    const cooldownSeconds = this.clamp(
      this.toInt(value.cooldownSeconds, fallback.cooldownSeconds),
      MIN_COOLDOWN_SECONDS,
      MAX_COOLDOWN_SECONDS
    );
    const maxAttempts = this.clamp(
      this.toInt(value.maxAttempts, fallback.maxAttempts),
      MIN_MAX_ATTEMPTS,
      MAX_MAX_ATTEMPTS
    );

    return {
      ttlSeconds,
      cooldownSeconds,
      maxAttempts
    };
  }

  private clamp(value: number, min: number, max: number) {
    if (Number.isNaN(value) || value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return value;
  }

  private toInt(value: unknown, fallback: number) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    return fallback;
  }
}
