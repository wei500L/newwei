import {
  createLogger,
  DEFAULT_URL_QUERY_PARAM_ALLOWLIST,
  MAX_URL_QUERY_PARAM_ALLOWLIST_SIZE,
  normalizeUrlQueryParamAllowlist,
} from "@modular/utils";
import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export type NewsSourceSchedulerSettingsSource = "default" | "db";

export interface NewsSourceSchedulerSettingsPublic {
  source: NewsSourceSchedulerSettingsSource;
  seedFreshnessWindowDays: number;
  seedCacheTtlSecondsSitemapRss: number;
  seedCacheTtlSecondsListDeep: number;
  seedCacheTtlForceGlobal: boolean;
  seedUrlQueryParamAllowlist: string[];
}

interface StoredNewsSourceSchedulerSettings {
  seedFreshnessWindowDays?: unknown;
  seedCacheTtlSecondsSitemapRss?: unknown;
  seedCacheTtlSecondsListDeep?: unknown;
  seedCacheTtlForceGlobal?: unknown;
  seedUrlQueryParamAllowlist?: unknown;
}

const SETTINGS_KEY = "news_source_scheduler_settings";
const SETTINGS_DESCRIPTION =
  "News source scheduler runtime settings (seed freshness + discovery TTL defaults)";
const DEFAULT_SEED_FRESHNESS_WINDOW_DAYS = 365;
const MIN_SEED_FRESHNESS_WINDOW_DAYS = 1;
const MAX_SEED_FRESHNESS_WINDOW_DAYS = 3_650;
const DEFAULT_SEED_CACHE_TTL_SECONDS_SITEMAP_RSS = 60;
const DEFAULT_SEED_CACHE_TTL_SECONDS_LIST_DEEP = 180;
const DEFAULT_SEED_CACHE_TTL_FORCE_GLOBAL = false;
const DEFAULT_SEED_URL_QUERY_PARAM_ALLOWLIST = [
  ...DEFAULT_URL_QUERY_PARAM_ALLOWLIST,
];
const MIN_SEED_CACHE_TTL_SECONDS = 10;
const MAX_SEED_CACHE_TTL_SECONDS = 3_600;
const SEED_DISCOVERY_CACHE_KEY_PREFIXES = [
  "news-source:sitemap:",
  "news-source:rss:",
  "news-source:list:",
  "news-source:deep:",
] as const;
const INVALID_PERSISTED_SETTINGS_CODE = "NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID";
const INVALID_PERSISTED_SETTINGS_ERROR =
  "Stored news source scheduler settings are invalid.";
const INVALID_PERSISTED_SETTINGS_DETAIL =
  "seedFreshnessWindowDays must be an integer between 1 and 3650; seedCacheTtlSecondsSitemapRss and seedCacheTtlSecondsListDeep must be integers between 10 and 3600; seedCacheTtlForceGlobal must be a boolean; seedUrlQueryParamAllowlist must be an array of valid query keys.";

