import { createLogger } from "@modular/utils";
import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";

import { CacheService } from "../cache/cache.service";
import { REDIS_CLIENT } from "../cache/cache.tokens";

import {
  buildAdsbLatestSnapshot,
  classifyOpenskyError,
  fetchJsonWithRetry,
  getAdsbStaleThresholdSeconds,
  normalizeString,
  normalizeUrl,
  readOpenskyStateVectors,
  toDiagnosticErrorDetails,
  toFiniteNumber,
} from "./realtime-signals.helpers";
import type {
  OpenSkyBudgetReserveResult,
  OpenSkyCreditScope,
  OpenSkyDiagnosticMessage,
  OpenSkyStateResponse,
  OpenSkyStateVector,
  RealtimeAdsbLatestSnapshot,
  RealtimeOpenskyBudgetDaySummary,
  RealtimeOpenskyBudgetDegradationLevel,
  RealtimeOpenskyBudgetPeriod,
  RealtimeOpenskyBudgetSummary,
  RealtimeOpenskyErrorKind,
  RealtimeSignalsRuntimeConfig,
} from "./realtime-signals.types";
import { RealtimeTransportPersistenceService } from "./realtime-transport-persistence.service";

const logger = createLogger({ name: "realtime-signals" });

const OPENSKY_DEFAULT_BASE_URL = "https://opensky-network.org/api";

const OPENSKY_DEFAULT_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

const OPENSKY_VIEWPORT_CACHE_TTL_SECONDS = 15;

const OPENSKY_REGION_CACHE_TTL_SECONDS = 60;

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

export const OPENSKY_MILITARY_QUERY_REGIONS = [
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

const GLOBAL_ALL_FLIGHT_CAPTURE_INTERVAL_SEC = 15 * 60;

const GLOBAL_ALL_FLIGHT_CAPTURE_CACHE_TTL_SECONDS = 60;

type OpenSkyBudgetCounterField =
  | "usedCredits"
  | "requestCount"
  | "militaryCredits"
  | "militaryCalls"
  | "allCredits"
  | "allCalls"
  | "errorCalls"
  | "authErrorCalls"
  | "rateLimitedErrorCalls"
  | "serverErrorCalls"
  | "timeoutErrorCalls"
  | "networkErrorCalls"
  | "unknownErrorCalls"
  | "blockedAllModeCount"
  | "skippedMilitaryCount";

const OPENSKY_HKT_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: OPENSKY_HKT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

export class OpenSkyBudgetExhaustedError extends Error {
  constructor(message = "OpenSky daily credit budget is exhausted") {
    super(message);
    this.name = "OpenSkyBudgetExhaustedError";
  }
}

export class OpenSkyBudgetReserveError extends Error {
  constructor(
    message = "OpenSky daily credit budget does not have enough remaining credits for this request",
  ) {
    super(message);
    this.name = "OpenSkyBudgetReserveError";
  }
}

@Injectable()
export class RealtimeOpenskyService {
  constructor(
    private readonly cache: CacheService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly transport: RealtimeTransportPersistenceService,
  ) {}

  async refreshGlobalAllFlightCapture(
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
      const snapshot = buildAdsbLatestSnapshot(
        endpoint,
        states.map((entry) => entry.raw),
        states.length,
        fetchedAtMs,
        getAdsbStaleThresholdSeconds(GLOBAL_ALL_FLIGHT_CAPTURE_INTERVAL_SEC),
      );
      for (const orgId of orgIds) {
        await this.transport.persistAircraftTransportSnapshot(
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

  async fetchOpenskyViewportSnapshot(
    runtime: RealtimeSignalsRuntimeConfig,
    options: {
      bbox?: [number, number, number, number];
    },
  ): Promise<{
    configured: boolean;
    requiresZoom: boolean;
    budgetLimited: boolean;
    sourceEndpoint: string;
    statusReasonCode?: string;
    statusReason?: string;
    budgetSummary?: RealtimeOpenskyBudgetSummary;
    snapshot: RealtimeAdsbLatestSnapshot | null;
  }> {
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
    const snapshot = buildAdsbLatestSnapshot(
      sourceEndpoint,
      states.map((entry) => entry.raw),
      states.length,
      Date.now(),
      getAdsbStaleThresholdSeconds(staleIntervalSec),
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

  hasOpenskyCredentials(runtime: RealtimeSignalsRuntimeConfig) {
    return Boolean(
      normalizeString(runtime.opensky.clientId) &&
        normalizeString(runtime.opensky.clientSecret),
    );
  }

  getOpenskyBaseUrl(runtime: RealtimeSignalsRuntimeConfig) {
    return normalizeUrl(runtime.opensky.baseUrl) ?? OPENSKY_DEFAULT_BASE_URL;
  }

  private getOpenskyTokenUrl(runtime: RealtimeSignalsRuntimeConfig) {
    return normalizeUrl(runtime.opensky.tokenUrl) ?? OPENSKY_DEFAULT_TOKEN_URL;
  }

  async fetchConservativeMilitaryOpenSkyStates(
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
          const payload = await fetchJsonWithRetry<OpenSkyStateResponse>(
            endpoint,
            runtime,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
              maxRetries: 0,
            },
          );
          return readOpenskyStateVectors(payload);
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
    const clientId = normalizeString(runtime.opensky.clientId);
    const clientSecret = normalizeString(runtime.opensky.clientSecret);
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
      const response = await fetchJsonWithRetry<{
        access_token?: unknown;
        expires_in?: unknown;
      }>(tokenUrl, runtime, {
        method: "POST",
        rawBody: payload.toString(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        shouldRetry: (error) => {
          const kind = classifyOpenskyError(error);
          return (
            kind === "rate_limited" ||
            kind === "server" ||
            kind === "timeout" ||
            kind === "network"
          );
        },
      });

      const accessToken = normalizeString(response.access_token);
      if (!accessToken) {
        throw new Error(
          "OpenSky OAuth token response did not include access_token",
        );
      }
      const expiresInSec = Math.max(
        60,
        Math.trunc(toFiniteNumber(response.expires_in) ?? 300),
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
    const callsign = normalizeString(state.callsign)?.toUpperCase();
    const hasMilitaryCallsign = callsign
      ? OPENSKY_HIGH_CONFIDENCE_CALLSIGN_PATTERNS.some((pattern) =>
          pattern.test(callsign),
        )
      : false;
    const hasMilitaryHexRange = state.icao24.startsWith("ae");
    return hasMilitaryCallsign || hasMilitaryHexRange;
  }

  buildOpenskyBudgetContext(budgetSummary: RealtimeOpenskyBudgetSummary) {
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
    const details = toDiagnosticErrorDetails(error);
    const dateHkt = this.getOpenskyHktDate(occurredAtMs ?? Date.now());
    const key = this.getOpenskyBudgetKey(dateHkt);
    const openskyErrorKind = details.kind ?? "unknown";
    await Promise.all([
      this.cache.hincrby(key, "errorCalls", 1),
      this.cache.hincrby(
        key,
        this.getOpenskyErrorBudgetField(openskyErrorKind),
        1,
      ),
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

  async getOpenskyBudgetSummary(
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

  normalizeOpenskyBudgetDegradation(
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

  getOpenskyStatusReasonMessage(code: string, message: string) {
    return { code, message } satisfies OpenSkyDiagnosticMessage;
  }

  getOpenskyBudgetLimitedMessage(
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
}
