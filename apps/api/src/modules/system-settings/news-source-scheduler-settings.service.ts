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
  rssAdaptiveHotHitRatePercent: number;
  rssAdaptiveWarmHitRatePercent: number;
  rssAdaptiveColdConsecutiveNoHitRuns: number;
  rssAdaptiveHotIntervalSeconds: number;
  rssAdaptiveWarmIntervalDivisor: number;
  rssAdaptiveWarmMinIntervalSeconds: number;
  rssAdaptiveColdIntervalMultiplier: number;
  rssAdaptiveColdMaxIntervalSeconds: number;
  rssAdaptiveHotDiscoveryCacheTtlCapSeconds: number;
  rssAdaptiveWarmDiscoveryCacheTtlCapSeconds: number;
}

interface StoredNewsSourceSchedulerSettings {
  seedFreshnessWindowDays?: unknown;
  seedCacheTtlSecondsSitemapRss?: unknown;
  seedCacheTtlSecondsListDeep?: unknown;
  seedCacheTtlForceGlobal?: unknown;
  seedUrlQueryParamAllowlist?: unknown;
  rssAdaptiveHotHitRatePercent?: unknown;
  rssAdaptiveWarmHitRatePercent?: unknown;
  rssAdaptiveColdConsecutiveNoHitRuns?: unknown;
  rssAdaptiveHotIntervalSeconds?: unknown;
  rssAdaptiveWarmIntervalDivisor?: unknown;
  rssAdaptiveWarmMinIntervalSeconds?: unknown;
  rssAdaptiveColdIntervalMultiplier?: unknown;
  rssAdaptiveColdMaxIntervalSeconds?: unknown;
  rssAdaptiveHotDiscoveryCacheTtlCapSeconds?: unknown;
  rssAdaptiveWarmDiscoveryCacheTtlCapSeconds?: unknown;
}

const SETTINGS_KEY = "news_source_scheduler_settings";
const SETTINGS_DESCRIPTION =
  "News source scheduler runtime settings (seed freshness + discovery TTL defaults)";
const SETTINGS_CACHE_TTL_MS = 30_000;
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
const DEFAULT_RSS_ADAPTIVE_HOT_HIT_RATE_PERCENT = 60;
const DEFAULT_RSS_ADAPTIVE_WARM_HIT_RATE_PERCENT = 25;
const DEFAULT_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS = 4;
const DEFAULT_RSS_ADAPTIVE_HOT_INTERVAL_SECONDS = 30;
const DEFAULT_RSS_ADAPTIVE_WARM_INTERVAL_DIVISOR = 2;
const DEFAULT_RSS_ADAPTIVE_WARM_MIN_INTERVAL_SECONDS = 30;
const DEFAULT_RSS_ADAPTIVE_COLD_INTERVAL_MULTIPLIER = 2;
const DEFAULT_RSS_ADAPTIVE_COLD_MAX_INTERVAL_SECONDS = 3_600;
const DEFAULT_RSS_ADAPTIVE_HOT_DISCOVERY_CACHE_TTL_CAP_SECONDS = 30;
const DEFAULT_RSS_ADAPTIVE_WARM_DISCOVERY_CACHE_TTL_CAP_SECONDS = 60;
const MIN_RSS_ADAPTIVE_HIT_RATE_PERCENT = 0;
const MAX_RSS_ADAPTIVE_HIT_RATE_PERCENT = 100;
const MIN_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS = 1;
const MAX_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS = 24;
const MIN_RSS_ADAPTIVE_INTERVAL_SECONDS = 10;
const MAX_RSS_ADAPTIVE_INTERVAL_SECONDS = 21_600;
const MIN_RSS_ADAPTIVE_INTERVAL_DIVISOR = 1;
const MAX_RSS_ADAPTIVE_INTERVAL_DIVISOR = 8;
const MIN_RSS_ADAPTIVE_INTERVAL_MULTIPLIER = 1;
const MAX_RSS_ADAPTIVE_INTERVAL_MULTIPLIER = 8;
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
  "seedFreshnessWindowDays must be an integer between 1 and 3650; seedCacheTtlSecondsSitemapRss and seedCacheTtlSecondsListDeep must be integers between 10 and 3600; seedCacheTtlForceGlobal must be a boolean; seedUrlQueryParamAllowlist must be an array of valid query keys; rssAdaptive* settings must be within configured integer ranges and satisfy warmHitRate<=hotHitRate, warmCacheTtlCap>=hotCacheTtlCap, coldMaxInterval>=warmMinInterval.";