@Injectable()
export class NewsSourceSchedulerSettingsService {
  private readonly logger = createLogger({ name: "news-source-scheduler-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getSettings(): Promise<NewsSourceSchedulerSettingsPublic> {
    let record: { value: unknown } | null = null;
    try {
      record = await this.prisma.systemSetting.findUnique({
        where: { key: SETTINGS_KEY },
        select: { value: true },
      });
    } catch (error) {
      this.logger.error(
        { error, settingsKey: SETTINGS_KEY },
        "Failed to load news source scheduler settings",
      );
      throw error;
    }

    if (!record) {
      return {
        source: "default",
        seedFreshnessWindowDays: DEFAULT_SEED_FRESHNESS_WINDOW_DAYS,
        seedCacheTtlSecondsSitemapRss:
          DEFAULT_SEED_CACHE_TTL_SECONDS_SITEMAP_RSS,
        seedCacheTtlSecondsListDeep: DEFAULT_SEED_CACHE_TTL_SECONDS_LIST_DEEP,
        seedCacheTtlForceGlobal: DEFAULT_SEED_CACHE_TTL_FORCE_GLOBAL,
        seedUrlQueryParamAllowlist: [...DEFAULT_SEED_URL_QUERY_PARAM_ALLOWLIST],
      };
    }

    const value = (record.value as StoredNewsSourceSchedulerSettings | null) ?? {};
    const parsedSeedFreshnessWindowDays = this.toStrictSeedFreshnessWindowDays(
      value.seedFreshnessWindowDays,
    );
    const parsedSeedCacheTtlSecondsSitemapRss =
      this.toStrictOptionalSeedCacheTtlSeconds(
        value.seedCacheTtlSecondsSitemapRss,
      );
    const parsedSeedCacheTtlSecondsListDeep =
      this.toStrictOptionalSeedCacheTtlSeconds(
        value.seedCacheTtlSecondsListDeep,
      );
    const parsedSeedCacheTtlForceGlobal = this.toStrictOptionalBoolean(
      value.seedCacheTtlForceGlobal,
    );
    const parsedSeedUrlQueryParamAllowlist =
      this.toStrictOptionalSeedUrlQueryParamAllowlist(
        value.seedUrlQueryParamAllowlist,
      );
    if (
      parsedSeedFreshnessWindowDays === null ||
      parsedSeedCacheTtlSecondsSitemapRss === null ||
      parsedSeedCacheTtlSecondsListDeep === null ||
      parsedSeedCacheTtlForceGlobal === null ||
      parsedSeedUrlQueryParamAllowlist === null
    ) {
      this.logger.error(
        {
          settingsKey: SETTINGS_KEY,
          storedSeedFreshnessWindowDays: value.seedFreshnessWindowDays,
          storedSeedCacheTtlSecondsSitemapRss:
            value.seedCacheTtlSecondsSitemapRss,
          storedSeedCacheTtlSecondsListDeep:
            value.seedCacheTtlSecondsListDeep,
          storedSeedCacheTtlForceGlobal: value.seedCacheTtlForceGlobal,
          storedSeedUrlQueryParamAllowlist: value.seedUrlQueryParamAllowlist,
        },
        "Invalid persisted news source scheduler settings value",
      );
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail: INVALID_PERSISTED_SETTINGS_DETAIL,
      });
    }

