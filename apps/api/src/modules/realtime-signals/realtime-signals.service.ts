import {
  buildProcessedItemHasLocationExpression,
  MapTransportObjectStateModel,
  MapTransportTrackPointModel,
  ProcessedItemModel,
} from "@modular/mongo";
import {
  createLogger,
  extractCountryCodeFromText,
  getCountryAlpha2,
  getCountryName,
  normalizeCountryCode,
} from "@modular/utils";
import { Inject, Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ProcessedArticleStatus } from "@prisma/client";
import type Redis from "ioredis";

import { fetchWithIpv4Fallback } from "../../common/http/fetch-with-ipv4-fallback";
import {
  extractProcessedArticleTerms,
  normalizeProcessedArticleSource,
} from "../../common/processed-article-indexing";
import { CacheService } from "../cache/cache.service";
import { REDIS_CLIENT } from "../cache/cache.tokens";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { RealtimeSignalsSettingsService } from "../system-settings/realtime-signals-settings.service";

import {
  REALTIME_SIGNALS_INGEST_LOCK_TTL_MS,
  REALTIME_SIGNAL_METRIC_SLUGS,
  REALTIME_SIGNAL_SOURCES,
} from "./realtime-signals.constants";
import { RealtimeSignalsSnapshotStore } from "./realtime-signals.snapshot-store";
import {
  classifyAircraftTransport,
  classifyAisShipType,
} from "./transport-classification";
import type {
  RealtimeAdsbAircraftSnapshot,
  RealtimeAdsbLatestSnapshot,
  RealtimeAdsbRuntimeDiagnostics,
  RealtimeAisDensitySnapshot,
  RealtimeAisDisruptionSeverity,
  RealtimeAisDisruptionSnapshot,
  RealtimeAisLatestSnapshot,
  RealtimeAisRelayDiagnostics,
  RealtimeAisRelayStatusSnapshot,
  RealtimeAisVesselSnapshot,
  RealtimeSignalFetchResult,
  RealtimeSignalFlightMode,
  RealtimeSignalRuntimeStatus,
  RealtimeOpenskyBudgetDaySummary,
  RealtimeOpenskyBudgetDegradationLevel,
  RealtimeOpenskyErrorKind,
  RealtimeOpenskyBudgetPeriod,
  RealtimeOpenskyBudgetSummary,
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
const OPENSKY_DEFAULT_BASE_URL = "https://opensky-network.org/api";
const OPENSKY_DEFAULT_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const OPENSKY_VIEWPORT_CACHE_TTL_SECONDS = 15;
const OPENSKY_REGION_CACHE_TTL_SECONDS = 60;
const PROCESSED_ARTICLE_TERM_COVERAGE_TTL_SECONDS = 300;
const OPENSKY_BUDGET_RETENTION_DAYS = 14;
const OPENSKY_BUDGET_RECENT_DAYS = 7;
const OPENSKY_HKT_TIME_ZONE = "Asia/Hong_Kong";
const OPENSKY_BUDGET_RESERVE_LUA_KEYS = 1;
const OPENSKY_BUDGET_RESERVE_LUA_SCRIPT = `
local key = KEYS[1]
local daily_budget = tonumber(ARGV[1]) or 0
local credits = tonumber(ARGV[2]) or 0
local request_count = tonumber(ARGV[3]) or 0
local calls_field = ARGV[4]
local credits_field = ARGV[5]
local ttl_seconds = tonumber(ARGV[6]) or 0

local used_credits = tonumber(redis.call('HGET', key, 'usedCredits') or '0')
local remaining_credits = math.max(0, daily_budget - used_credits)

if credits > 0 and used_credits + credits > daily_budget then
  return {0, used_credits, remaining_credits}
end

if credits > 0 then
  redis.call('HINCRBY', key, 'usedCredits', credits)
end
if request_count > 0 then
  redis.call('HINCRBY', key, 'requestCount', request_count)
  if calls_field and calls_field ~= '' then
    redis.call('HINCRBY', key, calls_field, request_count)
  end
end
if credits > 0 and credits_field and credits_field ~= '' then
  redis.call('HINCRBY', key, credits_field, credits)
end
if ttl_seconds > 0 then
  redis.call('EXPIRE', key, ttl_seconds)
end

local next_used = used_credits + credits
local next_remaining = math.max(0, daily_budget - next_used)
return {1, next_used, next_remaining}
`;
const FEET_PER_METER = 3.28084;
const KNOTS_PER_METER_PER_SECOND = 1.94384;
const OPENSKY_MILITARY_QUERY_REGIONS = [
  {
    key: "america",
    bbox: [-130, 24, -60, 55] as [number, number, number, number],
    credits: 4,
  },
  {
    key: "eu",
    bbox: [-15, 35, 40, 65] as [number, number, number, number],
    credits: 4,
  },
  {
    key: "mena",
    bbox: [-20, 12, 65, 45] as [number, number, number, number],
    credits: 4,
  },
  {
    key: "asia",
    bbox: [95, 18, 150, 52] as [number, number, number, number],
    credits: 4,
  },
  {
    key: "oceania",
    bbox: [110, -47, 180, 5] as [number, number, number, number],
    credits: 4,
  },
  {
    key: "arctic",
    bbox: [-80, 55, 60, 85] as [number, number, number, number],
    credits: 4,
  },
] as const;
const OPENSKY_HIGH_CONFIDENCE_CALLSIGN_PATTERNS = [
  /^(RCH|RRR|CNV|QID|GAF|BAF|NVY|NAF|VM)[A-Z0-9]{1,6}$/i,
  /^ASCOT[A-Z0-9]{1,6}$/i,
] as const;
const OPENSKY_ALL_CAPTURE_QUERY_REGIONS = [
  {
    key: "america",
    bbox: [-130, 24, -60, 55] as [number, number, number, number],
  },
  {
    key: "eu",
    bbox: [-15, 35, 40, 65] as [number, number, number, number],
  },
  {
    key: "mena",
    bbox: [-20, 12, 65, 45] as [number, number, number, number],
  },
  {
    key: "asia",
    bbox: [95, 18, 150, 52] as [number, number, number, number],
  },
  {
    key: "latam",
    bbox: [-120, -60, -30, 25] as [number, number, number, number],
  },
  {
    key: "africa",
    bbox: [-20, -35, 55, 37] as [number, number, number, number],
  },
  {
    key: "oceania",
    bbox: [110, -47, 180, 5] as [number, number, number, number],
  },
] as const;
const OPENSKY_BUDGET_HASH_FIELDS = [
  "usedCredits",
  "requestCount",
  "militaryCredits",
  "militaryCalls",
  "allCredits",
  "allCalls",
  "errorCalls",
  "authErrorCalls",
  "rateLimitedErrorCalls",
  "serverErrorCalls",
  "timeoutErrorCalls",
  "networkErrorCalls",
  "unknownErrorCalls",
  "blockedAllModeCount",
  "skippedMilitaryCount",
] as const;
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
const GLOBAL_ALL_FLIGHT_CAPTURE_INTERVAL_SEC = 15 * 60;
const GLOBAL_ALL_FLIGHT_CAPTURE_CACHE_TTL_SECONDS = 60;
const MAP_TRANSPORT_GEO_CELL_STEP_DEG = 0.5;
const MAP_TRANSPORT_HEARTBEAT_MS = 10 * 60 * 1_000;
const MAP_TRANSPORT_DISTANCE_THRESHOLD_KM = 2;
const MAP_TRANSPORT_ANGLE_THRESHOLD_DEG = 15;
const MAP_TRANSPORT_SPEED_THRESHOLD_KT = 5;
const MAP_TRANSPORT_ALTITUDE_THRESHOLD_FT = 1_000;

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
  rawBody?: string;
  beforeAttempt?: () => Promise<void> | void;
  maxRetries?: number;
  shouldRetry?: (error: unknown) => boolean;
}

interface UnrestFeedFetchResult {
  events: UnrestEventCandidate[];
  configured: boolean;
  error?: string;
}

interface OpenSkyStateResponse {
  time?: unknown;
  states?: unknown[];
}

interface OpenSkyStateVector {
  icao24: string;
  callsign?: string;
  countryName?: string;
  lastContactAt?: string;
  lastContactMs: number;
  longitude?: number;
  latitude?: number;
  heading?: number;
  altitudeFt?: number;
  groundSpeedKt?: number;
  raw: unknown[];
}

interface AdsbNormalizationResult {
  snapshot: RealtimeAdsbAircraftSnapshot | null;
  dropReason?: "invalid_position" | "missing_identity" | "stale_position";
}

type OpenSkyCreditScope = "military" | "all";

type OpenSkyBudgetCounterField = (typeof OPENSKY_BUDGET_HASH_FIELDS)[number];

interface OpenSkyBudgetReserveResult {
  allowed: boolean;
  usedCredits: number;
  remainingCredits: number;
}

interface OpenSkyDiagnosticMessage {
  code?: string;
  message?: string;
  status?: RealtimeSignalRuntimeStatus;
}

interface OpenSkyErrorDetails {
  kind: RealtimeOpenskyErrorKind;
  status?: number;
  message: string;
}

type TransportEntityKind = "aircraft" | "vessel";
type TransportSourceScope = "military" | "all" | "candidate";

interface TransportTelemetryRecord {
  orgId: string;
  entityKind: TransportEntityKind;
  sourceType: "opensky" | "ais";
  sourceScope: TransportSourceScope;
  objectKey: string;
  observedAt: string;
  sourceUpdatedAt?: string;
  lat: number;
  lng: number;
  geoCell: string;
  icao24?: string;
  mmsi?: string;
  callsign?: string;
  registration?: string;
  name?: string;
  aircraftType?: string;
  displayCategory?: string;
  displayCategoryZh?: string;
  role?: string;
  roleZh?: string;
  countryCode?: string;
  countryName?: string;
  heading?: number;
  course?: number;
  speed?: number;
  altitudeFt?: number;
  shipType?: number;
  shipTypeLabel?: string;
  shipTypeLabelZh?: string;
  isMilitaryCandidate: boolean;
  metadata?: Record<string, unknown>;
}

const OPENSKY_HKT_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: OPENSKY_HKT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

class OpenSkyBudgetExhaustedError extends Error {
  constructor(message = "OpenSky daily credit budget is exhausted") {
    super(message);
    this.name = "OpenSkyBudgetExhaustedError";
  }
}

class OpenSkyBudgetReserveError extends Error {
  constructor(
    message = "OpenSky daily credit budget does not have enough remaining credits for this request",
  ) {
    super(message);
    this.name = "OpenSkyBudgetReserveError";
  }
}

