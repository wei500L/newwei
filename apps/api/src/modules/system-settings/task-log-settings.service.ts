import {
  DEFAULT_TASK_LOG_RETENTION_DAYS,
  MAX_TASK_LOG_RETENTION_DAYS,
  MIN_TASK_LOG_RETENTION_DAYS,
  TASK_LOG_TTL_INDEX_NAME,
  TaskLogModel,
} from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable, type OnModuleInit } from "@nestjs/common";
import { setTimeout as sleep } from "node:timers/promises";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

export type TaskLogSettingsSource = "default" | "db";

export interface TaskLogSettingsPublic {
  source: TaskLogSettingsSource;
  retentionDays: number;
}

interface StoredTaskLogSettings {
  retentionDays?: unknown;
}

interface ManagedCreatedAtIndex {
  name: string;
  expireAfterSeconds: number | null;
}

type TtlReconcileStatus = "unchanged" | "updated";

const SETTINGS_KEY = "task_log_settings";
const SETTINGS_DESCRIPTION = "Task log retention settings.";
const SECONDS_PER_DAY = 24 * 60 * 60;
const INDEX_RECONCILE_MAX_ATTEMPTS = 3;
const INDEX_RECONCILE_BASE_DELAY_MS = 150;
const SETTINGS_CACHE_TTL_MS = 30_000;

@Injectable()
export class TaskLogSettingsService implements OnModuleInit {
  private readonly logger = createLogger({ name: "task-log-settings" });
  private ttlApplySuccessTotal = 0;
  private ttlApplyFailureTotal = 0;
  private ttlReconcileReady = false;
  private lastAppliedRetentionDays: number | null = null;

  private cachedSettings: TaskLogSettingsPublic;
  private cacheExpiresAt = 0;
  private cacheRefreshPromise: Promise<TaskLogSettingsPublic> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {
    this.cachedSettings = this.buildDefaultSettings();
  }

