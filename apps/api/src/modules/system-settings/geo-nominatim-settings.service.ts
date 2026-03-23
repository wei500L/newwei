import { isEmail } from "class-validator";
import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

export interface GeoNominatimSettings {
  userAgent: string | null;
  email: string | null;
  effectiveUserAgent: string;
  effectiveEmail: string | null;
}

export interface GeoNominatimEffectiveIdentity {
  userAgent: string;
  email?: string;
}

interface GeoNominatimOverrides {
  userAgent: string | null;
  email: string | null;
}

const GEO_NOMINATIM_SETTINGS_KEY = "geo_nominatim_identity";
const CACHE_TTL_MS = 30_000;

@Injectable()
export class GeoNominatimSettingsService {
  private cache: GeoNominatimSettings | null = null;
  private cacheExpiresAt = 0;

  constructor(private readonly prisma: PrismaService, private readonly env: EnvService) {}

  async getSettings(): Promise<GeoNominatimSettings> {
    const now = Date.now();
    if (this.cache && now < this.cacheExpiresAt) {
      return this.cache;
    }
    const settings = await this.loadSettings();
    this.cache = settings;
    this.cacheExpiresAt = now + CACHE_TTL_MS;
    return settings;
  }

  async getEffectiveIdentity(): Promise<GeoNominatimEffectiveIdentity> {
    const settings = await this.getSettings();
    return {
      userAgent: settings.effectiveUserAgent,
      ...(settings.effectiveEmail ? { email: settings.effectiveEmail } : {})
    };
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: { userAgent?: string | null; email?: string | null }
  ): Promise<GeoNominatimSettings> {
    const current = await this.loadOverrides();
    const nextOverrides: GeoNominatimOverrides = {
      userAgent:
        input.userAgent === undefined ? current.userAgent : this.normalizeUserAgent(input.userAgent),
      email: input.email === undefined ? current.email : this.normalizeEmail(input.email)
    };

    const prismaValue = this.toPrismaJson(nextOverrides);
    await this.prisma.systemSetting.upsert({
      where: { key: GEO_NOMINATIM_SETTINGS_KEY },
      update: { value: prismaValue, updatedById: actorId },
      create: {
        key: GEO_NOMINATIM_SETTINGS_KEY,
        value: prismaValue,
        updatedById: actorId,
        description: "Nominatim geocoding identity settings (User-Agent / email)"
      }
    });

    void writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "geo_nominatim_settings_update",
          metadata: prismaValue
        }
      },
      { orgId, actorId, resource: "system_settings", action: "geo_nominatim_settings_update" }
    ).catch(() => undefined);

    const settings = this.applyFallback(nextOverrides);
    this.cache = settings;
    this.cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return settings;
  }

  async invalidateCache() {
    this.cache = null;
    this.cacheExpiresAt = 0;
  }

  private async loadSettings(): Promise<GeoNominatimSettings> {
    const overrides = await this.loadOverrides();
    return this.applyFallback(overrides);
  }

  private async loadOverrides(): Promise<GeoNominatimOverrides> {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: GEO_NOMINATIM_SETTINGS_KEY }
    });
    if (!record) {
      return { userAgent: null, email: null };
    }
    const value = record.value as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { userAgent: null, email: null };
    }
    const obj = value as Record<string, unknown>;
    return {
      userAgent: this.normalizeUserAgent(obj.userAgent),
      email: this.normalizeEmail(obj.email)
    };
  }

  private applyFallback(overrides: GeoNominatimOverrides): GeoNominatimSettings {
    const fallbackUserAgent =
      this.env.get<string>("GEO_NOMINATIM_USER_AGENT", { infer: true }) ?? "modular-api";
    const fallbackEmail = this.normalizeEmail(
      this.env.get<string | undefined>("GEO_NOMINATIM_EMAIL", { infer: true }) ?? null,
    );

    return {
      userAgent: overrides.userAgent,
      email: overrides.email,
      effectiveUserAgent: overrides.userAgent ?? fallbackUserAgent,
      effectiveEmail: overrides.email ?? fallbackEmail
    };
  }

  private normalizeUserAgent(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private normalizeEmail(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return isEmail(trimmed) ? trimmed : null;
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