@Injectable()
export class RealtimeSignalsService {
  private readonly aisRelayIssueCodeByOrg = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
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
        try {
          await this.refreshGlobalAllFlightCapture(
            orgs.map((org) => org.id),
            runtime,
          );
        } catch (error) {
          logger.warn(
            { err: error },
            "Realtime signals global all-flight capture failed",
          );
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
      ? await this.getOpenskyBudgetSummary(runtime, nowMs)
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
      const effectiveIntervalSec =
        source === "opensky"
          ? (openskyBudget?.effectiveMilitaryIntervalSec ??
            sourceConfig.intervalSec)
          : sourceConfig.intervalSec;

      const refreshState = await this.resolveRefreshState(
        orgId,
        source,
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
        const diagnosticError = this.toDiagnosticErrorDetails(error);
        await this.store.setSourceState(orgId, {
          source,
          status: "error",
          lastAttemptAt: nowIso,
          lastSuccessAt: previousSourceState?.lastSuccessAt,
          lastErrorAt: nowIso,
          lastError: diagnosticError.message,
          lastErrorKind:
            source === "opensky" ? diagnosticError.kind : undefined,
          lastErrorStatus:
            source === "opensky" ? diagnosticError.status : undefined,
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

  private async refreshGlobalAllFlightCapture(
    orgIds: string[],
    runtime: RealtimeSignalsRuntimeConfig,
  ) {
    if (
      orgIds.length === 0 ||
      !runtime.enabled ||
      !runtime.sources.opensky.enabled ||
      !this.hasOpenskyCredentials(runtime)
    ) {
      return;
    }

    const lastRunMs =
      (await this.cache.get<number>(
        "realtime-signals:opensky:all-capture:last-run",
      )) ?? null;
    if (
      typeof lastRunMs === "number" &&
      Date.now() - lastRunMs < GLOBAL_ALL_FLIGHT_CAPTURE_INTERVAL_SEC * 1_000
    ) {
      return;
    }

    const budgetSummary = await this.getOpenskyBudgetSummary(
      runtime,
      Date.now(),
    );
    if (budgetSummary.allModeBlocked) {
      return;
    }

    const regionCursor =
      (await this.cache.get<number>(
        "realtime-signals:opensky:all-capture:cursor",
      )) ?? 0;
    const region =
      OPENSKY_ALL_CAPTURE_QUERY_REGIONS[
        Math.abs(regionCursor) % OPENSKY_ALL_CAPTURE_QUERY_REGIONS.length
      ];
    if (!region) {
      return;
    }

    try {
      const states = await this.fetchOpenSkyStates(runtime, {
        scope: "all",
        bbox: region.bbox,
        cacheKey: `realtime-signals:opensky:all-capture:${region.key}`,
        cacheTtlSeconds: GLOBAL_ALL_FLIGHT_CAPTURE_CACHE_TTL_SECONDS,
        reserveBudget: true,
      });
      const fetchedAtMs = Date.now();
      const endpoint = this.buildOpenskyStatesEndpoint(
        this.getOpenskyBaseUrl(runtime),
        region.bbox,
      );
      const snapshot = this.buildAdsbLatestSnapshot(
        endpoint,
        states.map((entry) => entry.raw),
        states.length,
        fetchedAtMs,
        this.getAdsbStaleThresholdSeconds(
          GLOBAL_ALL_FLIGHT_CAPTURE_INTERVAL_SEC,
        ),
      );
      for (const orgId of orgIds) {
        await this.persistAircraftTransportSnapshot(
          orgId,
          snapshot.aircraft,
          snapshot.updatedAt,
          "all",
        );
      }
      await Promise.all([
        this.cache.set(
          "realtime-signals:opensky:all-capture:last-run",
          fetchedAtMs,
          60 * 60 * 24 * 7,
        ),
        this.cache.set(
          "realtime-signals:opensky:all-capture:cursor",
          regionCursor + 1,
          60 * 60 * 24 * 30,
        ),
      ]);
    } catch (error) {
      if (
        error instanceof OpenSkyBudgetReserveError ||
        error instanceof OpenSkyBudgetExhaustedError
      ) {
        logger.debug(
          { region: region.key, err: error },
          "Skipped global all-flight capture because OpenSky budget is constrained",
        );
        return;
      }
      throw error;
    }
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
    ] = await Promise.all([
      this.getRuntimeConfig({ refreshAcledToken: false }),
      this.getRuntimeSettingsSource(orgId),
      this.store.getInsightSnapshot(orgId),
      this.getMarkerReadiness(orgId),
      this.store.getLatestAdsbSnapshot(orgId),
    ]);
    const nowMs = Date.now();
    const openskyBudget = await this.getOpenskyBudgetSummary(runtime, nowMs);

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

        const context =
          this.toDiagnosticContext(evaluation.context) ??
          this.toDiagnosticContext(sourceState?.context);
        const openskySnapshot =
          source === "opensky"
            ? this.buildAdsbRuntimeDiagnostics(
                adsbLatestSnapshot,
                {
                  rawAircraftCount:
                    this.toFiniteNumber(context?.totalAircraft) ?? 0,
                  currentValidPositionCount:
                    this.toFiniteNumber(context?.validPositionCount) ?? 0,
                },
                nowMs,
                effectiveIntervalSec,
              )
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
          lastSuccessAt: sourceState?.lastSuccessAt,
          lastErrorAt: sourceState?.lastErrorAt,
          lastError: sourceState?.lastError,
          lastErrorKind: sourceState?.lastErrorKind,
          lastErrorStatus: sourceState?.lastErrorStatus,
          latestValue: evaluation.latest,
          previousValue: evaluation.previous,
          changePercent: evaluation.changePercent,
          context,
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
      case "opensky":
        return this.fetchAdsbSignal(orgId, runtime);
      case "ais":
        return this.fetchAisSignal(orgId, runtime);
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
    const endpoint = `${this.getOpenskyBaseUrl(runtime)}/states/all?regions=${OPENSKY_MILITARY_QUERY_REGIONS.map((region) => region.key).join(",")}`;
    const nowMs = Date.now();
    const budgetSummary = await this.getOpenskyBudgetSummary(runtime, nowMs);
    const effectiveIntervalSec = budgetSummary.effectiveMilitaryIntervalSec;
    const budgetContext = this.buildOpenskyBudgetContext(budgetSummary);
    if (!this.hasOpenskyCredentials(runtime)) {
      await this.store.clearLatestAdsbSnapshot(orgId);
      return [
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.opensky,
          value: 0,
          context: {
            source: "opensky",
            scope: "military",
            configured: false,
            authRequired: true,
            authMode: "oauth2_client_credentials",
            sourceEndpoint: endpoint,
            totalAircraft: 0,
            militaryCount: 0,
            validPositionCount: 0,
            snapshotValidPositionCount: 0,
            countryCodes: [],
            ...budgetContext,
          },
        },
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.openskySnapshotHealth,
          value: 0,
          context: {
            source: "opensky",
            scope: "military",
            configured: false,
            authRequired: true,
            authMode: "oauth2_client_credentials",
            sourceEndpoint: endpoint,
            healthState: "missing",
            snapshotFreshness: "missing",
            stale: false,
            rawAircraftCount: 0,
            currentValidPositionCount: 0,
            snapshotValidPositionCount: 0,
            countryCodes: [],
            ...budgetContext,
          },
        },
      ] satisfies RealtimeSignalFetchResult[];
    }

    const previousSnapshot = await this.store.getLatestAdsbSnapshot(orgId);
    let militaryStates: OpenSkyStateVector[];
    try {
      militaryStates = await this.fetchConservativeMilitaryOpenSkyStates(
        runtime,
        budgetSummary,
      );
    } catch (error) {
      if (
        !(error instanceof OpenSkyBudgetExhaustedError) &&
        !(error instanceof OpenSkyBudgetReserveError)
      ) {
        throw error;
      }

      const pausedSnapshot = previousSnapshot;
      const adsbSnapshot = this.buildAdsbRuntimeDiagnostics(
        pausedSnapshot,
        {
          rawAircraftCount: pausedSnapshot?.totalAircraft ?? 0,
          currentValidPositionCount: pausedSnapshot?.validPositionCount ?? 0,
        },
        nowMs,
        effectiveIntervalSec,
      );
      const countryCodes = Array.from(
        new Set(
          (pausedSnapshot?.aircraft ?? [])
            .map((entry) => entry.countryCode)
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort();
      const militaryCount = pausedSnapshot?.aircraft.length ?? 0;
      const budgetReserveFailureContext =
        error instanceof OpenSkyBudgetReserveError
          ? {
              budgetReservationFailed: true,
              budgetReservationFailureCode:
                "opensky_budget_insufficient_credits",
            }
          : {};

      return [
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.opensky,
          value: militaryCount,
          context: {
            source: "opensky",
            sourceEndpoint: endpoint,
            scope: "military",
            configured: true,
            authRequired: true,
            authMode: "oauth2_client_credentials",
            totalAircraft: pausedSnapshot?.totalAircraft ?? 0,
            militaryCount,
            validPositionCount: pausedSnapshot?.validPositionCount ?? 0,
            snapshotValidPositionCount: pausedSnapshot?.validPositionCount ?? 0,
            latestObservedAt:
              pausedSnapshot?.latestObservedAt ??
              pausedSnapshot?.diagnostics.latestObservedAt ??
              pausedSnapshot?.updatedAt,
            snapshotUpdatedAt: pausedSnapshot?.updatedAt,
            snapshotFreshness: adsbSnapshot.freshness,
            snapshotAgeSec: adsbSnapshot.snapshotAgeSec,
            latestObservedAgeSec: adsbSnapshot.latestObservedAgeSec,
            snapshotRetainedPrevious:
              pausedSnapshot?.diagnostics.retainedPreviousSnapshot ?? false,
            staleThresholdSec: adsbSnapshot.staleThresholdSec,
            droppedInvalidPositionCount:
              pausedSnapshot?.diagnostics.droppedInvalidPositionCount ?? 0,
            droppedMissingIdentityCount:
              pausedSnapshot?.diagnostics.droppedMissingIdentityCount ?? 0,
            droppedStalePositionCount:
              pausedSnapshot?.diagnostics.droppedStalePositionCount ?? 0,
            deduplicatedCount:
              pausedSnapshot?.diagnostics.deduplicatedCount ?? 0,
            countryCodes,
            ...budgetContext,
            ...budgetReserveFailureContext,
          },
        },
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.openskySnapshotHealth,
          value:
            pausedSnapshot && adsbSnapshot.freshness === "fresh"
              ? this.computeAdsbSnapshotHealthValue(
                  pausedSnapshot,
                  adsbSnapshot,
                )
              : 2,
          context: {
            source: "opensky",
            sourceEndpoint: endpoint,
            scope: "military",
            configured: true,
            authRequired: true,
            authMode: "oauth2_client_credentials",
            healthState: adsbSnapshot.freshness,
            stale: adsbSnapshot.freshness !== "fresh",
            snapshotRetainedPrevious:
              pausedSnapshot?.diagnostics.retainedPreviousSnapshot ?? false,
            snapshotFreshness: adsbSnapshot.freshness,
            snapshotUpdatedAt: pausedSnapshot?.updatedAt,
            latestTimestamp:
              pausedSnapshot?.latestObservedAt ??
              pausedSnapshot?.diagnostics.latestObservedAt ??
              pausedSnapshot?.updatedAt,
            maxStaleMinutes: Math.max(
              1,
              Math.round(adsbSnapshot.staleThresholdSec / 60),
            ),
            rawAircraftCount: pausedSnapshot?.totalAircraft ?? 0,
            currentValidPositionCount: pausedSnapshot?.validPositionCount ?? 0,
            snapshotValidPositionCount: pausedSnapshot?.validPositionCount ?? 0,
            droppedInvalidPositionCount:
              pausedSnapshot?.diagnostics.droppedInvalidPositionCount ?? 0,
            droppedMissingIdentityCount:
              pausedSnapshot?.diagnostics.droppedMissingIdentityCount ?? 0,
            droppedStalePositionCount:
              pausedSnapshot?.diagnostics.droppedStalePositionCount ?? 0,
            deduplicatedCount:
              pausedSnapshot?.diagnostics.deduplicatedCount ?? 0,
            countryCodes,
            ...budgetContext,
            ...budgetReserveFailureContext,
          },
        },
      ] satisfies RealtimeSignalFetchResult[];
    }

    const militaryCount = militaryStates.length;
    const countries = new Set<string>();
    for (const state of militaryStates) {
      const countryCode = this.resolveOpenSkyCountryCode(state.countryName);
      if (countryCode) {
        countries.add(countryCode);
      }
    }
    const countryCodes = Array.from(countries).sort();

    const nextSnapshot = this.buildAdsbLatestSnapshot(
      endpoint,
      militaryStates.map((entry) => entry.raw),
      militaryCount,
      nowMs,
      this.getAdsbStaleThresholdSeconds(effectiveIntervalSec),
    );
    const latestSnapshot = this.selectAdsbSnapshotToStore(
      previousSnapshot,
      nextSnapshot,
      nowMs,
      effectiveIntervalSec,
    );
    await this.store.setLatestAdsbSnapshot(
      orgId,
      latestSnapshot,
      this.getAdsbSnapshotTtlSeconds(effectiveIntervalSec),
    );
    await this.persistAircraftTransportSnapshot(
      orgId,
      nextSnapshot.aircraft,
      nextSnapshot.updatedAt,
      "military",
    );
    const adsbSnapshot = this.buildAdsbRuntimeDiagnostics(
      latestSnapshot,
      {
        rawAircraftCount: militaryCount,
        currentValidPositionCount: nextSnapshot.validPositionCount,
      },
      nowMs,
      effectiveIntervalSec,
    );

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.opensky,
        value: militaryCount,
        context: {
          source: "opensky",
          sourceEndpoint: endpoint,
          scope: "military",
          configured: true,
          authRequired: true,
          authMode: "oauth2_client_credentials",
          totalAircraft: militaryCount,
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
          countryCodes,
          ...budgetContext,
        },
      },
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.openskySnapshotHealth,
        value: this.computeAdsbSnapshotHealthValue(
          latestSnapshot,
          adsbSnapshot,
        ),
        context: {
          source: "opensky",
          sourceEndpoint: endpoint,
          scope: "military",
          configured: true,
          authRequired: true,
          authMode: "oauth2_client_credentials",
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
          countryCodes,
          ...budgetContext,
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
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
    const sourceEndpoint = options.bbox
      ? this.buildOpenskyStatesEndpoint(
          this.getOpenskyBaseUrl(runtime),
          options.bbox,
        )
      : `${this.getOpenskyBaseUrl(runtime)}/states/all`;
    if (!runtime.enabled || !runtime.sources.opensky.enabled) {
      return {
        configured: false,
        requiresZoom: false,
        budgetLimited: false,
        sourceEndpoint,
        snapshot: null,
      };
    }
    if (!this.hasOpenskyCredentials(runtime)) {
      return {
        configured: false,
        requiresZoom: false,
        budgetLimited: false,
        sourceEndpoint,
        snapshot: null,
      };
    }
    if (!options.bbox) {
      return {
        configured: true,
        requiresZoom: true,
        budgetLimited: false,
        sourceEndpoint,
        snapshot: null,
      };
    }

    const budgetSummary = await this.getOpenskyBudgetSummary(
      runtime,
      Date.now(),
    );
    if (budgetSummary.allModeBlocked) {
      await this.recordOpenskyBudgetEvent("blockedAllModeCount");
      const budgetMessage = this.getOpenskyBudgetLimitedMessage(
        budgetSummary.degradationLevel,
      );
      return {
        configured: true,
        requiresZoom: false,
        budgetLimited: true,
        sourceEndpoint,
        statusReasonCode: budgetMessage.code,
        statusReason: budgetMessage.message,
        budgetSummary,
        snapshot: null,
      };
    }

    let states: OpenSkyStateVector[];
    try {
      states = await this.fetchOpenSkyViewportStates(runtime, options.bbox);
    } catch (error) {
      if (!(error instanceof OpenSkyBudgetReserveError)) {
        throw error;
      }
      await this.recordOpenskyBudgetEvent("blockedAllModeCount");
      const reserveSummary = await this.getOpenskyBudgetSummary(
        runtime,
        Date.now(),
      );
      const budgetMessage = this.getOpenskyBudgetLimitedMessage(
        reserveSummary.degradationLevel,
        "opensky_budget_insufficient_credits",
      );
      return {
        configured: true,
        requiresZoom: false,
        budgetLimited: true,
        sourceEndpoint,
        statusReasonCode: budgetMessage.code,
        statusReason: budgetMessage.message,
        budgetSummary: reserveSummary,
        snapshot: null,
      };
    }
    const staleIntervalSec = this.getEffectiveOpenskyMilitaryIntervalSec(
      runtime,
      budgetSummary.currentPeriod,
      budgetSummary.degradationLevel,
    );
    const snapshot = this.buildAdsbLatestSnapshot(
      sourceEndpoint,
      states.map((entry) => entry.raw),
      states.length,
      Date.now(),
      this.getAdsbStaleThresholdSeconds(staleIntervalSec),
    );
    return {
      configured: true,
      requiresZoom: false,
      budgetLimited: false,
      sourceEndpoint,
      budgetSummary,
      snapshot,
    };
  }

  private hasOpenskyCredentials(runtime: RealtimeSignalsRuntimeConfig) {
    return Boolean(
      this.normalizeString(runtime.opensky.clientId) &&
        this.normalizeString(runtime.opensky.clientSecret),
    );
  }

  private getOpenskyBaseUrl(runtime: RealtimeSignalsRuntimeConfig) {
    return (
      this.normalizeUrl(runtime.opensky.baseUrl) ?? OPENSKY_DEFAULT_BASE_URL
    );
  }

  private getOpenskyTokenUrl(runtime: RealtimeSignalsRuntimeConfig) {
    return (
      this.normalizeUrl(runtime.opensky.tokenUrl) ?? OPENSKY_DEFAULT_TOKEN_URL
    );
  }

  private async fetchConservativeMilitaryOpenSkyStates(
    runtime: RealtimeSignalsRuntimeConfig,
    budgetSummary?: RealtimeOpenskyBudgetSummary,
  ) {
    const regionCacheKeys = OPENSKY_MILITARY_QUERY_REGIONS.map(
      (region) => `realtime-signals:opensky:region:${region.key}`,
    );
    const cachedRegions =
      await this.cache.getMany<OpenSkyStateVector[]>(regionCacheKeys);
    const effectiveBudget =
      budgetSummary ??
      (await this.getOpenskyBudgetSummary(runtime, Date.now()));
    const missingRegions = OPENSKY_MILITARY_QUERY_REGIONS.filter(
      (_, index) => !Array.isArray(cachedRegions[index]),
    );
    if (effectiveBudget.militaryPaused && missingRegions.length > 0) {
      await this.recordOpenskyBudgetEvent("skippedMilitaryCount");
      throw new OpenSkyBudgetExhaustedError(
        "OpenSky military polling is paused because the daily credit budget is exhausted.",
      );
    }
    if (missingRegions.length === 0) {
      return this.dedupeOpenskyStateVectors(
        cachedRegions
          .flatMap((entry) => (Array.isArray(entry) ? entry : []))
          .filter((state) => this.isConservativeMilitaryState(state)),
      );
    }

    const accessToken = await this.getOpenskyAccessToken(runtime);
    const missingRegionCredits = missingRegions.reduce(
      (total, region) => total + region.credits,
      0,
    );
    const reserveResult = await this.reserveOpenskyCredits(runtime, {
      scope: "military",
      credits: missingRegionCredits,
      requestCount: missingRegions.length,
    });
    if (!reserveResult.allowed) {
      await this.recordOpenskyBudgetEvent("skippedMilitaryCount");
      throw new OpenSkyBudgetReserveError(
        "OpenSky military polling skipped because there are not enough remaining daily credits for the next region batch.",
      );
    }

    const regionStates = await Promise.all(
      OPENSKY_MILITARY_QUERY_REGIONS.map((region, index) => {
        const cached = cachedRegions[index];
        if (Array.isArray(cached)) {
          return cached;
        }
        return this.fetchOpenSkyStates(runtime, {
          scope: "military",
          bbox: region.bbox,
          cacheKey: regionCacheKeys[index]!,
          cacheTtlSeconds: OPENSKY_REGION_CACHE_TTL_SECONDS,
          reserveBudget: false,
          accessToken,
        });
      }),
    );
    return this.dedupeOpenskyStateVectors(
      regionStates
        .flat()
        .filter((state) => this.isConservativeMilitaryState(state)),
    );
  }

  private async fetchOpenSkyViewportStates(
    runtime: RealtimeSignalsRuntimeConfig,
    bbox: [number, number, number, number],
  ) {
    const signature = bbox.map((value) => value.toFixed(3)).join(",");
    return this.fetchOpenSkyStates(runtime, {
      scope: "all",
      bbox,
      cacheKey: `realtime-signals:opensky:viewport:${signature}`,
      cacheTtlSeconds: OPENSKY_VIEWPORT_CACHE_TTL_SECONDS,
      reserveBudget: true,
    });
  }

  private async fetchOpenSkyStates(
    runtime: RealtimeSignalsRuntimeConfig,
    options: {
      scope: OpenSkyCreditScope;
      bbox: [number, number, number, number];
      cacheKey: string;
      cacheTtlSeconds: number;
      reserveBudget: boolean;
      accessToken?: string;
    },
  ) {
    const credits = this.estimateOpenskyCreditsForBbox(options.bbox);
    return this.cache.wrap(
      options.cacheKey,
      options.cacheTtlSeconds,
      async () => {
        const accessToken =
          options.accessToken ?? (await this.getOpenskyAccessToken(runtime));
        const endpoint = this.buildOpenskyStatesEndpoint(
          this.getOpenskyBaseUrl(runtime),
          options.bbox,
        );
        if (options.reserveBudget) {
          const reserveResult = await this.reserveOpenskyCredits(runtime, {
            scope: options.scope,
            credits,
            requestCount: 1,
          });
          if (!reserveResult.allowed) {
            throw new OpenSkyBudgetReserveError(
              "OpenSky daily credit budget does not have enough remaining credits for this viewport request.",
            );
          }
        }
        try {
          const payload = await this.fetchJsonWithRetry<OpenSkyStateResponse>(
            endpoint,
            runtime,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
              maxRetries: 0,
            },
          );
          return this.readOpenskyStateVectors(payload);
        } catch (error) {
          await this.recordOpenskyError(error);
          throw error;
        }
      },
      {
        lockTtlMs: 20_000,
        retryDelayMs: 100,
        maxWaitMs: 10_000,
      },
    );
  }

