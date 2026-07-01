import { createLogger } from '@modular/utils';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';

import { toPrismaJsonValue } from '../../common/prisma-json';
import { writeAuditLogBestEffort } from '../audit/audit-log.writer';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../config/prisma.service';

export type NewsnowPersonalizationSettingsSource = 'default' | 'db';
export type NewsnowPersonalizationStaleTtlStrategy = 'multiplier' | 'fixed';

export interface NewsnowPersonalizationRuntimeMetricsIncrements {
  requestCount?: number;
  cacheHitFreshCount?: number;
  cacheHitStaleCount?: number;
  throttleLimitedCount?: number;
  throttleRejectedCount?: number;
  trimCount?: number;
  trimEvictedCount?: number;
}

export interface NewsnowPersonalizationRuntimeMetricsRow {
  date: string;
  requestCount: number;
  cacheHitFreshCount: number;
  cacheHitStaleCount: number;
  cacheHitTotalCount: number;
  cacheHitRate: number;
  throttleLimitedCount: number;
  throttleRejectedCount: number;
  throttleRate: number;
  trimCount: number;
  trimEvictedCount: number;
}

export interface NewsnowPersonalizationRuntimeMetricsSnapshot {
  from: string;
  to: string;
  windowDays: number;
  totals: Omit<NewsnowPersonalizationRuntimeMetricsRow, 'date'>;
  rows: NewsnowPersonalizationRuntimeMetricsRow[];
}

export interface NewsnowPersonalizationSettingsPublic {
  source: NewsnowPersonalizationSettingsSource;
  cacheTtlMs: number;
  maxCacheEntries: number;
  throttleWindowMs: number;
  maxRequestsPerWindowPerUser: number;
  affinitySourceWeight: number;
  behaviorSourceWeight: number;
  focusSourceBonus: number;
  staleTtlStrategy: NewsnowPersonalizationStaleTtlStrategy;
  staleTtlMultiplier: number;
  staleTtlFixedMs: number;
}

interface StoredNewsnowPersonalizationSettings {
  cacheTtlMs?: unknown;
  maxCacheEntries?: unknown;
  throttleWindowMs?: unknown;
  maxRequestsPerWindowPerUser?: unknown;
  affinitySourceWeight?: unknown;
  behaviorSourceWeight?: unknown;
  focusSourceBonus?: unknown;
  staleTtlStrategy?: unknown;
  staleTtlMultiplier?: unknown;
  staleTtlFixedMs?: unknown;
}

const SETTINGS_KEY = 'newsnow_personalization_settings';
const SETTINGS_DESCRIPTION =
  'NewsNow personalized sorting runtime policy (cache + throttle + ranking weights).';
const CACHE_TTL_MS_MIN = 0;
const CACHE_TTL_MS_MAX = 300_000;
const MAX_CACHE_ENTRIES_MIN = 100;
const MAX_CACHE_ENTRIES_MAX = 20_000;
const THROTTLE_WINDOW_MS_MIN = 1_000;
const THROTTLE_WINDOW_MS_MAX = 600_000;
const MAX_REQUESTS_PER_WINDOW_PER_USER_MIN = 1;
const MAX_REQUESTS_PER_WINDOW_PER_USER_MAX = 500;
const AFFINITY_SOURCE_WEIGHT_MIN = 0;
const AFFINITY_SOURCE_WEIGHT_MAX = 5;
const BEHAVIOR_SOURCE_WEIGHT_MIN = 0;
const BEHAVIOR_SOURCE_WEIGHT_MAX = 5;
const FOCUS_SOURCE_BONUS_MIN = 0;
const FOCUS_SOURCE_BONUS_MAX = 20;
const STALE_TTL_MULTIPLIER_MIN = 1;
const STALE_TTL_MULTIPLIER_MAX = 20;
const STALE_TTL_FIXED_MS_MIN = 1_000;
const STALE_TTL_FIXED_MS_MAX = 3_600_000;
const STALE_TTL_STRATEGY_VALUES: readonly NewsnowPersonalizationStaleTtlStrategy[] = [
  'multiplier',
  'fixed',
];
const RUNTIME_CACHE_TTL_MS = 30_000;
const INVALID_PERSISTED_SETTINGS_CODE = 'NEWSNOW_PERSONALIZATION_SETTINGS_INVALID';
const INVALID_PERSISTED_SETTINGS_ERROR =
  'Stored NewsNow personalization settings are invalid.';
