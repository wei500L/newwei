import { createLogger } from "@modular/utils";
import {
  Prisma,
  SituationMonitorExternalSnapshotScope,
  SituationMonitorExternalSnapshotStatus,
} from "@prisma/client";
import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import {
  SITUATION_MONITOR_CATEGORIES,
  type SituationMonitorCategory,
} from "./situation-monitor.constants";
import type { SituationMonitorHeadline } from "./situation-monitor.types";

import {
  type SituationMonitorExternalWarning,
  SituationMonitorExternalService,
} from "./external/situation-monitor-external.service";

const logger = createLogger({ name: "situation-monitor-external-snapshot" });

const SNAPSHOT_SCOPE = SituationMonitorExternalSnapshotScope.gdelt_global;
const SNAPSHOT_VARIANT_KEY = "default";
const SNAPSHOT_SOURCE = "scheduler";
const SNAPSHOT_REFRESH_INTERVAL_MINUTES = 15;
const SNAPSHOT_HISTORY_RETENTION_DAYS = 7;
const SNAPSHOT_CATEGORY_LIMIT = 20;
const SNAPSHOT_FETCH_DELAY_MS = 5_500;
const SNAPSHOT_GDELT_TIMEOUT_MS = 20_000;
const SNAPSHOT_FRESH_TTL_SECONDS = 20 * 60;
const SNAPSHOT_STALE_TTL_SECONDS = 24 * 60 * 60;
const SNAPSHOT_LOCK_TTL_MS = 10 * 60_000;
const SNAPSHOT_FRESH_CACHE_KEY =
  "situation-monitor:external-snapshot:gdelt:fresh:v1";
const SNAPSHOT_STALE_CACHE_KEY =
  "situation-monitor:external-snapshot:gdelt:stale:v1";
const SNAPSHOT_REFRESH_LOCK_KEY =
  "cron:situation-monitor:external-snapshot:gdelt";
const SNAPSHOT_PLACEHOLDER_TITLE_PATTERN =
  /^(?:no\s*title|untitled|title\s*unavailable|headline\s*unavailable|n\/a|na|null|undefined|\u6682\u65e0\u6807\u9898|\u65e0\u6807\u9898|\u672a\u547d\u540d(?:\u6807\u9898)?)$/i;

export interface SituationMonitorExternalSnapshotDiagnostics {
  requestedCategories: number;
  fetchedCategories: SituationMonitorCategory[];
  reusedCategories: SituationMonitorCategory[];
  failedCategories: SituationMonitorCategory[];
  totalHeadlines: number;
}

export interface SituationMonitorExternalSnapshotPayload {
  source: typeof SNAPSHOT_SOURCE;
  scope: SituationMonitorExternalSnapshotScope;
  variantKey: typeof SNAPSHOT_VARIANT_KEY;
  status: SituationMonitorExternalSnapshotStatus;
  generatedAt: string;
  expiresAt: string;
  partial: boolean;
  warnings: SituationMonitorExternalWarning[];
  diagnostics: SituationMonitorExternalSnapshotDiagnostics;
  headlinesByCategory: Record<SituationMonitorCategory, SituationMonitorHeadline[]>;
}

export interface SituationMonitorExternalSnapshotReadResult {
  payload: SituationMonitorExternalSnapshotPayload | null;
  stale: boolean;
}

export interface SituationMonitorExternalSnapshotStatusSummary {
  enabled: boolean;
  intervalMinutes: number;
  historyRetentionDays: number;
  status:
    | SituationMonitorExternalSnapshotStatus
    | "idle"
    | "disabled";
  stale: boolean;
  partial: boolean;
  generatedAt: string | null;
  expiresAt: string | null;
  lastFullSuccessAt: string | null;
  lastNonSuccessAt: string | null;
  nextScheduledAt: string | null;
  warningCount: number;
  availableCategoryCount: number;
  rolling24hSuccessRate: number | null;
  rolling24hRateLimitedCount: number;
  rolling24hAverageAvailableCategoryCount: number | null;
  warnings: SituationMonitorExternalWarning[];
}