  private async getOpenskyAccessToken(runtime: RealtimeSignalsRuntimeConfig) {
    const clientId = this.normalizeString(runtime.opensky.clientId);
    const clientSecret = this.normalizeString(runtime.opensky.clientSecret);
    if (!clientId || !clientSecret) {
      throw new Error("OpenSky OAuth client credentials are not configured");
    }

    const tokenUrl = this.getOpenskyTokenUrl(runtime);
    const cacheKey = `realtime-signals:opensky:oauth:${encodeURIComponent(
      `${tokenUrl}|${clientId}`,
    )}`;
    const cached = await this.cache.get<{ accessToken: string }>(cacheKey);
    if (cached?.accessToken) {
      return cached.accessToken;
    }

    const payload = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });
    try {
      const response = await this.fetchJsonWithRetry<{
        access_token?: unknown;
        expires_in?: unknown;
      }>(tokenUrl, runtime, {
        method: "POST",
        rawBody: payload.toString(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        shouldRetry: (error) => {
          const kind = this.classifyOpenskyError(error);
          return (
            kind === "rate_limited" ||
            kind === "server" ||
            kind === "timeout" ||
            kind === "network"
          );
        },
      });

      const accessToken = this.normalizeString(response.access_token);
      if (!accessToken) {
        throw new Error(
          "OpenSky OAuth token response did not include access_token",
        );
      }
      const expiresInSec = Math.max(
        60,
        Math.trunc(this.toFiniteNumber(response.expires_in) ?? 300),
      );
      await this.cache.set(
        cacheKey,
        { accessToken },
        Math.max(30, expiresInSec - 60),
      );
      return accessToken;
    } catch (error) {
      await this.recordOpenskyError(error);
      throw error;
    }
  }

  private buildOpenskyStatesEndpoint(
    baseUrl: string,
    bbox: [number, number, number, number],
  ) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const url = new URL(`${baseUrl}/states/all`);
    url.searchParams.set("lamin", String(minLat));
    url.searchParams.set("lomin", String(minLng));
    url.searchParams.set("lamax", String(maxLat));
    url.searchParams.set("lomax", String(maxLng));
    return url.toString();
  }

  private readOpenskyStateVectors(payload: unknown) {
    const states = this.readArray((payload as OpenSkyStateResponse)?.states);
    const parsed: OpenSkyStateVector[] = [];
    for (const entry of states) {
      const state = this.parseOpenskyStateVector(entry);
      if (state) {
        parsed.push(state);
      }
    }
    return parsed;
  }

  private parseOpenskyStateVector(entry: unknown): OpenSkyStateVector | null {
    if (!Array.isArray(entry)) {
      return null;
    }

    const icao24 = this.normalizeString(entry[0])?.toLowerCase();
    if (!icao24) {
      return null;
    }

    const callsign = this.normalizeString(entry[1]);
    const countryName = this.normalizeString(entry[2]);
    const lastContactSec =
      this.toFiniteNumber(entry[4]) ?? this.toFiniteNumber(entry[3]) ?? 0;
    const lastContactMs = Math.max(0, Math.trunc(lastContactSec * 1_000));
    const altitudeMeters =
      this.toFiniteNumber(entry[13]) ?? this.toFiniteNumber(entry[7]);
    const velocityMetersPerSecond = this.toFiniteNumber(entry[9]);
    const heading = this.toFiniteNumber(entry[10]);
    const longitude = this.toFiniteNumber(entry[5]) ?? undefined;
    const latitude = this.toFiniteNumber(entry[6]) ?? undefined;

    return {
      icao24,
      ...(callsign ? { callsign } : {}),
      ...(countryName ? { countryName } : {}),
      ...(lastContactMs > 0
        ? {
            lastContactAt: new Date(lastContactMs).toISOString(),
          }
        : {}),
      lastContactMs,
      ...(typeof longitude === "number" ? { longitude } : {}),
      ...(typeof latitude === "number" ? { latitude } : {}),
      ...(typeof heading === "number" ? { heading } : {}),
      ...(typeof altitudeMeters === "number"
        ? { altitudeFt: Math.round(altitudeMeters * FEET_PER_METER) }
        : {}),
      ...(typeof velocityMetersPerSecond === "number"
        ? {
            groundSpeedKt: Math.round(
              velocityMetersPerSecond * KNOTS_PER_METER_PER_SECOND,
            ),
          }
        : {}),
      raw: entry,
    };
  }

  private dedupeOpenskyStateVectors(states: OpenSkyStateVector[]) {
    const deduped = new Map<string, OpenSkyStateVector>();
    for (const state of states) {
      const current = deduped.get(state.icao24);
      if (!current) {
        deduped.set(state.icao24, state);
        continue;
      }
      deduped.set(
        state.icao24,
        state.lastContactMs >= current.lastContactMs ? state : current,
      );
    }
    return Array.from(deduped.values());
  }

  private isConservativeMilitaryState(state: OpenSkyStateVector) {
    const callsign = this.normalizeString(state.callsign)?.toUpperCase();
    const hasMilitaryCallsign = callsign
      ? OPENSKY_HIGH_CONFIDENCE_CALLSIGN_PATTERNS.some((pattern) =>
          pattern.test(callsign),
        )
      : false;
    const hasMilitaryHexRange = state.icao24.startsWith("ae");
    return hasMilitaryCallsign || hasMilitaryHexRange;
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
    const oldestObservedAt =
      normalizedEntries[normalizedEntries.length - 1]?.observedAt;

    return {
      source: "opensky",
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
    const state = this.parseOpenskyStateVector(entry);
    if (!state) {
      return { snapshot: null, dropReason: "invalid_position" };
    }

    if (
      typeof state.latitude !== "number" ||
      typeof state.longitude !== "number" ||
      state.latitude < -90 ||
      state.latitude > 90 ||
      state.longitude < -180 ||
      state.longitude > 180
    ) {
      return { snapshot: null, dropReason: "invalid_position" };
    }

    if (!state.icao24) {
      return { snapshot: null, dropReason: "missing_identity" };
    }

    const observedAt =
      state.lastContactAt ?? new Date(fetchedAtMs).toISOString();
    const observedAtMs = Date.parse(observedAt);
    if (
      Number.isFinite(observedAtMs) &&
      fetchedAtMs - observedAtMs > staleThresholdSec * 1_000
    ) {
      return { snapshot: null, dropReason: "stale_position" };
    }
    const countryCode = this.resolveOpenSkyCountryCode(state.countryName);
    const countryName =
      this.normalizeString(state.countryName) ??
      (countryCode ? getCountryName(countryCode) : undefined);

    return {
      snapshot: {
        id: state.icao24,
        icao24: state.icao24,
        ...(state.callsign ? { callsign: state.callsign } : {}),
        lat: state.latitude,
        lng: state.longitude,
        ...(typeof state.heading === "number"
          ? { heading: state.heading }
          : {}),
        ...(typeof state.altitudeFt === "number"
          ? { altitudeFt: state.altitudeFt }
          : {}),
        ...(typeof state.groundSpeedKt === "number"
          ? { groundSpeedKt: state.groundSpeedKt }
          : {}),
        ...(countryCode ? { countryCode } : {}),
        ...(countryName ? { countryName } : {}),
        observedAt,
        source: "opensky",
      },
    };
  }

  private selectPreferredAdsbAircraftSnapshot(
    current: RealtimeAdsbAircraftSnapshot,
    candidate: RealtimeAdsbAircraftSnapshot,
  ) {
    const currentObservedMs = Date.parse(current.observedAt);
    const candidateObservedMs = Date.parse(candidate.observedAt);
    if (
      Number.isFinite(candidateObservedMs) &&
      Number.isFinite(currentObservedMs)
    ) {
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
      ...((previousSnapshot.latestObservedAt ??
      previousSnapshot.diagnostics.latestObservedAt)
        ? {
            latestObservedAt:
              previousSnapshot.latestObservedAt ??
              previousSnapshot.diagnostics.latestObservedAt,
          }
        : {}),
      diagnostics: {
        ...((previousSnapshot.latestObservedAt ??
        previousSnapshot.diagnostics.latestObservedAt)
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
      (typeof snapshotAgeSec === "number" &&
        snapshotAgeSec > staleThresholdSec) ||
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
      ...(typeof latestObservedAgeSec === "number"
        ? { latestObservedAgeSec }
        : {}),
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
    if (
      diagnostics.freshness === "missing" ||
      diagnostics.freshness === "stale"
    ) {
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

  private resolveOpenSkyCountryCode(countryName: string | undefined) {
    if (!countryName) {
      return undefined;
    }
    const extractedCountryCode =
      extractCountryCodeFromText(countryName) ?? undefined;
    const normalizedCountryCode =
      normalizeCountryCode(countryName) ?? undefined;
    return (
      this.toAdsbDisplayCountryCode(extractedCountryCode) ??
      this.toAdsbDisplayCountryCode(normalizedCountryCode) ??
      this.toAdsbDisplayCountryCode(countryName)
    );
  }

  private buildOpenskyBudgetContext(
    budgetSummary: RealtimeOpenskyBudgetSummary,
  ) {
    return {
      dateHkt: budgetSummary.dateHkt,
      dailyCreditBudget: budgetSummary.dailyBudget,
      usedCredits: budgetSummary.usedCredits,
      remainingCredits: budgetSummary.remainingCredits,
      usagePct: budgetSummary.usagePct,
      currentPeriod: budgetSummary.currentPeriod,
      effectiveIntervalSec: budgetSummary.effectiveMilitaryIntervalSec,
      budgetDegradation: budgetSummary.degradationLevel,
      allModeBlocked: budgetSummary.allModeBlocked,
      militaryPaused: budgetSummary.militaryPaused,
    };
  }

  private getOpenskyBudgetKey(dateHkt: string) {
    return `realtime-signals:opensky:credits:${dateHkt}`;
  }

  private getOpenskyHktParts(nowMs: number) {
    const parts = OPENSKY_HKT_FORMATTER.formatToParts(new Date(nowMs));
    const byType = new Map<string, string>();
    for (const part of parts) {
      byType.set(part.type, part.value);
    }
    return {
      year: Number(byType.get("year")),
      month: Number(byType.get("month")),
      day: Number(byType.get("day")),
      hour: Number(byType.get("hour")),
    };
  }

  private getOpenskyHktDate(nowMs: number) {
    const parts = this.getOpenskyHktParts(nowMs);
    return `${parts.year.toString().padStart(4, "0")}-${parts.month
      .toString()
      .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
  }

  private getOpenskyBudgetPeriod(
    runtime: RealtimeSignalsRuntimeConfig,
    nowMs: number,
  ): RealtimeOpenskyBudgetPeriod {
    const hour = this.getOpenskyHktParts(nowMs).hour;
    return hour >= runtime.opensky.dayStartHourHkt &&
      hour < runtime.opensky.nightStartHourHkt
      ? "day"
      : "night";
  }

  private getConfiguredOpenskyMilitaryIntervalSec(
    runtime: RealtimeSignalsRuntimeConfig,
    currentPeriod: RealtimeOpenskyBudgetPeriod,
  ) {
    return currentPeriod === "day"
      ? runtime.opensky.dayIntervalSec
      : runtime.opensky.nightIntervalSec;
  }

  private resolveOpenskyBudgetDegradationLevel(
    runtime: RealtimeSignalsRuntimeConfig,
    remainingCredits: number,
    remainingPct: number,
  ): RealtimeOpenskyBudgetDegradationLevel {
    if (remainingCredits <= 0) {
      return "exhausted";
    }
    if (remainingPct <= runtime.opensky.criticalRemainingPct) {
      return "critical";
    }
    if (remainingPct <= runtime.opensky.warningRemainingPct) {
      return "warning";
    }
    return "normal";
  }

  private getEffectiveOpenskyMilitaryIntervalSec(
    runtime: RealtimeSignalsRuntimeConfig,
    currentPeriod: RealtimeOpenskyBudgetPeriod,
    degradationLevel: RealtimeOpenskyBudgetDegradationLevel,
  ) {
    const configured = this.getConfiguredOpenskyMilitaryIntervalSec(
      runtime,
      currentPeriod,
    );
    if (degradationLevel === "critical" || degradationLevel === "exhausted") {
      return Math.max(configured, runtime.opensky.nightIntervalSec);
    }
    return configured;
  }

  private readOpenskyBudgetNumber(
    payload: Record<string, string>,
    field: OpenSkyBudgetCounterField,
  ) {
    const parsed = Number(payload[field] ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private buildEmptyOpenskyBudgetDaySummary(
    dateHkt: string,
  ): RealtimeOpenskyBudgetDaySummary {
    return {
      dateHkt,
      usedCredits: 0,
      requestCount: 0,
      militaryCredits: 0,
      allCredits: 0,
      militaryCalls: 0,
      allCalls: 0,
      errorCalls: 0,
      authErrorCalls: 0,
      rateLimitedErrorCalls: 0,
      serverErrorCalls: 0,
      timeoutErrorCalls: 0,
      networkErrorCalls: 0,
      unknownErrorCalls: 0,
      blockedAllModeCount: 0,
      skippedMilitaryCount: 0,
    };
  }

  private async getOpenskyBudgetDaySummary(dateHkt: string) {
    const payload = await this.cache.hgetall(this.getOpenskyBudgetKey(dateHkt));
    if (!payload || Object.keys(payload).length === 0) {
      return this.buildEmptyOpenskyBudgetDaySummary(dateHkt);
    }
    return {
      dateHkt,
      usedCredits: this.readOpenskyBudgetNumber(payload, "usedCredits"),
      requestCount: this.readOpenskyBudgetNumber(payload, "requestCount"),
      militaryCredits: this.readOpenskyBudgetNumber(payload, "militaryCredits"),
      allCredits: this.readOpenskyBudgetNumber(payload, "allCredits"),
      militaryCalls: this.readOpenskyBudgetNumber(payload, "militaryCalls"),
      allCalls: this.readOpenskyBudgetNumber(payload, "allCalls"),
      errorCalls: this.readOpenskyBudgetNumber(payload, "errorCalls"),
      authErrorCalls: this.readOpenskyBudgetNumber(payload, "authErrorCalls"),
      rateLimitedErrorCalls: this.readOpenskyBudgetNumber(
        payload,
        "rateLimitedErrorCalls",
      ),
      serverErrorCalls: this.readOpenskyBudgetNumber(
        payload,
        "serverErrorCalls",
      ),
      timeoutErrorCalls: this.readOpenskyBudgetNumber(
        payload,
        "timeoutErrorCalls",
      ),
      networkErrorCalls: this.readOpenskyBudgetNumber(
        payload,
        "networkErrorCalls",
      ),
      unknownErrorCalls: this.readOpenskyBudgetNumber(
        payload,
        "unknownErrorCalls",
      ),
      blockedAllModeCount: this.readOpenskyBudgetNumber(
        payload,
        "blockedAllModeCount",
      ),
      skippedMilitaryCount: this.readOpenskyBudgetNumber(
        payload,
        "skippedMilitaryCount",
      ),
    };
  }

  private buildRecentOpenskyBudgetDates(nowMs: number, days: number) {
    return Array.from({ length: days }, (_, index) =>
      this.getOpenskyHktDate(nowMs - index * 24 * 60 * 60 * 1_000),
    );
  }

  private getOpenskyBudgetTtlSeconds() {
    return 60 * 60 * 24 * OPENSKY_BUDGET_RETENTION_DAYS;
  }

  private getOpenskyBudgetCallsField(scope: OpenSkyCreditScope) {
    return scope === "military" ? "militaryCalls" : "allCalls";
  }

  private getOpenskyBudgetCreditsField(scope: OpenSkyCreditScope) {
    return scope === "military" ? "militaryCredits" : "allCredits";
  }

  private async reserveOpenskyCredits(
    runtime: RealtimeSignalsRuntimeConfig,
    options: {
      scope: OpenSkyCreditScope;
      credits: number;
      requestCount: number;
      occurredAtMs?: number;
    },
  ): Promise<OpenSkyBudgetReserveResult> {
    const dateHkt = this.getOpenskyHktDate(options.occurredAtMs ?? Date.now());
    const key = this.getOpenskyBudgetKey(dateHkt);
    const response = (await this.redis.eval(
      OPENSKY_BUDGET_RESERVE_LUA_SCRIPT,
      OPENSKY_BUDGET_RESERVE_LUA_KEYS,
      key,
      Math.max(1, runtime.opensky.dailyCreditBudget),
      Math.max(0, Math.trunc(options.credits)),
      Math.max(0, Math.trunc(options.requestCount)),
      this.getOpenskyBudgetCallsField(options.scope),
      this.getOpenskyBudgetCreditsField(options.scope),
      this.getOpenskyBudgetTtlSeconds(),
    )) as unknown[];
    const allowed = Number(response?.[0]) === 1;
    const usedCredits = Number(response?.[1] ?? 0);
    const remainingCredits = Number(response?.[2] ?? 0);
    return {
      allowed,
      usedCredits: Number.isFinite(usedCredits) ? usedCredits : 0,
      remainingCredits: Number.isFinite(remainingCredits)
        ? remainingCredits
        : 0,
    };
  }

  private getOpenskyErrorBudgetField(kind: RealtimeOpenskyErrorKind) {
    switch (kind) {
      case "auth":
        return "authErrorCalls";
      case "rate_limited":
        return "rateLimitedErrorCalls";
      case "server":
        return "serverErrorCalls";
      case "timeout":
        return "timeoutErrorCalls";
      case "network":
        return "networkErrorCalls";
      default:
        return "unknownErrorCalls";
    }
  }

  private async recordOpenskyError(error: unknown, occurredAtMs?: number) {
    if (
      error &&
      typeof error === "object" &&
      (error as { __openskyBudgetErrorRecorded?: boolean })
        .__openskyBudgetErrorRecorded === true
    ) {
      return;
    }
    const details = this.toDiagnosticErrorDetails(error);
    const dateHkt = this.getOpenskyHktDate(occurredAtMs ?? Date.now());
    const key = this.getOpenskyBudgetKey(dateHkt);
    await Promise.all([
      this.cache.hincrby(key, "errorCalls", 1),
      this.cache.hincrby(key, this.getOpenskyErrorBudgetField(details.kind), 1),
      this.cache.expire(key, this.getOpenskyBudgetTtlSeconds()),
    ]);
    if (error && typeof error === "object") {
      (
        error as { __openskyBudgetErrorRecorded?: boolean }
      ).__openskyBudgetErrorRecorded = true;
    }
  }

  private async recordOpenskyBudgetEvent(
    field:
      | "errorCalls"
      | "authErrorCalls"
      | "rateLimitedErrorCalls"
      | "serverErrorCalls"
      | "timeoutErrorCalls"
      | "networkErrorCalls"
      | "unknownErrorCalls"
      | "blockedAllModeCount"
      | "skippedMilitaryCount",
    occurredAtMs?: number,
  ) {
    const dateHkt = this.getOpenskyHktDate(occurredAtMs ?? Date.now());
    const key = this.getOpenskyBudgetKey(dateHkt);
    await Promise.all([
      this.cache.hincrby(key, field, 1),
      this.cache.expire(key, this.getOpenskyBudgetTtlSeconds()),
    ]);
  }

  private estimateOpenskyCreditsForBbox(
    bbox?: [number, number, number, number],
  ) {
    if (!bbox) {
      return 4;
    }
    const area = Math.abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
    if (area <= 25) {
      return 1;
    }
    if (area <= 100) {
      return 2;
    }
    if (area <= 400) {
      return 3;
    }
    return 4;
  }

  private async getOpenskyBudgetSummary(
    runtime: RealtimeSignalsRuntimeConfig,
    nowMs = Date.now(),
  ): Promise<RealtimeOpenskyBudgetSummary> {
    const dateHkt = this.getOpenskyHktDate(nowMs);
    const recentDates = this.buildRecentOpenskyBudgetDates(
      nowMs,
      OPENSKY_BUDGET_RECENT_DAYS,
    );
    const [today, recentDays] = await Promise.all([
      this.getOpenskyBudgetDaySummary(dateHkt),
      Promise.all(
        recentDates.map((entryDate) =>
          this.getOpenskyBudgetDaySummary(entryDate),
        ),
      ),
    ]);
    const dailyBudget = Math.max(1, runtime.opensky.dailyCreditBudget);
    const usedCredits = today.usedCredits;
    const remainingCredits = Math.max(0, dailyBudget - usedCredits);
    const usagePct = Number(((usedCredits / dailyBudget) * 100).toFixed(2));
    const remainingPct = Number(
      ((remainingCredits / dailyBudget) * 100).toFixed(2),
    );
    const currentPeriod = this.getOpenskyBudgetPeriod(runtime, nowMs);
    const degradationLevel = this.resolveOpenskyBudgetDegradationLevel(
      runtime,
      remainingCredits,
      remainingPct,
    );
    const effectiveMilitaryIntervalSec =
      this.getEffectiveOpenskyMilitaryIntervalSec(
        runtime,
        currentPeriod,
        degradationLevel,
      );

    return {
      timezone: OPENSKY_HKT_TIME_ZONE,
      dateHkt,
      dailyBudget,
      usedCredits,
      remainingCredits,
      usagePct,
      remainingPct,
      requestCount: today.requestCount,
      militaryCredits: today.militaryCredits,
      allCredits: today.allCredits,
      militaryCalls: today.militaryCalls,
      allCalls: today.allCalls,
      errorCalls: today.errorCalls,
      authErrorCalls: today.authErrorCalls,
      rateLimitedErrorCalls: today.rateLimitedErrorCalls,
      serverErrorCalls: today.serverErrorCalls,
      timeoutErrorCalls: today.timeoutErrorCalls,
      networkErrorCalls: today.networkErrorCalls,
      unknownErrorCalls: today.unknownErrorCalls,
      blockedAllModeCount: today.blockedAllModeCount,
      skippedMilitaryCount: today.skippedMilitaryCount,
      currentPeriod,
      dayIntervalSec: runtime.opensky.dayIntervalSec,
      nightIntervalSec: runtime.opensky.nightIntervalSec,
      effectiveMilitaryIntervalSec,
      degradationLevel,
      allModeBlocked: degradationLevel !== "normal",
      militaryPaused: degradationLevel === "exhausted",
      warningRemainingPct: runtime.opensky.warningRemainingPct,
      criticalRemainingPct: runtime.opensky.criticalRemainingPct,
      recentDays,
    };
  }

  private getAdsbSnapshotTtlSeconds(intervalSec: number) {
    const safeIntervalSec = Math.max(60, Math.trunc(intervalSec));
    return Math.max(20 * 60, safeIntervalSec * 2);
  }

  private getAisSnapshotTtlSeconds(intervalSec: number) {
    const safeIntervalSec = Math.max(60, Math.trunc(intervalSec));
    return Math.max(10 * 60, safeIntervalSec * 2);
  }

  private normalizeAisMmsi(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(Math.trunc(value));
    }
    return this.normalizeString(value);
  }

  private resolveAisRelayStatusReason(snapshot: RealtimeAisLatestSnapshot) {
    const statusReasonCode = this.normalizeString(
      snapshot.diagnostics.statusReasonCode,
    );
    const statusReason = this.normalizeString(
      snapshot.diagnostics.statusReason,
    );
    if (statusReasonCode || statusReason) {
      return {
        code: statusReasonCode ?? "ais_relay_degraded",
        reason:
          statusReason ?? "AIS relay reported a degraded processing state.",
      };
    }
    if (!snapshot.status.connected) {
      const lastUpstreamError = this.normalizeString(
        snapshot.diagnostics.lastUpstreamError,
      );
      return {
        code: "ais_upstream_disconnected",
        reason: lastUpstreamError
          ? `AIS relay is reachable, but the upstream AIS stream is disconnected. Last upstream error: ${lastUpstreamError}`
          : "AIS relay is reachable, but the upstream AIS stream is disconnected.",
      };
    }
    if (
      snapshot.diagnostics.positionReportsSeen > 0 &&
      snapshot.diagnostics.positionReportsProcessed === 0 &&
      snapshot.status.vessels === 0
    ) {
      return {
        code: "ais_position_reports_not_retained",
        reason:
          "AIS relay is receiving position reports, but none are being retained as vessel snapshots.",
      };
    }
    return undefined;
  }

  private buildAisRelayContext(snapshot: RealtimeAisLatestSnapshot) {
    const relayStatusReason = this.resolveAisRelayStatusReason(snapshot);
    return {
      source: "relay",
      configured: true,
      connected: snapshot.status.connected,
      disruptions: snapshot.disruptions.length,
      densityRegions: snapshot.density.length,
      candidateCount: snapshot.candidateReports.length,
      vesselCount: snapshot.status.vessels,
      snapshotUpdatedAt: snapshot.updatedAt,
      allVesselsAvailable: snapshot.hasVesselSnapshot,
      messageCount: snapshot.status.messages,
      droppedMessages: snapshot.status.droppedMessages,
      healthState: relayStatusReason
        ? "degraded"
        : snapshot.diagnostics.healthState,
      positionReportsSeen: snapshot.diagnostics.positionReportsSeen,
      positionReportsProcessed: snapshot.diagnostics.positionReportsProcessed,
      ignoredPositionReports: snapshot.diagnostics.ignoredPositionReports,
      parseErrors: snapshot.diagnostics.parseErrors,
      ...(relayStatusReason?.code
        ? { statusReasonCode: relayStatusReason.code }
        : {}),
      ...(relayStatusReason?.reason
        ? { statusReason: relayStatusReason.reason }
        : {}),
      ...(snapshot.diagnostics.lastHealthyAt
        ? { lastHealthyAt: snapshot.diagnostics.lastHealthyAt }
        : {}),
      ...(snapshot.diagnostics.lastIssueAt
        ? { lastIssueAt: snapshot.diagnostics.lastIssueAt }
        : {}),
      ...(snapshot.diagnostics.lastUpstreamErrorAt
        ? { lastUpstreamErrorAt: snapshot.diagnostics.lastUpstreamErrorAt }
        : {}),
      ...(snapshot.diagnostics.lastUpstreamError
        ? { lastUpstreamError: snapshot.diagnostics.lastUpstreamError }
        : {}),
      ...(snapshot.diagnostics.lastParseErrorAt
        ? { lastParseErrorAt: snapshot.diagnostics.lastParseErrorAt }
        : {}),
      ...(snapshot.diagnostics.lastParseError
        ? { lastParseError: snapshot.diagnostics.lastParseError }
        : {}),
    } satisfies Record<string, unknown>;
  }

  private logAisRelayStatusChange(
    orgId: string,
    snapshot: RealtimeAisLatestSnapshot,
  ) {
    const relayStatusReason = this.resolveAisRelayStatusReason(snapshot);
    const issueCode = relayStatusReason?.code ?? "ok";
    const previousIssueCode = this.aisRelayIssueCodeByOrg.get(orgId);
    if (previousIssueCode === issueCode) {
      return;
    }

    this.aisRelayIssueCodeByOrg.set(orgId, issueCode);
    if (issueCode === "ok") {
      if (previousIssueCode && previousIssueCode !== "ok") {
        logger.info(
          {
            orgId,
            source: "ais",
            previousIssueCode,
            updatedAt: snapshot.updatedAt,
          },
          "AIS relay snapshot recovered",
        );
      }
      return;
    }

    logger.warn(
      {
        orgId,
        source: "ais",
        issueCode,
        issueReason: relayStatusReason?.reason,
        connected: snapshot.status.connected,
        messages: snapshot.status.messages,
        vessels: snapshot.status.vessels,
        positionReportsSeen: snapshot.diagnostics.positionReportsSeen,
        positionReportsProcessed: snapshot.diagnostics.positionReportsProcessed,
        ignoredPositionReports: snapshot.diagnostics.ignoredPositionReports,
        parseErrors: snapshot.diagnostics.parseErrors,
        updatedAt: snapshot.updatedAt,
      },
      "AIS relay snapshot reports degraded state",
    );
  }

  private async fetchAisSignal(
    orgId: string,
    runtime: RealtimeSignalsRuntimeConfig,
  ) {
    const aisBase = this.normalizeUrl(runtime.aisRelay.baseUrl);
    if (!aisBase) {
      await this.store.clearLatestAisSnapshot(orgId);
      return [
        {
          metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.ais,
          value: 0,
          context: {
            source: "relay",
            configured: false,
            connected: false,
            disruptions: 0,
            densityRegions: 0,
            candidateCount: 0,
            vesselCount: 0,
            allVesselsAvailable: false,
            countryCodes: [],
          },
        },
      ] satisfies RealtimeSignalFetchResult[];
    }
    const headers = this.buildAisHeaders(runtime);
    const payload = await this.fetchJsonWithRetry(
      `${aisBase}/ais/snapshot?candidates=true`,
      runtime,
      headers ? { headers } : undefined,
    );
    const snapshot = this.buildAisLatestSnapshot(
      payload,
      `${aisBase}/ais/snapshot`,
    );
    this.logAisRelayStatusChange(orgId, snapshot);
    await this.store.setLatestAisSnapshot(
      orgId,
      snapshot,
      this.getAisSnapshotTtlSeconds(runtime.sources.ais.intervalSec),
    );
    await this.persistAisTransportSnapshot(orgId, snapshot);

    const countries = new Set<string>();
    for (const disruption of snapshot.disruptions) {
      const code = this.extractCountryCode(disruption.region);
      if (code) {
        countries.add(code);
      }
    }

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.ais,
        value: snapshot.disruptions.length,
        context: {
          ...this.buildAisRelayContext(snapshot),
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
              ? "error" in acledFeed
                ? (acledFeed.error ?? null)
                : null
              : null,
            gdelt: "error" in gdeltFeed ? (gdeltFeed.error ?? null) : null,
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
    const coverageStart =
      await this.getProcessedArticleTermCoverageStart(orgId);
    const hasCoverage =
      coverageStart !== null &&
      coverageStart.getTime() <= baselineStart.getTime();

    const [recentTermRows, baselineTermRows, fallbackCounts] = hasCoverage
      ? await Promise.all([
          this.prisma.processedArticleTermHourly.groupBy({
            where: {
              orgId,
              bucketStart: { gte: recentStart },
            },
            by: ["term", "source"],
            _sum: {
              articleCount: true,
            },
          }),
          this.prisma.processedArticleTermHourly.groupBy({
            where: {
              orgId,
              bucketStart: { gte: baselineStart, lt: recentStart },
            },
            by: ["term"],
            _sum: {
              articleCount: true,
            },
          }),
          Promise.resolve(null),
        ])
      : await Promise.all([
          Promise.resolve([]),
          Promise.resolve([]),
          this.loadKeywordSpikeFallbackCounts(
            orgId,
            recentStart,
            baselineStart,
          ),
        ]);

    const resolvedFallbackCounts =
      !fallbackCounts &&
      recentTermRows.length === 0 &&
      baselineTermRows.length === 0
        ? await this.loadKeywordSpikeFallbackCounts(
            orgId,
            recentStart,
            baselineStart,
          )
        : fallbackCounts;
    const recentCounts =
      resolvedFallbackCounts?.recentCounts ??
      this.buildRecentTermCountsFromBuckets(recentTermRows);
    const baselineCounts =
      resolvedFallbackCounts?.baselineCounts ??
      this.buildBaselineTermCountsFromBuckets(baselineTermRows);

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
          recentArticleCount:
            resolvedFallbackCounts?.recentArticleCount ??
            recentTermRows.reduce(
              (total, row) => total + (row._sum.articleCount ?? 0),
              0,
            ),
          baselineArticleCount:
            resolvedFallbackCounts?.baselineArticleCount ??
            baselineTermRows.reduce(
              (total, row) => total + (row._sum.articleCount ?? 0),
              0,
            ),
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
    const coverageStart =
      await this.getProcessedArticleTermCoverageStart(orgId);
    const hasCoverage =
      coverageStart !== null && coverageStart.getTime() <= since.getTime();

    if (!hasCoverage) {
      return this.countNewsActivityFallback(orgId, searchTokens, since);
    }

    const rows = await this.prisma.processedArticleTermHourly.groupBy({
      where: {
        orgId,
        bucketStart: { gte: since },
        term: { in: searchTokens },
      },
      by: ["term"],
      _sum: {
        articleCount: true,
      },
    });

    const groupedCount = rows.reduce(
      (maxCount, row) => Math.max(maxCount, row._sum.articleCount ?? 0),
      0,
    );
    if (groupedCount > 0) {
      return groupedCount;
    }

    return this.countNewsActivityFallback(orgId, searchTokens, since);
  }

  private async getProcessedArticleTermCoverageStart(orgId: string) {
    const cached = await this.cache.wrap<{ bucketStart: string | null } | null>(
      `realtime-signals:processed-article-term-coverage:${orgId}`,
      PROCESSED_ARTICLE_TERM_COVERAGE_TTL_SECONDS,
      async () => {
        const row = await this.prisma.processedArticleTermHourly.findFirst({
          where: { orgId },
          orderBy: { bucketStart: "asc" },
          select: { bucketStart: true },
        });
        return row ? { bucketStart: row.bucketStart.toISOString() } : null;
      },
    );

    if (!cached?.bucketStart) {
      return null;
    }
    const parsed = new Date(cached.bucketStart);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  private async countNewsActivityFallback(
    orgId: string,
    searchTokens: string[],
    since: Date,
  ) {
    let total = 0;
    for (const token of searchTokens) {
      const count = await this.prisma.processedArticle.count({
        where: {
          status: ProcessedArticleStatus.completed,
          orgId,
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

  private buildRecentTermCountsFromBuckets(
    rows: Array<{
      term: string;
      source: string;
      _sum: { articleCount: number | null };
    }>,
  ) {
    const recentCounts = new Map<
      string,
      { count: number; sources: Set<string> }
    >();
    for (const row of rows) {
      const term = row.term.trim();
      if (!term) {
        continue;
      }
      const source = row.source.trim() || "unknown";
      const count = row._sum.articleCount ?? 0;
      const entry = recentCounts.get(term) ?? {
        count: 0,
        sources: new Set(),
      };
      entry.count += count;
      entry.sources.add(source);
      recentCounts.set(term, entry);
    }
    return recentCounts;
  }

  private buildBaselineTermCountsFromBuckets(
    rows: Array<{
      term: string;
      _sum: { articleCount: number | null };
    }>,
  ) {
    const baselineCounts = new Map<string, number>();
    for (const row of rows) {
      const term = row.term.trim();
      if (!term) {
        continue;
      }
      baselineCounts.set(
        term,
        (baselineCounts.get(term) ?? 0) + (row._sum.articleCount ?? 0),
      );
    }
    return baselineCounts;
  }

  private async loadKeywordSpikeFallbackCounts(
    orgId: string,
    recentStart: Date,
    baselineStart: Date,
  ) {
    const [recentArticles, baselineArticles] = await Promise.all([
      this.prisma.processedArticle.findMany({
        where: {
          status: ProcessedArticleStatus.completed,
          orgId,
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
          orgId,
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
      const source = normalizeProcessedArticleSource(article.source);
      for (const term of extractProcessedArticleTerms(article)) {
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
      for (const term of extractProcessedArticleTerms(article)) {
        baselineCounts.set(term, (baselineCounts.get(term) ?? 0) + 1);
      }
    }

    return {
      recentCounts,
      baselineCounts,
      recentArticleCount: recentArticles.length,
      baselineArticleCount: baselineArticles.length,
    };
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
        Math.floor(this.toFiniteNumber(countRow?.recentProcessedItems) ?? 0),
      );
      const recentProcessedItemsWithLocation = Math.max(
        0,
        Math.floor(
          this.toFiniteNumber(countRow?.recentProcessedItemsWithLocation) ?? 0,
        ),
      );

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
      this.parseTimestampMs(options.sourceState?.lastSuccessAt) ??
      (typeof options.lastRunMs === "number" &&
      Number.isFinite(options.lastRunMs)
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
        code:
          options.source === "opensky"
            ? options.sourceState.lastErrorKind
            : undefined,
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
      this.normalizeString(options.context?.snapshotFreshness) === "stale"
    ) {
      return {
        status: "stale" as const,
        code: "opensky_snapshot_stale",
        reason: "Latest OpenSky snapshot is stale.",
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

  private parseTimestampMs(value: string | undefined) {
    const normalized = this.normalizeString(value);
    if (!normalized) {
      return null;
    }
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private normalizeOpenskyBudgetDegradation(
    value: string | undefined,
  ): RealtimeOpenskyBudgetDegradationLevel | undefined {
    switch (value) {
      case "normal":
      case "warning":
      case "critical":
      case "exhausted":
        return value;
      default:
        return undefined;
    }
  }

  private getOpenskyStatusReasonMessage(code: string, message: string) {
    return { code, message } satisfies OpenSkyDiagnosticMessage;
  }

  private getOpenskyBudgetLimitedMessage(
    degradationLevel: RealtimeOpenskyBudgetDegradationLevel,
    code?: string,
  ) {
    if (code === "opensky_budget_insufficient_credits") {
      return this.getOpenskyStatusReasonMessage(
        code,
        "OpenSky does not have enough remaining daily credits for this request.",
      );
    }
    if (degradationLevel === "critical") {
      return this.getOpenskyStatusReasonMessage(
        code ?? "opensky_budget_critical",
        "OpenSky all-flight mode is limited and military polling is running at the night interval to preserve the daily credit budget.",
      );
    }
    if (degradationLevel === "exhausted") {
      return this.getOpenskyStatusReasonMessage(
        code ?? "opensky_budget_exhausted",
        "OpenSky daily credit budget is exhausted; all-flight mode is paused until the next Hong Kong day begins.",
      );
    }
    return this.getOpenskyStatusReasonMessage(
      code ?? "opensky_budget_warning",
      "OpenSky all-flight mode is temporarily limited to preserve the daily credit budget.",
    );
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
      const budgetReservationFailureCode = this.normalizeString(
        context.budgetReservationFailureCode,
      );
      if (budgetReservationFailureCode) {
        return this.getOpenskyBudgetLimitedMessage(
          this.normalizeOpenskyBudgetDegradation(
            this.normalizeString(context.budgetDegradation),
          ) ?? "warning",
          budgetReservationFailureCode,
        );
      }
      if (context.militaryPaused === true) {
        return this.getOpenskyStatusReasonMessage(
          "opensky_budget_exhausted",
          "OpenSky military polling is paused because the daily credit budget is exhausted.",
        );
      }
      if (this.normalizeString(context.budgetDegradation) === "critical") {
        return this.getOpenskyStatusReasonMessage(
          "opensky_budget_critical",
          "OpenSky all-flight mode is limited and military polling is running at the night interval to preserve daily credits.",
        );
      }
      if (context.allModeBlocked === true) {
        return this.getOpenskyStatusReasonMessage(
          "opensky_budget_warning",
          "OpenSky all-flight mode is temporarily limited to preserve daily credits.",
        );
      }
      if (context.snapshotRetainedPrevious === true) {
        return this.getOpenskyStatusReasonMessage(
          "opensky_snapshot_retained_previous",
          "Using retained OpenSky snapshot after empty or unusable fetch.",
        );
      }
      const validPositionCount = this.toFiniteNumber(
        context.validPositionCount,
      );
      const totalAircraft = this.toFiniteNumber(context.totalAircraft);
      if (
        typeof totalAircraft === "number" &&
        totalAircraft > 0 &&
        validPositionCount === 0
      ) {
        return this.getOpenskyStatusReasonMessage(
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
        acledApiEnabled ? this.normalizeString(feedErrors?.acled) : undefined,
        this.normalizeString(feedErrors?.gdelt),
      ].filter((value): value is string => Boolean(value));
      if (messages.length > 0) {
        return { message: messages.join(" | ") };
      }
      return undefined;
    }
    if (source === "ais") {
      const statusReasonCode = this.normalizeString(context.statusReasonCode);
      const statusReason = this.normalizeString(context.statusReason);
      if (statusReasonCode || statusReason) {
        return {
          code: statusReasonCode ?? "ais_relay_degraded",
          message:
            statusReason ?? "AIS relay reported a degraded processing state.",
          status: "error",
        };
      }

      if (context.connected === false) {
        const lastUpstreamError = this.normalizeString(
          context.lastUpstreamError,
        );
        return {
          code: "ais_upstream_disconnected",
          message: lastUpstreamError
            ? `AIS relay is reachable, but the upstream AIS stream is disconnected. Last upstream error: ${lastUpstreamError}`
            : "AIS relay is reachable, but the upstream AIS stream is disconnected.",
          status: "error",
        };
      }

      const positionReportsSeen = this.toFiniteNumber(
        context.positionReportsSeen,
      );
      const positionReportsProcessed = this.toFiniteNumber(
        context.positionReportsProcessed,
      );
      const vesselCount = this.toFiniteNumber(context.vesselCount);
      if (
        typeof positionReportsSeen === "number" &&
        positionReportsSeen > 0 &&
        positionReportsProcessed === 0 &&
        vesselCount === 0
      ) {
        return {
          code: "ais_position_reports_not_retained",
          message:
            "AIS relay is receiving position reports, but none are being retained as vessel snapshots.",
          status: "error",
        };
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

  private isAbortError(error: unknown) {
    return (
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.message.toLowerCase().includes("aborted"))
    );
  }

  private readHttpStatus(error: unknown) {
    if (!error || typeof error !== "object") {
      return undefined;
    }
    const status = Number((error as { status?: unknown }).status);
    return Number.isFinite(status) ? status : undefined;
  }

  private classifyOpenskyError(error: unknown): RealtimeOpenskyErrorKind {
    const status = this.readHttpStatus(error);
    if (status === 401 || status === 403) {
      return "auth";
    }
    if (status === 429) {
      return "rate_limited";
    }
    if (typeof status === "number" && status >= 500) {
      return "server";
    }
    if (this.isAbortError(error)) {
      return "timeout";
    }
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (
        message.includes("oauth client credentials") ||
        message.includes("access_token") ||
        message.includes("unauthorized") ||
        message.includes("forbidden")
      ) {
        return "auth";
      }
      if (message.includes("429") || message.includes("rate limit")) {
        return "rate_limited";
      }
      if (message.includes("fetch failed") || message.includes("network")) {
        return "network";
      }
    }
    return "unknown";
  }

  private toDiagnosticErrorDetails(error: unknown): OpenSkyErrorDetails {
    const status = this.readHttpStatus(error);
    return {
      kind: this.classifyOpenskyError(error),
      status,
      message: this.toDiagnosticErrorMessage(error),
    };
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

  private async fetchJsonWithRetry<T>(
    url: string,
    runtime: RealtimeSignalsRuntimeConfig,
    options: JsonFetchOptions = {},
  ): Promise<T> {
    const timeoutMs = Math.max(1_000, Math.trunc(runtime.requestTimeoutMs));
    const maxRetries = Math.max(
      0,
      Math.trunc(options.maxRetries ?? runtime.maxRetries),
    );
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        await options.beforeAttempt?.();
        const response = await fetchWithIpv4Fallback(
          url,
          {
            body:
              typeof options.rawBody === "string"
                ? options.rawBody
                : options.body
                  ? JSON.stringify(options.body)
                  : undefined,
            headers: {
              accept: "application/json",
              ...(options.body && !options.rawBody
                ? { "content-type": "application/json" }
                : {}),
              ...(options.headers ?? {}),
            },
            method: options.method ?? "GET",
          },
          { timeoutMs },
        );
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
        const shouldRetry =
          attempt < maxRetries &&
          (options.shouldRetry ? options.shouldRetry(error) : true);
        if (!shouldRetry) {
          break;
        }
        if (shouldRetry) {
          const delayMs = Math.min(5_000, 300 * (attempt + 1));
          await this.sleep(delayMs);
        }
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

  private readArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private buildAisLatestSnapshot(
    payload: unknown,
    sourceEndpoint: string,
  ): RealtimeAisLatestSnapshot {
    const {
      updatedAt,
      status,
      diagnostics,
      disruptions,
      density,
      candidateReports,
      vessels,
    } = this.readAisSnapshotPayload(payload);
    return {
      source: "relay",
      sourceEndpoint,
      updatedAt,
      status,
      diagnostics,
      disruptions,
      density,
      candidateReports,
      vessels,
      hasVesselSnapshot: Array.isArray(
        (payload as { vessels?: unknown } | null | undefined)?.vessels,
      ),
    };
  }

  private normalizeAisStatusPayload(
    value: unknown,
  ): RealtimeAisRelayStatusSnapshot {
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return {
      connected: record.connected === true,
      vessels: Math.max(
        0,
        Math.round(this.toFiniteNumber(record.vessels) ?? 0),
      ),
      messages: Math.max(
        0,
        Math.round(this.toFiniteNumber(record.messages) ?? 0),
      ),
      clients: Math.max(
        0,
        Math.round(this.toFiniteNumber(record.clients) ?? 0),
      ),
      droppedMessages: Math.max(
        0,
        Math.round(this.toFiniteNumber(record.droppedMessages) ?? 0),
      ),
    };
  }

  private normalizeAisRelayDiagnostics(
    value: unknown,
  ): RealtimeAisRelayDiagnostics {
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const statusReasonCode = this.normalizeString(record.statusReasonCode);
    const statusReason = this.normalizeString(record.statusReason);
    const healthState =
      this.normalizeString(record.healthState) === "degraded" ||
      statusReasonCode ||
      statusReason
        ? "degraded"
        : "ok";
    return {
      healthState,
      ...(statusReasonCode ? { statusReasonCode } : {}),
      ...(statusReason ? { statusReason } : {}),
      positionReportsSeen: Math.max(
        0,
        Math.round(this.toFiniteNumber(record.positionReportsSeen) ?? 0),
      ),
      positionReportsProcessed: Math.max(
        0,
        Math.round(this.toFiniteNumber(record.positionReportsProcessed) ?? 0),
      ),
      ignoredPositionReports: Math.max(
        0,
        Math.round(this.toFiniteNumber(record.ignoredPositionReports) ?? 0),
      ),
      parseErrors: Math.max(
        0,
        Math.round(this.toFiniteNumber(record.parseErrors) ?? 0),
      ),
      ...(this.normalizeString(record.lastHealthyAt)
        ? { lastHealthyAt: this.toIsoTimestamp(record.lastHealthyAt) }
        : {}),
      ...(this.normalizeString(record.lastIssueAt)
        ? { lastIssueAt: this.toIsoTimestamp(record.lastIssueAt) }
        : {}),
      ...(this.normalizeString(record.lastUpstreamErrorAt)
        ? {
            lastUpstreamErrorAt: this.toIsoTimestamp(
              record.lastUpstreamErrorAt,
            ),
          }
        : {}),
      ...(this.normalizeString(record.lastUpstreamError)
        ? { lastUpstreamError: this.normalizeString(record.lastUpstreamError) }
        : {}),
      ...(this.normalizeString(record.lastParseErrorAt)
        ? { lastParseErrorAt: this.toIsoTimestamp(record.lastParseErrorAt) }
        : {}),
      ...(this.normalizeString(record.lastParseError)
        ? { lastParseError: this.normalizeString(record.lastParseError) }
        : {}),
    };
  }

  private normalizeAisDisruptionSeverity(
    value: unknown,
  ): RealtimeAisDisruptionSeverity {
    const normalized = this.normalizeString(value)?.toLowerCase();
    if (normalized === "high") {
      return "high";
    }
    if (normalized === "elevated" || normalized === "medium") {
      return "elevated";
    }
    return "low";
  }

  private normalizeAisDisruptionSnapshot(
    value: unknown,
    index: number,
  ): RealtimeAisDisruptionSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const lat = this.toFiniteNumber(record.lat);
    const lng = this.toFiniteNumber(record.lon ?? record.lng);
    if (!this.isValidCoordinate(lat, lng)) {
      return null;
    }

    const id = this.normalizeString(record.id) ?? `ais-disruption-${index + 1}`;
    const name = this.normalizeString(record.name) ?? id;
    const type = this.normalizeString(record.type) ?? "unknown";
    return {
      id,
      name,
      type,
      lat: lat!,
      lng: lng!,
      severity: this.normalizeAisDisruptionSeverity(record.severity),
      ...(typeof this.toFiniteNumber(record.changePct) === "number"
        ? { changePct: this.toFiniteNumber(record.changePct)! }
        : {}),
      ...(typeof this.toFiniteNumber(record.windowHours) === "number"
        ? { windowHours: this.toFiniteNumber(record.windowHours)! }
        : {}),
      ...(typeof this.toFiniteNumber(record.vesselCount) === "number"
        ? { vesselCount: this.toFiniteNumber(record.vesselCount)! }
        : {}),
      ...(typeof this.toFiniteNumber(record.darkShips) === "number"
        ? { darkShips: this.toFiniteNumber(record.darkShips)! }
        : {}),
      ...(this.normalizeString(record.region)
        ? { region: this.normalizeString(record.region) }
        : {}),
      ...(this.normalizeString(record.description)
        ? { description: this.normalizeString(record.description) }
        : {}),
    };
  }

  private normalizeAisDensitySnapshot(
    value: unknown,
    index: number,
  ): RealtimeAisDensitySnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const lat = this.toFiniteNumber(record.lat);
    const lng = this.toFiniteNumber(record.lon ?? record.lng);
    const intensity = this.toFiniteNumber(record.intensity);
    if (!this.isValidCoordinate(lat, lng) || intensity === null) {
      return null;
    }

    return {
      id: this.normalizeString(record.id) ?? `ais-density-${index + 1}`,
      ...(this.normalizeString(record.name)
        ? { name: this.normalizeString(record.name) }
        : {}),
      lat: lat!,
      lng: lng!,
      intensity: Math.min(1, Math.max(0, intensity)),
      ...(typeof this.toFiniteNumber(record.deltaPct) === "number"
        ? { deltaPct: this.toFiniteNumber(record.deltaPct)! }
        : {}),
      ...(typeof this.toFiniteNumber(record.shipsPerDay) === "number"
        ? { shipsPerDay: this.toFiniteNumber(record.shipsPerDay)! }
        : {}),
      ...(this.normalizeString(record.note)
        ? { note: this.normalizeString(record.note) }
        : {}),
    };
  }

  private normalizeAisVesselSnapshot(
    value: unknown,
    fallbackObservedAt: string,
  ): RealtimeAisVesselSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const mmsi = this.normalizeAisMmsi(
      record.mmsi ?? record.MMSI ?? record.MMSI_String,
    );
    const lat = this.toFiniteNumber(record.lat);
    const lng = this.toFiniteNumber(record.lon ?? record.lng);
    if (!mmsi || !this.isValidCoordinate(lat, lng)) {
      return null;
    }

    const shipType = this.toFiniteNumber(
      record.shipType ?? record.ship_type ?? record.ShipType,
    );
    const heading = this.toFiniteNumber(record.heading ?? record.TrueHeading);
    const speed = this.toFiniteNumber(record.speed ?? record.Sog);
    const course = this.toFiniteNumber(record.course ?? record.Cog);

    return {
      mmsi,
      ...(this.normalizeString(record.name ?? record.ShipName)
        ? { name: this.normalizeString(record.name ?? record.ShipName) }
        : {}),
      lat: lat!,
      lng: lng!,
      ...(typeof shipType === "number" ? { shipType } : {}),
      ...(typeof heading === "number" ? { heading } : {}),
      ...(typeof speed === "number" ? { speed } : {}),
      ...(typeof course === "number" ? { course } : {}),
      observedAt: this.toIsoTimestamp(
        record.observedAt ?? record.timestamp ?? fallbackObservedAt,
      ),
    };
  }

  private readAisSnapshotPayload(payload: unknown) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(
        "AIS relay returned an invalid snapshot payload. Expected disruptions[] and density[].",
      );
    }

    const record = payload as {
      timestamp?: unknown;
      status?: unknown;
      diagnostics?: unknown;
      disruptions?: unknown;
      density?: unknown;
      candidateReports?: unknown;
      vessels?: unknown;
    };
    if (!Array.isArray(record.disruptions) || !Array.isArray(record.density)) {
      throw new Error(
        "AIS relay returned an invalid snapshot payload. Expected disruptions[] and density[].",
      );
    }

    const updatedAt = this.toIsoTimestamp(record.timestamp ?? new Date());
    return {
      updatedAt,
      status: this.normalizeAisStatusPayload(record.status),
      diagnostics: this.normalizeAisRelayDiagnostics(record.diagnostics),
      disruptions: record.disruptions
        .map((entry, index) =>
          this.normalizeAisDisruptionSnapshot(entry, index),
        )
        .filter((entry): entry is RealtimeAisDisruptionSnapshot =>
          Boolean(entry),
        ),
      density: record.density
        .map((entry, index) => this.normalizeAisDensitySnapshot(entry, index))
        .filter((entry): entry is RealtimeAisDensitySnapshot => Boolean(entry)),
      candidateReports: this.readArray(record.candidateReports)
        .map((entry) => this.normalizeAisVesselSnapshot(entry, updatedAt))
        .filter((entry): entry is RealtimeAisVesselSnapshot => Boolean(entry)),
      vessels: this.readArray(record.vessels)
        .map((entry) => this.normalizeAisVesselSnapshot(entry, updatedAt))
        .filter((entry): entry is RealtimeAisVesselSnapshot => Boolean(entry)),
    };
  }

  private async persistAircraftTransportSnapshot(
    orgId: string,
    aircraft: RealtimeAdsbAircraftSnapshot[],
    sourceUpdatedAt: string,
    sourceScope: "military" | "all",
  ) {
    const records = aircraft
      .map((entry) =>
        this.buildAircraftTransportRecord(
          orgId,
          entry,
          sourceUpdatedAt,
          sourceScope,
        ),
      )
      .filter((entry): entry is TransportTelemetryRecord => Boolean(entry));
    await this.persistTransportTelemetry(records);
  }

  private buildAircraftTransportRecord(
    orgId: string,
    aircraft: RealtimeAdsbAircraftSnapshot,
    sourceUpdatedAt: string,
    sourceScope: "military" | "all",
  ): TransportTelemetryRecord | null {
    if (!this.isValidCoordinate(aircraft.lat, aircraft.lng)) {
      return null;
    }
    const classification = classifyAircraftTransport({
      callsign: aircraft.callsign,
      icao24: aircraft.icao24,
      sourceScope,
    });
    const icao24 = aircraft.icao24.toLowerCase();
    return {
      orgId,
      entityKind: "aircraft",
      sourceType: "opensky",
      sourceScope,
      objectKey: `opensky:${icao24}`,
      observedAt: aircraft.observedAt,
      sourceUpdatedAt,
      lat: aircraft.lat,
      lng: aircraft.lng,
      geoCell: this.buildTransportGeoCell(aircraft.lat, aircraft.lng),
      icao24,
      ...(aircraft.callsign ? { callsign: aircraft.callsign } : {}),
      ...(aircraft.registration ? { registration: aircraft.registration } : {}),
      ...(aircraft.aircraftType ? { aircraftType: aircraft.aircraftType } : {}),
      name:
        aircraft.callsign ??
        aircraft.registration ??
        aircraft.icao24.toUpperCase(),
      ...(aircraft.countryCode ? { countryCode: aircraft.countryCode } : {}),
      ...(aircraft.countryName ? { countryName: aircraft.countryName } : {}),
      ...(typeof aircraft.heading === "number"
        ? { heading: this.normalizeHeading(aircraft.heading) }
        : {}),
      ...(typeof aircraft.groundSpeedKt === "number"
        ? { speed: aircraft.groundSpeedKt }
        : {}),
      ...(typeof aircraft.altitudeFt === "number"
        ? { altitudeFt: aircraft.altitudeFt }
        : {}),
      displayCategory: classification.displayCategory,
      displayCategoryZh: classification.displayCategoryZh,
      role: classification.role,
      roleZh: classification.roleZh,
      isMilitaryCandidate: classification.isMilitaryCandidate,
      metadata: {
        source: "opensky",
      },
    };
  }

  private async persistAisTransportSnapshot(
    orgId: string,
    snapshot: RealtimeAisLatestSnapshot,
  ) {
    const merged = new Map<
      string,
      {
        vessel: RealtimeAisVesselSnapshot;
        sourceScope: "all" | "candidate";
        isMilitaryCandidate: boolean;
      }
    >();

    for (const vessel of snapshot.vessels) {
      merged.set(vessel.mmsi, {
        vessel,
        sourceScope: "all",
        isMilitaryCandidate: false,
      });
    }

    for (const vessel of snapshot.candidateReports) {
      const current = merged.get(vessel.mmsi);
      merged.set(vessel.mmsi, {
        vessel: this.mergeAisVesselSnapshot(current?.vessel, vessel),
        sourceScope: "candidate",
        isMilitaryCandidate: true,
      });
    }

    const records = Array.from(merged.values())
      .map(({ vessel, sourceScope, isMilitaryCandidate }) =>
        this.buildAisTransportRecord(
          orgId,
          vessel,
          snapshot.updatedAt,
          sourceScope,
          isMilitaryCandidate,
        ),
      )
      .filter((entry): entry is TransportTelemetryRecord => Boolean(entry));

    await this.persistTransportTelemetry(records);
  }

  private mergeAisVesselSnapshot(
    current: RealtimeAisVesselSnapshot | undefined,
    candidate: RealtimeAisVesselSnapshot,
  ): RealtimeAisVesselSnapshot {
    if (!current) {
      return candidate;
    }
    const currentObservedMs = this.parseTimestampMs(current.observedAt) ?? 0;
    const candidateObservedMs =
      this.parseTimestampMs(candidate.observedAt) ?? 0;
    if (candidateObservedMs >= currentObservedMs) {
      return {
        ...current,
        ...candidate,
      };
    }
    return {
      ...candidate,
      ...current,
    };
  }

  private buildAisTransportRecord(
    orgId: string,
    vessel: RealtimeAisVesselSnapshot,
    sourceUpdatedAt: string,
    sourceScope: "all" | "candidate",
    isMilitaryCandidate: boolean,
  ): TransportTelemetryRecord | null {
    if (!this.isValidCoordinate(vessel.lat, vessel.lng)) {
      return null;
    }
    const classification = classifyAisShipType(
      vessel.shipType,
      isMilitaryCandidate,
    );
    return {
      orgId,
      entityKind: "vessel",
      sourceType: "ais",
      sourceScope,
      objectKey: `ais:${vessel.mmsi}`,
      observedAt: vessel.observedAt,
      sourceUpdatedAt,
      lat: vessel.lat,
      lng: vessel.lng,
      geoCell: this.buildTransportGeoCell(vessel.lat, vessel.lng),
      mmsi: vessel.mmsi,
      ...(vessel.name ? { name: vessel.name } : {}),
      ...(typeof vessel.shipType === "number"
        ? { shipType: vessel.shipType }
        : {}),
      ...(typeof vessel.heading === "number"
        ? { heading: this.normalizeHeading(vessel.heading) }
        : {}),
      ...(typeof vessel.course === "number"
        ? { course: this.normalizeHeading(vessel.course) }
        : {}),
      ...(typeof vessel.speed === "number" ? { speed: vessel.speed } : {}),
      shipTypeLabel: classification.shipTypeLabel,
      shipTypeLabelZh: classification.shipTypeLabelZh,
      role: classification.vesselRole,
      roleZh: classification.vesselRoleZh,
      displayCategory: classification.shipTypeLabel,
      displayCategoryZh: classification.shipTypeLabelZh,
      isMilitaryCandidate: classification.isMilitaryCandidate,
      metadata: {
        source: "ais",
      },
    };
  }

  private async persistTransportTelemetry(records: TransportTelemetryRecord[]) {
    if (records.length === 0) {
      return;
    }

    const dedupedRecords = this.dedupeTransportTelemetryRecords(records);
    if (dedupedRecords.length === 0) {
      return;
    }

    const orgId = dedupedRecords[0]!.orgId;
    const existingStates = await MapTransportObjectStateModel.find({
      orgId,
      objectKey: { $in: dedupedRecords.map((record) => record.objectKey) },
    }).lean();
    const existingByKey = new Map<string, Record<string, unknown>>(
      existingStates.map((state) => [
        String(state.objectKey),
        state as unknown as Record<string, unknown>,
      ]),
    );

    const trackPointsToInsert: TransportTelemetryRecord[] = [];
    const statesToUpsert: Array<{
      record: TransportTelemetryRecord;
      existing: Record<string, unknown> | null;
    }> = [];

    for (const record of dedupedRecords) {
      const existing =
        (existingByKey.get(record.objectKey) as
          | Record<string, unknown>
          | undefined) ?? null;
      if (this.shouldPersistTransportTrackPoint(record, existing)) {
        trackPointsToInsert.push(record);
      }

      const existingObservedAtMs = this.readDateMs(existing?.observedAt);
      const recordObservedAtMs = this.readDateMs(record.observedAt);
      if (
        recordObservedAtMs !== null &&
        (existingObservedAtMs === null ||
          recordObservedAtMs >= existingObservedAtMs)
      ) {
        statesToUpsert.push({ record, existing });
        existingByKey.set(record.objectKey, {
          ...existing,
          ...record,
          observedAt: new Date(record.observedAt),
          ...(record.sourceUpdatedAt
            ? { sourceUpdatedAt: new Date(record.sourceUpdatedAt) }
            : {}),
        });
      }
    }

    const insertedTrackPointIdByObjectKey = new Map<string, unknown>();
    if (trackPointsToInsert.length > 0) {
      const inserted = await MapTransportTrackPointModel.insertMany(
        trackPointsToInsert.map((record) => this.toTransportDocument(record)),
        { ordered: false },
      );
      for (const doc of inserted) {
        const objectKey = this.normalizeString(doc.objectKey);
        if (objectKey) {
          insertedTrackPointIdByObjectKey.set(objectKey, doc._id);
        }
      }
    }

    if (statesToUpsert.length > 0) {
      await MapTransportObjectStateModel.bulkWrite(
        statesToUpsert.map(({ record, existing }) => {
          const latestTrackPointId =
            insertedTrackPointIdByObjectKey.get(record.objectKey) ??
            existing?.latestTrackPointId ??
            null;
          return {
            updateOne: {
              filter: {
                orgId: record.orgId,
                objectKey: record.objectKey,
              },
              update: {
                $set: {
                  ...this.toTransportDocument(record),
                  latestTrackPointId,
                },
              },
              upsert: true,
            },
          };
        }),
        { ordered: false },
      );
    }
  }

  private dedupeTransportTelemetryRecords(records: TransportTelemetryRecord[]) {
    const deduped = new Map<string, TransportTelemetryRecord>();
    for (const record of records) {
      const current = deduped.get(record.objectKey);
      if (!current) {
        deduped.set(record.objectKey, record);
        continue;
      }
      const currentObservedAtMs = this.readDateMs(current.observedAt) ?? 0;
      const candidateObservedAtMs = this.readDateMs(record.observedAt) ?? 0;
      if (candidateObservedAtMs > currentObservedAtMs) {
        deduped.set(record.objectKey, record);
        continue;
      }
      if (candidateObservedAtMs < currentObservedAtMs) {
        continue;
      }
      if (
        this.scoreTransportTelemetryRecord(record) >=
        this.scoreTransportTelemetryRecord(current)
      ) {
        deduped.set(record.objectKey, record);
      }
    }
    return Array.from(deduped.values());
  }

  private scoreTransportTelemetryRecord(record: TransportTelemetryRecord) {
    let score = 0;
    if (record.callsign) score += 1;
    if (record.registration) score += 1;
    if (record.name) score += 1;
    if (record.countryCode) score += 1;
    if (typeof record.heading === "number") score += 1;
    if (typeof record.course === "number") score += 1;
    if (typeof record.speed === "number") score += 1;
    if (typeof record.altitudeFt === "number") score += 1;
    if (typeof record.shipType === "number") score += 1;
    return score;
  }

  private shouldPersistTransportTrackPoint(
    record: TransportTelemetryRecord,
    existing: Record<string, unknown> | null,
  ) {
    if (!existing) {
      return true;
    }

    const existingObservedAtMs = this.readDateMs(existing.observedAt);
    const recordObservedAtMs = this.readDateMs(record.observedAt);
    if (recordObservedAtMs === null) {
      return false;
    }
    if (
      existingObservedAtMs !== null &&
      recordObservedAtMs <= existingObservedAtMs
    ) {
      return false;
    }

    const distanceKm = this.computeTransportDistanceKm(
      record.lat,
      record.lng,
      this.readFiniteNumber(existing.lat),
      this.readFiniteNumber(existing.lng),
    );
    if (
      typeof distanceKm === "number" &&
      distanceKm >= MAP_TRANSPORT_DISTANCE_THRESHOLD_KM
    ) {
      return true;
    }

    if (
      this.computeTransportAngleDelta(
        record.heading,
        this.readFiniteNumber(existing.heading),
      ) >= MAP_TRANSPORT_ANGLE_THRESHOLD_DEG
    ) {
      return true;
    }
    if (
      this.computeTransportAngleDelta(
        record.course,
        this.readFiniteNumber(existing.course),
      ) >= MAP_TRANSPORT_ANGLE_THRESHOLD_DEG
    ) {
      return true;
    }

    const existingSpeed = this.readFiniteNumber(existing.speed);
    if (
      typeof record.speed === "number" &&
      typeof existingSpeed === "number" &&
      Math.abs(record.speed - existingSpeed) >= MAP_TRANSPORT_SPEED_THRESHOLD_KT
    ) {
      return true;
    }

    const existingAltitudeFt = this.readFiniteNumber(existing.altitudeFt);
    if (
      record.entityKind === "aircraft" &&
      typeof record.altitudeFt === "number" &&
      typeof existingAltitudeFt === "number" &&
      Math.abs(record.altitudeFt - existingAltitudeFt) >=
        MAP_TRANSPORT_ALTITUDE_THRESHOLD_FT
    ) {
      return true;
    }

    return (
      existingObservedAtMs === null ||
      recordObservedAtMs - existingObservedAtMs >= MAP_TRANSPORT_HEARTBEAT_MS
    );
  }

  private toTransportDocument(record: TransportTelemetryRecord) {
    return {
      orgId: record.orgId,
      entityKind: record.entityKind,
      sourceType: record.sourceType,
      sourceScope: record.sourceScope,
      objectKey: record.objectKey,
      observedAt: new Date(record.observedAt),
      sourceUpdatedAt: record.sourceUpdatedAt
        ? new Date(record.sourceUpdatedAt)
        : null,
      lat: record.lat,
      lng: record.lng,
      geoCell: record.geoCell,
      icao24: record.icao24 ?? null,
      mmsi: record.mmsi ?? null,
      callsign: record.callsign ?? null,
      registration: record.registration ?? null,
      name: record.name ?? null,
      aircraftType: record.aircraftType ?? null,
      displayCategory: record.displayCategory ?? null,
      displayCategoryZh: record.displayCategoryZh ?? null,
      role: record.role ?? null,
      roleZh: record.roleZh ?? null,
      countryCode: record.countryCode ?? null,
      countryName: record.countryName ?? null,
      heading: record.heading ?? null,
      course: record.course ?? null,
      speed: record.speed ?? null,
      altitudeFt: record.altitudeFt ?? null,
      shipType: record.shipType ?? null,
      shipTypeLabel: record.shipTypeLabel ?? null,
      shipTypeLabelZh: record.shipTypeLabelZh ?? null,
      isMilitaryCandidate: record.isMilitaryCandidate,
      metadata: record.metadata ?? null,
    };
  }

  private buildTransportGeoCell(lat: number, lng: number) {
    const step = MAP_TRANSPORT_GEO_CELL_STEP_DEG;
    const latCell = Math.floor(lat / step) * step;
    const lngCell = Math.floor(lng / step) * step;
    return `${latCell.toFixed(1)},${lngCell.toFixed(1)}`;
  }

  private normalizeHeading(value: number) {
    const normalized = value % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  }

  private computeTransportAngleDelta(
    left: number | null | undefined,
    right: number | null | undefined,
  ) {
    if (
      typeof left !== "number" ||
      !Number.isFinite(left) ||
      typeof right !== "number" ||
      !Number.isFinite(right)
    ) {
      return 0;
    }
    const delta = Math.abs(
      this.normalizeHeading(left) - this.normalizeHeading(right),
    );
    return Math.min(delta, 360 - delta);
  }

  private computeTransportDistanceKm(
    lat: number,
    lng: number,
    previousLat: number | null,
    previousLng: number | null,
  ) {
    if (
      previousLat === null ||
      previousLng === null ||
      !this.isValidCoordinate(previousLat, previousLng)
    ) {
      return null;
    }
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const earthRadiusKm = 6_371;
    const dLat = toRadians(previousLat - lat);
    const dLng = toRadians(previousLng - lng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(lat)) *
        Math.cos(toRadians(previousLat)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
  }

  private readDateMs(value: unknown) {
    if (value instanceof Date) {
      const timestamp = value.getTime();
      return Number.isFinite(timestamp) ? timestamp : null;
    }
    if (typeof value === "string") {
      return this.parseTimestampMs(value);
    }
    return null;
  }

  private readFiniteNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
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

  private buildAisHeaders(runtime: RealtimeSignalsRuntimeConfig) {
    const secret = runtime.aisRelay.sharedSecret?.trim();
    if (!secret) {
      return undefined;
    }
    return {
      Authorization: `Bearer ${secret}`,
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
