import {
  buildProcessedItemHasLocationExpression,
  ProcessedItemModel,
} from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ProcessedArticleStatus } from "@prisma/client";

import {
  claimSchedulerTick,
  settleWithConcurrency,
} from "../../common/multi-tenant-scheduler";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { ActiveOrgRegistryService } from "../org/active-org-registry.service";
import { MultiTenantSchedulerSettingsService } from "../system-settings/multi-tenant-scheduler-settings.service";
import { RealtimeSignalsSettingsService } from "../system-settings/realtime-signals-settings.service";

import { buildAisRuntimeSemantics } from "./ais-runtime-semantics";
import { RealtimeAdsbService } from "./realtime-adsb.service";
import { RealtimeAisService } from "./realtime-ais.service";
import { RealtimeKeywordPolymarketService } from "./realtime-keyword-polymarket.service";
import { RealtimeOpenskyService } from "./realtime-opensky.service";
import {
  REALTIME_SIGNALS_INGEST_LOCK_TTL_MS,
  REALTIME_SIGNAL_METRIC_SLUGS,
  REALTIME_SIGNAL_SOURCES,
} from "./realtime-signals.constants";
import {
  buildAdsbRuntimeDiagnostics,
  extractCountryCode,
  getRateLimitDetails,
  getRetryAfterMs,
  normalizeString,
  parseTimestampMs,
  readArray,
  toDiagnosticErrorDetails,
  toFiniteNumber,
  toIsoTimestamp,
} from "./realtime-signals.helpers";
import { RealtimeSignalsSnapshotStore } from "./realtime-signals.snapshot-store";
import type {
  OpenSkyDiagnosticMessage,
  RealtimeAdsbLatestSnapshot,
  RealtimeOpenskyBudgetSummary,
  RealtimeSignalFetchResult,
  RealtimeSignalRuntimeSourceDiagnostics,
  RealtimeSignalSource,
  RealtimeSignalSourceState,
  RealtimeSignalsInsightSnapshot,
  RealtimeSignalsMarkerReadiness,
  RealtimeSignalsRuntimeConfig,
  RealtimeSignalsRuntimeDiagnostics,
  RealtimeSignalsRuntimeSettingsSource,
  RealtimeSignalsSchedulerOrgRunStatus,
  RealtimeSignalsSharedSourceContext,
} from "./realtime-signals.types";
import { RealtimeUnrestOutageService } from "./realtime-unrest-outage.service";

const logger = createLogger({ name: "realtime-signals" });
const REALTIME_SIGNALS_TICK_GATE_TTL_MS = 55_000;

const REALTIME_GLOBAL_RESULT_SOURCES = new Set<RealtimeSignalSource>([
  "unrest",
  "outages",
  "pizzint",
  "gdelt_tension",
]);

const REALTIME_SIGNAL_INSIGHT_SOURCES = [
  "keyword_spike",
  "polymarket_leads",
  "gdelt_tension",
  "pizzint",
] as const;

const REALTIME_SIGNAL_DIAGNOSTICS_WINDOW_HOURS = 24 * 7;

const SOURCE_TO_METRIC_SLUG: Record<RealtimeSignalSource, string> = {
  opensky: REALTIME_SIGNAL_METRIC_SLUGS.opensky,
  ais: REALTIME_SIGNAL_METRIC_SLUGS.ais,
  unrest: REALTIME_SIGNAL_METRIC_SLUGS.unrest,
  outages: REALTIME_SIGNAL_METRIC_SLUGS.outages,
  keyword_spike: REALTIME_SIGNAL_METRIC_SLUGS.keywordSpike,
  pizzint: REALTIME_SIGNAL_METRIC_SLUGS.pizzint,
  gdelt_tension: REALTIME_SIGNAL_METRIC_SLUGS.gdeltTension,
  polymarket_leads: REALTIME_SIGNAL_METRIC_SLUGS.polymarketLeads,
};

type RealtimeSignalInsightSource =
  (typeof REALTIME_SIGNAL_INSIGHT_SOURCES)[number];

