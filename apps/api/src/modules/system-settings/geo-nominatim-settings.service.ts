import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { isEmail } from "class-validator";

import { normalizeAuditActorId } from "../audit/audit-actor";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PlatformAccessService } from "../auth/platform-access.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

import {
  DATA_RUNTIME_SETTINGS_NOMINATIM_LOCK,
  withDataRuntimeSettingsLock,
} from "./data-runtime-settings.lock";

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

/**
 * Error text returned when the global MySQL session lock for the Nominatim
 * identity row could not be acquired. Byte-identical to the Go takeover's 409
 * message so both implementations expose one retry contract.
 */
const NOMINATIM_LOCK_BUSY_MESSAGE =
  "Nominatim identity settings are being updated by another request; retry later";

@Injectable()
export class GeoNominatimSettingsService {
  private cache: GeoNominatimSettings | null = null;
  private cacheExpiresAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly platformAccess: PlatformAccessService,
  ) {}

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

  /**
   * Applies a partial update to the global Nominatim identity row.
   *
   * DS1: `geo_nominatim_identity` has no `orgId` dimension, so a tenant
   * administrator holding `settings.manage` must not be able to change the
   * User-Agent / e-mail every geocoding call is attributed to. The gate runs
   * first, against the live `GlobalRoleAssignment` table.
   *
   * DS2: the read-modify-write runs under the global
   * `data-runtime-settings:nominatim:v1` MySQL session lock and merges from the
   * raw MySQL row (`loadOverridesFromDB`), never from this process's 30 second
   * `cache` field. Two concurrent updates of `userAgent` and `email` therefore
   * both survive instead of the second one overwriting the first.
   *
   * The original fire-and-forget audit is preserved: the write returns as soon
   * as the row and the process cache are updated, and an audit failure is
   * swallowed rather than turned into a 500.
   */
  async updateSettings(
    orgId: string,
    actorId: string,
    input: { userAgent?: string | null; email?: string | null }
  ): Promise<GeoNominatimSettings> {
    await this.platformAccess.assertPlatformAdmin(actorId);
    const auditActorId = normalizeAuditActorId(actorId);

    return await withDataRuntimeSettingsLock(
      DATA_RUNTIME_SETTINGS_NOMINATIM_LOCK,
      NOMINATIM_LOCK_BUSY_MESSAGE,
      async () => {
        const current = await this.loadOverridesFromDB();
        const nextOverrides: GeoNominatimOverrides = {
          userAgent:
            input.userAgent === undefined
              ? current.userAgent
              : this.normalizeUserAgent(input.userAgent),
          email:
            input.email === undefined
              ? current.email
              : this.normalizeEmail(input.email)
        };

        const prismaValue = this.toPrismaJson(nextOverrides);
        await this.prisma.systemSetting.upsert({
          where: { key: GEO_NOMINATIM_SETTINGS_KEY },
          update: { value: prismaValue, updatedById: auditActorId },
          create: {
            key: GEO_NOMINATIM_SETTINGS_KEY,
            value: prismaValue,
            updatedById: auditActorId,
            description: "Nominatim geocoding identity settings (User-Agent / email)"
          }
        });

        void writeAuditLogBestEffort(
          this.prisma,
          {
            data: {
              orgId,
              actorId: auditActorId,
              resource: "system_settings",
              action: "geo_nominatim_settings_update",
              metadata: prismaValue
            }
          },
          {
            orgId,
            actorId: auditActorId,
            resource: "system_settings",
            action: "geo_nominatim_settings_update"
          }
        ).catch(() => undefined);

        const settings = this.applyFallback(nextOverrides);
        this.cache = settings;
        this.cacheExpiresAt = Date.now() + CACHE_TTL_MS;
        return settings;
      },
    );
  }

  async invalidateCache() {
    this.cache = null;
    this.cacheExpiresAt = 0;
  }

  private async loadSettings(): Promise<GeoNominatimSettings> {
    const overrides = await this.loadOverridesFromDB();
    return this.applyFallback(overrides);
  }

  /**
   * Reads the override row straight from MySQL.
   *
   * This is the authoritative read for both the management GET (on a process
   * cache miss) and every write: the 30 second in-process `cache` field is a
   * display/TTL cache only and is never a merge base. The deliberate
   * consequence is documented behaviour: after an update in one instance,
   * another instance may keep serving its own cached copy for up to 30 seconds.
   */
  private async loadOverridesFromDB(): Promise<GeoNominatimOverrides> {
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