  async onModuleInit(): Promise<void> {
    try {
      const settings = await this.refreshSettingsCache();
      await this.applyRetentionTtlIndex(settings.retentionDays);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          metricName: "task_log_ttl_apply_total",
          metricOutcome: "failure",
          ttlApplyFailureTotal: this.ttlApplyFailureTotal,
        },
        "Failed to apply TaskLog TTL index on startup",
      );
    } finally {
      this.ttlReconcileReady = true;
    }
  }

  async getSettings(): Promise<TaskLogSettingsPublic> {
    if (Date.now() < this.cacheExpiresAt) {
      return this.cloneSettings(this.cachedSettings);
    }
    const refreshed = await this.refreshSettingsCache();
    return this.cloneSettings(refreshed);
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    retentionDaysInput: number,
  ): Promise<TaskLogSettingsPublic> {
    const current = await this.getSettings();
    const retentionDays = this.normalizeRetentionDaysStrict(retentionDaysInput);
    if (retentionDays === null) {
      throw new BadRequestException(
        `retentionDays must be an integer between ${MIN_TASK_LOG_RETENTION_DAYS} and ${MAX_TASK_LOG_RETENTION_DAYS}`,
      );
    }

    if (retentionDays !== current.retentionDays) {
      await this.applyRetentionTtlIndex(retentionDays);
    }

    const value = { retentionDays };
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
          action: "task_log_settings_update",
          metadata: toPrismaJsonValue({ retentionDays }),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "task_log_settings_update",
      },
    );

    const next: TaskLogSettingsPublic = { source: "db", retentionDays };
    this.setCachedSettings(next);
    return this.cloneSettings(next);
  }

  async resetToDefault(
    orgId: string,
    actorId: string,
  ): Promise<TaskLogSettingsPublic> {
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
          action: "task_log_settings_reset",
          metadata: toPrismaJsonValue({
            retentionDays: defaults.retentionDays,
          }),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "task_log_settings_reset",
      },
    );

    this.setCachedSettings(defaults);
    return this.cloneSettings(defaults);
  }

  private buildDefaultSettings(): TaskLogSettingsPublic {
    return {
      source: "default",
      retentionDays: this.normalizeRetentionDays(
        this.env.taskLogRetentionDays ?? DEFAULT_TASK_LOG_RETENTION_DAYS,
      ),
    };
  }

  private cloneSettings(
    settings: TaskLogSettingsPublic,
  ): TaskLogSettingsPublic {
    return {
      source: settings.source,
      retentionDays: settings.retentionDays,
    };
  }

  private setCachedSettings(settings: TaskLogSettingsPublic): void {
    this.cachedSettings = this.cloneSettings(settings);
    this.cacheExpiresAt = Date.now() + SETTINGS_CACHE_TTL_MS;
  }

  private normalizeRetentionDays(value: number): number {
    const integer = Math.trunc(value);
    if (!Number.isFinite(integer) || integer < MIN_TASK_LOG_RETENTION_DAYS) {
      return MIN_TASK_LOG_RETENTION_DAYS;
    }
    if (integer > MAX_TASK_LOG_RETENTION_DAYS) {
      return MAX_TASK_LOG_RETENTION_DAYS;
    }
    return integer;
  }

  private normalizeRetentionDaysStrict(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    const integer = Math.trunc(value);
    if (integer < MIN_TASK_LOG_RETENTION_DAYS || integer > MAX_TASK_LOG_RETENTION_DAYS) {
      return null;
    }
    return integer;
  }

  private async refreshSettingsCache(): Promise<TaskLogSettingsPublic> {
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
            "Failed to refresh TaskLog settings cache",
          );
          return this.cachedSettings;
        })
        .finally(() => {
          this.cacheRefreshPromise = null;
        });
    }

    return this.cacheRefreshPromise;
  }

  private async loadSettingsFromDb(): Promise<TaskLogSettingsPublic> {
    const fallback = this.buildDefaultSettings();
    const stored = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY },
      select: { value: true },
    });
    if (!stored) {
      return fallback;
    }

    const retentionDays = this.parseRetentionDays(stored.value);
    return {
      source: "db",
      retentionDays: retentionDays ?? fallback.retentionDays,
    };
  }

  private parseRetentionDays(value: unknown): number | null {
    if (typeof value === "number") {
      return this.normalizeRetentionDaysStrict(value);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const typed = value as StoredTaskLogSettings;
    return this.normalizeRetentionDaysStrict(typed.retentionDays);
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
              indexName: TASK_LOG_TTL_INDEX_NAME,
              status,
              attempt,
              metricName: "task_log_ttl_apply_total",
              metricOutcome: "success",
              ttlApplySuccessTotal: this.ttlApplySuccessTotal,
            },
            "Applied TaskLog TTL index",
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
              metricName: "task_log_ttl_apply_total",
              metricOutcome: "failure",
              ttlApplyFailureTotal: this.ttlApplyFailureTotal,
            },
            "Failed to apply TaskLog TTL index",
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
          "Retrying TaskLog TTL index reconciliation",
        );
        await sleep(delayMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to apply TaskLog TTL index");
  }

  private async reconcileRetentionTtlAfterRefresh(
    settings: TaskLogSettingsPublic,
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
        { err: error, retentionDays: settings.retentionDays },
        "Failed to reconcile TaskLog TTL index after settings refresh",
      );
    }
  }

  private async reconcileTtlIndexOnce(
    expireAfterSeconds: number,
  ): Promise<TtlReconcileStatus> {
    const collection = TaskLogModel.collection;
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
        `Cannot apply TaskLog TTL index: existing non-TTL createdAt index (${blockingNonTtl}) would conflict`,
      );
    }

    await collection.createIndex(
      { createdAt: 1 },
      {
        name: TASK_LOG_TTL_INDEX_NAME,
        expireAfterSeconds,
      },
    );
    return "updated";
  }

  private async loadIndexesSafe(): Promise<Record<string, unknown>[]> {
    return TaskLogModel.collection.indexes();
  }

  private hasDesiredManagedTtlIndex(
    indexes: Record<string, unknown>[],
    expireAfterSeconds: number,
  ): boolean {
    return this.getManagedCreatedAtIndexes(indexes).some(
      (index) => index.expireAfterSeconds === expireAfterSeconds,
    );
  }

  private findStaleManagedTtlIndexes(
    indexes: Record<string, unknown>[],
    expireAfterSeconds: number,
  ): string[] {
    const managed = this.getManagedCreatedAtIndexes(indexes);
    const stale = managed.filter((index) => {
      if (index.name === TASK_LOG_TTL_INDEX_NAME) {
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
    indexes: Record<string, unknown>[],
  ): string | null {
    const managed = this.getManagedCreatedAtIndexes(indexes);
    const blocking = managed.find(
      (index) =>
        index.expireAfterSeconds === null &&
        index.name !== TASK_LOG_TTL_INDEX_NAME,
    );
    return blocking?.name ?? null;
  }

  private getManagedCreatedAtIndexes(
    indexes: Record<string, unknown>[],
  ): ManagedCreatedAtIndex[] {
    return indexes
      .filter((index) => this.hasCreatedAtSingleKey(index))
      .map((index) => {
        const name =
          typeof index.name === "string" && index.name.trim().length > 0
            ? index.name.trim()
            : "";
        return {
          name,
          expireAfterSeconds: this.normalizeExpireAfterSeconds(
            index.expireAfterSeconds,
          ),
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

  private isRetryableIndexError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    const typed = error as { code?: number; codeName?: string };
    return (
      typed.code === 85 ||
      typed.code === 86 ||
      typed.code === 91 ||
      typed.code === 112 ||
      typed.code === 12586 ||
      typed.codeName === "IndexOptionsConflict" ||
      typed.codeName === "IndexKeySpecsConflict" ||
      typed.codeName === "ShutdownInProgress" ||
      typed.codeName === "WriteConflict" ||
      typed.codeName === "BackgroundOperationInProgressForNamespace"
    );
  }

  private isIndexNotFound(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    const typed = error as { code?: number; codeName?: string };
    return typed.code === 27 || typed.codeName === "IndexNotFound";
  }
}