@Injectable()
export class NewsSourceSchedulerSettingsService {
  private readonly logger = createLogger({ name: "news-source-scheduler-settings" });
  private cachedSettings:
    | {
        value: NewsSourceSchedulerSettingsPublic;
        expiresAt: number;
      }
    | null = null;
  private loadingPromise: Promise<NewsSourceSchedulerSettingsPublic> | null =
    null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getSettings(): Promise<NewsSourceSchedulerSettingsPublic> {
    const cached = this.cachedSettings;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = this.loadSettingsFromStorage()
      .then((settings) => {
        this.cachedSettings = {
          value: settings,
          expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
        };
        return settings;
      })
      .finally(() => {
        this.loadingPromise = null;
      });

    return this.loadingPromise;
  }

  private async loadSettingsFromStorage(): Promise<NewsSourceSchedulerSettingsPublic> {
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
        rssAdaptiveHotHitRatePercent: DEFAULT_RSS_ADAPTIVE_HOT_HIT_RATE_PERCENT,
        rssAdaptiveWarmHitRatePercent:
          DEFAULT_RSS_ADAPTIVE_WARM_HIT_RATE_PERCENT,
        rssAdaptiveColdConsecutiveNoHitRuns:
          DEFAULT_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS,
        rssAdaptiveHotIntervalSeconds:
          DEFAULT_RSS_ADAPTIVE_HOT_INTERVAL_SECONDS,
        rssAdaptiveWarmIntervalDivisor:
          DEFAULT_RSS_ADAPTIVE_WARM_INTERVAL_DIVISOR,
        rssAdaptiveWarmMinIntervalSeconds:
          DEFAULT_RSS_ADAPTIVE_WARM_MIN_INTERVAL_SECONDS,
        rssAdaptiveColdIntervalMultiplier:
          DEFAULT_RSS_ADAPTIVE_COLD_INTERVAL_MULTIPLIER,
        rssAdaptiveColdMaxIntervalSeconds:
          DEFAULT_RSS_ADAPTIVE_COLD_MAX_INTERVAL_SECONDS,
        rssAdaptiveHotDiscoveryCacheTtlCapSeconds:
          DEFAULT_RSS_ADAPTIVE_HOT_DISCOVERY_CACHE_TTL_CAP_SECONDS,
        rssAdaptiveWarmDiscoveryCacheTtlCapSeconds:
          DEFAULT_RSS_ADAPTIVE_WARM_DISCOVERY_CACHE_TTL_CAP_SECONDS,
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
    const parsedRssAdaptiveHotHitRatePercent =
      this.toStrictOptionalRssAdaptiveHitRatePercent(
        value.rssAdaptiveHotHitRatePercent,
      );
    const parsedRssAdaptiveWarmHitRatePercent =
      this.toStrictOptionalRssAdaptiveHitRatePercent(
        value.rssAdaptiveWarmHitRatePercent,
      );
    const parsedRssAdaptiveColdConsecutiveNoHitRuns =
      this.toStrictOptionalRssAdaptiveColdConsecutiveNoHitRuns(
        value.rssAdaptiveColdConsecutiveNoHitRuns,
      );
    const parsedRssAdaptiveHotIntervalSeconds =
      this.toStrictOptionalRssAdaptiveIntervalSeconds(
        value.rssAdaptiveHotIntervalSeconds,
      );
    const parsedRssAdaptiveWarmIntervalDivisor =
      this.toStrictOptionalRssAdaptiveWarmIntervalDivisor(
        value.rssAdaptiveWarmIntervalDivisor,
      );
    const parsedRssAdaptiveWarmMinIntervalSeconds =
      this.toStrictOptionalRssAdaptiveIntervalSeconds(
        value.rssAdaptiveWarmMinIntervalSeconds,
      );
    const parsedRssAdaptiveColdIntervalMultiplier =
      this.toStrictOptionalRssAdaptiveColdIntervalMultiplier(
        value.rssAdaptiveColdIntervalMultiplier,
      );
    const parsedRssAdaptiveColdMaxIntervalSeconds =
      this.toStrictOptionalRssAdaptiveIntervalSeconds(
        value.rssAdaptiveColdMaxIntervalSeconds,
      );
    const parsedRssAdaptiveHotDiscoveryCacheTtlCapSeconds =
      this.toStrictOptionalSeedCacheTtlSeconds(
        value.rssAdaptiveHotDiscoveryCacheTtlCapSeconds,
      );
    const parsedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds =
      this.toStrictOptionalSeedCacheTtlSeconds(
        value.rssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
      );
    if (
      parsedSeedFreshnessWindowDays === null ||
      parsedSeedCacheTtlSecondsSitemapRss === null ||
      parsedSeedCacheTtlSecondsListDeep === null ||
      parsedSeedCacheTtlForceGlobal === null ||
      parsedSeedUrlQueryParamAllowlist === null ||
      parsedRssAdaptiveHotHitRatePercent === null ||
      parsedRssAdaptiveWarmHitRatePercent === null ||
      parsedRssAdaptiveColdConsecutiveNoHitRuns === null ||
      parsedRssAdaptiveHotIntervalSeconds === null ||
      parsedRssAdaptiveWarmIntervalDivisor === null ||
      parsedRssAdaptiveWarmMinIntervalSeconds === null ||
      parsedRssAdaptiveColdIntervalMultiplier === null ||
      parsedRssAdaptiveColdMaxIntervalSeconds === null ||
      parsedRssAdaptiveHotDiscoveryCacheTtlCapSeconds === null ||
      parsedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds === null
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
          storedRssAdaptiveHotHitRatePercent:
            value.rssAdaptiveHotHitRatePercent,
          storedRssAdaptiveWarmHitRatePercent:
            value.rssAdaptiveWarmHitRatePercent,
          storedRssAdaptiveColdConsecutiveNoHitRuns:
            value.rssAdaptiveColdConsecutiveNoHitRuns,
          storedRssAdaptiveHotIntervalSeconds:
            value.rssAdaptiveHotIntervalSeconds,
          storedRssAdaptiveWarmIntervalDivisor:
            value.rssAdaptiveWarmIntervalDivisor,
          storedRssAdaptiveWarmMinIntervalSeconds:
            value.rssAdaptiveWarmMinIntervalSeconds,
          storedRssAdaptiveColdIntervalMultiplier:
            value.rssAdaptiveColdIntervalMultiplier,
          storedRssAdaptiveColdMaxIntervalSeconds:
            value.rssAdaptiveColdMaxIntervalSeconds,
          storedRssAdaptiveHotDiscoveryCacheTtlCapSeconds:
            value.rssAdaptiveHotDiscoveryCacheTtlCapSeconds,
          storedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds:
            value.rssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
        },
        "Invalid persisted news source scheduler settings value",
      );
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail: INVALID_PERSISTED_SETTINGS_DETAIL,
      });
    }

    const rssAdaptiveHotHitRatePercent =
      parsedRssAdaptiveHotHitRatePercent ??
      DEFAULT_RSS_ADAPTIVE_HOT_HIT_RATE_PERCENT;
    const rssAdaptiveWarmHitRatePercent =
      parsedRssAdaptiveWarmHitRatePercent ??
      DEFAULT_RSS_ADAPTIVE_WARM_HIT_RATE_PERCENT;
    const rssAdaptiveWarmMinIntervalSeconds =
      parsedRssAdaptiveWarmMinIntervalSeconds ??
      DEFAULT_RSS_ADAPTIVE_WARM_MIN_INTERVAL_SECONDS;
    const rssAdaptiveColdMaxIntervalSeconds =
      parsedRssAdaptiveColdMaxIntervalSeconds ??
      DEFAULT_RSS_ADAPTIVE_COLD_MAX_INTERVAL_SECONDS;
    const rssAdaptiveHotDiscoveryCacheTtlCapSeconds =
      parsedRssAdaptiveHotDiscoveryCacheTtlCapSeconds ??
      DEFAULT_RSS_ADAPTIVE_HOT_DISCOVERY_CACHE_TTL_CAP_SECONDS;
    const rssAdaptiveWarmDiscoveryCacheTtlCapSeconds =
      parsedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds ??
      DEFAULT_RSS_ADAPTIVE_WARM_DISCOVERY_CACHE_TTL_CAP_SECONDS;
    if (rssAdaptiveWarmHitRatePercent > rssAdaptiveHotHitRatePercent) {
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail: INVALID_PERSISTED_SETTINGS_DETAIL,
      });
    }
    if (
      rssAdaptiveWarmDiscoveryCacheTtlCapSeconds <
      rssAdaptiveHotDiscoveryCacheTtlCapSeconds
    ) {
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail: INVALID_PERSISTED_SETTINGS_DETAIL,
      });
    }
    if (rssAdaptiveColdMaxIntervalSeconds < rssAdaptiveWarmMinIntervalSeconds) {
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
      rssAdaptiveHotHitRatePercent,
      rssAdaptiveWarmHitRatePercent,
      rssAdaptiveColdConsecutiveNoHitRuns:
        parsedRssAdaptiveColdConsecutiveNoHitRuns ??
        DEFAULT_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS,
      rssAdaptiveHotIntervalSeconds:
        parsedRssAdaptiveHotIntervalSeconds ??
        DEFAULT_RSS_ADAPTIVE_HOT_INTERVAL_SECONDS,
      rssAdaptiveWarmIntervalDivisor:
        parsedRssAdaptiveWarmIntervalDivisor ??
        DEFAULT_RSS_ADAPTIVE_WARM_INTERVAL_DIVISOR,
      rssAdaptiveWarmMinIntervalSeconds,
      rssAdaptiveColdIntervalMultiplier:
        parsedRssAdaptiveColdIntervalMultiplier ??
        DEFAULT_RSS_ADAPTIVE_COLD_INTERVAL_MULTIPLIER,
      rssAdaptiveColdMaxIntervalSeconds,
      rssAdaptiveHotDiscoveryCacheTtlCapSeconds,
      rssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
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
      rssAdaptiveHotHitRatePercent: number;
      rssAdaptiveWarmHitRatePercent: number;
      rssAdaptiveColdConsecutiveNoHitRuns: number;
      rssAdaptiveHotIntervalSeconds: number;
      rssAdaptiveWarmIntervalDivisor: number;
      rssAdaptiveWarmMinIntervalSeconds: number;
      rssAdaptiveColdIntervalMultiplier: number;
      rssAdaptiveColdMaxIntervalSeconds: number;
      rssAdaptiveHotDiscoveryCacheTtlCapSeconds: number;
      rssAdaptiveWarmDiscoveryCacheTtlCapSeconds: number;
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
    const normalizedRssAdaptiveHotHitRatePercent =
      this.toStrictRssAdaptiveHitRatePercent(input.rssAdaptiveHotHitRatePercent);
    const normalizedRssAdaptiveWarmHitRatePercent =
      this.toStrictRssAdaptiveHitRatePercent(
        input.rssAdaptiveWarmHitRatePercent,
      );
    const normalizedRssAdaptiveColdConsecutiveNoHitRuns =
      this.toStrictRssAdaptiveColdConsecutiveNoHitRuns(
        input.rssAdaptiveColdConsecutiveNoHitRuns,
      );
    const normalizedRssAdaptiveHotIntervalSeconds =
      this.toStrictRssAdaptiveIntervalSeconds(
        input.rssAdaptiveHotIntervalSeconds,
      );
    const normalizedRssAdaptiveWarmIntervalDivisor =
      this.toStrictRssAdaptiveWarmIntervalDivisor(
        input.rssAdaptiveWarmIntervalDivisor,
      );
    const normalizedRssAdaptiveWarmMinIntervalSeconds =
      this.toStrictRssAdaptiveIntervalSeconds(
        input.rssAdaptiveWarmMinIntervalSeconds,
      );
    const normalizedRssAdaptiveColdIntervalMultiplier =
      this.toStrictRssAdaptiveColdIntervalMultiplier(
        input.rssAdaptiveColdIntervalMultiplier,
      );
    const normalizedRssAdaptiveColdMaxIntervalSeconds =
      this.toStrictRssAdaptiveIntervalSeconds(
        input.rssAdaptiveColdMaxIntervalSeconds,
      );
    const normalizedRssAdaptiveHotDiscoveryCacheTtlCapSeconds =
      this.toStrictSeedCacheTtlSeconds(
        input.rssAdaptiveHotDiscoveryCacheTtlCapSeconds,
      );
    const normalizedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds =
      this.toStrictSeedCacheTtlSeconds(
        input.rssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
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
    if (normalizedRssAdaptiveHotHitRatePercent === null) {
      throw new BadRequestException(
        `rssAdaptiveHotHitRatePercent must be an integer between ${MIN_RSS_ADAPTIVE_HIT_RATE_PERCENT} and ${MAX_RSS_ADAPTIVE_HIT_RATE_PERCENT}`,
      );
    }
    if (normalizedRssAdaptiveWarmHitRatePercent === null) {
      throw new BadRequestException(
        `rssAdaptiveWarmHitRatePercent must be an integer between ${MIN_RSS_ADAPTIVE_HIT_RATE_PERCENT} and ${MAX_RSS_ADAPTIVE_HIT_RATE_PERCENT}`,
      );
    }
    if (
      normalizedRssAdaptiveWarmHitRatePercent >
      normalizedRssAdaptiveHotHitRatePercent
    ) {
      throw new BadRequestException(
        "rssAdaptiveWarmHitRatePercent must be less than or equal to rssAdaptiveHotHitRatePercent",
      );
    }
    if (normalizedRssAdaptiveColdConsecutiveNoHitRuns === null) {
      throw new BadRequestException(
        `rssAdaptiveColdConsecutiveNoHitRuns must be an integer between ${MIN_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS} and ${MAX_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS}`,
      );
    }
    if (normalizedRssAdaptiveHotIntervalSeconds === null) {
      throw new BadRequestException(
        `rssAdaptiveHotIntervalSeconds must be an integer between ${MIN_RSS_ADAPTIVE_INTERVAL_SECONDS} and ${MAX_RSS_ADAPTIVE_INTERVAL_SECONDS}`,
      );
    }
    if (normalizedRssAdaptiveWarmIntervalDivisor === null) {
      throw new BadRequestException(
        `rssAdaptiveWarmIntervalDivisor must be an integer between ${MIN_RSS_ADAPTIVE_INTERVAL_DIVISOR} and ${MAX_RSS_ADAPTIVE_INTERVAL_DIVISOR}`,
      );
    }
    if (normalizedRssAdaptiveWarmMinIntervalSeconds === null) {
      throw new BadRequestException(
        `rssAdaptiveWarmMinIntervalSeconds must be an integer between ${MIN_RSS_ADAPTIVE_INTERVAL_SECONDS} and ${MAX_RSS_ADAPTIVE_INTERVAL_SECONDS}`,
      );
    }
    if (normalizedRssAdaptiveColdIntervalMultiplier === null) {
      throw new BadRequestException(
        `rssAdaptiveColdIntervalMultiplier must be an integer between ${MIN_RSS_ADAPTIVE_INTERVAL_MULTIPLIER} and ${MAX_RSS_ADAPTIVE_INTERVAL_MULTIPLIER}`,
      );
    }
    if (normalizedRssAdaptiveColdMaxIntervalSeconds === null) {
      throw new BadRequestException(
        `rssAdaptiveColdMaxIntervalSeconds must be an integer between ${MIN_RSS_ADAPTIVE_INTERVAL_SECONDS} and ${MAX_RSS_ADAPTIVE_INTERVAL_SECONDS}`,
      );
    }
    if (normalizedRssAdaptiveColdMaxIntervalSeconds < normalizedRssAdaptiveWarmMinIntervalSeconds) {
      throw new BadRequestException(
        "rssAdaptiveColdMaxIntervalSeconds must be greater than or equal to rssAdaptiveWarmMinIntervalSeconds",
      );
    }
    if (normalizedRssAdaptiveHotDiscoveryCacheTtlCapSeconds === null) {
      throw new BadRequestException(
        `rssAdaptiveHotDiscoveryCacheTtlCapSeconds must be an integer between ${MIN_SEED_CACHE_TTL_SECONDS} and ${MAX_SEED_CACHE_TTL_SECONDS}`,
      );
    }
    if (normalizedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds === null) {
      throw new BadRequestException(
        `rssAdaptiveWarmDiscoveryCacheTtlCapSeconds must be an integer between ${MIN_SEED_CACHE_TTL_SECONDS} and ${MAX_SEED_CACHE_TTL_SECONDS}`,
      );
    }
    if (
      normalizedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds <
      normalizedRssAdaptiveHotDiscoveryCacheTtlCapSeconds
    ) {
      throw new BadRequestException(
        "rssAdaptiveWarmDiscoveryCacheTtlCapSeconds must be greater than or equal to rssAdaptiveHotDiscoveryCacheTtlCapSeconds",
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
            rssAdaptiveHotHitRatePercent:
              normalizedRssAdaptiveHotHitRatePercent,
            rssAdaptiveWarmHitRatePercent:
              normalizedRssAdaptiveWarmHitRatePercent,
            rssAdaptiveColdConsecutiveNoHitRuns:
              normalizedRssAdaptiveColdConsecutiveNoHitRuns,
            rssAdaptiveHotIntervalSeconds:
              normalizedRssAdaptiveHotIntervalSeconds,
            rssAdaptiveWarmIntervalDivisor:
              normalizedRssAdaptiveWarmIntervalDivisor,
            rssAdaptiveWarmMinIntervalSeconds:
              normalizedRssAdaptiveWarmMinIntervalSeconds,
            rssAdaptiveColdIntervalMultiplier:
              normalizedRssAdaptiveColdIntervalMultiplier,
            rssAdaptiveColdMaxIntervalSeconds:
              normalizedRssAdaptiveColdMaxIntervalSeconds,
            rssAdaptiveHotDiscoveryCacheTtlCapSeconds:
              normalizedRssAdaptiveHotDiscoveryCacheTtlCapSeconds,
            rssAdaptiveWarmDiscoveryCacheTtlCapSeconds:
              normalizedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
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
            rssAdaptiveHotHitRatePercent:
              normalizedRssAdaptiveHotHitRatePercent,
            rssAdaptiveWarmHitRatePercent:
              normalizedRssAdaptiveWarmHitRatePercent,
            rssAdaptiveColdConsecutiveNoHitRuns:
              normalizedRssAdaptiveColdConsecutiveNoHitRuns,
            rssAdaptiveHotIntervalSeconds:
              normalizedRssAdaptiveHotIntervalSeconds,
            rssAdaptiveWarmIntervalDivisor:
              normalizedRssAdaptiveWarmIntervalDivisor,
            rssAdaptiveWarmMinIntervalSeconds:
              normalizedRssAdaptiveWarmMinIntervalSeconds,
            rssAdaptiveColdIntervalMultiplier:
              normalizedRssAdaptiveColdIntervalMultiplier,
            rssAdaptiveColdMaxIntervalSeconds:
              normalizedRssAdaptiveColdMaxIntervalSeconds,
            rssAdaptiveHotDiscoveryCacheTtlCapSeconds:
              normalizedRssAdaptiveHotDiscoveryCacheTtlCapSeconds,
            rssAdaptiveWarmDiscoveryCacheTtlCapSeconds:
              normalizedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
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
          rssAdaptiveHotHitRatePercent: normalizedRssAdaptiveHotHitRatePercent,
          rssAdaptiveWarmHitRatePercent:
            normalizedRssAdaptiveWarmHitRatePercent,
          rssAdaptiveColdConsecutiveNoHitRuns:
            normalizedRssAdaptiveColdConsecutiveNoHitRuns,
          rssAdaptiveHotIntervalSeconds:
            normalizedRssAdaptiveHotIntervalSeconds,
          rssAdaptiveWarmIntervalDivisor:
            normalizedRssAdaptiveWarmIntervalDivisor,
          rssAdaptiveWarmMinIntervalSeconds:
            normalizedRssAdaptiveWarmMinIntervalSeconds,
          rssAdaptiveColdIntervalMultiplier:
            normalizedRssAdaptiveColdIntervalMultiplier,
          rssAdaptiveColdMaxIntervalSeconds:
            normalizedRssAdaptiveColdMaxIntervalSeconds,
          rssAdaptiveHotDiscoveryCacheTtlCapSeconds:
            normalizedRssAdaptiveHotDiscoveryCacheTtlCapSeconds,
          rssAdaptiveWarmDiscoveryCacheTtlCapSeconds:
            normalizedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
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
            rssAdaptiveHotHitRatePercent:
              normalizedRssAdaptiveHotHitRatePercent,
            rssAdaptiveWarmHitRatePercent:
              normalizedRssAdaptiveWarmHitRatePercent,
            rssAdaptiveColdConsecutiveNoHitRuns:
              normalizedRssAdaptiveColdConsecutiveNoHitRuns,
            rssAdaptiveHotIntervalSeconds:
              normalizedRssAdaptiveHotIntervalSeconds,
            rssAdaptiveWarmIntervalDivisor:
              normalizedRssAdaptiveWarmIntervalDivisor,
            rssAdaptiveWarmMinIntervalSeconds:
              normalizedRssAdaptiveWarmMinIntervalSeconds,
            rssAdaptiveColdIntervalMultiplier:
              normalizedRssAdaptiveColdIntervalMultiplier,
            rssAdaptiveColdMaxIntervalSeconds:
              normalizedRssAdaptiveColdMaxIntervalSeconds,
            rssAdaptiveHotDiscoveryCacheTtlCapSeconds:
              normalizedRssAdaptiveHotDiscoveryCacheTtlCapSeconds,
            rssAdaptiveWarmDiscoveryCacheTtlCapSeconds:
              normalizedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
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

    const next: NewsSourceSchedulerSettingsPublic = {
      source: "db",
      seedFreshnessWindowDays: normalizedSeedFreshnessWindowDays,
      seedCacheTtlSecondsSitemapRss: normalizedSeedCacheTtlSecondsSitemapRss,
      seedCacheTtlSecondsListDeep: normalizedSeedCacheTtlSecondsListDeep,
      seedCacheTtlForceGlobal: normalizedSeedCacheTtlForceGlobal,
      seedUrlQueryParamAllowlist: normalizedSeedUrlQueryParamAllowlist,
      rssAdaptiveHotHitRatePercent: normalizedRssAdaptiveHotHitRatePercent,
      rssAdaptiveWarmHitRatePercent: normalizedRssAdaptiveWarmHitRatePercent,
      rssAdaptiveColdConsecutiveNoHitRuns:
        normalizedRssAdaptiveColdConsecutiveNoHitRuns,
      rssAdaptiveHotIntervalSeconds: normalizedRssAdaptiveHotIntervalSeconds,
      rssAdaptiveWarmIntervalDivisor:
        normalizedRssAdaptiveWarmIntervalDivisor,
      rssAdaptiveWarmMinIntervalSeconds:
        normalizedRssAdaptiveWarmMinIntervalSeconds,
      rssAdaptiveColdIntervalMultiplier:
        normalizedRssAdaptiveColdIntervalMultiplier,
      rssAdaptiveColdMaxIntervalSeconds:
        normalizedRssAdaptiveColdMaxIntervalSeconds,
      rssAdaptiveHotDiscoveryCacheTtlCapSeconds:
        normalizedRssAdaptiveHotDiscoveryCacheTtlCapSeconds,
      rssAdaptiveWarmDiscoveryCacheTtlCapSeconds:
        normalizedRssAdaptiveWarmDiscoveryCacheTtlCapSeconds,
    };
    this.cachedSettings = {
      value: next,
      expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS,
    };
    return next;
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

  private toStrictOptionalRssAdaptiveHitRatePercent(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.toStrictRssAdaptiveHitRatePercent(value);
  }

  private toStrictRssAdaptiveHitRatePercent(value: unknown): number | null {
    const parsed = this.toNumber(value);
    if (parsed === null || !Number.isInteger(parsed)) {
      return null;
    }
    if (
      parsed < MIN_RSS_ADAPTIVE_HIT_RATE_PERCENT ||
      parsed > MAX_RSS_ADAPTIVE_HIT_RATE_PERCENT
    ) {
      return null;
    }
    return parsed;
  }

  private toStrictOptionalRssAdaptiveColdConsecutiveNoHitRuns(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.toStrictRssAdaptiveColdConsecutiveNoHitRuns(value);
  }

  private toStrictRssAdaptiveColdConsecutiveNoHitRuns(
    value: unknown,
  ): number | null {
    const parsed = this.toNumber(value);
    if (parsed === null || !Number.isInteger(parsed)) {
      return null;
    }
    if (
      parsed < MIN_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS ||
      parsed > MAX_RSS_ADAPTIVE_COLD_CONSECUTIVE_NO_HIT_RUNS
    ) {
      return null;
    }
    return parsed;
  }

  private toStrictOptionalRssAdaptiveIntervalSeconds(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.toStrictRssAdaptiveIntervalSeconds(value);
  }

  private toStrictRssAdaptiveIntervalSeconds(value: unknown): number | null {
    const parsed = this.toNumber(value);
    if (parsed === null || !Number.isInteger(parsed)) {
      return null;
    }
    if (
      parsed < MIN_RSS_ADAPTIVE_INTERVAL_SECONDS ||
      parsed > MAX_RSS_ADAPTIVE_INTERVAL_SECONDS
    ) {
      return null;
    }
    return parsed;
  }

  private toStrictOptionalRssAdaptiveWarmIntervalDivisor(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.toStrictRssAdaptiveWarmIntervalDivisor(value);
  }

  private toStrictRssAdaptiveWarmIntervalDivisor(value: unknown): number | null {
    const parsed = this.toNumber(value);
    if (parsed === null || !Number.isInteger(parsed)) {
      return null;
    }
    if (
      parsed < MIN_RSS_ADAPTIVE_INTERVAL_DIVISOR ||
      parsed > MAX_RSS_ADAPTIVE_INTERVAL_DIVISOR
    ) {
      return null;
    }
    return parsed;
  }

  private toStrictOptionalRssAdaptiveColdIntervalMultiplier(value: unknown) {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.toStrictRssAdaptiveColdIntervalMultiplier(value);
  }

  private toStrictRssAdaptiveColdIntervalMultiplier(
    value: unknown,
  ): number | null {
    const parsed = this.toNumber(value);
    if (parsed === null || !Number.isInteger(parsed)) {
      return null;
    }
    if (
      parsed < MIN_RSS_ADAPTIVE_INTERVAL_MULTIPLIER ||
      parsed > MAX_RSS_ADAPTIVE_INTERVAL_MULTIPLIER
    ) {
      return null;
    }
    return parsed;
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