interface SituationMonitorExternalSnapshotStatusMetrics {
  lastFullSuccessAt: string | null;
  lastNonSuccessAt: string | null;
  nextScheduledAt: string | null;
  rolling24hSuccessRate: number | null;
  rolling24hRateLimitedCount: number;
  rolling24hAverageAvailableCategoryCount: number | null;
}

@Injectable()
export class SituationMonitorExternalSnapshotService {
  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
    private readonly external: SituationMonitorExternalService,
  ) {}

  @Cron("0 */15 * * * *")
  async refreshScheduled() {
    if (!this.external.isGdeltEnabled()) {
      return;
    }

    const locked = await this.cache.withLock(
      SNAPSHOT_REFRESH_LOCK_KEY,
      SNAPSHOT_LOCK_TTL_MS,
      async () => await this.rebuildSnapshot({ bypassCategoryCache: false }),
    );

    if (locked === null) {
      logger.info("Skipped GDELT snapshot refresh because a previous run is still in progress");
    }
  }

  async forceRefresh(): Promise<SituationMonitorExternalSnapshotStatusSummary> {
    if (!this.external.isGdeltEnabled()) {
      return await this.buildStatusSummary(null, false, false);
    }

    const locked = await this.cache.withLock(
      SNAPSHOT_REFRESH_LOCK_KEY,
      SNAPSHOT_LOCK_TTL_MS,
      async () => await this.rebuildSnapshot({ bypassCategoryCache: true }),
    );

    if (locked) {
      return await this.buildStatusSummary(locked, false, true);
    }

    const current = await this.getLatestSnapshot({ includeDatabase: true });
    return await this.buildStatusSummary(current.payload, current.stale, true);
  }

  async getLatestSnapshot(
    options?: { includeDatabase?: boolean },
  ): Promise<SituationMonitorExternalSnapshotReadResult> {
    return await this.readSnapshot({
      includeDatabase: options?.includeDatabase ?? true,
    });
  }

  async getStatusSummary(): Promise<SituationMonitorExternalSnapshotStatusSummary> {
    if (!this.external.isGdeltEnabled()) {
      const current = await this.readSnapshot({ includeDatabase: true });
      return await this.buildStatusSummary(current.payload, current.stale, false);
    }

    const current = await this.readSnapshot({ includeDatabase: true });
    return await this.buildStatusSummary(current.payload, current.stale, true);
  }

  private async rebuildSnapshot(input: {
    bypassCategoryCache: boolean;
  }): Promise<SituationMonitorExternalSnapshotPayload> {
    const previous = await this.readSnapshot({ includeDatabase: true });
    const headlinesByCategory = this.createEmptyHeadlinesByCategory();
    const warningGroups = new Map<
      string,
      {
        warning: SituationMonitorExternalWarning;
        categories: Set<SituationMonitorCategory>;
        details: Set<string>;
      }
    >();
    const fetchedCategories: SituationMonitorCategory[] = [];
    const reusedCategories: SituationMonitorCategory[] = [];
    const failedCategories: SituationMonitorCategory[] = [];

    for (const [index, category] of SITUATION_MONITOR_CATEGORIES.entries()) {
      const result = await this.external.fetchGdeltCategoryHeadlines(
        category,
        SNAPSHOT_CATEGORY_LIMIT,
        {
          bypassCache: input.bypassCategoryCache,
          timeoutMs: SNAPSHOT_GDELT_TIMEOUT_MS,
        },
      );

      if (result.warning) {
        this.collectWarning(warningGroups, category, result.warning);
      }

      const nextHeadlines = this.normalizeSnapshotHeadlines(
        result.headlines,
        category,
      );
      if (nextHeadlines.length > 0) {
        headlinesByCategory[category] = nextHeadlines;
        fetchedCategories.push(category);
      } else {
        const previousHeadlines =
          previous.payload?.headlinesByCategory[category] ?? [];
        if (previousHeadlines.length > 0) {
          headlinesByCategory[category] =
            this.cloneSnapshotHeadlines(previousHeadlines);
          reusedCategories.push(category);
        } else {
          failedCategories.push(category);
        }
      }

      if (index < SITUATION_MONITOR_CATEGORIES.length - 1) {
        await this.delay(SNAPSHOT_FETCH_DELAY_MS);
      }
    }

    const warnings = Array.from(warningGroups.values()).map(
      ({ warning, categories, details }) => ({
        ...warning,
        detail: this.formatWarningDetail(categories, details),
      }),
    );
    const totalHeadlines = SITUATION_MONITOR_CATEGORIES.reduce(
      (sum, category) => sum + headlinesByCategory[category].length,
      0,
    );

    const status =
      totalHeadlines === 0 &&
      fetchedCategories.length === 0 &&
      reusedCategories.length === 0
        ? SituationMonitorExternalSnapshotStatus.failed
        : warnings.length > 0 ||
            reusedCategories.length > 0 ||
            failedCategories.length > 0
          ? SituationMonitorExternalSnapshotStatus.partial
          : SituationMonitorExternalSnapshotStatus.completed;

    const generatedAt = new Date();
    const expiresAt = new Date(
      generatedAt.getTime() + SNAPSHOT_FRESH_TTL_SECONDS * 1000,
    );
    const diagnostics: SituationMonitorExternalSnapshotDiagnostics = {
      requestedCategories: SITUATION_MONITOR_CATEGORIES.length,
      fetchedCategories,
      reusedCategories,
      failedCategories,
      totalHeadlines,
    };
    const payload: SituationMonitorExternalSnapshotPayload = {
      source: SNAPSHOT_SOURCE,
      scope: SNAPSHOT_SCOPE,
      variantKey: SNAPSHOT_VARIANT_KEY,
      status,
      generatedAt: generatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      partial: status !== SituationMonitorExternalSnapshotStatus.completed,
      warnings,
      diagnostics,
      headlinesByCategory,
    };

    await Promise.all([
      this.persistSnapshot(payload),
      this.cache.set(
        SNAPSHOT_FRESH_CACHE_KEY,
        payload,
        SNAPSHOT_FRESH_TTL_SECONDS,
      ),
      this.cache.set(
        SNAPSHOT_STALE_CACHE_KEY,
        payload,
        SNAPSHOT_STALE_TTL_SECONDS,
      ),
    ]);
    await this.pruneHistory();

    logger.info(
      {
        status,
        totalHeadlines,
        fetchedCategories,
        reusedCategories,
        failedCategories,
        warningCount: warnings.length,
      },
      "Situation Monitor GDELT snapshot refresh completed",
    );

    return payload;
  }

  private async persistSnapshot(
    payload: SituationMonitorExternalSnapshotPayload,
  ) {
    await this.prisma.situationMonitorExternalSnapshot.create({
      data: {
        scope: SNAPSHOT_SCOPE,
        variantKey: SNAPSHOT_VARIANT_KEY,
        status: payload.status,
        source: SNAPSHOT_SOURCE,
        payload: payload as unknown as Prisma.InputJsonValue,
        warnings: payload.warnings as unknown as Prisma.InputJsonValue,
        diagnostics: payload.diagnostics as unknown as Prisma.InputJsonValue,
        generatedAt: new Date(payload.generatedAt),
        expiresAt: new Date(payload.expiresAt),
      },
    });
  }

  private async pruneHistory() {
    const cutoff = new Date(
      Date.now() - SNAPSHOT_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    await this.prisma.situationMonitorExternalSnapshot.deleteMany({
      where: {
        scope: SNAPSHOT_SCOPE,
        variantKey: SNAPSHOT_VARIANT_KEY,
        generatedAt: { lt: cutoff },
      },
    });
  }

  private async readSnapshot(input: {
    includeDatabase: boolean;
  }): Promise<SituationMonitorExternalSnapshotReadResult> {
    const fresh = await this.cache.get<SituationMonitorExternalSnapshotPayload>(
      SNAPSHOT_FRESH_CACHE_KEY,
    );
    const normalizedFresh = this.normalizePayload(fresh);
    if (normalizedFresh) {
      return {
        payload: normalizedFresh,
        stale: this.isExpired(normalizedFresh.expiresAt),
      };
    }

    const stale = await this.cache.get<SituationMonitorExternalSnapshotPayload>(
      SNAPSHOT_STALE_CACHE_KEY,
    );
    const normalizedStale = this.normalizePayload(stale);
    if (normalizedStale) {
      return {
        payload: normalizedStale,
        stale: this.isExpired(normalizedStale.expiresAt),
      };
    }

    if (!input.includeDatabase) {
      return { payload: null, stale: false };
    }

    const record =
      await this.prisma.situationMonitorExternalSnapshot.findFirst({
        where: {
          scope: SNAPSHOT_SCOPE,
          variantKey: SNAPSHOT_VARIANT_KEY,
        },
        orderBy: [{ generatedAt: "desc" }, { createdAt: "desc" }],
      });
    const payload = this.normalizePayload(
      record?.payload as SituationMonitorExternalSnapshotPayload | null,
    );
    if (!payload) {
      return { payload: null, stale: false };
    }

    await this.restoreSnapshotCaches(payload);
    return {
      payload,
      stale: this.isExpired(payload.expiresAt),
    };
  }

  private async restoreSnapshotCaches(
    payload: SituationMonitorExternalSnapshotPayload,
  ) {
    const stale = this.isExpired(payload.expiresAt);
    await Promise.all([
      stale
        ? Promise.resolve(undefined)
        : this.cache.set(
            SNAPSHOT_FRESH_CACHE_KEY,
            payload,
            SNAPSHOT_FRESH_TTL_SECONDS,
          ),
      this.cache.set(
        SNAPSHOT_STALE_CACHE_KEY,
        payload,
        SNAPSHOT_STALE_TTL_SECONDS,
      ),
    ]);
  }

  private async buildStatusSummary(
    payload: SituationMonitorExternalSnapshotPayload | null,
    stale: boolean,
    enabled: boolean,
  ): Promise<SituationMonitorExternalSnapshotStatusSummary> {
    const metrics = await this.loadStatusMetrics();
    return {
      enabled,
      intervalMinutes: SNAPSHOT_REFRESH_INTERVAL_MINUTES,
      historyRetentionDays: SNAPSHOT_HISTORY_RETENTION_DAYS,
      status: enabled
        ? payload?.status ?? "idle"
        : "disabled",
      stale,
      partial: payload?.partial ?? false,
      generatedAt: payload?.generatedAt ?? null,
      expiresAt: payload?.expiresAt ?? null,
      lastFullSuccessAt: metrics.lastFullSuccessAt,
      lastNonSuccessAt: metrics.lastNonSuccessAt,
      nextScheduledAt: enabled ? metrics.nextScheduledAt : null,
      warningCount: payload?.warnings.length ?? 0,
      availableCategoryCount: payload
        ? SITUATION_MONITOR_CATEGORIES.filter(
            (category) => payload.headlinesByCategory[category].length > 0,
          ).length
        : 0,
      rolling24hSuccessRate: metrics.rolling24hSuccessRate,
      rolling24hRateLimitedCount: metrics.rolling24hRateLimitedCount,
      rolling24hAverageAvailableCategoryCount:
        metrics.rolling24hAverageAvailableCategoryCount,
      warnings: payload?.warnings ?? [],
    };
  }

  private async loadStatusMetrics(): Promise<SituationMonitorExternalSnapshotStatusMetrics> {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [recentRecords, latestCompleted, latestNonSuccess] = await Promise.all([
      this.prisma.situationMonitorExternalSnapshot.findMany({
        where: {
          scope: SNAPSHOT_SCOPE,
          variantKey: SNAPSHOT_VARIANT_KEY,
          generatedAt: { gte: dayAgo },
        },
        orderBy: [{ generatedAt: "desc" }, { createdAt: "desc" }],
      }),
      this.prisma.situationMonitorExternalSnapshot.findFirst({
        where: {
          scope: SNAPSHOT_SCOPE,
          variantKey: SNAPSHOT_VARIANT_KEY,
          status: SituationMonitorExternalSnapshotStatus.completed,
        },
        orderBy: [{ generatedAt: "desc" }, { createdAt: "desc" }],
      }),
      this.prisma.situationMonitorExternalSnapshot.findFirst({
        where: {
          scope: SNAPSHOT_SCOPE,
          variantKey: SNAPSHOT_VARIANT_KEY,
          status: {
            in: [
              SituationMonitorExternalSnapshotStatus.partial,
              SituationMonitorExternalSnapshotStatus.failed,
            ],
          },
        },
        orderBy: [{ generatedAt: "desc" }, { createdAt: "desc" }],
      }),
    ]);

    const recentPayloads = recentRecords
      .map((record) =>
        this.normalizePayload(
          record.payload as SituationMonitorExternalSnapshotPayload | null,
        ),
      )
      .filter(
        (payload): payload is SituationMonitorExternalSnapshotPayload =>
          payload !== null,
      );
    const completedCount = recentRecords.filter(
      (record) => record.status === SituationMonitorExternalSnapshotStatus.completed,
    ).length;
    const rateLimitedCount = recentPayloads.filter((payload) =>
      payload.warnings.some((warning) => warning.code === "gdelt_rate_limited"),
    ).length;
    const averageAvailableCategoryCount =
      recentPayloads.length > 0
        ? Math.round(
            (recentPayloads.reduce((sum, payload) => {
              const availableCount = SITUATION_MONITOR_CATEGORIES.filter(
                (category) => payload.headlinesByCategory[category].length > 0,
              ).length;
              return sum + availableCount;
            }, 0) /
              recentPayloads.length) *
              10,
          ) / 10
        : null;

    return {
      lastFullSuccessAt: latestCompleted?.generatedAt.toISOString() ?? null,
      lastNonSuccessAt: latestNonSuccess?.generatedAt.toISOString() ?? null,
      nextScheduledAt: this.computeNextScheduledAt(now).toISOString(),
      rolling24hSuccessRate:
        recentRecords.length > 0
          ? Math.round((completedCount / recentRecords.length) * 1000) / 10
          : null,
      rolling24hRateLimitedCount: rateLimitedCount,
      rolling24hAverageAvailableCategoryCount: averageAvailableCategoryCount,
    };
  }

  private computeNextScheduledAt(now: Date): Date {
    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    const minute = next.getUTCMinutes();
    const nextQuarterMinute = Math.ceil((minute + 1) / 15) * 15;
    if (nextQuarterMinute >= 60) {
      next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
      return next;
    }
    next.setUTCMinutes(nextQuarterMinute, 0, 0);
    return next;
  }

  private normalizePayload(
    value: SituationMonitorExternalSnapshotPayload | null | undefined,
  ): SituationMonitorExternalSnapshotPayload | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const generatedAt =
      typeof value.generatedAt === "string" ? value.generatedAt : "";
    const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt : "";
    if (!generatedAt || !expiresAt) {
      return null;
    }

    const headlinesByCategory = this.createEmptyHeadlinesByCategory();
    for (const category of SITUATION_MONITOR_CATEGORIES) {
      const rawCategoryHeadlines =
        value.headlinesByCategory?.[category] ?? [];
      headlinesByCategory[category] = Array.isArray(rawCategoryHeadlines)
        ? rawCategoryHeadlines
            .filter((headline) => headline && typeof headline === "object")
            .map((headline) => ({
              ...(headline as SituationMonitorHeadline),
              category,
            }))
        : [];
    }

    return {
      source: SNAPSHOT_SOURCE,
      scope: SNAPSHOT_SCOPE,
      variantKey: SNAPSHOT_VARIANT_KEY,
      status:
        value.status === SituationMonitorExternalSnapshotStatus.failed
          ? SituationMonitorExternalSnapshotStatus.failed
          : value.status === SituationMonitorExternalSnapshotStatus.partial
            ? SituationMonitorExternalSnapshotStatus.partial
            : SituationMonitorExternalSnapshotStatus.completed,
      generatedAt,
      expiresAt,
      partial: Boolean(value.partial),
      warnings: Array.isArray(value.warnings)
        ? value.warnings.filter((warning) => warning && typeof warning === "object")
        : [],
      diagnostics: {
        requestedCategories:
          typeof value.diagnostics?.requestedCategories === "number"
            ? value.diagnostics.requestedCategories
            : SITUATION_MONITOR_CATEGORIES.length,
        fetchedCategories: Array.isArray(value.diagnostics?.fetchedCategories)
          ? value.diagnostics.fetchedCategories.filter((category) =>
              SITUATION_MONITOR_CATEGORIES.includes(
                category as SituationMonitorCategory,
              ),
            ) as SituationMonitorCategory[]
          : [],
        reusedCategories: Array.isArray(value.diagnostics?.reusedCategories)
          ? value.diagnostics.reusedCategories.filter((category) =>
              SITUATION_MONITOR_CATEGORIES.includes(
                category as SituationMonitorCategory,
              ),
            ) as SituationMonitorCategory[]
          : [],
        failedCategories: Array.isArray(value.diagnostics?.failedCategories)
          ? value.diagnostics.failedCategories.filter((category) =>
              SITUATION_MONITOR_CATEGORIES.includes(
                category as SituationMonitorCategory,
              ),
            ) as SituationMonitorCategory[]
          : [],
        totalHeadlines:
          typeof value.diagnostics?.totalHeadlines === "number"
            ? value.diagnostics.totalHeadlines
            : SITUATION_MONITOR_CATEGORIES.reduce(
                (sum, category) => sum + headlinesByCategory[category].length,
                0,
              ),
      },
      headlinesByCategory,
    };
  }

  private createEmptyHeadlinesByCategory(): Record<
    SituationMonitorCategory,
    SituationMonitorHeadline[]
  > {
    return {
      politics: [],
      tech: [],
      finance: [],
      gov: [],
      ai: [],
      intel: [],
    };
  }

  private normalizeSnapshotHeadlines(
    headlines: SituationMonitorHeadline[],
    category: SituationMonitorCategory,
  ): SituationMonitorHeadline[] {
    const dedupe = new Set<string>();
    const normalized: SituationMonitorHeadline[] = [];

    for (const headline of headlines) {
      const title =
        typeof headline.title === "string" ? headline.title.trim() : "";
      const link =
        typeof headline.link === "string" ? headline.link.trim() : "";
      if (
        !title ||
        !link ||
        SNAPSHOT_PLACEHOLDER_TITLE_PATTERN.test(
          title.replace(/[。.!?！？]+$/gu, "").trim(),
        ) ||
        dedupe.has(link)
      ) {
        continue;
      }

      dedupe.add(link);
      normalized.push({
        ...headline,
        title,
        link,
        category,
      });

      if (normalized.length >= SNAPSHOT_CATEGORY_LIMIT) {
        break;
      }
    }

    return normalized;
  }

  private cloneSnapshotHeadlines(headlines: SituationMonitorHeadline[]) {
    return headlines.map((headline) => ({ ...headline }));
  }

  private collectWarning(
    groups: Map<
      string,
      {
        warning: SituationMonitorExternalWarning;
        categories: Set<SituationMonitorCategory>;
        details: Set<string>;
      }
    >,
    category: SituationMonitorCategory,
    warning: SituationMonitorExternalWarning,
  ) {
    const existing = groups.get(warning.code);
    if (existing) {
      existing.categories.add(category);
      if (warning.detail) {
        existing.details.add(warning.detail);
      }
      return;
    }

    groups.set(warning.code, {
      warning,
      categories: new Set([category]),
      details: warning.detail ? new Set([warning.detail]) : new Set(),
    });
  }

  private formatWarningDetail(
    categories: Set<SituationMonitorCategory>,
    details: Set<string>,
  ): string | undefined {
    const parts: string[] = [];
    const orderedCategories = SITUATION_MONITOR_CATEGORIES.filter((category) =>
      categories.has(category),
    );
    if (orderedCategories.length > 0) {
      parts.push(`Categories: ${orderedCategories.join(", ")}`);
    }
    if (details.size > 0) {
      parts.push(Array.from(details).join(" | "));
    }
    return parts.length > 0 ? parts.join(". ") : undefined;
  }

  private isExpired(expiresAt: string) {
    const timestamp = Date.parse(expiresAt);
    return !Number.isFinite(timestamp) || timestamp <= Date.now();
  }

  private async delay(ms: number) {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
