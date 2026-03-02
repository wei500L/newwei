import {
  createLogger,
  extractCountryCodeFromText,
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
  RealtimeSignalFetchResult,
  RealtimeSignalSource,
  RealtimeSignalsInsightSnapshot,
  RealtimeSignalsRuntimeConfig,
} from "./realtime-signals.types";

const logger = createLogger({ name: "realtime-signals" });
const ACLED_API_URL = "https://acleddata.com/api/acled/read";
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

const MILITARY_QUERY_REGIONS = [
  {
    id: "indo_pacific",
    lamin: -10,
    lomin: 90,
    lamax: 60,
    lomax: 170,
  },
  {
    id: "centcom",
    lamin: 5,
    lomin: 30,
    lamax: 45,
    lomax: 75,
  },
  {
    id: "eucom",
    lamin: 35,
    lomin: -15,
    lamax: 70,
    lomax: 45,
  },
  {
    id: "arctic",
    lamin: 60,
    lomin: -180,
    lamax: 85,
    lomax: 180,
  },
] as const;

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

    await this.cache.withLock(
      "cron:realtime-signals",
      REALTIME_SIGNALS_INGEST_LOCK_TTL_MS,
      async () => {
        const orgs = await this.prisma.org.findMany({
          where: { isActive: true },
          select: { id: true },
        });
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

  async refreshOrg(orgId: string, runtimeConfig?: RealtimeSignalsRuntimeConfig) {
    const runtime = runtimeConfig ?? (await this.getRuntimeConfig());
    if (!runtime.enabled) {
      return;
    }

    const currentInsight = (await this.store.getInsightSnapshot(orgId)) ?? {
      keywordSpikes: [],
      predictionLeads: [],
      tensions: [],
    };
    const nextInsight: RealtimeSignalsInsightSnapshot = { ...currentInsight };

    for (const source of REALTIME_SIGNAL_SOURCES) {
      const sourceConfig = runtime.sources[source];
      if (!sourceConfig?.enabled) {
        continue;
      }

      const shouldRun = await this.shouldRefreshSource(
        orgId,
        source,
        sourceConfig.intervalSec,
      );
      if (!shouldRun) {
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
        this.updateInsightSnapshot(nextInsight, source, results, nowIso);
      } catch (error) {
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

  async evaluateMetric(orgId: string, metricSlug: string, changeWindowMin?: number | null) {
    return this.store.evaluateMetric(orgId, metricSlug, changeWindowMin);
  }

  async getSituationMonitorInsightSnapshot(orgId: string) {
    return (
      (await this.store.getInsightSnapshot(orgId)) ?? {
        keywordSpikes: [],
        predictionLeads: [],
        tensions: [],
      }
    );
  }

  private async shouldRefreshSource(
    orgId: string,
    source: RealtimeSignalSource,
    intervalSec: number,
  ) {
    const lastRun = await this.store.getLastRun(orgId, source);
    if (!lastRun) {
      return true;
    }
    const safeIntervalSec = Math.max(10, Math.trunc(intervalSec));
    return Date.now() - lastRun >= safeIntervalSec * 1_000;
  }

  private async fetchSource(
    orgId: string,
    source: RealtimeSignalSource,
    runtime: RealtimeSignalsRuntimeConfig,
  ): Promise<RealtimeSignalFetchResult[]> {
    switch (source) {
      case "opensky":
        return this.fetchOpenSkySignal(runtime);
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

  private async fetchOpenSkySignal(runtime: RealtimeSignalsRuntimeConfig) {
    const relayBase = this.normalizeUrl(runtime.relay.baseUrl);
    const headers = this.buildRelayHeaders(runtime);

    const relayUrl = relayBase ? `${relayBase}/opensky` : null;
    const directUrl = "https://opensky-network.org/api/states/all";
    let source = relayUrl ? "relay" : "opensky";
    let states: unknown[] = [];
    let queriedRegions = 0;
    let failedRegions = 0;

    if (relayUrl) {
      try {
        const payload = await this.fetchJsonWithRetry(
          relayUrl,
          runtime,
          headers ? { headers } : undefined,
        );
        states = this.readArray((payload as { states?: unknown[] })?.states);
      } catch (error) {
        logger.warn(
          { err: error },
          "OpenSky relay request failed, fallback to direct regional pull",
        );
        source = "opensky";
      }
    }

    if (source === "opensky") {
      const regionalStates = await this.fetchOpenSkyRegionalStates(runtime, directUrl);
      states = regionalStates.states;
      queriedRegions = regionalStates.queriedRegions;
      failedRegions = regionalStates.failedRegions;
    }

    const militaryPrefixes = [
      "RCH",
      "AMC",
      "CNV",
      "FORTE",
      "LAGR",
      "QID",
      "RRR",
      "BAF",
      "MMF",
      "NAVY",
      "ARMY",
      "USAF",
      "RAF",
      "RUAF",
      "CHAF",
      "IAF",
    ];
    let militaryCount = 0;
    const countries = new Set<string>();
    for (const entry of states) {
      if (!Array.isArray(entry)) {
        continue;
      }
      const callsign = typeof entry[1] === "string" ? entry[1].trim().toUpperCase() : "";
      const countryCode = this.extractCountryCode(entry[2]);
      if (countryCode) {
        countries.add(countryCode);
      }
      if (!callsign) {
        continue;
      }
      if (militaryPrefixes.some((prefix) => callsign.startsWith(prefix))) {
        militaryCount += 1;
      }
    }

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.opensky,
        value: militaryCount,
        context: {
          source,
          totalStates: states.length,
          militaryCount,
          countryCodes: Array.from(countries),
          queriedRegions,
          failedRegions,
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
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
      `${relayBase}/ais-snapshot?candidates=false`,
      runtime,
      Object.keys(headers).length > 0 ? { headers } : undefined,
    );

    const disruptions = this.readArray(
      (payload as { disruptions?: unknown[] })?.disruptions,
    );
    const density = this.readArray((payload as { density?: unknown[] })?.density);

    const countries = new Set<string>();
    for (const disruption of disruptions) {
      if (!disruption || typeof disruption !== "object") {
        continue;
      }
      const record = disruption as Record<string, unknown>;
      const code = this.extractCountryCode(record.countryCode ?? record.country);
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
    const [acledEvents, gdeltEvents] = await Promise.all([
      this.fetchAcledUnrestEvents(runtime),
      this.fetchGdeltUnrestEvents(runtime),
    ]);
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
          acledConfigured: Boolean(
            runtime.credentials.acledAccessToken?.trim(),
          ),
          countryCodes: Array.from(countries),
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  private async fetchOpenSkyRegionalStates(
    runtime: RealtimeSignalsRuntimeConfig,
    directUrl: string,
  ) {
    const states: unknown[] = [];
    const seenIcao24 = new Set<string>();
    let queriedRegions = 0;
    let failedRegions = 0;

    for (const region of MILITARY_QUERY_REGIONS) {
      queriedRegions += 1;
      const url = new URL(directUrl);
      url.searchParams.set("lamin", String(region.lamin));
      url.searchParams.set("lamax", String(region.lamax));
      url.searchParams.set("lomin", String(region.lomin));
      url.searchParams.set("lomax", String(region.lomax));

      try {
        const payload = await this.fetchJsonWithRetry(url.toString(), runtime);
        const regionStates = this.readArray(
          (payload as { states?: unknown[] })?.states,
        );

        for (const entry of regionStates) {
          let dedupeKey: string | null = null;
          if (Array.isArray(entry)) {
            const icao24 = this.normalizeString(entry[0]);
            dedupeKey = icao24 ? icao24.toLowerCase() : null;
          }
          if (dedupeKey) {
            if (seenIcao24.has(dedupeKey)) {
              continue;
            }
            seenIcao24.add(dedupeKey);
          }
          states.push(entry);
        }
      } catch (error) {
        failedRegions += 1;
        logger.warn(
          { region: region.id, err: error },
          "OpenSky regional request failed",
        );
      }
    }

    return {
      states,
      queriedRegions,
      failedRegions,
    };
  }

  private async fetchAcledUnrestEvents(runtime: RealtimeSignalsRuntimeConfig) {
    const token = runtime.credentials.acledAccessToken?.trim();
    if (!token) {
      return [] as UnrestEventCandidate[];
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

    try {
      const payload = await this.fetchJsonWithRetry(url, runtime, {
        headers: { Authorization: `Bearer ${token}` },
      });

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
        return [] as UnrestEventCandidate[];
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
    } catch (error) {
      logger.warn({ err: error }, "ACLED unrest request failed");
      return [] as UnrestEventCandidate[];
    }
  }

  private async fetchGdeltUnrestEvents(runtime: RealtimeSignalsRuntimeConfig) {
    const url = new URL("https://api.gdeltproject.org/api/v2/geo/geo");
    url.searchParams.set("query", "protest");
    url.searchParams.set("format", "geojson");
    url.searchParams.set("maxrecords", "250");
    url.searchParams.set("timespan", "7d");

    try {
      const payload = await this.fetchJsonWithRetry(url.toString(), runtime);
      const features = this.readArray(
        (payload as { features?: unknown[] })?.features,
      );

      const seenLocations = new Set<string>();
      const rows: UnrestEventCandidate[] = [];

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

        const locationKey = name.toLowerCase();
        if (seenLocations.has(locationKey)) {
          continue;
        }

        const reports = Math.max(
          1,
          Math.trunc(this.toFiniteNumber(properties.count) ?? 1),
        );
        if (reports < 5) {
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

        seenLocations.add(locationKey);
        const occurredAt = this.toIsoTimestamp(
          properties.date ??
            properties.event_date ??
            properties.timestamp ??
            properties.datetime ??
            Date.now(),
        );
        const countryRaw = name.split(",").pop()?.trim() ?? name;
        rows.push({
          id: `gdelt-${lat.toFixed(2)}-${lon.toFixed(2)}-${this.toDateBucket(occurredAt)}-${idx}`,
          lat,
          lon,
          occurredAt,
          source: "gdelt",
          countryCode: this.extractCountryCode(countryRaw),
          reports,
        });
      }

      return rows;
    } catch (error) {
      logger.warn({ err: error }, "GDELT unrest request failed");
      return [] as UnrestEventCandidate[];
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
          locationRecord.alpha2 ?? locationRecord.countryCode ?? locationRecord.name,
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

    const recentCounts = new Map<string, { count: number; sources: Set<string> }>();
    const baselineCounts = new Map<string, number>();

    for (const article of recentArticles) {
      const source = this.normalizeSource(article.source);
      for (const term of this.extractTermsFromArticle(article)) {
        const entry = recentCounts.get(term) ?? { count: 0, sources: new Set() };
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

    const spikes: Array<{
      id: string;
      term: string;
      count: number;
      baseline: number;
      multiplier: number;
      sourceCount: number;
      confidence: number;
    }> = [];

    const minCount = Math.max(1, runtime.thresholds.keywordSpikeMinCount);
    const requiredMultiplier = Math.max(1, runtime.thresholds.keywordSpikeMultiplier);
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
    url.searchParams.set("pairs", GDELT_TENSION_PAIRS.join(","));
    url.searchParams.set("method", "gpr");

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
          },
        },
      ] satisfies RealtimeSignalFetchResult[];
    }

    const maxScore = tensions.reduce((acc, item) => Math.max(acc, item.score), 0);
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

    const leads: Array<{
      id: string;
      title: string;
      shift: number;
      newsActivity: number;
      confidence: number;
    }> = [];

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
    const rows: Array<{
      id: string;
      label: string;
      score: number;
      changePercent: number;
      trend: "rising" | "stable" | "falling";
      countries: string[];
      updatedAt: string;
    }> = [];

    if (!payload || typeof payload !== "object") {
      return rows;
    }

    const record = payload as Record<string, unknown>;
    const container =
      record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? (record.data as Record<string, unknown>)
        : record;

    for (const pair of GDELT_TENSION_PAIRS) {
      const series = this.readArray(container[pair]);
      if (series.length === 0) {
        continue;
      }
      const points = series
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
        .map((entry) => ({
          value: this.toFiniteNumber(entry.v ?? entry.value ?? entry.score),
          ts:
            this.normalizeString(entry.t ?? entry.timestamp ?? entry.date) ??
            new Date().toISOString(),
        }))
        .filter((entry): entry is { value: number; ts: string } => entry.value !== null);
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
        changePercent > 5 ? "rising" : changePercent < -5 ? "falling" : "stable";
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
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
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
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
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
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
        .map((entry, index): {
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
            trendRaw === "rising" || trendRaw === "falling" || trendRaw === "stable"
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
            updatedAt: this.normalizeString(entry.updatedAt) ?? fallbackTimestamp,
          };
        });
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

  private async getRuntimeConfig(): Promise<RealtimeSignalsRuntimeConfig> {
    try {
      return await this.settings.getRuntimeConfig();
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to resolve realtime signal runtime settings from DB; fallback to env",
      );
      return this.fromEnvConfig();
    }
  }

  private fromEnvConfig(): RealtimeSignalsRuntimeConfig {
    const cfg = this.env.realtimeSignalsConfig;
    return {
      enabled: cfg.enabled,
      requestTimeoutMs: cfg.requestTimeoutMs,
      maxRetries: cfg.maxRetries,
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
      relay: cfg.relay,
      credentials: cfg.credentials,
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
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
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

  private readArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
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