const METRICS_KEY_PREFIX = 'newsnow:personalization:metrics:v1';
const METRICS_DEFAULT_WINDOW_DAYS = 7;
const METRICS_MAX_WINDOW_DAYS = 90;
const METRICS_RETENTION_DAYS = 45;
const METRICS_RETENTION_TTL_SECONDS = METRICS_RETENTION_DAYS * 24 * 60 * 60;

const DEFAULT_SETTINGS: Omit<NewsnowPersonalizationSettingsPublic, 'source'> = {
  cacheTtlMs: 20_000,
  maxCacheEntries: 2_000,
  throttleWindowMs: 10_000,
  maxRequestsPerWindowPerUser: 40,
  affinitySourceWeight: 0.42,
  behaviorSourceWeight: 0.58,
  focusSourceBonus: 0.35,
  staleTtlStrategy: 'multiplier',
  staleTtlMultiplier: 3,
  staleTtlFixedMs: 60_000,
};

@Injectable()
export class NewsnowPersonalizationSettingsService {
  private readonly logger = createLogger({ name: 'newsnow-personalization-settings' });

  private cachedRuntime?: NewsnowPersonalizationSettingsPublic;
  private cachedRuntimeAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
  ) {}

  async getSettings(): Promise<NewsnowPersonalizationSettingsPublic> {
    let record: { value: unknown } | null = null;
    try {
      record = await this.prisma.systemSetting.findUnique({
        where: { key: SETTINGS_KEY },
        select: { value: true },
      });
    } catch (error) {
      this.logger.error(
        { error, settingsKey: SETTINGS_KEY },
        'Failed to load NewsNow personalization settings',
      );
      throw error;
    }

    if (!record) {
      return {
        source: 'default',
        ...DEFAULT_SETTINGS,
      };
    }

    const normalized = this.normalizeStoredSettings(record.value);
    if (!normalized) {
      this.logger.error(
        { settingsKey: SETTINGS_KEY, storedValue: record.value },
        'Invalid persisted NewsNow personalization settings',
      );
      throw new ConflictException({
        code: INVALID_PERSISTED_SETTINGS_CODE,
        message: INVALID_PERSISTED_SETTINGS_ERROR,
        detail:
          'Expected valid values for cacheTtlMs/maxCacheEntries/throttleWindowMs/maxRequestsPerWindowPerUser/affinitySourceWeight/behaviorSourceWeight/focusSourceBonus/staleTtlStrategy/staleTtlMultiplier/staleTtlFixedMs.',
      });
    }

    return {
      source: 'db',
      ...normalized,
    };
  }

  async getRuntimeSettings() {
    const now = Date.now();
    if (this.cachedRuntime && now - this.cachedRuntimeAt <= RUNTIME_CACHE_TTL_MS) {
      return this.cachedRuntime;
    }

    const settings = await this.getSettings();
    this.cachedRuntime = settings;
    this.cachedRuntimeAt = now;
    return settings;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      cacheTtlMs: number;
      maxCacheEntries: number;
      throttleWindowMs: number;
      maxRequestsPerWindowPerUser: number;
      affinitySourceWeight?: number;
      behaviorSourceWeight?: number;
      focusSourceBonus?: number;
      staleTtlStrategy: NewsnowPersonalizationStaleTtlStrategy;
      staleTtlMultiplier: number;
      staleTtlFixedMs: number;
    },
  ): Promise<NewsnowPersonalizationSettingsPublic> {
    const normalized = this.normalizeInputOrThrow(input);

    try {
      await this.prisma.systemSetting.upsert({
        where: { key: SETTINGS_KEY },
        update: {
          value: toPrismaJsonValue(normalized),
          updatedById: actorId,
          description: SETTINGS_DESCRIPTION,
        },
        create: {
          key: SETTINGS_KEY,
          value: toPrismaJsonValue(normalized),
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
          ...normalized,
        },
        'Failed to persist NewsNow personalization settings',
      );
      throw error;
    }

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: 'system_settings',
          action: 'newsnow_personalization_settings_update',
          metadata: toPrismaJsonValue(normalized),
        },
      },
      {
        orgId,
        actorId,
        resource: 'system_settings',
        action: 'newsnow_personalization_settings_update',
      },
    );

    this.cachedRuntime = {
      source: 'db',
      ...normalized,
    };
    this.cachedRuntimeAt = Date.now();

    return {
      source: 'db',
      ...normalized,
    };
  }

  resolveStaleTtlMs(input: {
    cacheTtlMs: number;
    throttleWindowMs: number;
    staleTtlStrategy: NewsnowPersonalizationStaleTtlStrategy;
    staleTtlMultiplier: number;
    staleTtlFixedMs: number;
  }): number {
    const fromStrategy =
      input.staleTtlStrategy === 'fixed'
        ? input.staleTtlFixedMs
        : input.cacheTtlMs * input.staleTtlMultiplier;
    const minByThrottle = input.throttleWindowMs * 2;
    return Math.max(1_000, Math.floor(Math.max(fromStrategy, minByThrottle)));
  }

  recordRuntimeMetricsBestEffort(input: NewsnowPersonalizationRuntimeMetricsIncrements) {
    void this.recordRuntimeMetrics(input).catch((error) => {
      this.logger.warn(
        { error },
        'Failed to record NewsNow personalization runtime metrics',
      );
    });
  }

  async getRuntimeMetricsSnapshot(
    daysInput?: number,
  ): Promise<NewsnowPersonalizationRuntimeMetricsSnapshot> {
    const safeDays = this.normalizeMetricsWindowDays(daysInput);
    const today = this.startOfUtcDay(new Date());
    const start = this.addUtcDays(today, -(safeDays - 1));
    const rows: NewsnowPersonalizationRuntimeMetricsRow[] = [];
    const totals = this.createEmptyMetricsRow('totals');

    for (let index = 0; index < safeDays; index += 1) {
      const day = this.addUtcDays(start, index);
      const key = this.buildMetricsKey(day);
      const date = this.formatUtcDate(day);
      let record: Record<string, string> = {};
      try {
        record = await this.cacheService.hgetall(key);
      } catch (error) {
        this.logger.warn(
          { error, key },
          'Failed to read NewsNow personalization metrics bucket',
        );
      }
      const row = this.metricsRowFromRecord(date, record);
      rows.push(row);
      totals.requestCount += row.requestCount;
      totals.cacheHitFreshCount += row.cacheHitFreshCount;
      totals.cacheHitStaleCount += row.cacheHitStaleCount;
      totals.cacheHitTotalCount += row.cacheHitTotalCount;
      totals.throttleLimitedCount += row.throttleLimitedCount;
      totals.throttleRejectedCount += row.throttleRejectedCount;
      totals.trimCount += row.trimCount;
      totals.trimEvictedCount += row.trimEvictedCount;
    }

    totals.cacheHitRate = this.safeRatio(totals.cacheHitTotalCount, totals.requestCount);
    totals.throttleRate = this.safeRatio(totals.throttleLimitedCount, totals.requestCount);

    return {
      from: this.formatUtcDate(start),
      to: this.formatUtcDate(today),
      windowDays: safeDays,
      totals: {
        requestCount: totals.requestCount,
        cacheHitFreshCount: totals.cacheHitFreshCount,
        cacheHitStaleCount: totals.cacheHitStaleCount,
        cacheHitTotalCount: totals.cacheHitTotalCount,
        cacheHitRate: totals.cacheHitRate,
        throttleLimitedCount: totals.throttleLimitedCount,
        throttleRejectedCount: totals.throttleRejectedCount,
        throttleRate: totals.throttleRate,
        trimCount: totals.trimCount,
        trimEvictedCount: totals.trimEvictedCount,
      },
      rows,
    };
  }

  private normalizeStoredSettings(
    value: unknown,
  ): Omit<NewsnowPersonalizationSettingsPublic, 'source'> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const record = value as StoredNewsnowPersonalizationSettings;

    const cacheTtlMs = this.toStrictInt(record.cacheTtlMs, CACHE_TTL_MS_MIN, CACHE_TTL_MS_MAX);
    const maxCacheEntries = this.toStrictInt(
      record.maxCacheEntries,
      MAX_CACHE_ENTRIES_MIN,
      MAX_CACHE_ENTRIES_MAX,
    );
    const throttleWindowMs = this.toStrictInt(
      record.throttleWindowMs,
      THROTTLE_WINDOW_MS_MIN,
      THROTTLE_WINDOW_MS_MAX,
    );
    const maxRequestsPerWindowPerUser = this.toStrictInt(
      record.maxRequestsPerWindowPerUser,
      MAX_REQUESTS_PER_WINDOW_PER_USER_MIN,
      MAX_REQUESTS_PER_WINDOW_PER_USER_MAX,
    );
    const affinitySourceWeight = this.toStrictFloat(
      record.affinitySourceWeight,
      AFFINITY_SOURCE_WEIGHT_MIN,
      AFFINITY_SOURCE_WEIGHT_MAX,
    );
    if (record.affinitySourceWeight !== undefined && affinitySourceWeight === null) {
      return null;
    }
    const behaviorSourceWeight = this.toStrictFloat(
      record.behaviorSourceWeight,
      BEHAVIOR_SOURCE_WEIGHT_MIN,
      BEHAVIOR_SOURCE_WEIGHT_MAX,
    );
    if (record.behaviorSourceWeight !== undefined && behaviorSourceWeight === null) {
      return null;
    }
    const focusSourceBonus = this.toStrictFloat(
      record.focusSourceBonus,
      FOCUS_SOURCE_BONUS_MIN,
      FOCUS_SOURCE_BONUS_MAX,
    );
    if (record.focusSourceBonus !== undefined && focusSourceBonus === null) {
      return null;
    }
    const staleTtlStrategy = this.toStaleTtlStrategy(record.staleTtlStrategy);
    if (record.staleTtlStrategy !== undefined && staleTtlStrategy === null) {
      return null;
    }
    const staleTtlMultiplier = this.toStrictInt(
      record.staleTtlMultiplier,
      STALE_TTL_MULTIPLIER_MIN,
      STALE_TTL_MULTIPLIER_MAX,
    );
    if (record.staleTtlMultiplier !== undefined && staleTtlMultiplier === null) {
      return null;
    }
    const staleTtlFixedMs = this.toStrictInt(
      record.staleTtlFixedMs,
      STALE_TTL_FIXED_MS_MIN,
      STALE_TTL_FIXED_MS_MAX,
    );
    if (record.staleTtlFixedMs !== undefined && staleTtlFixedMs === null) {
      return null;
    }

    if (
      cacheTtlMs === null ||
      maxCacheEntries === null ||
      throttleWindowMs === null ||
      maxRequestsPerWindowPerUser === null
    ) {
      return null;
    }

    const normalizedAffinitySourceWeight =
      affinitySourceWeight ?? DEFAULT_SETTINGS.affinitySourceWeight;
    const normalizedBehaviorSourceWeight =
      behaviorSourceWeight ?? DEFAULT_SETTINGS.behaviorSourceWeight;
    if (normalizedAffinitySourceWeight + normalizedBehaviorSourceWeight <= 0) {
      return null;
    }

    return {
      cacheTtlMs,
      maxCacheEntries,
      throttleWindowMs,
      maxRequestsPerWindowPerUser,
      affinitySourceWeight: normalizedAffinitySourceWeight,
      behaviorSourceWeight: normalizedBehaviorSourceWeight,
      focusSourceBonus: focusSourceBonus ?? DEFAULT_SETTINGS.focusSourceBonus,
      staleTtlStrategy: staleTtlStrategy ?? DEFAULT_SETTINGS.staleTtlStrategy,
      staleTtlMultiplier: staleTtlMultiplier ?? DEFAULT_SETTINGS.staleTtlMultiplier,
      staleTtlFixedMs: staleTtlFixedMs ?? DEFAULT_SETTINGS.staleTtlFixedMs,
    };
  }

  private normalizeInputOrThrow(input: {
    cacheTtlMs: number;
    maxCacheEntries: number;
    throttleWindowMs: number;
    maxRequestsPerWindowPerUser: number;
    affinitySourceWeight?: number;
    behaviorSourceWeight?: number;
    focusSourceBonus?: number;
    staleTtlStrategy: NewsnowPersonalizationStaleTtlStrategy;
    staleTtlMultiplier: number;
    staleTtlFixedMs: number;
  }): Omit<NewsnowPersonalizationSettingsPublic, 'source'> {
    const cacheTtlMs = this.toStrictInt(input.cacheTtlMs, CACHE_TTL_MS_MIN, CACHE_TTL_MS_MAX);
    if (cacheTtlMs === null) {
      throw new BadRequestException(
        `cacheTtlMs must be an integer between ${CACHE_TTL_MS_MIN} and ${CACHE_TTL_MS_MAX}`,
      );
    }

    const maxCacheEntries = this.toStrictInt(
      input.maxCacheEntries,
      MAX_CACHE_ENTRIES_MIN,
      MAX_CACHE_ENTRIES_MAX,
    );
    if (maxCacheEntries === null) {
      throw new BadRequestException(
        `maxCacheEntries must be an integer between ${MAX_CACHE_ENTRIES_MIN} and ${MAX_CACHE_ENTRIES_MAX}`,
      );
    }

    const throttleWindowMs = this.toStrictInt(
      input.throttleWindowMs,
      THROTTLE_WINDOW_MS_MIN,
      THROTTLE_WINDOW_MS_MAX,
    );
    if (throttleWindowMs === null) {
      throw new BadRequestException(
        `throttleWindowMs must be an integer between ${THROTTLE_WINDOW_MS_MIN} and ${THROTTLE_WINDOW_MS_MAX}`,
      );
    }

    const maxRequestsPerWindowPerUser = this.toStrictInt(
      input.maxRequestsPerWindowPerUser,
      MAX_REQUESTS_PER_WINDOW_PER_USER_MIN,
      MAX_REQUESTS_PER_WINDOW_PER_USER_MAX,
    );
    if (maxRequestsPerWindowPerUser === null) {
      throw new BadRequestException(
        `maxRequestsPerWindowPerUser must be an integer between ${MAX_REQUESTS_PER_WINDOW_PER_USER_MIN} and ${MAX_REQUESTS_PER_WINDOW_PER_USER_MAX}`,
      );
    }

    const affinitySourceWeight = this.toStrictFloat(
      input.affinitySourceWeight ?? DEFAULT_SETTINGS.affinitySourceWeight,
      AFFINITY_SOURCE_WEIGHT_MIN,
      AFFINITY_SOURCE_WEIGHT_MAX,
    );
    if (affinitySourceWeight === null) {
      throw new BadRequestException(
        `affinitySourceWeight must be a number between ${AFFINITY_SOURCE_WEIGHT_MIN} and ${AFFINITY_SOURCE_WEIGHT_MAX}`,
      );
    }

    const behaviorSourceWeight = this.toStrictFloat(
      input.behaviorSourceWeight ?? DEFAULT_SETTINGS.behaviorSourceWeight,
      BEHAVIOR_SOURCE_WEIGHT_MIN,
      BEHAVIOR_SOURCE_WEIGHT_MAX,
    );
    if (behaviorSourceWeight === null) {
      throw new BadRequestException(
        `behaviorSourceWeight must be a number between ${BEHAVIOR_SOURCE_WEIGHT_MIN} and ${BEHAVIOR_SOURCE_WEIGHT_MAX}`,
      );
    }

    if (affinitySourceWeight + behaviorSourceWeight <= 0) {
      throw new BadRequestException(
        'affinitySourceWeight + behaviorSourceWeight must be greater than 0',
      );
    }

    const focusSourceBonus = this.toStrictFloat(
      input.focusSourceBonus ?? DEFAULT_SETTINGS.focusSourceBonus,
      FOCUS_SOURCE_BONUS_MIN,
      FOCUS_SOURCE_BONUS_MAX,
    );
    if (focusSourceBonus === null) {
      throw new BadRequestException(
        `focusSourceBonus must be a number between ${FOCUS_SOURCE_BONUS_MIN} and ${FOCUS_SOURCE_BONUS_MAX}`,
      );
    }
    const staleTtlStrategy = this.toStaleTtlStrategy(input.staleTtlStrategy);
    if (!staleTtlStrategy) {
      throw new BadRequestException(
        `staleTtlStrategy must be one of ${STALE_TTL_STRATEGY_VALUES.join(', ')}`,
      );
    }

    const staleTtlMultiplier = this.toStrictInt(
      input.staleTtlMultiplier,
      STALE_TTL_MULTIPLIER_MIN,
      STALE_TTL_MULTIPLIER_MAX,
    );
    if (staleTtlMultiplier === null) {
      throw new BadRequestException(
        `staleTtlMultiplier must be an integer between ${STALE_TTL_MULTIPLIER_MIN} and ${STALE_TTL_MULTIPLIER_MAX}`,
      );
    }

    const staleTtlFixedMs = this.toStrictInt(
      input.staleTtlFixedMs,
      STALE_TTL_FIXED_MS_MIN,
      STALE_TTL_FIXED_MS_MAX,
    );
    if (staleTtlFixedMs === null) {
      throw new BadRequestException(
        `staleTtlFixedMs must be an integer between ${STALE_TTL_FIXED_MS_MIN} and ${STALE_TTL_FIXED_MS_MAX}`,
      );
    }

    return {
      cacheTtlMs,
      maxCacheEntries,
      throttleWindowMs,
      maxRequestsPerWindowPerUser,
      affinitySourceWeight,
      behaviorSourceWeight,
      focusSourceBonus,
      staleTtlStrategy,
      staleTtlMultiplier,
      staleTtlFixedMs,
    };
  }

  private async recordRuntimeMetrics(input: NewsnowPersonalizationRuntimeMetricsIncrements) {
    const normalized = this.normalizeMetricIncrements(input);
    if (normalized.length === 0) {
      return;
    }
    const key = this.buildMetricsKey(new Date());

    for (const [field, amount] of normalized) {
      await this.cacheService.hincrby(key, field, amount);
    }
    await this.cacheService.expire(key, METRICS_RETENTION_TTL_SECONDS);
  }

  private normalizeMetricIncrements(input: NewsnowPersonalizationRuntimeMetricsIncrements) {
    const entries = Object.entries(input) as [string, unknown][];
    const normalized: [string, number][] = [];
    for (const [field, raw] of entries) {
      const value = this.toPositiveInt(raw);
      if (value <= 0) {
        continue;
      }
      normalized.push([field, value]);
    }
    return normalized;
  }

  private metricsRowFromRecord(date: string, record: Record<string, string>) {
    const base = this.createEmptyMetricsRow(date);
    base.requestCount = this.toPositiveInt(record.requestCount);
    base.cacheHitFreshCount = this.toPositiveInt(record.cacheHitFreshCount);
    base.cacheHitStaleCount = this.toPositiveInt(record.cacheHitStaleCount);
    base.cacheHitTotalCount = base.cacheHitFreshCount + base.cacheHitStaleCount;
    base.throttleLimitedCount = this.toPositiveInt(record.throttleLimitedCount);
    base.throttleRejectedCount = this.toPositiveInt(record.throttleRejectedCount);
    base.trimCount = this.toPositiveInt(record.trimCount);
    base.trimEvictedCount = this.toPositiveInt(record.trimEvictedCount);
    base.cacheHitRate = this.safeRatio(base.cacheHitTotalCount, base.requestCount);
    base.throttleRate = this.safeRatio(base.throttleLimitedCount, base.requestCount);
    return base;
  }

  private createEmptyMetricsRow(date: string): NewsnowPersonalizationRuntimeMetricsRow {
    return {
      date,
      requestCount: 0,
      cacheHitFreshCount: 0,
      cacheHitStaleCount: 0,
      cacheHitTotalCount: 0,
      cacheHitRate: 0,
      throttleLimitedCount: 0,
      throttleRejectedCount: 0,
      throttleRate: 0,
      trimCount: 0,
      trimEvictedCount: 0,
    };
  }

  private normalizeMetricsWindowDays(daysInput?: number): number {
    if (typeof daysInput !== 'number' || !Number.isFinite(daysInput)) {
      return METRICS_DEFAULT_WINDOW_DAYS;
    }
    const normalized = Math.floor(daysInput);
    if (normalized < 1) {
      return 1;
    }
    if (normalized > METRICS_MAX_WINDOW_DAYS) {
      return METRICS_MAX_WINDOW_DAYS;
    }
    return normalized;
  }

  private buildMetricsKey(date: Date): string {
    return `${METRICS_KEY_PREFIX}:${this.formatUtcDate(this.startOfUtcDay(date))}`;
  }

  private startOfUtcDay(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  private addUtcDays(date: Date, deltaDays: number): Date {
    const copy = new Date(date);
    copy.setUTCDate(copy.getUTCDate() + deltaDays);
    return copy;
  }

  private formatUtcDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private safeRatio(numerator: number, denominator: number) {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
      return 0;
    }
    return Number((Math.max(0, numerator) / denominator).toFixed(4));
  }

  private toStrictInt(value: unknown, min: number, max: number): number | null {
    const parsed = this.toNumber(value);
    if (parsed === null || !Number.isInteger(parsed)) {
      return null;
    }
    if (parsed < min || parsed > max) {
      return null;
    }
    return parsed;
  }

  private toStrictFloat(value: unknown, min: number, max: number): number | null {
    const parsed = this.toNumber(value);
    if (parsed === null || !Number.isFinite(parsed)) {
      return null;
    }
    if (parsed < min || parsed > max) {
      return null;
    }
    return Number(parsed.toFixed(4));
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  private toPositiveInt(value: unknown): number {
    const parsed = this.toNumber(value);
    if (parsed === null || !Number.isFinite(parsed)) {
      return 0;
    }
    const rounded = Math.floor(parsed);
    return rounded > 0 ? rounded : 0;
  }

  private toStaleTtlStrategy(value: unknown): NewsnowPersonalizationStaleTtlStrategy | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim() as NewsnowPersonalizationStaleTtlStrategy;
    if (!STALE_TTL_STRATEGY_VALUES.includes(normalized)) {
      return null;
    }
    return normalized;
  }
}
