import {
  DEFAULT_LLM_REQUEST_LOG_RETENTION_DAYS,
  LLM_REQUEST_LOG_TTL_INDEX_NAME,
  LlmRequestLogModel,
  MAX_LLM_REQUEST_LOG_RETENTION_DAYS,
  MIN_LLM_REQUEST_LOG_RETENTION_DAYS,
} from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable, type OnModuleInit } from "@nestjs/common";
import { setTimeout as sleep } from "node:timers/promises";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PrismaService } from "../config/prisma.service";

export type LlmRequestLogSettingsSource = "default" | "db";

export const DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS = [
  "attempt",
  "batchid",
  "category",
  "channel",
  "correlationid",
  "env",
  "feature",
  "flowid",
  "jobid",
  "language",
  "locale",
  "model",
  "module",
  "nodeid",
  "operation",
  "pipeline",
  "profileid",
  "profile",
  "provider",
  "requestid",
  "retry",
  "frontiernodeid",
  "frontierrunid",
  "crawlsiteprofileid",
  "runid",
  "scenario",
  "sessionid",
  "source",
  "stage",
  "tags",
  "taskid",
  "tenantid",
  "traceid",
  "userid",
  "version",
] as const;

export const REQUIRED_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS = [
  "runid",
  "nodeid",
  "profileid",
  "frontierrunid",
  "frontiernodeid",
  "crawlsiteprofileid",
] as const;

export const DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES = [
  "x_",
  "meta_",
  "ctx_",
] as const;

export interface LlmRequestLogSettingsPublic {
  source: LlmRequestLogSettingsSource;
  retentionDays: number;
  metadataAllowedTopLevelKeys: string[];
  metadataAllowedTopLevelPrefixes: string[];
  briefErrorRateThreshold: number;
  briefInvalidJsonRatioThreshold: number;
  briefConsecutiveDaysThreshold: number;
}

export interface LlmRequestLogMetadataPolicy {
  allowedTopLevelKeys: string[];
  allowedTopLevelPrefixes: string[];
}

export interface LlmRequestLogMetadataPolicySummarySnapshot
  extends LlmRequestLogMetadataPolicy {
  source: LlmRequestLogSettingsSource;
}

interface StoredLlmRequestLogSettings {
  retentionDays?: unknown;
  metadataAllowedTopLevelKeys?: unknown;
  metadataAllowedTopLevelPrefixes?: unknown;
  briefErrorRateThreshold?: unknown;
  briefInvalidJsonRatioThreshold?: unknown;
  briefConsecutiveDaysThreshold?: unknown;
}

interface ManagedCreatedAtIndex {
  name: string;
  expireAfterSeconds: number | null;
}

type TtlReconcileStatus = "unchanged" | "updated";

const SETTINGS_KEY = "llm_request_log_settings";
const SETTINGS_DESCRIPTION =
  "LLM request log retention and metadata whitelist settings.";
const SECONDS_PER_DAY = 24 * 60 * 60;
const INDEX_RECONCILE_MAX_ATTEMPTS = 3;
const INDEX_RECONCILE_BASE_DELAY_MS = 150;
const SETTINGS_CACHE_TTL_MS = 30_000;
const MAX_METADATA_ALLOWED_TOP_LEVEL_KEYS = 100;
const MAX_METADATA_ALLOWED_TOP_LEVEL_PREFIXES = 20;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_PREFIX_LENGTH = 24;
const METADATA_TOKEN_PATTERN = /^[a-z0-9_:\-.]+$/;
const DEFAULT_BRIEF_ERROR_RATE_THRESHOLD = 0.1;
const DEFAULT_BRIEF_INVALID_JSON_RATIO_THRESHOLD = 0.3;
const DEFAULT_BRIEF_CONSECUTIVE_DAYS_THRESHOLD = 3;
const MIN_BRIEF_CONSECUTIVE_DAYS_THRESHOLD = 1;
const MAX_BRIEF_CONSECUTIVE_DAYS_THRESHOLD = 30;

