import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { readHttpStatus } from "../../common/http/upstream-error-classification";
import { RealtimeSignalsSettingsService } from "../system-settings/realtime-signals-settings.service";

import { REALTIME_SIGNAL_METRIC_SLUGS } from "./realtime-signals.constants";
import {
  extractCountryCode,
  fetchJsonWithRetry,
  normalizeString,
  readArray,
  toDateBucket,
  toDiagnosticErrorMessage,
  toFiniteNumber,
  toIsoTimestamp,
  toCompactDayString,
} from "./realtime-signals.helpers";
import type {
  RealtimeSignalFetchResult,
  RealtimeSignalsRuntimeConfig,
  UnrestEventCandidate,
  UnrestFeedFetchResult,
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

@Injectable()
export class RealtimeUnrestOutageService {
  constructor(private readonly settings: RealtimeSignalsSettingsService) {}

  async fetchUnrestSignal(runtime: RealtimeSignalsRuntimeConfig) {
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
      const payload = await fetchJsonWithRetry(url, runtime, {
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
      const status = readHttpStatus(error);
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
                error: toDiagnosticErrorMessage(retryError),
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
        error: toDiagnosticErrorMessage(error),
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
      const payload = await fetchJsonWithRetry(url.toString(), runtime);
      const features = readArray(
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

        const name = normalizeString(
          properties.name ?? properties.location ?? properties.title,
        );
        if (!name) {
          continue;
        }
        const mentionedThemes = normalizeString(
          properties.mentionedthemes ?? properties.themes,
        );
        if (
          mentionedThemes &&
          !mentionedThemes.toLowerCase().includes("protest")
        ) {
          continue;
        }
        const tone = toFiniteNumber(
          properties.urltone ?? properties.tone ?? properties.toneavg,
        );
        if (tone !== null && tone > 0.25) {
          continue;
        }

        const coordinates = readArray(geometry.coordinates);
        if (coordinates.length < 2) {
          continue;
        }
        const lon = toFiniteNumber(coordinates[0]);
        const lat = toFiniteNumber(coordinates[1]);
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

        const occurredAt = toIsoTimestamp(
          properties.urlpubtimedate ??
            properties.date ??
            properties.event_date ??
            properties.timestamp ??
            properties.datetime ??
            Date.now(),
        );
        const countryRaw = name.split(",").pop()?.trim() ?? name;
        const aggregateKey = `${name.toLowerCase()}:${toDateBucket(occurredAt)}`;
        const existing = grouped.get(aggregateKey);
        if (!existing) {
          grouped.set(aggregateKey, {
            id: `gdelt-${lat.toFixed(2)}-${lon.toFixed(2)}-${toDateBucket(occurredAt)}-${idx}`,
            lat,
            lon,
            occurredAt,
            source: "gdelt",
            countryCode: extractCountryCode(countryRaw),
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
          existing.id = `gdelt-${lat.toFixed(2)}-${lon.toFixed(2)}-${toDateBucket(occurredAt)}-${idx}`;
        }
        if (!existing.countryCode) {
          existing.countryCode = extractCountryCode(countryRaw);
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
        error: toDiagnosticErrorMessage(error),
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

  async fetchOutagesSignal(runtime: RealtimeSignalsRuntimeConfig) {
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
    const payload = await fetchJsonWithRetry(url, runtime, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = readArray((payload as { result?: unknown[] })?.result);
    const countries = new Set<string>();

    for (const outage of result) {
      if (!outage || typeof outage !== "object") {
        continue;
      }
      const record = outage as Record<string, unknown>;
      const locations = readArray(record.locations);
      for (const entry of locations) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const locationRecord = entry as Record<string, unknown>;
        const code = extractCountryCode(
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

  async fetchPizzintSignal(runtime: RealtimeSignalsRuntimeConfig) {
    const payload = await fetchJsonWithRetry(
      "https://www.pizzint.watch/api/dashboard-data",
      runtime,
    );

    const locations = readArray(
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

  async fetchGdeltTensionSignal(runtime: RealtimeSignalsRuntimeConfig) {
    const url = new URL("https://www.pizzint.watch/api/gdelt/batch");
    const endDate = toCompactDayString(Date.now());
    const startDate = toCompactDayString(Date.now() - 7 * 24 * 60 * 60 * 1_000);
    url.searchParams.set("pairs", GDELT_TENSION_PAIRS.join(","));
    url.searchParams.set("method", "gpr");
    url.searchParams.set("dateStart", startDate);
    url.searchParams.set("dateEnd", endDate);

    const payload = await fetchJsonWithRetry(url.toString(), runtime);
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
      const series = readArray(container[pair]);
      if (series.length === 0) {
        continue;
      }
      const points = series
        .filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object"),
        )
        .map((entry) => ({
          value: toFiniteNumber(entry.v ?? entry.value ?? entry.score),
          ts:
            normalizeString(entry.t ?? entry.timestamp ?? entry.date) ??
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

    const events = readArray(response.data);
    const rows: UnrestEventCandidate[] = [];

    for (let idx = 0; idx < events.length; idx += 1) {
      const entry = events[idx];
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;

      const lat = toFiniteNumber(record.latitude);
      const lon = toFiniteNumber(record.longitude);
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

      const occurredAt = toIsoTimestamp(record.event_date ?? record.occurredAt);
      const eventId =
        normalizeString(record.event_id_cnty) ??
        `acled-${lat.toFixed(3)}-${lon.toFixed(3)}-${toDateBucket(occurredAt)}-${idx}`;
      rows.push({
        id: `acled-${eventId}`,
        lat,
        lon,
        occurredAt,
        source: "acled",
        countryCode: extractCountryCode(
          record.iso ??
            record.country_code ??
            record.country ??
            record.admin1 ??
            record.location,
        ),
        reports: Math.max(
          1,
          Math.trunc(toFiniteNumber(record.fatalities) ?? 1),
        ),
      });
    }

    return rows;
  }

  private buildUnrestMergeKey(event: UnrestEventCandidate) {
    const latKey = Math.round(event.lat * 10) / 10;
    const lonKey = Math.round(event.lon * 10) / 10;
    const dateKey = toDateBucket(event.occurredAt);
    return `${latKey}:${lonKey}:${dateKey}`;
  }
}