@Injectable()
export class RealtimeSignalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly store: RealtimeSignalsSnapshotStore,
    private readonly settings: RealtimeSignalsSettingsService,
    private readonly activeOrgRegistry: ActiveOrgRegistryService,
    private readonly schedulerSettings: MultiTenantSchedulerSettingsService,
    private readonly opensky: RealtimeOpenskyService,
    private readonly adsb: RealtimeAdsbService,
    private readonly ais: RealtimeAisService,
    private readonly unrestOutage: RealtimeUnrestOutageService,
    private readonly keywordPolymarket: RealtimeKeywordPolymarketService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async refreshScheduled() {
    const claimed = await claimSchedulerTick(
      this.cache,
      "cron:realtime-signals:tick-gate",
      REALTIME_SIGNALS_TICK_GATE_TTL_MS,
    );
    if (!claimed) {
      logger.info(
        "Skipped realtime signals refresh tick because another instance already claimed this interval",
      );
      return;
    }

    const runtime = await this.getRuntimeConfig();
    if (!runtime.enabled) {
      return;
    }

    const orgs = await this.activeOrgRegistry.listActiveOrgs();

    if (orgs.length === 0) {
      return;
    }

    const schedulerRuntime = await this.schedulerSettings.getRuntimeSettings();
    const concurrency = schedulerRuntime.realtimeSignalsOrgConcurrency;
    logger.info(
      { orgCount: orgs.length, concurrency },
      "Realtime signals refresh tick started",
    );

    const sharedSourceContext = this.createSharedSourceContext(runtime);
    const results = await settleWithConcurrency(
      orgs,
      concurrency,
      async (org) =>
        this.refreshOrgWithLock(org.id, runtime, sharedSourceContext),
    );

    let failedOrgs = 0;
    let skippedOrgs = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        failedOrgs += 1;
        logger.warn(
          { orgId: result.item.id, err: result.reason },
          "Realtime signals refresh failed for org",
        );
        continue;
      }
      if (result.value === "skipped") {
        skippedOrgs += 1;
      }
    }

    try {
      await this.refreshGlobalAllFlightCaptureWithLock(
        orgs.map((org) => org.id),
        runtime,
      );
    } catch (error) {
      logger.warn(
        { err: error },
        "Realtime signals global all-flight capture failed",
      );
    }

    logger.info(
      { orgCount: orgs.length, concurrency, failedOrgs, skippedOrgs },
      "Realtime signals refresh tick completed",
    );
  }

  private async refreshOrgWithLock(
    orgId: string,
    runtime: RealtimeSignalsRuntimeConfig,
    sharedSourceContext?: RealtimeSignalsSharedSourceContext,
  ): Promise<RealtimeSignalsSchedulerOrgRunStatus> {
    const locked = await this.cache.withLock(
      `cron:realtime-signals:org:${orgId}`,
      REALTIME_SIGNALS_INGEST_LOCK_TTL_MS,
      async () => {
        await this.refreshOrg(orgId, runtime, sharedSourceContext);
        return "completed" as const;
      },
    );

    if (locked !== null) {
      return locked;
    }

    logger.info(
      { orgId },
      "Skipped realtime signals org refresh because previous org run is still in progress",
    );
    return "skipped";
  }

  private async refreshGlobalAllFlightCaptureWithLock(
    orgIds: string[],
    runtime: RealtimeSignalsRuntimeConfig,
  ) {
    const locked = await this.cache.withLock(
      "cron:realtime-signals:opensky-all-capture",
      REALTIME_SIGNALS_INGEST_LOCK_TTL_MS,
      async () => {
        await this.opensky.refreshGlobalAllFlightCapture(orgIds, runtime);
        return "completed" as const;
      },
    );

    if (locked === null) {
      logger.info(
        "Skipped realtime signals global all-flight capture because another run is in progress",
      );
    }
  }

  async refreshOrg(
    orgId: string,
    runtimeConfig?: RealtimeSignalsRuntimeConfig,
    sharedSourceContext?: RealtimeSignalsSharedSourceContext,
  ) {
    const runtime = runtimeConfig ?? (await this.getRuntimeConfig());
    if (!runtime.enabled) {
      await this.store.clearLatestAdsbSnapshot(orgId);
      await this.store.clearLatestAisSnapshot(orgId);
      await this.store.setInsightSnapshot(
        orgId,
        this.createEmptyInsightSnapshot(),
      );
      return;
    }

    const currentInsight =
      (await this.store.getInsightSnapshot(orgId)) ??
      this.createEmptyInsightSnapshot();
    const nextInsight = this.createEmptyInsightSnapshot();
    const nowMs = Date.now();
    const openskyBudget = runtime.sources.opensky.enabled
      ? await this.opensky.getOpenskyBudgetSummary(runtime, nowMs)
      : undefined;

    for (const source of REALTIME_SIGNAL_SOURCES) {
      const sourceConfig = runtime.sources[source];
      if (!sourceConfig?.enabled) {
        if (source === "opensky") {
          await this.store.clearLatestAdsbSnapshot(orgId);
        } else if (source === "ais") {
          await this.store.clearLatestAisSnapshot(orgId);
        }
        continue;
      }
      const previousSourceState = await this.store.getSourceState(
        orgId,
        source,
      );
      const lastRunMs = await this.store.getLastRun(orgId, source);
      const effectiveIntervalSec =
        source === "opensky"
          ? (openskyBudget?.effectiveMilitaryIntervalSec ??
            sourceConfig.intervalSec)
          : sourceConfig.intervalSec;

      const refreshState = this.resolveRefreshState(
        previousSourceState,
        lastRunMs,
        effectiveIntervalSec,
      );
      if (!refreshState.shouldRun) {
        this.carryForwardInsightSnapshot(
          nextInsight,
          currentInsight,
          source,
          refreshState.lastRunMs,
          effectiveIntervalSec,
          nowMs,
        );
        continue;
      }

      try {
        const results = await this.fetchSource(
          orgId,
          source,
          runtime,
          sharedSourceContext,
        );
        const completedAtMs = Date.now();
        const nowIso = new Date(completedAtMs).toISOString();
        const nextEligibleAt = new Date(
          completedAtMs +
            Math.max(10, Math.trunc(effectiveIntervalSec)) * 1_000,
        ).toISOString();
        for (const result of results) {
          await this.store.appendPoint(orgId, result.metricSlug, {
            ts: nowIso,
            value: result.value,
            context: result.context,
          });
        }
        await this.store.setLastRun(orgId, source, completedAtMs);
        const primaryResult = results[0];
        await this.store.setSourceState(orgId, {
          source,
          status: "success",
          lastAttemptAt: nowIso,
          nextEligibleAt,
          lastSuccessAt: nowIso,
          lastRateLimit: undefined,
          metricSlug: primaryResult?.metricSlug,
          latestValue: primaryResult?.value,
          context: this.toDiagnosticContext(primaryResult?.context),
        });
        this.updateInsightSnapshot(nextInsight, source, results, nowIso);
      } catch (error) {
        const completedAtMs = Date.now();
        const nowIso = new Date(completedAtMs).toISOString();
        const diagnosticError = toDiagnosticErrorDetails(error);
        const nextEligibleAt = this.computeNextEligibleAt(
          completedAtMs,
          effectiveIntervalSec,
          error,
        );
        await this.store.setSourceState(orgId, {
          source,
          status: "error",
          lastAttemptAt: nowIso,
          nextEligibleAt,
          lastSuccessAt: previousSourceState?.lastSuccessAt,
          lastErrorAt: nowIso,
          lastError: diagnosticError.message,
          lastErrorCode: diagnosticError.code,
          lastErrorKind:
            source === "opensky" ? diagnosticError.kind : undefined,
          lastErrorStatus: diagnosticError.status,
          lastRateLimit: getRateLimitDetails(error),
          metricSlug: previousSourceState?.metricSlug,
          latestValue: previousSourceState?.latestValue,
          context: previousSourceState?.context,
        });
        // A failed insight source must keep its previously fetched data
        // (matching the shouldRun=false carry-forward path): otherwise a
        // single transient GDELT/Polymarket failure wipes the whole
        // keywordSpikes/tensions/predictionLeads/pizzint block until the next
        // successful run.
        this.carryForwardInsightSnapshot(
          nextInsight,
          currentInsight,
          source,
          lastRunMs,
          effectiveIntervalSec,
          completedAtMs,
        );
        logger.warn(
          {
            orgId,
            source,
            err: error,
          },
          "Realtime signal source refresh failed",
        );
      }
    }

    await this.store.setInsightSnapshot(orgId, nextInsight);
  }

  async getRuntimeDiagnostics(
    orgId: string,
  ): Promise<RealtimeSignalsRuntimeDiagnostics> {
    const [
      runtime,
      settingsSource,
      insight,
      markerReadiness,
      adsbLatestSnapshot,
      aisLatestSnapshot,
    ] = await Promise.all([
      this.getRuntimeConfig({ refreshAcledToken: false }),
      this.getRuntimeSettingsSource(orgId),
      this.store.getInsightSnapshot(orgId),
      this.getMarkerReadiness(orgId),
      this.store.getLatestAdsbSnapshot(orgId),
      this.store.getLatestAisSnapshot(orgId),
    ]);
    const nowMs = Date.now();
    const openskyBudget = await this.opensky.getOpenskyBudgetSummary(
      runtime,
      nowMs,
    );

    const sources = await Promise.all(
      REALTIME_SIGNAL_SOURCES.map(async (source) => {
        const sourceConfig = runtime.sources[source];
        const effectiveIntervalSec =
          source === "opensky"
            ? openskyBudget.effectiveMilitaryIntervalSec
            : sourceConfig.intervalSec;
        const metricSlug = SOURCE_TO_METRIC_SLUG[source];
        const [lastRunMs, sourceState, evaluation] = await Promise.all([
          this.store.getLastRun(orgId, source),
          this.store.getSourceState(orgId, source),
          this.store.evaluateMetric(
            orgId,
            metricSlug,
            Math.max(60, Math.round(effectiveIntervalSec / 60)),
          ),
        ]);

        const evaluationContext = this.toDiagnosticContext(evaluation.context);
        const sourceStateContext = this.toDiagnosticContext(
          sourceState?.context,
        );
        const context =
          evaluationContext || sourceStateContext
            ? {
                ...(evaluationContext ?? {}),
                ...(sourceStateContext ?? {}),
              }
            : undefined;
        const openskySnapshot =
          source === "opensky"
            ? buildAdsbRuntimeDiagnostics(
                adsbLatestSnapshot,
                {
                  rawAircraftCount: toFiniteNumber(context?.totalAircraft) ?? 0,
                  currentValidPositionCount:
                    toFiniteNumber(context?.validPositionCount) ?? 0,
                },
                nowMs,
                effectiveIntervalSec,
              )
            : undefined;
        const aisRuntime =
          source === "ais"
            ? buildAisRuntimeSemantics({
                snapshot: aisLatestSnapshot,
                sourceState,
              })
            : undefined;
        const runtimeStatus = this.resolveRuntimeSourceStatus({
          source,
          sourceConfig: {
            enabled: sourceConfig.enabled,
            intervalSec: effectiveIntervalSec,
          },
          sourceState,
          lastRunMs,
          context,
          aisRuntime,
          nowMs,
        });

        return {
          source,
          enabled: sourceConfig.enabled,
          intervalSec: effectiveIntervalSec,
          ...(source === "opensky"
            ? { configuredIntervalSec: sourceConfig.intervalSec }
            : {}),
          status: runtimeStatus.status,
          statusReason: runtimeStatus.reason,
          statusReasonCode: runtimeStatus.code,
          lastRunAt:
            typeof lastRunMs === "number" && Number.isFinite(lastRunMs)
              ? new Date(lastRunMs).toISOString()
              : undefined,
          lastAttemptAt: sourceState?.lastAttemptAt,
          nextEligibleAt: sourceState?.nextEligibleAt,
          lastSuccessAt: sourceState?.lastSuccessAt,
          lastErrorAt: sourceState?.lastErrorAt,
          lastError: sourceState?.lastError,
          lastErrorCode: sourceState?.lastErrorCode,
          lastErrorKind: sourceState?.lastErrorKind,
          lastErrorStatus: sourceState?.lastErrorStatus,
          lastRateLimit: sourceState?.lastRateLimit,
          latestValue: evaluation.latest,
          previousValue: evaluation.previous,
          changePercent: evaluation.changePercent,
          context,
          ...(aisRuntime ? { aisDiagnostics: aisRuntime.diagnostics } : {}),
          ...(openskySnapshot
            ? {
                openskySnapshot,
                adsbSnapshot: openskySnapshot,
              }
            : {}),
        } satisfies RealtimeSignalRuntimeSourceDiagnostics;
      }),
    );

    return {
      checkedAt: new Date().toISOString(),
      settingsSource,
      runtimeEnabled: runtime.enabled,
      sources,
      insight: insight ?? this.createEmptyInsightSnapshot(),
      markerReadiness,
      openskyBudget,
    };
  }

  async evaluateMetric(
    orgId: string,
    metricSlug: string,
    changeWindowMin?: number | null,
  ) {
    return this.store.evaluateMetric(orgId, metricSlug, changeWindowMin);
  }

  async getSituationMonitorInsightSnapshot(orgId: string) {
    const runtime = await this.getRuntimeConfig({ refreshAcledToken: false });
    if (!runtime.enabled) {
      return this.createEmptyInsightSnapshot();
    }

    const currentInsight =
      (await this.store.getInsightSnapshot(orgId)) ??
      this.createEmptyInsightSnapshot();
    const nextInsight = this.createEmptyInsightSnapshot();
    const nowMs = Date.now();

    for (const source of REALTIME_SIGNAL_INSIGHT_SOURCES) {
      const sourceConfig = runtime.sources[source];
      if (!sourceConfig?.enabled) {
        continue;
      }
      const lastRunMs = await this.store.getLastRun(orgId, source);
      this.carryForwardInsightSnapshot(
        nextInsight,
        currentInsight,
        source,
        lastRunMs,
        sourceConfig.intervalSec,
        nowMs,
      );
    }

    return nextInsight;
  }

  async fetchOpenskyViewportSnapshot(options: {
    bbox?: [number, number, number, number];
  }): Promise<{
    configured: boolean;
    requiresZoom: boolean;
    budgetLimited: boolean;
    sourceEndpoint: string;
    statusReasonCode?: string;
    statusReason?: string;
    budgetSummary?: RealtimeOpenskyBudgetSummary;
    snapshot: RealtimeAdsbLatestSnapshot | null;
  }> {
    const runtime = await this.getRuntimeConfig({ refreshAcledToken: false });
    return this.opensky.fetchOpenskyViewportSnapshot(runtime, options);
  }

  private resolveRefreshState(
    sourceState: RealtimeSignalSourceState | null | undefined,
    lastRunMs: number | null,
    intervalSec: number,
  ) {
    const nextEligibleMs = parseTimestampMs(sourceState?.nextEligibleAt);
    const safeIntervalSec = Math.max(10, Math.trunc(intervalSec));
    if (nextEligibleMs !== null) {
      return {
        shouldRun: Date.now() >= nextEligibleMs,
        lastRunMs,
      };
    }
    const lastAttemptMs =
      parseTimestampMs(sourceState?.lastAttemptAt) ??
      (typeof lastRunMs === "number" && Number.isFinite(lastRunMs)
        ? lastRunMs
        : null);
    if (lastAttemptMs === null) {
      return { shouldRun: true, lastRunMs: null };
    }
    return {
      shouldRun: Date.now() - lastAttemptMs >= safeIntervalSec * 1_000,
      lastRunMs,
    };
  }

  private createEmptyInsightSnapshot(): RealtimeSignalsInsightSnapshot {
    return {
      keywordSpikes: [],
      predictionLeads: [],
      tensions: [],
    };
  }

  private carryForwardInsightSnapshot(
    nextInsight: RealtimeSignalsInsightSnapshot,
    currentInsight: RealtimeSignalsInsightSnapshot,
    source: RealtimeSignalSource,
    lastRunMs: number | null,
    intervalSec: number,
    nowMs: number,
  ) {
    if (!this.isInsightSource(source)) {
      return;
    }
    if (lastRunMs === null) {
      return;
    }
    if (!this.isInsightFresh(lastRunMs, intervalSec, nowMs)) {
      return;
    }

    if (source === "keyword_spike") {
      nextInsight.keywordSpikes = currentInsight.keywordSpikes;
      return;
    }

    if (source === "polymarket_leads") {
      nextInsight.predictionLeads = currentInsight.predictionLeads;
      return;
    }

    if (source === "gdelt_tension") {
      nextInsight.tensions = currentInsight.tensions;
      return;
    }

    nextInsight.pizzint = currentInsight.pizzint;
  }

  private isInsightSource(
    source: RealtimeSignalSource,
  ): source is RealtimeSignalInsightSource {
    return REALTIME_SIGNAL_INSIGHT_SOURCES.includes(
      source as RealtimeSignalInsightSource,
    );
  }

  private isInsightFresh(
    lastRunMs: number,
    intervalSec: number,
    nowMs: number,
  ) {
    const safeIntervalSec = Math.max(10, Math.trunc(intervalSec));
    const freshnessMs = Math.max(5 * 60 * 1_000, safeIntervalSec * 2 * 1_000);
    return nowMs - lastRunMs <= freshnessMs;
  }

  private async fetchSource(
    orgId: string,
    source: RealtimeSignalSource,
    runtime: RealtimeSignalsRuntimeConfig,
    sharedSourceContext?: RealtimeSignalsSharedSourceContext,
  ): Promise<RealtimeSignalFetchResult[]> {
    if (sharedSourceContext && REALTIME_GLOBAL_RESULT_SOURCES.has(source)) {
      return await sharedSourceContext.fetch(source);
    }

    switch (source) {
      case "opensky":
        return this.adsb.fetchAdsbSignal(orgId, runtime);
      case "ais":
        return this.ais.fetchAisSignal(orgId, runtime);
      case "unrest":
        return this.unrestOutage.fetchUnrestSignal(runtime);
      case "outages":
        return this.unrestOutage.fetchOutagesSignal(runtime);
      case "keyword_spike":
        return this.keywordPolymarket.fetchKeywordSpikeSignal(orgId, runtime);
      case "pizzint":
        return this.unrestOutage.fetchPizzintSignal(runtime);
      case "gdelt_tension":
        return this.unrestOutage.fetchGdeltTensionSignal(runtime);
      case "polymarket_leads":
        return this.keywordPolymarket.fetchPolymarketLeadsSignal(
          orgId,
          runtime,
        );
      default:
        return [];
    }
  }

  private createSharedSourceContext(
    runtime: RealtimeSignalsRuntimeConfig,
  ): RealtimeSignalsSharedSourceContext {
    const fetches = new Map<
      RealtimeSignalSource,
      Promise<RealtimeSignalFetchResult[]>
    >();

    return {
      fetch: async (source) => {
        const existing = fetches.get(source);
        if (existing) {
          return await existing;
        }

        const promise = this.fetchSharedGlobalSource(source, runtime);
        fetches.set(source, promise);
        return await promise;
      },
    };
  }

  private async fetchSharedGlobalSource(
    source: RealtimeSignalSource,
    runtime: RealtimeSignalsRuntimeConfig,
  ): Promise<RealtimeSignalFetchResult[]> {
    switch (source) {
      case "unrest":
        return this.unrestOutage.fetchUnrestSignal(runtime);
      case "outages":
        return this.unrestOutage.fetchOutagesSignal(runtime);
      case "pizzint":
        return this.unrestOutage.fetchPizzintSignal(runtime);
      case "gdelt_tension":
        return this.unrestOutage.fetchGdeltTensionSignal(runtime);
      default:
        return [];
    }
  }

  private updateInsightSnapshot(
    snapshot: RealtimeSignalsInsightSnapshot,
    source: RealtimeSignalSource,
    results: RealtimeSignalFetchResult[],
    fallbackTimestamp: string,
  ) {
    const primaryContext =
      results.length > 0 &&
      results[0]?.context &&
      typeof results[0].context === "object" &&
      !Array.isArray(results[0].context)
        ? (results[0].context as Record<string, unknown>)
        : null;

    if (!primaryContext) {
      return;
    }

    if (source === "keyword_spike") {
      const spikes = readArray(primaryContext.spikes)
        .filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object"),
        )
        .map((entry, index) => ({
          id:
            normalizeString(entry.id) ??
            `keyword:${normalizeString(entry.term) ?? index}`,
          term: normalizeString(entry.term) ?? "unknown",
          count: toFiniteNumber(entry.count) ?? 0,
          baseline: toFiniteNumber(entry.baseline) ?? 0,
          multiplier: toFiniteNumber(entry.multiplier) ?? 0,
          sourceCount: toFiniteNumber(entry.sourceCount) ?? 0,
          confidence: toFiniteNumber(entry.confidence) ?? 0.5,
        }));
      snapshot.keywordSpikes = spikes;
      return;
    }

    if (source === "polymarket_leads") {
      const leads = readArray(primaryContext.leads)
        .filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object"),
        )
        .map((entry, index) => ({
          id: normalizeString(entry.id) ?? `lead:${index}`,
          title: normalizeString(entry.title) ?? "unknown",
          shift: toFiniteNumber(entry.shift) ?? 0,
          newsActivity: toFiniteNumber(entry.newsActivity) ?? 0,
          confidence: toFiniteNumber(entry.confidence) ?? 0.5,
        }));
      snapshot.predictionLeads = leads;
      return;
    }

    if (source === "gdelt_tension") {
      const tensions = readArray(primaryContext.tensions)
        .filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object"),
        )
        .map(
          (
            entry,
            index,
          ): {
            id: string;
            label: string;
            score: number;
            changePercent: number;
            trend: "rising" | "stable" | "falling";
            countries: string[];
            updatedAt: string;
          } => {
            const trendRaw = normalizeString(entry.trend)?.toLowerCase();
            const trend: "rising" | "stable" | "falling" =
              trendRaw === "rising" ||
              trendRaw === "falling" ||
              trendRaw === "stable"
                ? trendRaw
                : "stable";
            return {
              id: normalizeString(entry.id) ?? `tension:${index}`,
              label: normalizeString(entry.label) ?? "Unknown pair",
              score: toFiniteNumber(entry.score) ?? 0,
              changePercent: toFiniteNumber(entry.changePercent) ?? 0,
              trend,
              countries: readArray(entry.countries)
                .map((country) => extractCountryCode(country))
                .filter((country): country is string => Boolean(country)),
              updatedAt: normalizeString(entry.updatedAt) ?? fallbackTimestamp,
            };
          },
        );
      snapshot.tensions = tensions;
      return;
    }

    if (source === "pizzint") {
      const defcon = toFiniteNumber(primaryContext.defcon);
      if (defcon === null) {
        return;
      }
      snapshot.pizzint = {
        defcon,
        adjustedScore: toFiniteNumber(primaryContext.adjustedScore) ?? 0,
        openLocations: toFiniteNumber(primaryContext.openLocations) ?? 0,
        activeSpikes: toFiniteNumber(primaryContext.activeSpikes) ?? 0,
        avgPop: toFiniteNumber(primaryContext.avgPop) ?? 0,
        updatedAt: fallbackTimestamp,
      };
    }
  }

  private async getRuntimeConfig(options?: {
    refreshAcledToken?: boolean;
  }): Promise<RealtimeSignalsRuntimeConfig> {
    try {
      return await this.settings.getRuntimeConfig(options);
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to resolve realtime signal runtime settings from DB; fallback to env",
      );
      return this.fromEnvConfig();
    }
  }

  private async getRuntimeSettingsSource(
    orgId: string,
  ): Promise<RealtimeSignalsRuntimeSettingsSource> {
    try {
      return await this.settings.getSettingsSource();
    } catch (error) {
      logger.warn(
        {
          orgId,
          diagnosticsSection: "settings_source",
          fallbackSource: "unknown",
          err: error,
        },
        "Failed to resolve realtime signal settings source for runtime diagnostics; using unknown fallback source",
      );
      return "unknown";
    }
  }

  private async getMarkerReadiness(
    orgId: string,
  ): Promise<RealtimeSignalsMarkerReadiness> {
    const since = new Date(
      Date.now() - REALTIME_SIGNAL_DIAGNOSTICS_WINDOW_HOURS * 60 * 60 * 1_000,
    );

    const mongoReadinessPromise = this.getMongoMarkerReadiness(orgId, since);
    let recentProcessedArticles = 0;
    let recentProcessedArticlesWithLocation = 0;
    let latestProcessedArticleAt: string | undefined;

    try {
      const [articleCount, articleWithLocationCount, latestProcessedArticle] =
        await Promise.all([
          this.prisma.processedArticle.count({
            where: {
              status: ProcessedArticleStatus.completed,
              orgId,
              processedAt: { gte: since },
            },
          }),
          this.countRecentProcessedArticlesWithLocation(orgId, since),
          this.prisma.processedArticle.findFirst({
            where: {
              status: ProcessedArticleStatus.completed,
              orgId,
            },
            orderBy: { processedAt: "desc" },
            select: { processedAt: true },
          }),
        ]);
      recentProcessedArticles = articleCount;
      recentProcessedArticlesWithLocation = articleWithLocationCount;
      latestProcessedArticleAt =
        latestProcessedArticle?.processedAt?.toISOString();
    } catch (error) {
      logger.warn(
        {
          orgId,
          diagnosticsSection: "marker_readiness_prisma",
          windowHours: REALTIME_SIGNAL_DIAGNOSTICS_WINDOW_HOURS,
          err: error,
        },
        "Failed to load prisma marker readiness diagnostics",
      );
    }

    const mongoReadiness = await mongoReadinessPromise;

    return {
      windowHours: REALTIME_SIGNAL_DIAGNOSTICS_WINDOW_HOURS,
      recentProcessedArticles,
      recentProcessedArticlesWithLocation,
      recentMongoProcessedItems: mongoReadiness.recentProcessedItems,
      recentMongoProcessedItemsWithLocation:
        mongoReadiness.recentProcessedItemsWithLocation,
      latestProcessedArticleAt,
      latestProcessedItemAt: mongoReadiness.latestProcessedItemAt,
      newsMarkersReady:
        recentProcessedArticlesWithLocation > 0 ||
        mongoReadiness.recentProcessedItemsWithLocation > 0,
    };
  }

  private async countRecentProcessedArticlesWithLocation(
    orgId: string,
    since: Date,
  ): Promise<number> {
    return this.prisma.processedArticle.count({
      where: {
        orgId,
        status: ProcessedArticleStatus.completed,
        processedAt: { gte: since },
        hasLocation: true,
      },
    });
  }

  private async getMongoMarkerReadiness(
    orgId: string,
    since: Date,
  ): Promise<{
    recentProcessedItems: number;
    recentProcessedItemsWithLocation: number;
    latestProcessedItemAt?: string;
  }> {
    try {
      const timeFilter = {
        $or: [
          { sortAt: { $gte: since } },
          { ingestedAt: { $gte: since } },
          { createdAt: { $gte: since } },
        ],
      };
      const [countRows, latestDoc] = await Promise.all([
        ProcessedItemModel.aggregate<{
          _id: null;
          recentProcessedItems?: number;
          recentProcessedItemsWithLocation?: number;
        }>([
          {
            $match: {
              orgId,
              status: "completed",
              duplicateOf: null,
              ...timeFilter,
            },
          },
          {
            $group: {
              _id: null,
              recentProcessedItems: { $sum: 1 },
              recentProcessedItemsWithLocation: {
                $sum: {
                  $cond: [buildProcessedItemHasLocationExpression(), 1, 0],
                },
              },
            },
          },
        ]).exec(),
        ProcessedItemModel.findOne(
          {
            orgId,
            status: "completed",
            duplicateOf: null,
          },
          {
            sortAt: 1,
            ingestedAt: 1,
            createdAt: 1,
          },
        )
          .sort({ sortAt: -1, ingestedAt: -1, createdAt: -1 })
          .lean()
          .exec(),
      ]);
      const countRow = countRows[0];
      const recentProcessedItems = Math.max(
        0,
        Math.floor(toFiniteNumber(countRow?.recentProcessedItems) ?? 0),
      );
      const recentProcessedItemsWithLocation = Math.max(
        0,
        Math.floor(
          toFiniteNumber(countRow?.recentProcessedItemsWithLocation) ?? 0,
        ),
      );

      const latestProcessedItemValue =
        latestDoc?.sortAt ?? latestDoc?.ingestedAt ?? latestDoc?.createdAt;
      return {
        recentProcessedItems,
        recentProcessedItemsWithLocation,
        latestProcessedItemAt: latestProcessedItemValue
          ? toIsoTimestamp(latestProcessedItemValue)
          : undefined,
      };
    } catch (error) {
      logger.warn(
        {
          orgId,
          diagnosticsSection: "marker_readiness_mongo",
          since: since.toISOString(),
          err: error,
        },
        "Failed to load mongo marker readiness diagnostics",
      );
      return {
        recentProcessedItems: 0,
        recentProcessedItemsWithLocation: 0,
      };
    }
  }

  private resolveRuntimeSourceStatus(options: {
    source: RealtimeSignalSource;
    sourceConfig: { enabled: boolean; intervalSec: number };
    sourceState: RealtimeSignalSourceState | null | undefined;
    lastRunMs: number | null;
    context: Record<string, unknown> | undefined;
    aisRuntime?: ReturnType<typeof buildAisRuntimeSemantics>;
    nowMs: number;
  }) {
    if (!options.sourceConfig.enabled) {
      return {
        status: "idle" as const,
        code: "source_disabled",
        reason: "Source is disabled.",
      };
    }

    const missingConfigReason = this.getMissingConfigReason(
      options.source,
      options.context,
    );
    if (missingConfigReason) {
      return {
        status: "not_configured" as const,
        code: missingConfigReason.code,
        reason: missingConfigReason.message,
      };
    }

    const lastSuccessMs =
      parseTimestampMs(options.sourceState?.lastSuccessAt) ??
      (typeof options.lastRunMs === "number" &&
      Number.isFinite(options.lastRunMs)
        ? options.lastRunMs
        : null);
    const lastErrorMs = parseTimestampMs(options.sourceState?.lastErrorAt);
    if (
      options.sourceState?.status === "error" &&
      options.sourceState.lastError &&
      (lastSuccessMs === null ||
        (lastErrorMs !== null && lastErrorMs >= lastSuccessMs))
    ) {
      return {
        status: "error" as const,
        code:
          options.source === "opensky"
            ? options.sourceState.lastErrorKind
            : options.sourceState.lastErrorCode,
        reason: options.sourceState.lastError,
      };
    }

    if (lastSuccessMs === null) {
      return {
        status: "idle" as const,
        code: "no_successful_run",
        reason: "No successful run yet.",
      };
    }

    const staleAfterMs = Math.max(
      options.sourceConfig.intervalSec * 2 * 1_000,
      5 * 60_000,
    );
    if (options.nowMs - lastSuccessMs > staleAfterMs) {
      return {
        status: "stale" as const,
        code: "last_success_stale",
        reason: "Last successful run is stale.",
      };
    }

    if (
      options.source === "opensky" &&
      normalizeString(options.context?.snapshotFreshness) === "stale"
    ) {
      return {
        status: "stale" as const,
        code: "opensky_snapshot_stale",
        reason: "Latest OpenSky snapshot is stale.",
      };
    }

    if (options.source === "ais") {
      if (
        options.aisRuntime?.statusReasonCode ||
        options.aisRuntime?.statusReason
      ) {
        return {
          status: "error" as const,
          code: options.aisRuntime.statusReasonCode,
          reason: options.aisRuntime.statusReason,
        };
      }
      return {
        status: "ok" as const,
      };
    }

    const contextReason = this.getRuntimeContextReason(
      options.source,
      options.context,
    );
    if (contextReason?.status && contextReason.status !== "ok") {
      return {
        status: contextReason.status,
        code: contextReason.code,
        reason: contextReason.message,
      };
    }
    return {
      status: "ok" as const,
      code: contextReason?.code,
      reason: contextReason?.message,
    };
  }

  private getMissingConfigReason(
    source: RealtimeSignalSource,
    context: Record<string, unknown> | undefined,
  ): OpenSkyDiagnosticMessage | undefined {
    if (!context) {
      return undefined;
    }
    if (source === "opensky" && context.configured === false) {
      return {
        code: "opensky_not_configured",
        message: "OpenSky OAuth client credentials are not configured.",
      };
    }
    if (source === "ais" && context.configured === false) {
      return {
        code: "ais_not_configured",
        message: "AIS base URL is not configured.",
      };
    }
    if (source === "outages" && context.configured === false) {
      return {
        code: "outages_not_configured",
        message: "Cloudflare API token is not configured.",
      };
    }
    return undefined;
  }

  private getRuntimeContextReason(
    source: RealtimeSignalSource,
    context: Record<string, unknown> | undefined,
  ): OpenSkyDiagnosticMessage | undefined {
    if (!context) {
      return undefined;
    }
    if (source === "opensky") {
      const budgetReservationFailureCode = normalizeString(
        context.budgetReservationFailureCode,
      );
      if (budgetReservationFailureCode) {
        return this.opensky.getOpenskyBudgetLimitedMessage(
          this.opensky.normalizeOpenskyBudgetDegradation(
            normalizeString(context.budgetDegradation),
          ) ?? "warning",
          budgetReservationFailureCode,
        );
      }
      if (context.militaryPaused === true) {
        return this.opensky.getOpenskyStatusReasonMessage(
          "opensky_budget_exhausted",
          "OpenSky military polling is paused because the daily credit budget is exhausted.",
        );
      }
      if (normalizeString(context.budgetDegradation) === "critical") {
        return this.opensky.getOpenskyStatusReasonMessage(
          "opensky_budget_critical",
          "OpenSky all-flight mode is limited and military polling is running at the night interval to preserve daily credits.",
        );
      }
      if (context.allModeBlocked === true) {
        return this.opensky.getOpenskyStatusReasonMessage(
          "opensky_budget_warning",
          "OpenSky all-flight mode is temporarily limited to preserve daily credits.",
        );
      }
      if (context.snapshotRetainedPrevious === true) {
        return this.opensky.getOpenskyStatusReasonMessage(
          "opensky_snapshot_retained_previous",
          "Using retained OpenSky snapshot after empty or unusable fetch.",
        );
      }
      const validPositionCount = toFiniteNumber(context.validPositionCount);
      const totalAircraft = toFiniteNumber(context.totalAircraft);
      if (
        typeof totalAircraft === "number" &&
        totalAircraft > 0 &&
        validPositionCount === 0
      ) {
        return this.opensky.getOpenskyStatusReasonMessage(
          "opensky_no_valid_positions",
          "OpenSky returned aircraft but no current positions passed validation.",
        );
      }
      return undefined;
    }
    if (source === "unrest") {
      const acledApiEnabled = context.acledApiEnabled !== false;
      const feedErrors =
        context.feedErrors &&
        typeof context.feedErrors === "object" &&
        !Array.isArray(context.feedErrors)
          ? (context.feedErrors as Record<string, unknown>)
          : null;
      const messages = [
        acledApiEnabled ? normalizeString(feedErrors?.acled) : undefined,
        normalizeString(feedErrors?.gdelt),
      ].filter((value): value is string => Boolean(value));
      if (messages.length > 0) {
        return { message: messages.join(" | ") };
      }
      return undefined;
    }
    return undefined;
  }

  private toDiagnosticContext(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  private fromEnvConfig(): RealtimeSignalsRuntimeConfig {
    const cfg = this.env.realtimeSignalsConfig;
    return {
      enabled: cfg.enabled,
      requestTimeoutMs: cfg.requestTimeoutMs,
      maxRetries: cfg.maxRetries,
      capabilities: {
        acledApiEnabled: false,
        acledApiDisabledReason: "Open myACLED does not include API access.",
      },
      sources: {
        opensky: cfg.sources.opensky,
        ais: cfg.sources.ais,
        unrest: cfg.sources.unrest,
        outages: cfg.sources.outages,
        keyword_spike: cfg.sources.keywordSpike,
        pizzint: cfg.sources.pizzint,
        gdelt_tension: cfg.sources.gdeltTension,
        polymarket_leads: cfg.sources.polymarketLeads,
      },
      thresholds: cfg.thresholds,
      aisRelay: cfg.ais,
      opensky: cfg.opensky,
      credentials: {
        cloudflareApiToken: cfg.credentials.cloudflareApiToken,
        wingbitsApiKey: cfg.credentials.wingbitsApiKey,
      },
      polymarket: cfg.polymarket,
    };
  }

  private computeNextEligibleAt(
    attemptCompletedAtMs: number,
    intervalSec: number,
    error: unknown,
  ) {
    const defaultDelayMs = Math.max(10, Math.trunc(intervalSec)) * 1_000;
    const retryAfterMs = getRetryAfterMs(error);
    const delayMs =
      retryAfterMs === null
        ? defaultDelayMs
        : Math.max(defaultDelayMs, retryAfterMs);
    return new Date(attemptCompletedAtMs + delayMs).toISOString();
  }
}