export function mergeRequiredLlmRequestLogMetadataAllowedTopLevelKeys(
  keys: readonly string[],
): string[] {
  return Array.from(
    new Set([
      ...keys,
      ...REQUIRED_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS,
    ]),
  );
}

@Injectable()
export class LlmRequestLogSettingsService implements OnModuleInit {
  private readonly logger = createLogger({ name: "llm-request-log-settings" });
  private ttlApplySuccessTotal = 0;
  private ttlApplyFailureTotal = 0;
  private ttlReconcileReady = false;
  private lastAppliedRetentionDays: number | null = null;

  private cachedSettings: LlmRequestLogSettingsPublic = this.buildDefaultSettings();
  private cacheExpiresAt = 0;
  private cacheRefreshPromise: Promise<LlmRequestLogSettingsPublic> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const settings = await this.refreshSettingsCache();
      await this.applyRetentionTtlIndex(settings.retentionDays);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          metricName: "llm_request_log_ttl_apply_total",
          metricOutcome: "failure",
          ttlApplyFailureTotal: this.ttlApplyFailureTotal,
        },
        "Failed to apply LLM request log TTL index on startup",
      );
    } finally {
      this.ttlReconcileReady = true;
    }
  }

  async getSettings(): Promise<LlmRequestLogSettingsPublic> {
    if (Date.now() < this.cacheExpiresAt) {
      return this.cloneSettings(this.cachedSettings);
    }
    const refreshed = await this.refreshSettingsCache();
    return this.cloneSettings(refreshed);
  }

  getMetadataPolicySnapshot(): LlmRequestLogMetadataPolicy {
    const summary = this.getMetadataPolicySummarySnapshot();
    return {
      allowedTopLevelKeys: summary.allowedTopLevelKeys,
      allowedTopLevelPrefixes: summary.allowedTopLevelPrefixes,
    };
  }

  getMetadataPolicySummarySnapshot(): LlmRequestLogMetadataPolicySummarySnapshot {
    if (Date.now() >= this.cacheExpiresAt) {
      this.scheduleCacheRefresh();
    }
    const source = this.cachedSettings;
    return {
      source: source.source,
      allowedTopLevelKeys: [...source.metadataAllowedTopLevelKeys],
      allowedTopLevelPrefixes: [...source.metadataAllowedTopLevelPrefixes],
    };
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      retentionDays?: number;
      metadataAllowedTopLevelKeys?: string[];
      metadataAllowedTopLevelPrefixes?: string[];
      briefErrorRateThreshold?: number;
      briefInvalidJsonRatioThreshold?: number;
      briefConsecutiveDaysThreshold?: number;
    },
  ): Promise<LlmRequestLogSettingsPublic> {
    const hasAnyInput =
      input.retentionDays !== undefined ||
      input.metadataAllowedTopLevelKeys !== undefined ||
      input.metadataAllowedTopLevelPrefixes !== undefined ||
      input.briefErrorRateThreshold !== undefined ||
      input.briefInvalidJsonRatioThreshold !== undefined ||
      input.briefConsecutiveDaysThreshold !== undefined;

    if (!hasAnyInput) {
      throw new BadRequestException(
        "At least one of retentionDays, metadataAllowedTopLevelKeys, metadataAllowedTopLevelPrefixes, briefErrorRateThreshold, briefInvalidJsonRatioThreshold, briefConsecutiveDaysThreshold is required",
      );
    }

    const current = await this.getSettings();

    const retentionDays =
      input.retentionDays === undefined
        ? current.retentionDays
        : this.normalizeRetentionDaysStrict(input.retentionDays);
    if (retentionDays === null) {
      throw new BadRequestException(
        `retentionDays must be an integer between ${MIN_LLM_REQUEST_LOG_RETENTION_DAYS} and ${MAX_LLM_REQUEST_LOG_RETENTION_DAYS}`,
      );
    }

    const metadataAllowedTopLevelKeys =
      input.metadataAllowedTopLevelKeys === undefined
        ? current.metadataAllowedTopLevelKeys
        : this.normalizeMetadataAllowedTopLevelKeysStrict(
            input.metadataAllowedTopLevelKeys,
          );
    if (metadataAllowedTopLevelKeys === null) {
      throw new BadRequestException(
        `metadataAllowedTopLevelKeys must be an array of up to ${MAX_METADATA_ALLOWED_TOP_LEVEL_KEYS} lowercase tokens ([a-z0-9_:. -], max ${MAX_METADATA_KEY_LENGTH} chars each)`,
      );
    }

    const metadataAllowedTopLevelPrefixes =
      input.metadataAllowedTopLevelPrefixes === undefined
        ? current.metadataAllowedTopLevelPrefixes
        : this.normalizeMetadataAllowedTopLevelPrefixesStrict(
            input.metadataAllowedTopLevelPrefixes,
          );
    if (metadataAllowedTopLevelPrefixes === null) {
      throw new BadRequestException(
        `metadataAllowedTopLevelPrefixes must be an array of up to ${MAX_METADATA_ALLOWED_TOP_LEVEL_PREFIXES} lowercase prefixes ([a-z0-9_:. -], max ${MAX_METADATA_PREFIX_LENGTH} chars each)`,
      );
    }

    const briefErrorRateThreshold =
      input.briefErrorRateThreshold === undefined
        ? current.briefErrorRateThreshold
        : this.normalizeThresholdRateStrict(input.briefErrorRateThreshold);
    if (briefErrorRateThreshold === null) {
      throw new BadRequestException(
        "briefErrorRateThreshold must be a number between 0 and 1",
      );
    }

    const briefInvalidJsonRatioThreshold =
      input.briefInvalidJsonRatioThreshold === undefined
        ? current.briefInvalidJsonRatioThreshold
        : this.normalizeThresholdRateStrict(input.briefInvalidJsonRatioThreshold);
    if (briefInvalidJsonRatioThreshold === null) {
      throw new BadRequestException(
        "briefInvalidJsonRatioThreshold must be a number between 0 and 1",
      );
    }

    const briefConsecutiveDaysThreshold =
      input.briefConsecutiveDaysThreshold === undefined
        ? current.briefConsecutiveDaysThreshold
        : this.normalizeBriefConsecutiveDaysThresholdStrict(
            input.briefConsecutiveDaysThreshold,
          );
    if (briefConsecutiveDaysThreshold === null) {
      throw new BadRequestException(
        `briefConsecutiveDaysThreshold must be an integer between ${MIN_BRIEF_CONSECUTIVE_DAYS_THRESHOLD} and ${MAX_BRIEF_CONSECUTIVE_DAYS_THRESHOLD}`,
      );
    }

    const shouldApplyRetentionTtl =
      input.retentionDays !== undefined && retentionDays !== current.retentionDays;
    if (shouldApplyRetentionTtl) {
      await this.applyRetentionTtlIndex(retentionDays);
    }

    const value = {
      retentionDays,
      metadataAllowedTopLevelKeys,
      metadataAllowedTopLevelPrefixes,
      briefErrorRateThreshold,
      briefInvalidJsonRatioThreshold,
      briefConsecutiveDaysThreshold,
    };

    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      update: {
        value: toPrismaJsonValue(value),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false,
      },
      create: {
        key: SETTINGS_KEY,
        value: toPrismaJsonValue(value),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false,
      },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "llm_request_log_settings_update",
          metadata: toPrismaJsonValue({
            retentionDays,
            metadataAllowedTopLevelKeys,
            metadataAllowedTopLevelPrefixes,
            metadataTopLevelKeysCount: metadataAllowedTopLevelKeys.length,
            metadataPrefixCount: metadataAllowedTopLevelPrefixes.length,
            briefErrorRateThreshold,
            briefInvalidJsonRatioThreshold,
            briefConsecutiveDaysThreshold,
          }),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "llm_request_log_settings_update",
      },
    );

    const next: LlmRequestLogSettingsPublic = {
      source: "db",
      retentionDays,
      metadataAllowedTopLevelKeys,
      metadataAllowedTopLevelPrefixes,
      briefErrorRateThreshold,
      briefInvalidJsonRatioThreshold,
      briefConsecutiveDaysThreshold,
    };

    this.setCachedSettings(next);
    return this.cloneSettings(next);
  }

  async resetToDefault(
    orgId: string,
    actorId: string,
  ): Promise<LlmRequestLogSettingsPublic> {
    const defaults = this.buildDefaultSettings();
    await this.applyRetentionTtlIndex(defaults.retentionDays);

    await this.prisma.systemSetting.deleteMany({
      where: { key: SETTINGS_KEY },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "llm_request_log_settings_reset",
          metadata: toPrismaJsonValue({
            retentionDays: defaults.retentionDays,
            metadataAllowedTopLevelKeys: defaults.metadataAllowedTopLevelKeys,
            metadataAllowedTopLevelPrefixes:
              defaults.metadataAllowedTopLevelPrefixes,
            briefErrorRateThreshold: defaults.briefErrorRateThreshold,
            briefInvalidJsonRatioThreshold:
              defaults.briefInvalidJsonRatioThreshold,
            briefConsecutiveDaysThreshold:
              defaults.briefConsecutiveDaysThreshold,
          }),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "llm_request_log_settings_reset",
      },
    );

    this.setCachedSettings(defaults);
    return this.cloneSettings(defaults);
  }

  async resetMetadataPolicy(
    orgId: string,
    actorId: string,
  ): Promise<LlmRequestLogSettingsPublic> {
    return this.updateSettings(orgId, actorId, {
      metadataAllowedTopLevelKeys: [
        ...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS,
      ],
      metadataAllowedTopLevelPrefixes: [
        ...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
      ],
    });
  }

  private async applyRetentionTtlIndex(retentionDays: number): Promise<void> {
    const expireAfterSeconds = retentionDays * SECONDS_PER_DAY;
    let lastError: unknown;

    for (let attempt = 1; attempt <= INDEX_RECONCILE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const status = await this.reconcileTtlIndexOnce(expireAfterSeconds);
        this.ttlApplySuccessTotal += 1;

        if (status === "updated" || attempt > 1) {
          this.logger.info(
            {
              retentionDays,
              expireAfterSeconds,
              indexName: LLM_REQUEST_LOG_TTL_INDEX_NAME,
              status,
              attempt,
              metricName: "llm_request_log_ttl_apply_total",
              metricOutcome: "success",
              ttlApplySuccessTotal: this.ttlApplySuccessTotal,
            },
            "Applied LLM request log TTL index",
          );
        }
        this.lastAppliedRetentionDays = retentionDays;
        return;
      } catch (error) {
        lastError = error;
        const retryable = this.isRetryableIndexError(error);
        if (!retryable || attempt >= INDEX_RECONCILE_MAX_ATTEMPTS) {
          this.ttlApplyFailureTotal += 1;
          this.logger.error(
            {
              err: error,
              retentionDays,
              expireAfterSeconds,
              attempt,
              metricName: "llm_request_log_ttl_apply_total",
              metricOutcome: "failure",
              ttlApplyFailureTotal: this.ttlApplyFailureTotal,
            },
            "Failed to apply LLM request log TTL index",
          );
          throw error;
        }

        const delayMs = INDEX_RECONCILE_BASE_DELAY_MS * attempt;
        this.logger.warn(
          {
            err: error,
            retentionDays,
            expireAfterSeconds,
            attempt,
            delayMs,
          },
          "Retrying LLM request log TTL index reconciliation",
        );
        await sleep(delayMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to apply LLM request log TTL index");
  }

  private async reconcileRetentionTtlAfterRefresh(
    settings: LlmRequestLogSettingsPublic,
  ): Promise<void> {
    if (!this.ttlReconcileReady) {
      return;
    }
    if (this.lastAppliedRetentionDays === settings.retentionDays) {
      return;
    }
    try {
      await this.applyRetentionTtlIndex(settings.retentionDays);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          retentionDays: settings.retentionDays,
        },
        "Failed to reconcile LLM request log TTL index after settings refresh",
      );
    }
  }

  private async reconcileTtlIndexOnce(
    expireAfterSeconds: number,
  ): Promise<TtlReconcileStatus> {
    const collection = LlmRequestLogModel.collection;
    const initialIndexes = await this.loadIndexesSafe();

    if (this.hasDesiredManagedTtlIndex(initialIndexes, expireAfterSeconds)) {
      return "unchanged";
    }

    const staleManagedTtlIndexes = this.findStaleManagedTtlIndexes(
      initialIndexes,
      expireAfterSeconds,
    );

    for (const indexName of staleManagedTtlIndexes) {
      try {
        await collection.dropIndex(indexName);
      } catch (error) {
        if (!this.isIndexNotFound(error) && !this.isRetryableIndexError(error)) {
          throw error;
        }
      }
    }

    const indexesAfterDrop =
      staleManagedTtlIndexes.length > 0
        ? await this.loadIndexesSafe()
        : initialIndexes;

    if (this.hasDesiredManagedTtlIndex(indexesAfterDrop, expireAfterSeconds)) {
      return "updated";
    }

    const blockingNonTtl = this.findBlockingNonTtlCreatedAtIndex(indexesAfterDrop);
    if (blockingNonTtl) {
      throw new Error(
        `Cannot apply LLM request log TTL index: existing non-TTL createdAt index (${blockingNonTtl}) would conflict`,
      );
    }

    await collection.createIndex(
      { createdAt: 1 },
      {
        name: LLM_REQUEST_LOG_TTL_INDEX_NAME,
        expireAfterSeconds,
      },
    );

    return "updated";
  }

  private hasDesiredManagedTtlIndex(
    indexes: Array<Record<string, unknown>>,
    expireAfterSeconds: number,
  ): boolean {
    return this.getManagedCreatedAtIndexes(indexes).some(
      (index) => index.expireAfterSeconds === expireAfterSeconds,
    );
  }

  private findStaleManagedTtlIndexes(
    indexes: Array<Record<string, unknown>>,
    expireAfterSeconds: number,
  ): string[] {
    const managed = this.getManagedCreatedAtIndexes(indexes);
    const stale = managed.filter((index) => {
      if (index.name === LLM_REQUEST_LOG_TTL_INDEX_NAME) {
        return index.expireAfterSeconds !== expireAfterSeconds;
      }
      if (index.expireAfterSeconds === null) {
        return false;
      }
      return index.expireAfterSeconds !== expireAfterSeconds;
    });

    return Array.from(new Set(stale.map((index) => index.name)));
  }

  private findBlockingNonTtlCreatedAtIndex(
    indexes: Array<Record<string, unknown>>,
  ): string | null {
    const managed = this.getManagedCreatedAtIndexes(indexes);
    const blocking = managed.find(
      (index) =>
        index.expireAfterSeconds === null &&
        index.name !== LLM_REQUEST_LOG_TTL_INDEX_NAME,
    );
    return blocking?.name ?? null;
  }

  private getManagedCreatedAtIndexes(
    indexes: Array<Record<string, unknown>>,
  ): ManagedCreatedAtIndex[] {
    return indexes
      .filter((index) => this.hasCreatedAtSingleKey(index))
      .map((index) => {
        const name =
          typeof index.name === "string" && index.name.trim().length > 0
            ? index.name.trim()
            : "";
        const expireAfterSeconds = this.normalizeExpireAfterSeconds(
          index.expireAfterSeconds,
        );
        return {
          name,
          expireAfterSeconds,
        };
      })
      .filter((index) => index.name.length > 0);
  }

  private hasCreatedAtSingleKey(index: Record<string, unknown>): boolean {
    const key = index.key;
    if (!key || typeof key !== "object") {
      return false;
    }
    const typedKey = key as Record<string, unknown>;
    const keyNames = Object.keys(typedKey);
    return keyNames.length === 1 && typedKey.createdAt === 1;
  }

  private normalizeExpireAfterSeconds(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.trunc(parsed);
      }
    }
    return null;
  }

  private async refreshSettingsCache(): Promise<LlmRequestLogSettingsPublic> {
    if (!this.cacheRefreshPromise) {
      this.cacheRefreshPromise = this.loadSettingsFromDb()
        .then(async (settings) => {
          this.setCachedSettings(settings);
          await this.reconcileRetentionTtlAfterRefresh(settings);
          return settings;
        })
        .catch((error) => {
          this.logger.warn(
            { err: error },
            "Failed to refresh LLM request log settings cache",
          );
          return this.cachedSettings;
        })
        .finally(() => {
          this.cacheRefreshPromise = null;
        });
    }

    const settings = await this.cacheRefreshPromise;
    return this.cloneSettings(settings);
  }

  private scheduleCacheRefresh(): void {
    if (!this.cacheRefreshPromise) {
      void this.refreshSettingsCache();
    }
  }

  private async loadSettingsFromDb(): Promise<LlmRequestLogSettingsPublic> {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY },
      select: { value: true },
    });
    if (!record) {
      return this.buildDefaultSettings();
    }

    const value = record.value as unknown;
    const retentionDays = this.parseRetentionDays(value);

    const rawObject = value && typeof value === "object" ? (value as StoredLlmRequestLogSettings) : null;

    const metadataAllowedTopLevelKeys =
      this.normalizeMetadataAllowedTopLevelKeysLenient(
        rawObject?.metadataAllowedTopLevelKeys,
      );

    const metadataAllowedTopLevelPrefixes =
      this.normalizeMetadataAllowedTopLevelPrefixesLenient(
        rawObject?.metadataAllowedTopLevelPrefixes,
      );

    const briefErrorRateThreshold = this.normalizeThresholdRateLenient(
      rawObject?.briefErrorRateThreshold,
      DEFAULT_BRIEF_ERROR_RATE_THRESHOLD,
    );
    const briefInvalidJsonRatioThreshold = this.normalizeThresholdRateLenient(
      rawObject?.briefInvalidJsonRatioThreshold,
      DEFAULT_BRIEF_INVALID_JSON_RATIO_THRESHOLD,
    );
    const briefConsecutiveDaysThreshold =
      this.normalizeBriefConsecutiveDaysThresholdLenient(
        rawObject?.briefConsecutiveDaysThreshold,
      );

    return {
      source: "db",
      retentionDays: retentionDays ?? DEFAULT_LLM_REQUEST_LOG_RETENTION_DAYS,
      metadataAllowedTopLevelKeys,
      metadataAllowedTopLevelPrefixes,
      briefErrorRateThreshold,
      briefInvalidJsonRatioThreshold,
      briefConsecutiveDaysThreshold,
    };
  }

  private parseRetentionDays(value: unknown): number | null {
    if (typeof value === "number") {
      return this.normalizeRetentionDaysStrict(value);
    }
    if (value && typeof value === "object") {
      const stored = value as StoredLlmRequestLogSettings;
      return this.normalizeRetentionDaysStrict(stored.retentionDays);
    }
    return null;
  }

  private normalizeRetentionDaysStrict(value: unknown): number | null {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    if (!Number.isInteger(numeric)) {
      return null;
    }
    if (
      numeric < MIN_LLM_REQUEST_LOG_RETENTION_DAYS ||
      numeric > MAX_LLM_REQUEST_LOG_RETENTION_DAYS
    ) {
      return null;
    }
    return numeric;
  }

  private normalizeThresholdRateStrict(value: unknown): number | null {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    if (numeric < 0 || numeric > 1) {
      return null;
    }
    return Number(numeric.toFixed(4));
  }

  private normalizeThresholdRateLenient(
    value: unknown,
    fallback: number,
  ): number {
    const normalized = this.normalizeThresholdRateStrict(value);
    return normalized === null ? fallback : normalized;
  }

  private normalizeBriefConsecutiveDaysThresholdStrict(
    value: unknown,
  ): number | null {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    if (!Number.isInteger(numeric)) {
      return null;
    }
    if (
      numeric < MIN_BRIEF_CONSECUTIVE_DAYS_THRESHOLD ||
      numeric > MAX_BRIEF_CONSECUTIVE_DAYS_THRESHOLD
    ) {
      return null;
    }
    return numeric;
  }

  private normalizeBriefConsecutiveDaysThresholdLenient(value: unknown): number {
    const normalized = this.normalizeBriefConsecutiveDaysThresholdStrict(value);
    return normalized === null
      ? DEFAULT_BRIEF_CONSECUTIVE_DAYS_THRESHOLD
      : normalized;
  }

  private normalizeMetadataAllowedTopLevelKeysStrict(
    value: unknown,
  ): string[] | null {
    const normalized = this.normalizeMetadataTokenList(
      value,
      MAX_METADATA_ALLOWED_TOP_LEVEL_KEYS,
      MAX_METADATA_KEY_LENGTH,
      true,
    );
    if (normalized === null) {
      return null;
    }
    return mergeRequiredLlmRequestLogMetadataAllowedTopLevelKeys(normalized);
  }

  private normalizeMetadataAllowedTopLevelPrefixesStrict(
    value: unknown,
  ): string[] | null {
    return this.normalizeMetadataTokenList(
      value,
      MAX_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
      MAX_METADATA_PREFIX_LENGTH,
      true,
    );
  }

  private normalizeMetadataAllowedTopLevelKeysLenient(value: unknown): string[] {
    const normalized = this.normalizeMetadataTokenList(
      value,
      MAX_METADATA_ALLOWED_TOP_LEVEL_KEYS,
      MAX_METADATA_KEY_LENGTH,
      false,
    );
    if (normalized === null) {
      return mergeRequiredLlmRequestLogMetadataAllowedTopLevelKeys(
        DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS,
      );
    }
    return mergeRequiredLlmRequestLogMetadataAllowedTopLevelKeys(normalized);
  }

  private normalizeMetadataAllowedTopLevelPrefixesLenient(value: unknown): string[] {
    const normalized = this.normalizeMetadataTokenList(
      value,
      MAX_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
      MAX_METADATA_PREFIX_LENGTH,
      false,
    );
    if (normalized === null) {
      return [...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES];
    }
    return normalized;
  }

  private normalizeMetadataTokenList(
    value: unknown,
    maxItems: number,
    maxTokenLength: number,
    strict: boolean,
  ): string[] | null {
    if (!Array.isArray(value)) {
      return strict ? null : null;
    }

    if (value.length > maxItems) {
      return strict ? null : value.slice(0, maxItems)
        .map((entry) => this.normalizeMetadataToken(entry, maxTokenLength))
        .filter((entry): entry is string => Boolean(entry));
    }

    const normalized = value
      .map((entry) => this.normalizeMetadataToken(entry, maxTokenLength))
      .filter((entry): entry is string => Boolean(entry));

    if (strict && normalized.length !== value.length) {
      return null;
    }

    return Array.from(new Set(normalized));
  }

  private normalizeMetadataToken(
    value: unknown,
    maxTokenLength: number,
  ): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || trimmed.length > maxTokenLength) {
      return null;
    }
    if (!METADATA_TOKEN_PATTERN.test(trimmed)) {
      return null;
    }
    return trimmed;
  }

  private setCachedSettings(settings: LlmRequestLogSettingsPublic): void {
    this.cachedSettings = this.cloneSettings(settings);
    this.cacheExpiresAt = Date.now() + SETTINGS_CACHE_TTL_MS;
  }

  private cloneSettings(
    settings: LlmRequestLogSettingsPublic,
  ): LlmRequestLogSettingsPublic {
    return {
      source: settings.source,
      retentionDays: settings.retentionDays,
      metadataAllowedTopLevelKeys:
        mergeRequiredLlmRequestLogMetadataAllowedTopLevelKeys(
          settings.metadataAllowedTopLevelKeys,
        ),
      metadataAllowedTopLevelPrefixes: [
        ...settings.metadataAllowedTopLevelPrefixes,
      ],
      briefErrorRateThreshold: settings.briefErrorRateThreshold,
      briefInvalidJsonRatioThreshold: settings.briefInvalidJsonRatioThreshold,
      briefConsecutiveDaysThreshold: settings.briefConsecutiveDaysThreshold,
    };
  }

  private buildDefaultSettings(): LlmRequestLogSettingsPublic {
    return {
      source: "default",
      retentionDays: DEFAULT_LLM_REQUEST_LOG_RETENTION_DAYS,
      metadataAllowedTopLevelKeys:
        mergeRequiredLlmRequestLogMetadataAllowedTopLevelKeys(
          DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_KEYS,
        ),
      metadataAllowedTopLevelPrefixes: [
        ...DEFAULT_LLM_REQUEST_LOG_METADATA_ALLOWED_TOP_LEVEL_PREFIXES,
      ],
      briefErrorRateThreshold: DEFAULT_BRIEF_ERROR_RATE_THRESHOLD,
      briefInvalidJsonRatioThreshold:
        DEFAULT_BRIEF_INVALID_JSON_RATIO_THRESHOLD,
      briefConsecutiveDaysThreshold: DEFAULT_BRIEF_CONSECUTIVE_DAYS_THRESHOLD,
    };
  }

  private async loadIndexesSafe(): Promise<Array<Record<string, unknown>>> {
    const collection = LlmRequestLogModel.collection;
    try {
      const indexes = await collection.indexes();
      return indexes as Array<Record<string, unknown>>;
    } catch (error) {
      if (this.isNamespaceNotFound(error)) {
        return [];
      }
      throw error;
    }
  }

  private isNamespaceNotFound(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    const code = (error as { code?: unknown }).code;
    const codeName = (error as { codeName?: unknown }).codeName;
    return code === 26 || codeName === "NamespaceNotFound";
  }

  private isIndexNotFound(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    const code = (error as { code?: unknown }).code;
    const codeName = (error as { codeName?: unknown }).codeName;
    return code === 27 || codeName === "IndexNotFound";
  }

  private isRetryableIndexError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const code = (error as { code?: unknown }).code;
    const codeName = (error as { codeName?: unknown }).codeName;
    const message =
      typeof (error as { message?: unknown }).message === "string"
        ? ((error as { message?: string }).message ?? "")
        : "";

    if (
      code === 85 ||
      code === 86 ||
      code === 11000 ||
      code === 12586 ||
      code === 12587 ||
      code === 285
    ) {
      return true;
    }

    if (
      codeName === "IndexOptionsConflict" ||
      codeName === "IndexKeySpecsConflict" ||
      codeName === "IndexBuildAlreadyInProgress" ||
      codeName === "BackgroundOperationInProgressForNamespace" ||
      codeName === "BackgroundOperationInProgressForDatabase"
    ) {
      return true;
    }

    const lowerMessage = message.toLowerCase();
    return (
      lowerMessage.includes("index build") ||
      lowerMessage.includes("already exists") ||
      lowerMessage.includes("conflict") ||
      lowerMessage.includes("in progress")
    );
  }
}
