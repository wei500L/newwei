import { ProcessedItemModel } from "@modular/mongo";
import {
  createLogger,
  extractCountryCodeFromText,
  getCountryAlpha2,
  getCountryName,
  normalizeCountryCode,
} from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ProcessedArticleStatus } from "@prisma/client";

import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { RealtimeSignalsSettingsService } from "../system-settings/realtime-signals-settings.service";

import {
  REALTIME_SIGNALS_INGEST_LOCK_TTL_MS,
  REALTIME_SIGNAL_METRIC_SLUGS,
  REALTIME_SIGNAL_SOURCES,
} from "./realtime-signals.constants";
import { RealtimeSignalsSnapshotStore } from "./realtime-signals.snapshot-store";
import type {
  RealtimeAdsbAircraftSnapshot,
  RealtimeAdsbLatestSnapshot,
  RealtimeAdsbRuntimeDiagnostics,
  RealtimeSignalFetchResult,
  RealtimeSignalsRuntimeDiagnostics,
  RealtimeSignalRuntimeSourceDiagnostics,
  RealtimeSignalSource,
  RealtimeSignalSourceState,
  RealtimeSignalsMarkerReadiness,
  RealtimeSignalsInsightSnapshot,
  RealtimeSignalsRuntimeConfig,
  RealtimeSignalsRuntimeSettingsSource,
} from "./realtime-signals.types";

const logger = createLogger({ name: "realtime-signals" });
const ACLED_API_URL = "https://acleddata.com/api/acled/read";
const GDELT_UNREST_GEOJSON_URL =
  "https://api.gdeltproject.org/api/v1/gkg_geojson";
const GDELT_TENSION_PAIRS = [
  "usa_russia",
  "russia_ukraine",
  "usa_china",
  "china_taiwan",
  "usa_iran",
  "usa_venezuela",
] as const;

const COUNTRY_TOKEN_TO_ALPHA2: Record<string, string> = {
  usa: "US",
  us: "US",
  russia: "RU",
  ukraine: "UA",
  china: "CN",
  taiwan: "TW",
  iran: "IR",
  venezuela: "VE",
};

const SIMPLE_STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "will",
  "have",
  "about",
  "their",
  "there",
  "after",
  "before",
  "where",
  "which",
  "while",
  "into",
  "within",
  "across",
  "against",
  "under",
  "between",
  "said",
  "says",
  "report",
  "reports",
  "update",
  "latest",
  "breaking",
  "market",
  "global",
  "world",
  "news",
  "analysis",
  "today",
  "live",
]);