    return {
      source: "db",
      seedFreshnessWindowDays: parsedSeedFreshnessWindowDays,
      seedCacheTtlSecondsSitemapRss:
        parsedSeedCacheTtlSecondsSitemapRss ??
        DEFAULT_SEED_CACHE_TTL_SECONDS_SITEMAP_RSS,
      seedCacheTtlSecondsListDeep:
        parsedSeedCacheTtlSecondsListDeep ??
        DEFAULT_SEED_CACHE_TTL_SECONDS_LIST_DEEP,
      seedCacheTtlForceGlobal:
        parsedSeedCacheTtlForceGlobal ?? DEFAULT_SEED_CACHE_TTL_FORCE_GLOBAL,
      seedUrlQueryParamAllowlist:
        parsedSeedUrlQueryParamAllowlist ??
        [...DEFAULT_SEED_URL_QUERY_PARAM_ALLOWLIST],
    };
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      seedFreshnessWindowDays: number;
      seedCacheTtlSecondsSitemapRss: number;
      seedCacheTtlSecondsListDeep: number;
      seedCacheTtlForceGlobal: boolean;
      seedUrlQueryParamAllowlist: string[];
    },
  ): Promise<NewsSourceSchedulerSettingsPublic> {
    const normalizedSeedFreshnessWindowDays = this.toStrictSeedFreshnessWindowDays(
      input.seedFreshnessWindowDays,
    );
    const normalizedSeedCacheTtlSecondsSitemapRss =
      this.toStrictSeedCacheTtlSeconds(input.seedCacheTtlSecondsSitemapRss);
    const normalizedSeedCacheTtlSecondsListDeep = this.toStrictSeedCacheTtlSeconds(
      input.seedCacheTtlSecondsListDeep,
    );
    const normalizedSeedCacheTtlForceGlobal = this.toStrictBoolean(
      input.seedCacheTtlForceGlobal,
    );
    const normalizedSeedUrlQueryParamAllowlist =
      this.toStrictSeedUrlQueryParamAllowlist(
        input.seedUrlQueryParamAllowlist,
      );
    if (normalizedSeedFreshnessWindowDays === null) {
      throw new BadRequestException(
        `seedFreshnessWindowDays must be an integer between ${MIN_SEED_FRESHNESS_WINDOW_DAYS} and ${MAX_SEED_FRESHNESS_WINDOW_DAYS}`,
      );
    }
    if (normalizedSeedCacheTtlSecondsSitemapRss === null) {
      throw new BadRequestException(
        `seedCacheTtlSecondsSitemapRss must be an integer between ${MIN_SEED_CACHE_TTL_SECONDS} and ${MAX_SEED_CACHE_TTL_SECONDS}`,
      );
    }
    if (normalizedSeedCacheTtlSecondsListDeep === null) {
      throw new BadRequestException(
        `seedCacheTtlSecondsListDeep must be an integer between ${MIN_SEED_CACHE_TTL_SECONDS} and ${MAX_SEED_CACHE_TTL_SECONDS}`,
      );
    }
    if (normalizedSeedCacheTtlForceGlobal === null) {
      throw new BadRequestException(
        "seedCacheTtlForceGlobal must be a boolean",
      );
    }
    if (normalizedSeedUrlQueryParamAllowlist === null) {
      throw new BadRequestException(
        `seedUrlQueryParamAllowlist must be an array of valid query keys (max ${MAX_URL_QUERY_PARAM_ALLOWLIST_SIZE})`,
      );
    }

    try {
      await this.prisma.systemSetting.upsert({
        where: { key: SETTINGS_KEY },
        update: {
          value: toPrismaJsonValue({
            seedFreshnessWindowDays: normalizedSeedFreshnessWindowDays,
            seedCacheTtlSecondsSitemapRss:
              normalizedSeedCacheTtlSecondsSitemapRss,
            seedCacheTtlSecondsListDeep: normalizedSeedCacheTtlSecondsListDeep,
            seedCacheTtlForceGlobal: normalizedSeedCacheTtlForceGlobal,
            seedUrlQueryParamAllowlist: normalizedSeedUrlQueryParamAllowlist,
          }),
          updatedById: actorId,
          description: SETTINGS_DESCRIPTION,
        },
        create: {
          key: SETTINGS_KEY,
          value: toPrismaJsonValue({
            seedFreshnessWindowDays: normalizedSeedFreshnessWindowDays,
            seedCacheTtlSecondsSitemapRss:
              normalizedSeedCacheTtlSecondsSitemapRss,
            seedCacheTtlSecondsListDeep: normalizedSeedCacheTtlSecondsListDeep,
            seedCacheTtlForceGlobal: normalizedSeedCacheTtlForceGlobal,
            seedUrlQueryParamAllowlist: normalizedSeedUrlQueryParamAllowlist,
          }),
          updatedById: actorId,
          description: SETTINGS_DESCRIPTION,
        },
      });
    } catch (error) {
      this.logger.error(
        {
          error,
          orgId,
          actorId,
          settingsKey: SETTINGS_KEY,
          seedFreshnessWindowDays: normalizedSeedFreshnessWindowDays,
          seedCacheTtlSecondsSitemapRss:
            normalizedSeedCacheTtlSecondsSitemapRss,
          seedCacheTtlSecondsListDeep: normalizedSeedCacheTtlSecondsListDeep,
          seedCacheTtlForceGlobal: normalizedSeedCacheTtlForceGlobal,
          seedUrlQueryParamAllowlist: normalizedSeedUrlQueryParamAllowlist,
        },
        "Failed to persist news source scheduler settings",
      );
      throw error;
    }
    await this.invalidateSeedDiscoveryCacheBestEffort(
      normalizedSeedCacheTtlForceGlobal,
    );

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "news_source_scheduler_settings_update",
          metadata: toPrismaJsonValue({
            seedFreshnessWindowDays: normalizedSeedFreshnessWindowDays,
            seedCacheTtlSecondsSitemapRss:
              normalizedSeedCacheTtlSecondsSitemapRss,
            seedCacheTtlSecondsListDeep: normalizedSeedCacheTtlSecondsListDeep,
            seedCacheTtlForceGlobal: normalizedSeedCacheTtlForceGlobal,
            seedUrlQueryParamAllowlist: normalizedSeedUrlQueryParamAllowlist,
          }),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "news_source_scheduler_settings_update",
      },
    );

    return {
      source: "db",
      seedFreshnessWindowDays: normalizedSeedFreshnessWindowDays,
      seedCacheTtlSecondsSitemapRss: normalizedSeedCacheTtlSecondsSitemapRss,
      seedCacheTtlSecondsListDeep: normalizedSeedCacheTtlSecondsListDeep,
      seedCacheTtlForceGlobal: normalizedSeedCacheTtlForceGlobal,
      seedUrlQueryParamAllowlist: normalizedSeedUrlQueryParamAllowlist,
    };
  }

  private toStrictSeedFreshnessWindowDays(value: unknown): number | null {
    const parsed = this.toNumber(value);
    if (parsed === null || !Number.isInteger(parsed)) {
      return null;
    }
    if (
      parsed < MIN_SEED_FRESHNESS_WINDOW_DAYS ||
      parsed > MAX_SEED_FRESHNESS_WINDOW_DAYS
    ) {
      return null;
    }
    return parsed;
  }

  private toStrictOptionalSeedCacheTtlSeconds(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.toStrictSeedCacheTtlSeconds(value);
  }

  private toStrictSeedCacheTtlSeconds(value: unknown): number | null {
    const parsed = this.toNumber(value);
    if (parsed === null || !Number.isInteger(parsed)) {
      return null;
    }
    if (
      parsed < MIN_SEED_CACHE_TTL_SECONDS ||
      parsed > MAX_SEED_CACHE_TTL_SECONDS
    ) {
      return null;
    }
    return parsed;
  }

  private toStrictOptionalBoolean(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.toStrictBoolean(value);
  }

  private toStrictOptionalSeedUrlQueryParamAllowlist(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.toStrictSeedUrlQueryParamAllowlist(value);
  }

  private toStrictSeedUrlQueryParamAllowlist(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
      return null;
    }
    if (value.length > MAX_URL_QUERY_PARAM_ALLOWLIST_SIZE) {
      return null;
    }

    for (const entry of value) {
      if (typeof entry !== "string") {
        return null;
      }
      const normalized = normalizeUrlQueryParamAllowlist([entry], []);
      if (normalized.length === 0) {
        return null;
      }
    }

    return normalizeUrlQueryParamAllowlist(
      value,
      DEFAULT_SEED_URL_QUERY_PARAM_ALLOWLIST,
    );
  }

  private toStrictBoolean(value: unknown): boolean | null {
    if (typeof value === "boolean") {
      return value;
    }
    return null;
  }

  private async invalidateSeedDiscoveryCacheBestEffort(
    forceGlobal: boolean,
  ) {
    try {
      let deleted = 0;
      for (const prefix of SEED_DISCOVERY_CACHE_KEY_PREFIXES) {
        deleted += await this.cache.delByPrefix(prefix);
      }
      this.logger.info(
        {
          settingsKey: SETTINGS_KEY,
          forceGlobal,
          deletedCacheKeys: deleted,
          prefixes: SEED_DISCOVERY_CACHE_KEY_PREFIXES,
        },
        "Invalidated news source seed discovery cache after scheduler settings update",
      );
    } catch (error) {
      this.logger.warn(
        { error, settingsKey: SETTINGS_KEY, forceGlobal },
        "Failed to invalidate news source seed discovery cache after scheduler settings update",
      );
    }
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }
}