const REALTIME_SIGNAL_INSIGHT_SOURCES = [
  "keyword_spike",
  "polymarket_leads",
  "gdelt_tension",
  "pizzint",
] as const;
const REALTIME_SIGNAL_DIAGNOSTICS_WINDOW_HOURS = 24 * 7;
const MIN_ADSB_STALE_THRESHOLD_SEC = 10 * 60;
const MAX_ADSB_STALE_THRESHOLD_SEC = 30 * 60;
const SOURCE_TO_METRIC_SLUG: Record<RealtimeSignalSource, string> = {
  adsb: REALTIME_SIGNAL_METRIC_SLUGS.adsb,
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

interface UnrestEventCandidate {
  id: string;
  lat: number;
  lon: number;
  occurredAt: string;
  source: "acled" | "gdelt";
  countryCode?: string;
  reports: number;
}

interface JsonFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface UnrestFeedFetchResult {
  events: UnrestEventCandidate[];
  configured: boolean;
  error?: string;
}

interface AdsbNormalizationResult {
  snapshot: RealtimeAdsbAircraftSnapshot | null;
  dropReason?: "invalid_position" | "missing_identity" | "stale_position";
}

@Injectable()
export class RealtimeSignalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly store: RealtimeSignalsSnapshotStore,
    private readonly settings: RealtimeSignalsSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async refreshScheduled() {
    const runtime = await this.getRuntimeConfig();
    if (!runtime.enabled) {
      return;
    }

    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    await this.cache.withLock(
      "cron:realtime-signals",
      REALTIME_SIGNALS_INGEST_LOCK_TTL_MS,
      async () => {
        for (const org of orgs) {
          try {
            await this.refreshOrg(org.id, runtime);
          } catch (error) {
            logger.warn(
              { orgId: org.id, err: error },
              "Realtime signals refresh failed for org",
            );
          }
        }
      },
    );
  }

  async refreshOrg(
    orgId: string,
    runtimeConfig?: RealtimeSignalsRuntimeConfig,
  ) {
    const runtime = runtimeConfig ?? (await this.getRuntimeConfig());
    if (!runtime.enabled) {
      await this.store.clearLatestAdsbSnapshot(orgId);
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

    for (const source of REALTIME_SIGNAL_SOURCES) {
      const sourceConfig = runtime.sources[source];
      if (!sourceConfig?.enabled) {
        if (source === "adsb") {
          await this.store.clearLatestAdsbSnapshot(orgId);
        }
        continue;
      }
      const previousSourceState = await this.store.getSourceState(orgId, source);

      const refreshState = await this.resolveRefreshState(
        orgId,
        source,
        sourceConfig.intervalSec,
      );
      if (!refreshState.shouldRun) {
        this.carryForwardInsightSnapshot(
          nextInsight,
          currentInsight,
          source,
          refreshState.lastRunMs,
          sourceConfig.intervalSec,
          nowMs,
        );
        continue;
      }

      try {
        const results = await this.fetchSource(orgId, source, runtime);
        const nowIso = new Date().toISOString();
        for (const result of results) {
          await this.store.appendPoint(orgId, result.metricSlug, {
            ts: nowIso,
            value: result.value,
            context: result.context,
          });
        }
        await this.store.setLastRun(orgId, source, Date.now());
        const primaryResult = results[0];
        await this.store.setSourceState(orgId, {
          source,
          status: "success",
          lastAttemptAt: nowIso,
          lastSuccessAt: nowIso,
          metricSlug: primaryResult?.metricSlug,
          latestValue: primaryResult?.value,
          context: this.toDiagnosticContext(primaryResult?.context),
        });
        this.updateInsightSnapshot(nextInsight, source, results, nowIso);
      } catch (error) {
        const nowIso = new Date().toISOString();
        await this.store.setSourceState(orgId, {
          source,
          status: "error",
          lastAttemptAt: nowIso,
          lastSuccessAt: previousSourceState?.lastSuccessAt,
          lastErrorAt: nowIso,
          lastError: this.toDiagnosticErrorMessage(error),
          metricSlug: previousSourceState?.metricSlug,
          latestValue: previousSourceState?.latestValue,
          context: previousSourceState?.context,
        });
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
    const [runtime, settingsSource, insight, markerReadiness, adsbLatestSnapshot] =
      await Promise.all([
        this.getRuntimeConfig({ refreshAcledToken: false }),
        this.getRuntimeSettingsSource(orgId),
        this.store.getInsightSnapshot(orgId),
        this.getMarkerReadiness(orgId),
        this.store.getLatestAdsbSnapshot(orgId),
      ]);
    const nowMs = Date.now();

    const sources = await Promise.all(
      REALTIME_SIGNAL_SOURCES.map(async (source) => {
        const sourceConfig = runtime.sources[source];
        const metricSlug = SOURCE_TO_METRIC_SLUG[source];
        const [lastRunMs, sourceState, evaluation] = await Promise.all([
          this.store.getLastRun(orgId, source),
          this.store.getSourceState(orgId, source),
          this.store.evaluateMetric(
            orgId,
            metricSlug,
            Math.max(60, Math.round(sourceConfig.intervalSec / 60)),
          ),
        ]);

        const context =
          this.toDiagnosticContext(evaluation.context) ??
          this.toDiagnosticContext(sourceState?.context);
        const adsbSnapshot =
          source === "adsb"
            ? this.buildAdsbRuntimeDiagnostics(
                adsbLatestSnapshot,
                {
                  rawAircraftCount:
                    this.toFiniteNumber(context?.totalAircraft) ?? 0,
                  currentValidPositionCount:
                    this.toFiniteNumber(context?.validPositionCount) ?? 0,
                },
                nowMs,
                sourceConfig.intervalSec,
              )
            : undefined;
        const runtimeStatus = this.resolveRuntimeSourceStatus({
          source,
          sourceConfig,
          sourceState,
          lastRunMs,
          context,
          nowMs,
        });

        return {
          source,
          enabled: sourceConfig.enabled,
          intervalSec: sourceConfig.intervalSec,
          status: runtimeStatus.status,
          statusReason: runtimeStatus.reason,
          lastRunAt:
            typeof lastRunMs === "number" && Number.isFinite(lastRunMs)
              ? new Date(lastRunMs).toISOString()
              : undefined,
          lastAttemptAt: sourceState?.lastAttemptAt,
          lastSuccessAt: sourceState?.lastSuccessAt,
          lastErrorAt: sourceState?.lastErrorAt,
          lastError: sourceState?.lastError,
          latestValue: evaluation.latest,
          previousValue: evaluation.previous,
          changePercent: evaluation.changePercent,
          context,
          ...(adsbSnapshot ? { adsbSnapshot } : {}),
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

  private async resolveRefreshState(
    orgId: string,
    source: RealtimeSignalSource,
    intervalSec: number,
  ) {
    const lastRunMs = await this.store.getLastRun(orgId, source);
    if (!lastRunMs) {
      return { shouldRun: true, lastRunMs: null };
    }
    const safeIntervalSec = Math.max(10, Math.trunc(intervalSec));
    return {
      shouldRun: Date.now() - lastRunMs >= safeIntervalSec * 1_000,
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
  ): Promise<RealtimeSignalFetchResult[]> {
    switch (source) {
      case "adsb":
        return this.fetchAdsbSignal(orgId, runtime);
      case "ais":
        return this.fetchAisSignal(runtime);
      case "unrest":
        return this.fetchUnrestSignal(runtime);
      case "outages":
        return this.fetchOutagesSignal(runtime);
      case "keyword_spike":
        return this.fetchKeywordSpikeSignal(orgId, runtime);
      case "pizzint":
        return this.fetchPizzintSignal(runtime);
      case "gdelt_tension":
        return this.fetchGdeltTensionSignal(runtime);
      case "polymarket_leads":
        return this.fetchPolymarketLeadsSignal(orgId, runtime);
      default:
        return [];
    }
  }

  private async fetchAdsbSignal(
    orgId: string,
    runtime: RealtimeSignalsRuntimeConfig,
  ) {
    const baseUrl =
      this.normalizeUrl(runtime.adsb.baseUrl) ?? "https://api.adsb.lol";
    const endpoint = `${baseUrl}/v2/mil`;
    const payload = await this.fetchJsonWithRetry(endpoint, runtime);
    const aircraft = this.readArray((payload as { ac?: unknown[] })?.ac);
    const totalFromPayload = this.toFiniteNumber(
      (payload as { total?: unknown })?.total,
    );
    const militaryCount =
      totalFromPayload === null
        ? aircraft.length
        : Math.max(0, Math.trunc(totalFromPayload));

    const countries = new Set<string>();
    for (const entry of aircraft) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const countryCode =
        this.toAdsbDisplayCountryCode(
          this.extractCountryCode(record.countryCode) ??
            this.extractCountryCode(record.country),
        );
      if (countryCode) {
        countries.add(countryCode);
      }
    }

    const nowMs = Date.now();
    const previousSnapshot = await this.store.getLatestAdsbSnapshot(orgId);
    const nextSnapshot = this.buildAdsbLatestSnapshot(
      endpoint,
      aircraft,
      militaryCount,
      nowMs,
      this.getAdsbStaleThresholdSeconds(runtime.sources.adsb.intervalSec),
    );
    const latestSnapshot = this.selectAdsbSnapshotToStore(
      previousSnapshot,
      nextSnapshot,
      nowMs,
      runtime.sources.adsb.intervalSec,
    );
    await this.store.setLatestAdsbSnapshot(
      orgId,
      latestSnapshot,
      this.getAdsbSnapshotTtlSeconds(runtime.sources.adsb.intervalSec),
    );
    const adsbSnapshot = this.buildAdsbRuntimeDiagnostics(
      latestSnapshot,
      {
        rawAircraftCount: aircraft.length,
        currentValidPositionCount: nextSnapshot.validPositionCount,
      },
      nowMs,
      runtime.sources.adsb.intervalSec,
    );

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.adsb,
        value: militaryCount,
        context: {
          source: "adsb",
          sourceEndpoint: endpoint,
          totalAircraft: aircraft.length,
          militaryCount,
          validPositionCount: nextSnapshot.validPositionCount,
          snapshotValidPositionCount: latestSnapshot.validPositionCount,
          latestObservedAt:
            latestSnapshot.latestObservedAt ??
            latestSnapshot.diagnostics.latestObservedAt ??
            latestSnapshot.updatedAt,
          snapshotUpdatedAt: latestSnapshot.updatedAt,
          snapshotFreshness: adsbSnapshot.freshness,
          snapshotAgeSec: adsbSnapshot.snapshotAgeSec,
          latestObservedAgeSec: adsbSnapshot.latestObservedAgeSec,
          snapshotRetainedPrevious:
            latestSnapshot.diagnostics.retainedPreviousSnapshot,
          staleThresholdSec: latestSnapshot.diagnostics.staleThresholdSec,
          droppedInvalidPositionCount:
            nextSnapshot.diagnostics.droppedInvalidPositionCount,
          droppedMissingIdentityCount:
            nextSnapshot.diagnostics.droppedMissingIdentityCount,
          droppedStalePositionCount:
            nextSnapshot.diagnostics.droppedStalePositionCount,
          deduplicatedCount: nextSnapshot.diagnostics.deduplicatedCount,
          countryCodes: Array.from(countries),
        },
      },
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.adsbSnapshotHealth,
        value: this.computeAdsbSnapshotHealthValue(
          latestSnapshot,
          adsbSnapshot,
        ),
        context: {
          source: "adsb",
          sourceEndpoint: endpoint,
          healthState: adsbSnapshot.freshness,
          stale: adsbSnapshot.freshness !== "fresh",
          snapshotRetainedPrevious:
            latestSnapshot.diagnostics.retainedPreviousSnapshot,
          snapshotFreshness: adsbSnapshot.freshness,
          snapshotUpdatedAt: latestSnapshot.updatedAt,
          latestTimestamp:
            latestSnapshot.latestObservedAt ??
            latestSnapshot.diagnostics.latestObservedAt ??
            latestSnapshot.updatedAt,
          maxStaleMinutes: Math.max(
            1,
            Math.round(latestSnapshot.diagnostics.staleThresholdSec / 60),
          ),
          rawAircraftCount: adsbSnapshot.rawAircraftCount,
          currentValidPositionCount: adsbSnapshot.currentValidPositionCount,
          snapshotValidPositionCount: adsbSnapshot.snapshotValidPositionCount,
          droppedInvalidPositionCount:
            latestSnapshot.diagnostics.droppedInvalidPositionCount,
          droppedMissingIdentityCount:
            latestSnapshot.diagnostics.droppedMissingIdentityCount,
          droppedStalePositionCount:
            latestSnapshot.diagnostics.droppedStalePositionCount,
          deduplicatedCount: latestSnapshot.diagnostics.deduplicatedCount,
          countryCodes: Array.from(countries),
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  private buildAdsbLatestSnapshot(
    endpoint: string,
    aircraft: unknown[],
    totalAircraft: number,
    fetchedAtMs: number,
    staleThresholdSec: number,
  ): RealtimeAdsbLatestSnapshot {
    const normalizedAircraft = new Map<string, RealtimeAdsbAircraftSnapshot>();
    let droppedInvalidPositionCount = 0;
    let droppedMissingIdentityCount = 0;
    let droppedStalePositionCount = 0;
    let deduplicatedCount = 0;

    for (const entry of aircraft) {
      const result = this.normalizeAdsbAircraftSnapshot(
        entry,
        fetchedAtMs,
        staleThresholdSec,
      );
      if (!result.snapshot) {
        if (result.dropReason === "stale_position") {
          droppedStalePositionCount += 1;
        } else if (result.dropReason === "missing_identity") {
          droppedMissingIdentityCount += 1;
        } else {
          droppedInvalidPositionCount += 1;
        }
        continue;
      }
      const existing = normalizedAircraft.get(result.snapshot.id);
      if (existing) {
        deduplicatedCount += 1;
        normalizedAircraft.set(
          result.snapshot.id,
          this.selectPreferredAdsbAircraftSnapshot(existing, result.snapshot),
        );
        continue;
      }
      normalizedAircraft.set(result.snapshot.id, result.snapshot);
    }

    const normalizedEntries = Array.from(normalizedAircraft.values()).sort(
      (left, right) => {
        const observedDelta =
          Date.parse(right.observedAt) - Date.parse(left.observedAt);
        if (Number.isFinite(observedDelta) && observedDelta !== 0) {
          return observedDelta;
        }
        return left.id.localeCompare(right.id);
      },
    );
    const latestObservedAt = normalizedEntries[0]?.observedAt;
    const oldestObservedAt = normalizedEntries[normalizedEntries.length - 1]?.observedAt;

    return {
      source: "adsb",
      sourceEndpoint: endpoint,
      updatedAt: new Date(fetchedAtMs).toISOString(),
      totalAircraft,
      validPositionCount: normalizedAircraft.size,
      ...(latestObservedAt ? { latestObservedAt } : {}),
      diagnostics: {
        ...(latestObservedAt ? { latestObservedAt } : {}),
        ...(oldestObservedAt ? { oldestObservedAt } : {}),
        staleThresholdSec,
        droppedInvalidPositionCount,
        droppedMissingIdentityCount,
        droppedStalePositionCount,
        deduplicatedCount,
        retainedPreviousSnapshot: false,
      },
      aircraft: normalizedEntries,
    };
  }

  private normalizeAdsbAircraftSnapshot(
    entry: unknown,
    fetchedAtMs: number,
    staleThresholdSec: number,
  ): AdsbNormalizationResult {
    if (!entry || typeof entry !== "object") {
      return { snapshot: null, dropReason: "invalid_position" };
    }

    const record = entry as Record<string, unknown>;
    const position = this.resolveAdsbAircraftPosition(record);
    if (!position) {
      return { snapshot: null, dropReason: "invalid_position" };
    }

    const icao24 =
      this.normalizeString(record.hex)?.toLowerCase() ??
      this.normalizeString(record.icao)?.toLowerCase();
    if (!icao24) {
      return { snapshot: null, dropReason: "missing_identity" };
    }

    const callsign = this.normalizeString(record.flight);
    const registration = this.normalizeString(record.r);
    const aircraftType = this.normalizeString(record.t);
    const observedAt = this.resolveAdsbObservedAt(record, fetchedAtMs);
    const observedAtMs = Date.parse(observedAt);
    if (
      Number.isFinite(observedAtMs) &&
      fetchedAtMs - observedAtMs > staleThresholdSec * 1_000
    ) {
      return { snapshot: null, dropReason: "stale_position" };
    }
    const heading = this.resolveAdsbHeading(record);
    const altitudeFt = this.resolveAdsbAltitudeFt(record);
    const groundSpeedKt = this.resolveAdsbGroundSpeedKt(record);
    const normalizedCountryCode = this.extractCountryCode(
      record.countryCode ?? record.country,
    );
    const countryCode = this.toAdsbDisplayCountryCode(normalizedCountryCode);
    const countryName = getCountryName(normalizedCountryCode);

    return {
      snapshot: {
        id: icao24,
        icao24,
        ...(callsign ? { callsign } : {}),
        ...(registration ? { registration } : {}),
        ...(aircraftType ? { aircraftType } : {}),
        lat: position.lat,
        lng: position.lng,
        ...(heading !== null ? { heading } : {}),
        ...(altitudeFt !== null ? { altitudeFt } : {}),
        ...(groundSpeedKt !== null ? { groundSpeedKt } : {}),
        ...(countryCode ? { countryCode } : {}),
        ...(countryName ? { countryName } : {}),
        observedAt,
        source: "adsb",
      },
    };
  }

  private selectPreferredAdsbAircraftSnapshot(
    current: RealtimeAdsbAircraftSnapshot,
    candidate: RealtimeAdsbAircraftSnapshot,
  ) {
    const currentObservedMs = Date.parse(current.observedAt);
    const candidateObservedMs = Date.parse(candidate.observedAt);
    if (Number.isFinite(candidateObservedMs) && Number.isFinite(currentObservedMs)) {
      if (candidateObservedMs > currentObservedMs) {
        return candidate;
      }
      if (candidateObservedMs < currentObservedMs) {
        return current;
      }
    }

    return this.scoreAdsbAircraftSnapshot(candidate) >=
      this.scoreAdsbAircraftSnapshot(current)
      ? candidate
      : current;
  }

  private scoreAdsbAircraftSnapshot(snapshot: RealtimeAdsbAircraftSnapshot) {
    let score = 0;
    if (snapshot.callsign) score += 1;
    if (snapshot.registration) score += 1;
    if (snapshot.aircraftType) score += 1;
    if (snapshot.countryCode) score += 1;
    if (typeof snapshot.heading === "number") score += 1;
    if (typeof snapshot.altitudeFt === "number") score += 1;
    if (typeof snapshot.groundSpeedKt === "number") score += 1;
    return score;
  }

  private selectAdsbSnapshotToStore(
    previousSnapshot: RealtimeAdsbLatestSnapshot | null | undefined,
    nextSnapshot: RealtimeAdsbLatestSnapshot,
    fetchedAtMs: number,
    intervalSec: number,
  ): RealtimeAdsbLatestSnapshot {
    if (nextSnapshot.validPositionCount > 0 || !previousSnapshot) {
      return nextSnapshot;
    }

    const previousUpdatedMs = this.parseTimestampMs(previousSnapshot.updatedAt);
    if (
      previousUpdatedMs === null ||
      fetchedAtMs - previousUpdatedMs >
        this.getAdsbSnapshotRetentionGraceSeconds(intervalSec) * 1_000
    ) {
      return nextSnapshot;
    }

    return {
      ...previousSnapshot,
      sourceEndpoint: nextSnapshot.sourceEndpoint,
      totalAircraft: nextSnapshot.totalAircraft,
      ...(
        previousSnapshot.latestObservedAt ??
        previousSnapshot.diagnostics.latestObservedAt
          ? {
              latestObservedAt:
                previousSnapshot.latestObservedAt ??
                previousSnapshot.diagnostics.latestObservedAt,
            }
          : {}
      ),
      diagnostics: {
        ...(previousSnapshot.latestObservedAt ??
        previousSnapshot.diagnostics.latestObservedAt
          ? {
              latestObservedAt:
                previousSnapshot.latestObservedAt ??
                previousSnapshot.diagnostics.latestObservedAt,
            }
          : {}),
        ...(previousSnapshot.diagnostics.oldestObservedAt
          ? { oldestObservedAt: previousSnapshot.diagnostics.oldestObservedAt }
          : {}),
        staleThresholdSec: nextSnapshot.diagnostics.staleThresholdSec,
        droppedInvalidPositionCount:
          nextSnapshot.diagnostics.droppedInvalidPositionCount,
        droppedMissingIdentityCount:
          nextSnapshot.diagnostics.droppedMissingIdentityCount,
        droppedStalePositionCount:
          nextSnapshot.diagnostics.droppedStalePositionCount,
        deduplicatedCount: nextSnapshot.diagnostics.deduplicatedCount,
        retainedPreviousSnapshot: true,
      },
    };
  }

  private buildAdsbRuntimeDiagnostics(
    snapshot: RealtimeAdsbLatestSnapshot | null | undefined,
    current: {
      rawAircraftCount: number;
      currentValidPositionCount: number;
    },
    nowMs: number,
    intervalSec: number,
  ): RealtimeAdsbRuntimeDiagnostics {
    const staleThresholdSec =
      snapshot?.diagnostics.staleThresholdSec ??
      this.getAdsbStaleThresholdSeconds(intervalSec);

    if (!snapshot) {
      return {
        freshness: "missing",
        rawAircraftCount: current.rawAircraftCount,
        currentValidPositionCount: current.currentValidPositionCount,
        snapshotValidPositionCount: 0,
        staleThresholdSec,
        retainedPreviousSnapshot: false,
        droppedInvalidPositionCount: 0,
        droppedMissingIdentityCount: 0,
        droppedStalePositionCount: 0,
        deduplicatedCount: 0,
      };
    }

    const snapshotUpdatedMs = this.parseTimestampMs(snapshot.updatedAt);
    const latestObservedMs = this.parseTimestampMs(
      snapshot.latestObservedAt ?? snapshot.diagnostics.latestObservedAt,
    );
    const snapshotAgeSec =
      snapshotUpdatedMs === null
        ? undefined
        : Math.max(0, Math.round((nowMs - snapshotUpdatedMs) / 1_000));
    const latestObservedAgeSec =
      latestObservedMs === null
        ? undefined
        : Math.max(0, Math.round((nowMs - latestObservedMs) / 1_000));
    const freshness =
      snapshot.validPositionCount <= 0 ||
      (typeof snapshotAgeSec === "number" && snapshotAgeSec > staleThresholdSec) ||
      (typeof latestObservedAgeSec === "number" &&
        latestObservedAgeSec > staleThresholdSec)
        ? "stale"
        : "fresh";

    return {
      freshness,
      rawAircraftCount: current.rawAircraftCount,
      currentValidPositionCount: current.currentValidPositionCount,
      snapshotValidPositionCount: snapshot.validPositionCount,
      snapshotUpdatedAt: snapshot.updatedAt,
      ...(typeof snapshotAgeSec === "number" ? { snapshotAgeSec } : {}),
      ...(snapshot.latestObservedAt
        ? { latestObservedAt: snapshot.latestObservedAt }
        : snapshot.diagnostics.latestObservedAt
          ? { latestObservedAt: snapshot.diagnostics.latestObservedAt }
        : {}),
      ...(typeof latestObservedAgeSec === "number" ? { latestObservedAgeSec } : {}),
      staleThresholdSec,
      retainedPreviousSnapshot: snapshot.diagnostics.retainedPreviousSnapshot,
      droppedInvalidPositionCount:
        snapshot.diagnostics.droppedInvalidPositionCount,
      droppedMissingIdentityCount:
        snapshot.diagnostics.droppedMissingIdentityCount,
      droppedStalePositionCount: snapshot.diagnostics.droppedStalePositionCount,
      deduplicatedCount: snapshot.diagnostics.deduplicatedCount,
    };
  }

  private computeAdsbSnapshotHealthValue(
    snapshot: RealtimeAdsbLatestSnapshot,
    diagnostics: RealtimeAdsbRuntimeDiagnostics,
  ) {
    if (diagnostics.freshness === "missing" || diagnostics.freshness === "stale") {
      return 2;
    }
    if (snapshot.diagnostics.retainedPreviousSnapshot) {
      return 1;
    }
    return 0;
  }

  private resolveAdsbAircraftPosition(record: Record<string, unknown>) {
    const lat = this.toFiniteNumber(record.lat);
    const lng = this.toFiniteNumber(record.lon);
    if (this.isValidCoordinate(lat, lng)) {
      return { lat: lat!, lng: lng! };
    }

    const lastPosition =
      record.lastPosition &&
      typeof record.lastPosition === "object" &&
      !Array.isArray(record.lastPosition)
        ? (record.lastPosition as Record<string, unknown>)
        : null;
    const lastLat = this.toFiniteNumber(lastPosition?.lat);
    const lastLng = this.toFiniteNumber(lastPosition?.lon);
    if (this.isValidCoordinate(lastLat, lastLng)) {
      return { lat: lastLat!, lng: lastLng! };
    }

    return null;
  }

  private resolveAdsbObservedAt(
    record: Record<string, unknown>,
    fetchedAtMs: number,
  ) {
    const seenPosSec =
      this.toFiniteNumber(record.seen_pos) ??
      this.toFiniteNumber(
        record.lastPosition &&
          typeof record.lastPosition === "object" &&
          !Array.isArray(record.lastPosition)
          ? (record.lastPosition as Record<string, unknown>).seen_pos
          : undefined,
      ) ??
      0;
    const observedAtMs = fetchedAtMs - Math.max(0, seenPosSec) * 1_000;
    return new Date(observedAtMs).toISOString();
  }

  private resolveAdsbHeading(record: Record<string, unknown>) {
    return (
      this.toFiniteNumber(record.track) ??
      this.toFiniteNumber(record.calc_track) ??
      this.toFiniteNumber(record.nav_heading)
    );
  }

  private resolveAdsbAltitudeFt(record: Record<string, unknown>) {
    return (
      this.toFiniteNumber(record.alt_baro) ??
      this.toFiniteNumber(record.alt_geom)
    );
  }

  private resolveAdsbGroundSpeedKt(record: Record<string, unknown>) {
    return this.toFiniteNumber(record.gs);
  }

  private getAdsbStaleThresholdSeconds(intervalSec: number) {
    const safeIntervalSec = Math.max(60, Math.trunc(intervalSec));
    return Math.max(
      MIN_ADSB_STALE_THRESHOLD_SEC,
      Math.min(MAX_ADSB_STALE_THRESHOLD_SEC, safeIntervalSec * 6),
    );
  }

  private getAdsbSnapshotRetentionGraceSeconds(intervalSec: number) {
    return this.getAdsbStaleThresholdSeconds(intervalSec);
  }

  private toAdsbDisplayCountryCode(code: string | undefined) {
    return getCountryAlpha2(code) ?? undefined;
  }

  private getAdsbSnapshotTtlSeconds(intervalSec: number) {
    const safeIntervalSec = Math.max(60, Math.trunc(intervalSec));
    return Math.max(20 * 60, safeIntervalSec * 2);
  }

  private async fetchAisSignal(runtime: RealtimeSignalsRuntimeConfig) {
    const relayBase = this.normalizeUrl(runtime.relay.baseUrl);
    if (!relayBase) {
      return [
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.ais,
          value: 0,
          context: {
            source: "relay",
            configured: false,
            disruptions: 0,
            densityRegions: 0,
            countryCodes: [],
          },
        },
      ] satisfies RealtimeSignalFetchResult[];
    }
    const relayHeaders = this.buildRelayHeaders(runtime) ?? {};
    const aisApiKey = runtime.credentials.aisApiKey?.trim();
    const headers = {
      ...relayHeaders,
      ...(aisApiKey ? { "X-AIS-API-Key": aisApiKey } : {}),
    };
    const payload = await this.fetchJsonWithRetry(
      `${relayBase}/ais/snapshot?candidates=false`,
      runtime,
      Object.keys(headers).length > 0 ? { headers } : undefined,
    );
    const { disruptions, density } = this.readAisSnapshotPayload(payload);

    const countries = new Set<string>();
    for (const disruption of disruptions) {
      if (!disruption || typeof disruption !== "object") {
        continue;
      }
      const record = disruption as Record<string, unknown>;
      const code = this.extractCountryCode(
        record.countryCode ?? record.country,
      );
      if (code) {
        countries.add(code);
      }
    }

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.ais,
        value: disruptions.length,
        context: {
          source: "relay",
          disruptions: disruptions.length,
          densityRegions: density.length,
          countryCodes: Array.from(countries),
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  private async fetchUnrestSignal(runtime: RealtimeSignalsRuntimeConfig) {
    const [acledFeed, gdeltFeed] = await Promise.all([
      runtime.capabilities.acledApiEnabled
        ? this.fetchAcledUnrestEvents(runtime)
        : Promise.resolve({
            events: [] as UnrestEventCandidate[],
            configured: false,
          } satisfies UnrestFeedFetchResult),
      this.fetchGdeltUnrestEvents(runtime),
    ]);
    const acledEvents = acledFeed.events;
    const gdeltEvents = gdeltFeed.events;
    const merged = this.mergeUnrestEvents(acledEvents, gdeltEvents);
    const countries = new Set<string>();
    for (const entry of merged) {
      if (entry.countryCode) {
        countries.add(entry.countryCode);
      }
    }
    const source =
      acledEvents.length > 0 && gdeltEvents.length > 0
        ? "acled+gdelt"
        : acledEvents.length > 0
          ? "acled"
          : gdeltEvents.length > 0
            ? "gdelt"
            : "none";

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.unrest,
        value: merged.length,
        context: {
          source,
          unrestCount: merged.length,
          acledCount: acledEvents.length,
          gdeltCount: gdeltEvents.length,
          dedupeReducedBy:
            acledEvents.length + gdeltEvents.length - merged.length,
          acledConfigured: acledFeed.configured,
          acledApiEnabled: runtime.capabilities.acledApiEnabled,
          acledApiDisabledReason: runtime.capabilities.acledApiDisabledReason,
          unrestMode: runtime.capabilities.acledApiEnabled
            ? "acled_gdelt"
            : "gdelt_only",
          countryCodes: Array.from(countries),
          feedErrors: {
            acled: runtime.capabilities.acledApiEnabled
              ? acledFeed.error ?? null
              : null,
            gdelt: gdeltFeed.error ?? null,
          },
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  private async fetchAcledUnrestEvents(runtime: RealtimeSignalsRuntimeConfig) {
    if (!runtime.capabilities.acledApiEnabled) {
      return {
        events: [] as UnrestEventCandidate[],
        configured: false,
      } satisfies UnrestFeedFetchResult;
    }

    const now = Date.now();
    const startDate = new Date(now - 30 * 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10);
    const endDate = new Date(now).toISOString().slice(0, 10);

    const params = new URLSearchParams({
      event_type: "Protests",
      event_date: `${startDate}|${endDate}`,
      event_date_where: "BETWEEN",
      limit: "500",
      _format: "json",
    });
    const url = `${ACLED_API_URL}?${params.toString()}`;

    const fetchRows = async (token: string) => {
      const payload = await this.fetchJsonWithRetry(url, runtime, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return this.readAcledUnrestRows(payload);
    };

    const token = runtime.credentials.acledAccessToken?.trim();
    if (!token) {
      return {
        events: [] as UnrestEventCandidate[],
        configured: false,
        error: "ACLED access token is not configured.",
      } satisfies UnrestFeedFetchResult;
    }

    try {
      return {
        events: await fetchRows(token),
        configured: true,
      } satisfies UnrestFeedFetchResult;
    } catch (error) {
      const status = this.readHttpStatus(error);
      if (status === 401 || status === 403) {
        try {
          const refreshedToken =
            await this.settings.forceRefreshAcledAccessToken();
          if (refreshedToken?.trim()) {
            runtime.credentials.acledAccessToken = refreshedToken.trim();
            try {
              return {
                events: await fetchRows(refreshedToken.trim()),
                configured: true,
              } satisfies UnrestFeedFetchResult;
            } catch (retryError) {
              logger.warn(
                { err: retryError },
                "ACLED unrest request failed after token refresh",
              );
              return {
                events: [] as UnrestEventCandidate[],
                configured: true,
                error: this.toDiagnosticErrorMessage(retryError),
              } satisfies UnrestFeedFetchResult;
            }
          }
        } catch (refreshError) {
          logger.warn(
            { err: refreshError },
            "ACLED token refresh failed after unauthorized response",
          );
        }
      }
      logger.warn({ err: error }, "ACLED unrest request failed");
      return {
        events: [] as UnrestEventCandidate[],
        configured: true,
        error: this.toDiagnosticErrorMessage(error),
      } satisfies UnrestFeedFetchResult;
    }
  }

  private async fetchGdeltUnrestEvents(runtime: RealtimeSignalsRuntimeConfig) {
    const url = new URL(GDELT_UNREST_GEOJSON_URL);
    url.searchParams.set("QUERY", "PROTEST");
    url.searchParams.set("TIMESPAN", String(7 * 24 * 60));
    url.searchParams.set("MAXROWS", "250");
    url.searchParams.set(
      "OUTPUTFIELDS",
      "name,url,urlpubtimedate,urltone,mentionedthemes,geores",
    );

    try {
      const payload = await this.fetchJsonWithRetry(url.toString(), runtime);
      const features = this.readArray(
        (payload as { features?: unknown[] })?.features,
      );

      const grouped = new Map<string, UnrestEventCandidate>();

      for (let idx = 0; idx < features.length; idx += 1) {
        const feature = features[idx];
        if (!feature || typeof feature !== "object") {
          continue;
        }
        const featureRecord = feature as Record<string, unknown>;
        const properties =
          featureRecord.properties &&
          typeof featureRecord.properties === "object" &&
          !Array.isArray(featureRecord.properties)
            ? (featureRecord.properties as Record<string, unknown>)
            : {};
        const geometry =
          featureRecord.geometry &&
          typeof featureRecord.geometry === "object" &&
          !Array.isArray(featureRecord.geometry)
            ? (featureRecord.geometry as Record<string, unknown>)
            : {};

        const name = this.normalizeString(
          properties.name ?? properties.location ?? properties.title,
        );
        if (!name) {
          continue;
        }
        const mentionedThemes = this.normalizeString(
          properties.mentionedthemes ?? properties.themes,
        );
        if (
          mentionedThemes &&
          !mentionedThemes.toLowerCase().includes("protest")
        ) {
          continue;
        }
        const tone = this.toFiniteNumber(
          properties.urltone ?? properties.tone ?? properties.toneavg,
        );
        if (tone !== null && tone > 0.25) {
          continue;
        }

        const coordinates = this.readArray(geometry.coordinates);
        if (coordinates.length < 2) {
          continue;
        }
        const lon = this.toFiniteNumber(coordinates[0]);
        const lat = this.toFiniteNumber(coordinates[1]);
        if (
          lat === null ||
          lon === null ||
          lat < -90 ||
          lat > 90 ||
          lon < -180 ||
          lon > 180
        ) {
          continue;
        }

        const occurredAt = this.toIsoTimestamp(
          properties.urlpubtimedate ??
            properties.date ??
            properties.event_date ??
            properties.timestamp ??
            properties.datetime ??
            Date.now(),
        );
        const countryRaw = name.split(",").pop()?.trim() ?? name;
        const aggregateKey = `${name.toLowerCase()}:${this.toDateBucket(occurredAt)}`;
        const existing = grouped.get(aggregateKey);
        if (!existing) {
          grouped.set(aggregateKey, {
            id: `gdelt-${lat.toFixed(2)}-${lon.toFixed(2)}-${this.toDateBucket(occurredAt)}-${idx}`,
            lat,
            lon,
            occurredAt,
            source: "gdelt",
            countryCode: this.extractCountryCode(countryRaw),
            reports: 1,
          });
          continue;
        }

        existing.reports += 1;
        const existingTs = Date.parse(existing.occurredAt);
        const candidateTs = Date.parse(occurredAt);
        if (
          Number.isFinite(candidateTs) &&
          (!Number.isFinite(existingTs) || candidateTs > existingTs)
        ) {
          existing.occurredAt = occurredAt;
          existing.id = `gdelt-${lat.toFixed(2)}-${lon.toFixed(2)}-${this.toDateBucket(occurredAt)}-${idx}`;
        }
        if (!existing.countryCode) {
          existing.countryCode = this.extractCountryCode(countryRaw);
        }
      }

      const rows = Array.from(grouped.values())
        .filter((entry) => entry.reports >= 2)
        .sort((a, b) => {
          if (b.reports !== a.reports) {
            return b.reports - a.reports;
          }
          return Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
        });

      return {
        events: rows,
        configured: true,
      } satisfies UnrestFeedFetchResult;
    } catch (error) {
      logger.warn({ err: error }, "GDELT unrest request failed");
      return {
        events: [] as UnrestEventCandidate[],
        configured: true,
        error: this.toDiagnosticErrorMessage(error),
      } satisfies UnrestFeedFetchResult;
    }
  }

  private mergeUnrestEvents(
    acledEvents: UnrestEventCandidate[],
    gdeltEvents: UnrestEventCandidate[],
  ) {
    const unique = new Map<string, UnrestEventCandidate>();

    for (const event of [...acledEvents, ...gdeltEvents]) {
      const key = this.buildUnrestMergeKey(event);
      const existing = unique.get(key);

      if (!existing) {
        unique.set(key, { ...event });
        continue;
      }

      if (event.source === "acled" && existing.source !== "acled") {
        unique.set(key, {
          ...event,
          reports: Math.max(event.reports, existing.reports),
          countryCode: event.countryCode ?? existing.countryCode,
        });
        continue;
      }

      if (existing.source === "acled") {
        existing.reports = Math.max(existing.reports, event.reports);
        if (!existing.countryCode && event.countryCode) {
          existing.countryCode = event.countryCode;
        }
        continue;
      }

      existing.reports = Math.max(existing.reports, event.reports);
      if (!existing.countryCode && event.countryCode) {
        existing.countryCode = event.countryCode;
      }
      const existingTs = Date.parse(existing.occurredAt);
      const candidateTs = Date.parse(event.occurredAt);
      if (
        Number.isFinite(candidateTs) &&
        (!Number.isFinite(existingTs) || candidateTs > existingTs)
      ) {
        existing.id = event.id;
        existing.occurredAt = event.occurredAt;
      }
    }

    const rows = Array.from(unique.values());
    rows.sort((a, b) => {
      const aTs = Date.parse(a.occurredAt);
      const bTs = Date.parse(b.occurredAt);
      if (Number.isFinite(aTs) && Number.isFinite(bTs)) {
        return bTs - aTs;
      }
      if (Number.isFinite(bTs)) {
        return 1;
      }
      if (Number.isFinite(aTs)) {
        return -1;
      }
      return 0;
    });
    return rows;
  }

  private async fetchOutagesSignal(runtime: RealtimeSignalsRuntimeConfig) {
    const token = runtime.credentials.cloudflareApiToken?.trim();
    if (!token) {
      return [
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.outages,
          value: 0,
          context: {
            configured: false,
            source: "cloudflare",
          },
        },
      ] satisfies RealtimeSignalFetchResult[];
    }

    const url =
      "https://api.cloudflare.com/client/v4/radar/annotations/outages?dateRange=7d&limit=50";
    const payload = await this.fetchJsonWithRetry(url, runtime, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = this.readArray((payload as { result?: unknown[] })?.result);
    const countries = new Set<string>();

    for (const outage of result) {
      if (!outage || typeof outage !== "object") {
        continue;
      }
      const record = outage as Record<string, unknown>;
      const locations = this.readArray(record.locations);
      for (const entry of locations) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const locationRecord = entry as Record<string, unknown>;
        const code = this.extractCountryCode(
          locationRecord.alpha2 ??
            locationRecord.countryCode ??
            locationRecord.name,
        );
        if (code) {
          countries.add(code);
        }
      }
    }

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.outages,
        value: result.length,
        context: {
          source: "cloudflare",
          outages: result.length,
          countryCodes: Array.from(countries),
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  private async fetchKeywordSpikeSignal(
    orgId: string,
    runtime: RealtimeSignalsRuntimeConfig,
  ) {
    const recentStart = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const baselineStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);

    const [recentArticles, baselineArticles] = await Promise.all([
      this.prisma.processedArticle.findMany({
        where: {
          status: ProcessedArticleStatus.completed,
          article: { orgId },
          processedAt: { gte: recentStart },
        },
        select: {
          title: true,
          summary: true,
          source: true,
          topics: true,
        },
        orderBy: { processedAt: "desc" },
        take: 1_500,
      }),
      this.prisma.processedArticle.findMany({
        where: {
          status: ProcessedArticleStatus.completed,
          article: { orgId },
          processedAt: { gte: baselineStart, lt: recentStart },
        },
        select: {
          title: true,
          summary: true,
          source: true,
          topics: true,
        },
        orderBy: { processedAt: "desc" },
        take: 5_000,
      }),
    ]);

    const recentCounts = new Map<
      string,
      { count: number; sources: Set<string> }
    >();
    const baselineCounts = new Map<string, number>();

    for (const article of recentArticles) {
      const source = this.normalizeSource(article.source);
      for (const term of this.extractTermsFromArticle(article)) {
        const entry = recentCounts.get(term) ?? {
          count: 0,
          sources: new Set(),
        };
        entry.count += 1;
        entry.sources.add(source);
        recentCounts.set(term, entry);
      }
    }

    for (const article of baselineArticles) {
      for (const term of this.extractTermsFromArticle(article)) {
        baselineCounts.set(term, (baselineCounts.get(term) ?? 0) + 1);
      }
    }

    const spikes: {
      id: string;
      term: string;
      count: number;
      baseline: number;
      multiplier: number;
      sourceCount: number;
      confidence: number;
    }[] = [];

    const minCount = Math.max(1, runtime.thresholds.keywordSpikeMinCount);
    const requiredMultiplier = Math.max(
      1,
      runtime.thresholds.keywordSpikeMultiplier,
    );
    const recentHours = 2;
    const baselineHours = 7 * 24;

    for (const [term, entry] of recentCounts.entries()) {
      if (entry.count < minCount || entry.sources.size < 2) {
        continue;
      }
      const baselineCount = baselineCounts.get(term) ?? 0;
      const baselineExpected = (baselineCount / baselineHours) * recentHours;
      const safeBaseline = baselineExpected > 0 ? baselineExpected : 1;
      const multiplier = entry.count / safeBaseline;
      if (multiplier < requiredMultiplier) {
        continue;
      }
      const confidence = Math.min(0.95, 0.4 + multiplier / 10);
      spikes.push({
        id: `keyword:${term}`,
        term,
        count: entry.count,
        baseline: Number(baselineExpected.toFixed(3)),
        multiplier: Number(multiplier.toFixed(3)),
        sourceCount: entry.sources.size,
        confidence: Number(confidence.toFixed(3)),
      });
    }

    spikes.sort((a, b) => b.multiplier - a.multiplier);
    const topSpikes = spikes.slice(0, 10);

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.keywordSpike,
        value: topSpikes.length,
        context: {
          source: "internal",
          recentArticleCount: recentArticles.length,
          baselineArticleCount: baselineArticles.length,
          spikes: topSpikes,
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  private async fetchPizzintSignal(runtime: RealtimeSignalsRuntimeConfig) {
    const payload = await this.fetchJsonWithRetry(
      "https://www.pizzint.watch/api/dashboard-data",
      runtime,
    );

    const locations = this.readArray(
      (payload as { locations?: unknown[] })?.locations ??
        (payload as { data?: { locations?: unknown[] } })?.data?.locations,
    );
    const openLocations = locations.filter(
      (entry): entry is Record<string, unknown> => {
        if (!entry || typeof entry !== "object") {
          return false;
        }
        const record = entry as Record<string, unknown>;
        return (
          record.open === true ||
          record.is_open === true ||
          record.status === "open"
        );
      },
    );
    const activeSpikes = locations.filter((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const record = entry as Record<string, unknown>;
      return (
        record.activeSpike === true ||
        record.has_spike === true ||
        record.spike === true
      );
    }).length;

    const avgPop =
      openLocations.length > 0
        ? openLocations.reduce((acc: number, entry) => {
            const record = entry as Record<string, unknown>;
            const value =
              typeof record.pop === "number"
                ? record.pop
                : typeof record.avg_pop === "number"
                  ? record.avg_pop
                  : typeof record.traffic === "number"
                    ? record.traffic
                    : 0;
            return acc + value;
          }, 0) / openLocations.length
        : 0;
    const adjustedScore = Math.min(100, avgPop + activeSpikes * 10);
    const defcon =
      adjustedScore >= 85
        ? 1
        : adjustedScore >= 70
          ? 2
          : adjustedScore >= 50
            ? 3
            : adjustedScore >= 25
              ? 4
              : 5;

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.pizzint,
        value: defcon,
        context: {
          source: "pizzint",
          defcon,
          adjustedScore: Number(adjustedScore.toFixed(3)),
          openLocations: openLocations.length,
          activeSpikes,
          avgPop: Number(avgPop.toFixed(3)),
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  private async fetchGdeltTensionSignal(runtime: RealtimeSignalsRuntimeConfig) {
    const url = new URL("https://www.pizzint.watch/api/gdelt/batch");
    const endDate = this.toCompactDayString(Date.now());
    const startDate = this.toCompactDayString(
      Date.now() - 7 * 24 * 60 * 60 * 1_000,
    );
    url.searchParams.set("pairs", GDELT_TENSION_PAIRS.join(","));
    url.searchParams.set("method", "gpr");
    url.searchParams.set("dateStart", startDate);
    url.searchParams.set("dateEnd", endDate);

    const payload = await this.fetchJsonWithRetry(url.toString(), runtime);
    const tensions = this.parseTensionPayload(payload);
    if (tensions.length === 0) {
      return [
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.gdeltTension,
          value: 0,
          context: {
            source: "pizzint-gdelt",
            tensions: [],
            countryCodes: [],
            dateStart: startDate,
            dateEnd: endDate,
          },
        },
      ] satisfies RealtimeSignalFetchResult[];
    }

    const maxScore = tensions.reduce(
      (acc, item) => Math.max(acc, item.score),
      0,
    );
    const countryCodes = Array.from(
      new Set(tensions.flatMap((item) => item.countries)),
    );

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.gdeltTension,
        value: Number(maxScore.toFixed(3)),
        context: {
          source: "pizzint-gdelt",
          tensions,
          countryCodes,
          dateStart: startDate,
          dateEnd: endDate,
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  private async fetchPolymarketLeadsSignal(
    orgId: string,
    runtime: RealtimeSignalsRuntimeConfig,
  ) {
    const proxyUrl = this.normalizeUrl(runtime.polymarket.proxyUrl);
    const baseUrl = proxyUrl ?? "https://gamma-api.polymarket.com";
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "60");

    const payload = await this.fetchJsonWithRetry(url.toString(), runtime);
    const events = this.readArray(payload);
    const previousPrices =
      (await this.cache.get<Record<string, number>>(
        `realtime-signals:polymarket:prices:${orgId}`,
      )) ?? {};
    const nextPrices: Record<string, number> = {};

    const leads: {
      id: string;
      title: string;
      shift: number;
      newsActivity: number;
      confidence: number;
    }[] = [];

    for (const entry of events.slice(0, 60)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const title = this.normalizeString(record.title ?? record.name);
      if (!title) {
        continue;
      }
      const eventId = this.normalizeString(record.id) ?? title;
      const active = record.active !== false && record.closed !== true;
      if (!active) {
        continue;
      }
      const volume = this.toFiniteNumber(
        record.volume ?? record.volumeNum ?? record.liquidity,
      );
      if (volume !== null && volume < 1_000) {
        continue;
      }

      const probability = this.resolvePolymarketYesPrice(record);
      if (probability === null) {
        continue;
      }
      nextPrices[eventId] = probability;
      const previous = previousPrices[eventId];
      const shift =
        typeof previous === "number" && Number.isFinite(previous)
          ? Math.abs(probability - previous)
          : 0;
      if (shift < runtime.thresholds.predictionShiftThreshold) {
        continue;
      }

      const topicTokens = this.extractTopicTokens(title);
      const newsActivity = await this.countNewsActivity(orgId, topicTokens);
      if (newsActivity >= runtime.thresholds.predictionNewsActivityThreshold) {
        continue;
      }

      const confidence = Math.min(0.9, 0.5 + shift / 20);
      leads.push({
        id: eventId,
        title,
        shift: Number(shift.toFixed(3)),
        newsActivity,
        confidence: Number(confidence.toFixed(3)),
      });
    }

    leads.sort((a, b) => b.shift - a.shift);
    const topLeads = leads.slice(0, 20);
    await this.cache.set(
      `realtime-signals:polymarket:prices:${orgId}`,
      nextPrices,
      60 * 60 * 24,
    );

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.polymarketLeads,
        value: topLeads.length,
        context: {
          source: proxyUrl ? "proxy" : "gamma-api",
          leads: topLeads,
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  private async countNewsActivity(orgId: string, tokens: string[]) {
    if (tokens.length === 0) {
      return 0;
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const searchTokens = tokens.slice(0, 3);
    let total = 0;
    for (const token of searchTokens) {
      const count = await this.prisma.processedArticle.count({
        where: {
          status: ProcessedArticleStatus.completed,
          article: { orgId },
          processedAt: { gte: since },
          OR: [
            { title: { contains: token } },
            { summary: { contains: token } },
          ],
        },
      });
      total = Math.max(total, count);
    }
    return total;
  }

  private extractTopicTokens(title: string) {
    return title
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 4 && !SIMPLE_STOPWORDS.has(entry))
      .slice(0, 8);
  }

  private resolvePolymarketYesPrice(eventRecord: Record<string, unknown>) {
    const markets = this.readArray(eventRecord.markets);
    for (const market of markets) {
      if (!market || typeof market !== "object") {
        continue;
      }
      const record = market as Record<string, unknown>;
      const yesPriceRaw =
        record.yesPrice ?? record.outcomePrice ?? record.lastTradePrice;
      const yesPrice = this.toFiniteNumber(yesPriceRaw);
      if (yesPrice === null) {
        continue;
      }
      if (yesPrice <= 1) {
        return yesPrice * 100;
      }
      return yesPrice;
    }

    const direct = this.toFiniteNumber(
      eventRecord.yesPrice ??
        eventRecord.price ??
        eventRecord.lastTradePrice ??
        eventRecord.probability,
    );
    if (direct === null) {
      return null;
    }
    return direct <= 1 ? direct * 100 : direct;
  }

  private parseTensionPayload(payload: unknown) {
    const rows: {
      id: string;
      label: string;
      score: number;
      changePercent: number;
      trend: "rising" | "stable" | "falling";
      countries: string[];
      updatedAt: string;
    }[] = [];

    if (!payload || typeof payload !== "object") {
      return rows;
    }

    const record = payload as Record<string, unknown>;
    const container =
      record.data &&
      typeof record.data === "object" &&
      !Array.isArray(record.data)
        ? (record.data as Record<string, unknown>)
        : record;

    for (const pair of GDELT_TENSION_PAIRS) {
      const series = this.readArray(container[pair]);
      if (series.length === 0) {
        continue;
      }
      const points = series
        .filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object"),
        )
        .map((entry) => ({
          value: this.toFiniteNumber(entry.v ?? entry.value ?? entry.score),
          ts:
            this.normalizeString(entry.t ?? entry.timestamp ?? entry.date) ??
            new Date().toISOString(),
        }))
        .filter(
          (entry): entry is { value: number; ts: string } =>
            entry.value !== null,
        );
      if (points.length === 0) {
        continue;
      }
      const latest = points[points.length - 1]!;
      const previous = points.length > 1 ? points[points.length - 2] : null;
      const changePercent =
        previous && previous.value !== 0
          ? ((latest.value - previous.value) / previous.value) * 100
          : 0;
      const trend: "rising" | "stable" | "falling" =
        changePercent > 5
          ? "rising"
          : changePercent < -5
            ? "falling"
            : "stable";
      rows.push({
        id: `gdelt:${pair}`,
        label: pair.replace(/_/g, " / ").toUpperCase(),
        score: Number(latest.value.toFixed(3)),
        changePercent: Number(changePercent.toFixed(3)),
        trend,
        countries: pair
          .split("_")
          .filter((token): token is string => token.trim().length > 0)
          .map((token) => COUNTRY_TOKEN_TO_ALPHA2[token] ?? token.toUpperCase())
          .filter((entry) => entry.length > 0),
        updatedAt: latest.ts,
      });
    }

    rows.sort((a, b) => b.score - a.score);
    return rows;
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
      const spikes = this.readArray(primaryContext.spikes)
        .filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object"),
        )
        .map((entry, index) => ({
          id:
            this.normalizeString(entry.id) ??
            `keyword:${this.normalizeString(entry.term) ?? index}`,
          term: this.normalizeString(entry.term) ?? "unknown",
          count: this.toFiniteNumber(entry.count) ?? 0,
          baseline: this.toFiniteNumber(entry.baseline) ?? 0,
          multiplier: this.toFiniteNumber(entry.multiplier) ?? 0,
          sourceCount: this.toFiniteNumber(entry.sourceCount) ?? 0,
          confidence: this.toFiniteNumber(entry.confidence) ?? 0.5,
        }));
      snapshot.keywordSpikes = spikes;
      return;
    }

    if (source === "polymarket_leads") {
      const leads = this.readArray(primaryContext.leads)
        .filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object"),
        )
        .map((entry, index) => ({
          id: this.normalizeString(entry.id) ?? `lead:${index}`,
          title: this.normalizeString(entry.title) ?? "unknown",
          shift: this.toFiniteNumber(entry.shift) ?? 0,
          newsActivity: this.toFiniteNumber(entry.newsActivity) ?? 0,
          confidence: this.toFiniteNumber(entry.confidence) ?? 0.5,
        }));
      snapshot.predictionLeads = leads;
      return;
    }

    if (source === "gdelt_tension") {
      const tensions = this.readArray(primaryContext.tensions)
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
            const trendRaw = this.normalizeString(entry.trend)?.toLowerCase();
            const trend: "rising" | "stable" | "falling" =
              trendRaw === "rising" ||
              trendRaw === "falling" ||
              trendRaw === "stable"
                ? trendRaw
                : "stable";
            return {
              id: this.normalizeString(entry.id) ?? `tension:${index}`,
              label: this.normalizeString(entry.label) ?? "Unknown pair",
              score: this.toFiniteNumber(entry.score) ?? 0,
              changePercent: this.toFiniteNumber(entry.changePercent) ?? 0,
              trend,
              countries: this.readArray(entry.countries)
                .map((country) => this.extractCountryCode(country))
                .filter((country): country is string => Boolean(country)),
              updatedAt:
                this.normalizeString(entry.updatedAt) ?? fallbackTimestamp,
            };
          },
        );
      snapshot.tensions = tensions;
      return;
    }

    if (source === "pizzint") {
      const defcon = this.toFiniteNumber(primaryContext.defcon);
      if (defcon === null) {
        return;
      }
      snapshot.pizzint = {
        defcon,
        adjustedScore: this.toFiniteNumber(primaryContext.adjustedScore) ?? 0,
        openLocations: this.toFiniteNumber(primaryContext.openLocations) ?? 0,
        activeSpikes: this.toFiniteNumber(primaryContext.activeSpikes) ?? 0,
        avgPop: this.toFiniteNumber(primaryContext.avgPop) ?? 0,
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
      const [
        articleCount,
        articleWithLocationCount,
        latestProcessedArticle,
      ] = await Promise.all([
        this.prisma.processedArticle.count({
          where: {
            status: ProcessedArticleStatus.completed,
            article: { orgId },
            processedAt: { gte: since },
          },
        }),
        this.countRecentProcessedArticlesWithLocation(orgId, since),
        this.prisma.processedArticle.findFirst({
          where: {
            status: ProcessedArticleStatus.completed,
            article: { orgId },
          },
          orderBy: { processedAt: "desc" },
          select: { processedAt: true },
        }),
      ]);
      recentProcessedArticles = articleCount;
      recentProcessedArticlesWithLocation = articleWithLocationCount;
      latestProcessedArticleAt = latestProcessedArticle?.processedAt?.toISOString();
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
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint | number }>>`
      SELECT COUNT(*) AS count
      FROM \`ProcessedArticle\` pa
      INNER JOIN \`Article\` a ON a.id = pa.articleId
      WHERE a.orgId = ${orgId}
        AND pa.status = ${ProcessedArticleStatus.completed}
        AND pa.processedAt >= ${since}
        AND pa.location IS NOT NULL
        AND CHAR_LENGTH(TRIM(pa.location)) > 0
    `;
    const count = rows[0]?.count;
    if (typeof count === "bigint") {
      return Number(count);
    }
    return this.toFiniteNumber(count) ?? 0;
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
      const [recentProcessedItems, recentProcessedItemsWithLocation, latestDoc] =
        await Promise.all([
          ProcessedItemModel.countDocuments({
            orgId,
            status: "completed",
            duplicateOf: null,
            ...timeFilter,
          }),
          ProcessedItemModel.countDocuments({
            orgId,
            status: "completed",
            duplicateOf: null,
            "result.location": { $type: "string", $regex: /\S/ },
            ...timeFilter,
          }),
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

      const latestProcessedItemValue =
        latestDoc?.sortAt ?? latestDoc?.ingestedAt ?? latestDoc?.createdAt;
      return {
        recentProcessedItems,
        recentProcessedItemsWithLocation,
        latestProcessedItemAt: latestProcessedItemValue
          ? this.toIsoTimestamp(latestProcessedItemValue)
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
    nowMs: number;
  }) {
    if (!options.sourceConfig.enabled) {
      return {
        status: "idle" as const,
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
        reason: missingConfigReason,
      };
    }

    const lastSuccessMs =
      this.parseTimestampMs(options.sourceState?.lastSuccessAt) ??
      (typeof options.lastRunMs === "number" && Number.isFinite(options.lastRunMs)
        ? options.lastRunMs
        : null);
    const lastErrorMs = this.parseTimestampMs(options.sourceState?.lastErrorAt);
    if (
      options.sourceState?.status === "error" &&
      options.sourceState.lastError &&
      (lastSuccessMs === null ||
        (lastErrorMs !== null && lastErrorMs >= lastSuccessMs))
    ) {
      return {
        status: "error" as const,
        reason: options.sourceState.lastError,
      };
    }

    if (lastSuccessMs === null) {
      return {
        status: "idle" as const,
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
        reason: "Last successful run is stale.",
      };
    }

    if (
      options.source === "adsb" &&
      this.normalizeString(options.context?.snapshotFreshness) === "stale"
    ) {
      return {
        status: "stale" as const,
        reason: "Latest ADS-B snapshot is stale.",
      };
    }

    const contextReason = this.getRuntimeContextReason(
      options.source,
      options.context,
    );
    return {
      status: "ok" as const,
      reason: contextReason,
    };
  }

  private parseTimestampMs(value: string | undefined) {
    const normalized = this.normalizeString(value);
    if (!normalized) {
      return null;
    }
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private getMissingConfigReason(
    source: RealtimeSignalSource,
    context: Record<string, unknown> | undefined,
  ) {
    if (!context) {
      return undefined;
    }
    if (source === "ais" && context.configured === false) {
      return "AIS relay base URL is not configured.";
    }
    if (source === "outages" && context.configured === false) {
      return "Cloudflare API token is not configured.";
    }
    return undefined;
  }

  private getRuntimeContextReason(
    source: RealtimeSignalSource,
    context: Record<string, unknown> | undefined,
  ) {
    if (!context) {
      return undefined;
    }
    if (source === "adsb") {
      if (context.snapshotRetainedPrevious === true) {
        return "Using retained ADS-B snapshot after empty or unusable fetch.";
      }
      const validPositionCount = this.toFiniteNumber(context.validPositionCount);
      const totalAircraft = this.toFiniteNumber(context.totalAircraft);
      if (
        typeof totalAircraft === "number" &&
        totalAircraft > 0 &&
        validPositionCount === 0
      ) {
        return "ADS-B feed returned aircraft but no current positions passed validation.";
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
        acledApiEnabled ? this.normalizeString(feedErrors?.acled) : undefined,
        this.normalizeString(feedErrors?.gdelt),
      ].filter((value): value is string => Boolean(value));
      if (messages.length > 0) {
        return messages.join(" | ");
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

  private toDiagnosticErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }
    if (error && typeof error === "object") {
      const status = this.readHttpStatus(error);
      const statusText = this.normalizeString(
        (error as { statusText?: unknown }).statusText,
      );
      const body = this.normalizeString((error as { body?: unknown }).body);
      const detail = [status, statusText].filter(Boolean).join(" ");
      if (detail && body) {
        return `${detail}: ${body}`.slice(0, 400);
      }
      if (detail) {
        return detail.slice(0, 240);
      }
      if (body) {
        return body.slice(0, 400);
      }
    }
    return "Unknown realtime signal fetch error";
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
        adsb: cfg.sources.adsb,
        ais: cfg.sources.ais,
        unrest: cfg.sources.unrest,
        outages: cfg.sources.outages,
        keyword_spike: cfg.sources.keywordSpike,
        pizzint: cfg.sources.pizzint,
        gdelt_tension: cfg.sources.gdeltTension,
        polymarket_leads: cfg.sources.polymarketLeads,
      },
      thresholds: cfg.thresholds,
      relay: cfg.relay,
      adsb: cfg.adsb,
      credentials: {
        aisApiKey: cfg.credentials.aisApiKey,
        cloudflareApiToken: cfg.credentials.cloudflareApiToken,
        wingbitsApiKey: cfg.credentials.wingbitsApiKey,
      },
      polymarket: cfg.polymarket,
    };
  }

  private async fetchJsonWithRetry<T>(
    url: string,
    runtime: RealtimeSignalsRuntimeConfig,
    options: JsonFetchOptions = {},
  ): Promise<T> {
    const timeoutMs = Math.max(1_000, Math.trunc(runtime.requestTimeoutMs));
    const maxRetries = Math.max(0, Math.trunc(runtime.maxRetries));
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: options.method ?? "GET",
          headers: {
            accept: "application/json",
            ...(options.body ? { "content-type": "application/json" } : {}),
            ...(options.headers ?? {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const error = new Error(
            `HTTP ${response.status} ${response.statusText}`,
          );
          Object.assign(error, {
            body,
            status: response.status,
            statusText: response.statusText,
          });
          throw error;
        }
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          const delayMs = Math.min(5_000, 300 * (attempt + 1));
          await this.sleep(delayMs);
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error("Unknown fetch error");
  }

  private readAcledUnrestRows(payload: unknown): UnrestEventCandidate[] {
    const response = payload as {
      data?: unknown[];
      message?: unknown;
      error?: unknown;
    };
    if (response.message || response.error) {
      logger.warn(
        { message: response.message, error: response.error },
        "ACLED unrest request returned error payload",
      );
      return [];
    }

    const events = this.readArray(response.data);
    const rows: UnrestEventCandidate[] = [];

    for (let idx = 0; idx < events.length; idx += 1) {
      const entry = events[idx];
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;

      const lat = this.toFiniteNumber(record.latitude);
      const lon = this.toFiniteNumber(record.longitude);
      if (
        lat === null ||
        lon === null ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      ) {
        continue;
      }

      const occurredAt = this.toIsoTimestamp(
        record.event_date ?? record.occurredAt,
      );
      const eventId =
        this.normalizeString(record.event_id_cnty) ??
        `acled-${lat.toFixed(3)}-${lon.toFixed(3)}-${this.toDateBucket(occurredAt)}-${idx}`;
      rows.push({
        id: `acled-${eventId}`,
        lat,
        lon,
        occurredAt,
        source: "acled",
        countryCode: this.extractCountryCode(
          record.iso ??
            record.country_code ??
            record.country ??
            record.admin1 ??
            record.location,
        ),
        reports: Math.max(
          1,
          Math.trunc(this.toFiniteNumber(record.fatalities) ?? 1),
        ),
      });
    }

    return rows;
  }

  private readHttpStatus(error: unknown) {
    if (!error || typeof error !== "object") {
      return null;
    }
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" && Number.isFinite(status)
      ? status
      : null;
  }

  private readArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private readAisSnapshotPayload(payload: unknown) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(
        "AIS relay returned an invalid snapshot payload. Expected disruptions[] and density[].",
      );
    }

    const record = payload as {
      disruptions?: unknown;
      density?: unknown;
    };
    if (!Array.isArray(record.disruptions) || !Array.isArray(record.density)) {
      throw new Error(
        "AIS relay returned an invalid snapshot payload. Expected disruptions[] and density[].",
      );
    }

    return {
      disruptions: record.disruptions,
      density: record.density,
    };
  }

  private normalizeString(value: unknown) {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private toFiniteNumber(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private isValidCoordinate(lat: number | null, lng: number | null) {
    return (
      lat !== null &&
      lng !== null &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    );
  }

  private toIsoTimestamp(value: unknown) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        if (/^\d{8}$/.test(trimmed)) {
          const y = trimmed.slice(0, 4);
          const m = trimmed.slice(4, 6);
          const d = trimmed.slice(6, 8);
          const parsed = Date.parse(`${y}-${m}-${d}T00:00:00.000Z`);
          if (Number.isFinite(parsed)) {
            return new Date(parsed).toISOString();
          }
        }
        if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
          const numeric = Number(trimmed);
          const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
          return new Date(ms).toISOString();
        }
        const parsed = Date.parse(trimmed);
        if (Number.isFinite(parsed)) {
          return new Date(parsed).toISOString();
        }
      }
      return new Date().toISOString();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      if (value >= 10_000_000 && value <= 99_999_999) {
        const dayValue = Math.trunc(value).toString();
        const y = dayValue.slice(0, 4);
        const m = dayValue.slice(4, 6);
        const d = dayValue.slice(6, 8);
        const parsed = Date.parse(`${y}-${m}-${d}T00:00:00.000Z`);
        if (Number.isFinite(parsed)) {
          return new Date(parsed).toISOString();
        }
      }
      const ms = value > 1_000_000_000_000 ? value : value * 1_000;
      return new Date(ms).toISOString();
    }

    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value.toISOString();
    }

    return new Date().toISOString();
  }

  private toCompactDayString(value: Date | number) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return new Date().toISOString().slice(0, 10).replace(/-/g, "");
    }
    return date.toISOString().slice(0, 10).replace(/-/g, "");
  }

  private toDateBucket(value: string) {
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) {
      return new Date(ts).toISOString().slice(0, 10);
    }
    return new Date().toISOString().slice(0, 10);
  }

  private buildUnrestMergeKey(event: UnrestEventCandidate) {
    const latKey = Math.round(event.lat * 10) / 10;
    const lonKey = Math.round(event.lon * 10) / 10;
    const dateKey = this.toDateBucket(event.occurredAt);
    return `${latKey}:${lonKey}:${dateKey}`;
  }

  private extractCountryCode(value: unknown) {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = normalizeCountryCode(value);
    if (normalized) {
      return normalized;
    }
    return extractCountryCodeFromText(value) ?? undefined;
  }

  private normalizeSource(value: unknown) {
    const normalized = this.normalizeString(value);
    return normalized ?? "unknown";
  }

  private extractTermsFromArticle(article: {
    title?: string | null;
    summary?: string | null;
    topics?: unknown;
  }) {
    const terms = new Set<string>();
    const pushTokens = (text: string | null | undefined) => {
      if (!text) {
        return;
      }
      for (const token of text.toLowerCase().split(/[^a-z0-9]+/g)) {
        const term = token.trim();
        if (term.length < 4 || SIMPLE_STOPWORDS.has(term)) {
          continue;
        }
        terms.add(term);
      }
    };

    pushTokens(article.title ?? undefined);
    pushTokens(article.summary ?? undefined);
    if (Array.isArray(article.topics)) {
      for (const topic of article.topics) {
        if (typeof topic === "string") {
          pushTokens(topic);
          continue;
        }
        if (topic && typeof topic === "object") {
          const record = topic as Record<string, unknown>;
          pushTokens(this.normalizeString(record.name) ?? undefined);
          pushTokens(this.normalizeString(record.label) ?? undefined);
        }
      }
    }

    return Array.from(terms);
  }

  private buildRelayHeaders(runtime: RealtimeSignalsRuntimeConfig) {
    const secret = runtime.relay.sharedSecret?.trim();
    if (!secret) {
      return undefined;
    }
    return {
      Authorization: `Bearer ${secret}`,
      "x-relay-key": secret,
      "X-Relay-Secret": secret,
    } satisfies Record<string, string>;
  }

  private normalizeUrl(value: string | undefined) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.replace(/\/+$/, "");
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
