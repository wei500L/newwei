import { ProcessedItemModel } from "@modular/mongo";
import {
  extractCountryCodeFromText,
  getCountryAlpha2,
  getCountryName,
  normalizeCountryCode,
} from "@modular/utils";
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { AlertSeverity, ProcessedArticleStatus } from "@prisma/client";
import { createHash } from "node:crypto";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import { GeocodingService } from "../geo/geocoding.service";
import { SituationMonitorTranslationService } from "../situation-monitor/situation-monitor-translation.service";

import worldGeoJson from "./assets/world.geo.json";
import type { DashboardTimeRangeQueryDto } from "./dto/dashboard-charts.dto";
import {
  buildWarMapLayersResponse,
  type WarMapLayersResponse,
} from "./war-map-layers";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;
const DEFAULT_SECTOR_CATEGORY = "economic-short";
const DEFAULT_CANDLESTICK_SLUG = "sp500_index";
const HEATMAP_COLUMNS = 4;
const MAX_SECTOR_CELLS = 8;
const MAX_WAR_MAP_NEWS_MARKERS = 500;
const MAX_WAR_MAP_NEWS_GEOCODE_NETWORK = 3;
const MAX_SPACETIME_GEO_RECORDS = 2000;
const MAX_SPACETIME_GEO_LOCATIONS = 500;
const MAX_SPACETIME_GEO_POINTS = 300;
const MAX_SPACETIME_GEO_GEOCODE_NETWORK = 6;
const SPACETIME_GEO_CLUSTER_STEP_DEG = 0.5;
const SPACETIME_GEO_HEAT_HALF_LIFE_DAYS = 7;
const SPACETIME_GEO_SNAPSHOT_TTL_SECONDS = 60 * 60;
const PREFERRED_SOURCE_FIELDS = [
  "close",
  "收盘价",
  "value",
  "current_value",
  "今值",
  "最新值",
  "latest_price",
  "最新价",
  "现价",
  "current_price",
  "最新",
  "美元",
] as const;

const OHLC_FIELD_ALIASES = {
  open: ["open", "开盘价"],
  high: ["high", "最高价"],
  low: ["low", "最低价"],
  close: ["close", "收盘价"],
} as const;

type OhlcField = keyof typeof OHLC_FIELD_ALIASES;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeSourceFieldKey = (value: string) => value.trim().toLowerCase();

const parseStringList = (value: unknown): string[] | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry);
  return result.length > 0 ? result : undefined;
};

const uniqStrings = (values: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const normalizeMongoId = (value: unknown): string => {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "object") {
    const maybeHex = (value as { toHexString?: () => string }).toHexString?.();
    if (typeof maybeHex === "string" && maybeHex.trim()) {
      return maybeHex.trim();
    }
    const maybeString = (value as { toString?: () => string }).toString?.();
    if (
      typeof maybeString === "string" &&
      maybeString.trim() &&
      maybeString !== "[object Object]"
    ) {
      return maybeString.trim();
    }
  }
  return "";
};

interface DataVizConfig {
  heatmap: { preferredSourceFields?: string[] };
  candlestick: { ohlc?: Partial<Record<OhlcField, string[]>> };
}

const getDataVizConfig = (metadata: unknown): DataVizConfig => {
  if (!isPlainObject(metadata)) {
    return { heatmap: {}, candlestick: {} };
  }
  const dataViz = metadata.dataViz;
  if (!isPlainObject(dataViz)) {
    return { heatmap: {}, candlestick: {} };
  }

  const heatmap = dataViz.heatmap;
  const preferredSourceFields = isPlainObject(heatmap)
    ? parseStringList(heatmap.preferredSourceFields)
    : undefined;

  const candlestick = dataViz.candlestick;
  const ohlc = isPlainObject(candlestick) ? candlestick.ohlc : undefined;
  const ohlcFieldAliases: Partial<Record<OhlcField, string[]>> = {};
  if (isPlainObject(ohlc)) {
    (Object.keys(OHLC_FIELD_ALIASES) as OhlcField[]).forEach((field) => {
      const parsed = parseStringList(ohlc[field]);
      if (parsed) {
        ohlcFieldAliases[field] = parsed;
      }
    });
  }

  return {
    heatmap: {
      preferredSourceFields,
    },
    candlestick: {
      ohlc:
        Object.keys(ohlcFieldAliases).length > 0 ? ohlcFieldAliases : undefined,
    },
  };
};

const buildLabelToSourceFieldMap = (metadata: unknown): Map<string, string> => {
  const map = new Map<string, string>();
  if (!isPlainObject(metadata)) {
    return map;
  }
  const parser = metadata.parser;
  if (!isPlainObject(parser)) {
    return map;
  }

  const candidates: unknown[] = [];
  if (Array.isArray(parser.valueFields)) {
    candidates.push(...parser.valueFields);
  }
  if (Array.isArray(parser.seriesFields)) {
    candidates.push(...parser.seriesFields);
  }

  for (const entry of candidates) {
    if (!isPlainObject(entry)) continue;
    const field = entry.field;
    if (typeof field !== "string" || !field.trim()) {
      continue;
    }
    const trimmedField = field.trim();
    map.set(trimmedField, trimmedField);
    map.set(normalizeSourceFieldKey(trimmedField), trimmedField);
    const label = entry.label;
    if (typeof label === "string" && label.trim()) {
      const trimmedLabel = label.trim();
      map.set(trimmedLabel, trimmedField);
      map.set(normalizeSourceFieldKey(trimmedLabel), trimmedField);
    }
  }

  return map;
};

const resolvePreferredSourceField = (
  seriesByField: Map<string, unknown[]>,
  preferredKeys: string[],
  labelToField: Map<string, string>,
) => {
  const normalizedToActual = new Map<string, string>();
  for (const key of seriesByField.keys()) {
    const normalized = normalizeSourceFieldKey(key);
    if (!normalizedToActual.has(normalized)) {
      normalizedToActual.set(normalized, key);
    }
  }

  for (const key of preferredKeys) {
    if (seriesByField.has(key)) {
      return key;
    }
    const normalizedKey = normalizeSourceFieldKey(key);
    const mapped = labelToField.get(key) ?? labelToField.get(normalizedKey);
    if (mapped) {
      if (seriesByField.has(mapped)) {
        return mapped;
      }
      const normalizedMapped = normalizedToActual.get(
        normalizeSourceFieldKey(mapped),
      );
      if (normalizedMapped) {
        return normalizedMapped;
      }
    }

    const normalizedMatch = normalizedToActual.get(normalizedKey);
    if (normalizedMatch) {
      return normalizedMatch;
    }
  }
  return undefined;
};

interface GeoJsonGeometry {
  type:
    | "Point"
    | "MultiPoint"
    | "LineString"
    | "MultiLineString"
    | "Polygon"
    | "MultiPolygon"
    | "GeometryCollection";
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
  [key: string]: unknown;
}

interface GeoJsonFeature {
  type: "Feature";
  geometry: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
  id?: string;
  [key: string]: unknown;
}

interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
  [key: string]: unknown;
}

export interface WarMapGeoJsonResponse {
  name: string;
  geoJson: typeof worldGeoJson;
  center?: [number, number];
  zoom?: number;
}

interface WarMapEvent {
  id: string;
  name: string;
  nameZh?: string;
  lat: number;
  lng: number;
  severity: AlertSeverity;
  /**
   * Aggregated score for the location, derived from alert severities.
   * Current algorithm: sum of severity ranks (low=1, medium=2, high=3).
   */
  derivedScore: number;
  value: number;
  alertScore?: number;
  alertCount?: number;
  newsCount?: number;
}

export interface WarMapEventsResponse {
  events: WarMapEvent[];
  updatedAt?: string;
}

type WarMapNewsGeoSource = "geocoded" | "fallback-country";

interface WarMapNewsMarker {
  id: string;
  title: string;
  titleZh?: string;
  url?: string | null;
  location: string;
  locationZh?: string;
  lat: number;
  lng: number;
  publishedAt?: string;
  ingestedAt?: string;
  displayName?: string;
  displayNameZh?: string;
  geoSource: WarMapNewsGeoSource;
}

export interface WarMapNewsMarkersResponse {
  markers: WarMapNewsMarker[];
  updatedAt?: string;
}

interface WarMapNewsMarkersOptions {
  translateTarget?: "zh-CN";
}

interface WarMapLayersOptions {
  translateTarget?: "zh-CN";
}

interface WarMapEventsOptions {
  translateTarget?: "zh-CN";
}

export type SpacetimeSentimentLabel =
  | "positive"
  | "neutral"
  | "negative"
  | "unknown";

export interface SpacetimeGeoHeatPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  heat: number;
  total: number;
  sentiment: Record<SpacetimeSentimentLabel, number>;
  buckets?: SpacetimeGeoHeatPointBucket[];
}

export interface SpacetimeGeoHeatPointBucket {
  bucketStart: string;
  total: number;
  sentiment: Record<SpacetimeSentimentLabel, number>;
}

export interface SpacetimeGeoHeatmapResponse {
  points: SpacetimeGeoHeatPoint[];
  snapshotId?: string;
  updatedAt?: string;
}

interface SpacetimeGeoHeatmapSnapshot {
  v: 1;
  orgId: string;
  eventId: string | null;
  rangeStart: string;
  rangeEnd: string;
  pointToLocationKeys: Record<string, string[]>;
}

export interface SpacetimeGeoHeatmapArticle {
  id: string;
  title: string;
  url?: string | null;
  sourceLabel?: string | null;
  location?: string | null;
  publishedAt?: string;
  ingestedAt?: string;
  processedAt?: string;
  sentiment?: SpacetimeSentimentLabel;
}

export interface SpacetimeGeoHeatmapArticlesResponse {
  pointId: string;
  bucketStart?: string;
  hasMore: boolean;
  articles: SpacetimeGeoHeatmapArticle[];
  updatedAt?: string;
}

export type SpacetimePropagationEdgeKind = "duplicate" | "time";

export interface SpacetimePropagationNode {
  id: string;
  name: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

export interface SpacetimePropagationEdge {
  source: string;
  target: string;
  kind: SpacetimePropagationEdgeKind;
  weight: number;
  avgLagMs: number;
  firstAt: string;
  lastAt: string;
  avgDuplicateSimilarity?: number;
}

export interface SpacetimePropagationResponse {
  eventId: string;
  windowHours: number;
  nodes: SpacetimePropagationNode[];
  edges: SpacetimePropagationEdge[];
  updatedAt?: string;
}

export interface SpacetimePropagationArticle {
  id: string;
  title: string;
  url?: string | null;
  sourceLabel?: string | null;
  publishedAt?: string;
  ingestedAt?: string;
  processedAt?: string;
  sentiment?: SpacetimeSentimentLabel;
}

export interface SpacetimePropagationArticlesResponse {
  eventId: string;
  source: string;
  cursorStart?: string;
  cursorEnd?: string;
  hasMore: boolean;
  articles: SpacetimePropagationArticle[];
  updatedAt?: string;
}

export { type WarMapLayersResponse };

interface SectorHeatmapCell {
  x: number;
  y: number;
  name: string;
  value: number;
  change: number;
  unit?: string | null;
  sourceField?: string;
}

export interface SectorHeatmapResponse {
  xLabels: string[];
  yLabels: string[];
  cells: SectorHeatmapCell[];
  updatedAt?: string;
}

interface FinancialCandlestickPoint {
  timestamp: string;
  open: number;
  close: number;
  low: number;
  high: number;
  volume?: number;
}

export interface FinancialCandlestickResponse {
  symbol: string;
  interval: string;
  points: FinancialCandlestickPoint[];
  unit?: string | null;
  sourceFields?: Record<string, string>;
  updatedAt?: string;
}

interface DateRange {
  start: Date;
  end: Date;
}

const alignUtcDayStart = (value: Date) => {
  const normalized = new Date(value);
  normalized.setUTCHours(0, 0, 0, 0);
  return normalized;
};

const alignUtcDayEnd = (value: Date) => {
  const normalized = new Date(value);
  normalized.setUTCHours(23, 59, 59, 999);
  return normalized;
};

const normalizeGeoId = (input?: string | null): string | null => {
  if (!input || typeof input !== "string") {
    return null;
  }
  const normalized = normalizeCountryCode(input);
  return normalized ? normalized.toUpperCase() : null;
};

const normalizeLocationCandidate = (input: string): string => {
  return input
    .trim()
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
};

// Group key is used for aggregation; keep it stable but avoid losing useful country context for geocoding.
const normalizeLocationGroupKey = (input: string): string => {
  const trimmed = normalizeLocationCandidate(input);
  const primaryChunk = trimmed.split(/[,;/|]/)[0]?.trim() ?? "";
  return (primaryChunk || trimmed).slice(0, 120);
};

const clampFinite = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;

const roundToStep = (value: number, step: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return value;
  }
  return Math.round(value / step) * step;
};

const normalizeSentimentLabel = (raw: unknown): SpacetimeSentimentLabel => {
  if (typeof raw !== "string") {
    return "unknown";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "positive") return "positive";
  if (normalized === "neutral") return "neutral";
  if (normalized === "negative") return "negative";
  return "unknown";
};

const toUtcDayStartIso = (value: Date) => {
  const d = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
  return d.toISOString();
};

const alertSeverityRank: Record<AlertSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const alertSeverityByRank: Record<number, AlertSeverity> = {
  1: AlertSeverity.low,
  2: AlertSeverity.medium,
  3: AlertSeverity.high,
};

@Injectable()
export class DashboardChartsService {
  private geoIndex: Map<
    string,
    { name: string; lat: number; lng: number }
  > | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocoding: GeocodingService,
    private readonly cache: CacheService,
    private readonly translation?: SituationMonitorTranslationService,
  ) {}

  private geoHeatmapSnapshotCacheKey(orgId: string, snapshotId: string) {
    return `dashboard:spacetime:geo-heatmap:snapshot:${orgId}:${snapshotId}`;
  }

  private async loadGeoHeatmapSnapshot(orgId: string, snapshotId: string) {
    if (!snapshotId) {
      return null;
    }
    try {
      return await this.cache.get<SpacetimeGeoHeatmapSnapshot>(
        this.geoHeatmapSnapshotCacheKey(orgId, snapshotId),
      );
    } catch {
      return null;
    }
  }

  private async storeGeoHeatmapSnapshot(
    orgId: string,
    snapshotId: string,
    snapshot: SpacetimeGeoHeatmapSnapshot,
  ): Promise<boolean> {
    if (!snapshotId) {
      return false;
    }
    try {
      await this.cache.set(
        this.geoHeatmapSnapshotCacheKey(orgId, snapshotId),
        snapshot,
        SPACETIME_GEO_SNAPSHOT_TTL_SECONDS,
      );
      return true;
    } catch {
      return false;
    }
  }

  resolveRange(query: DashboardTimeRangeQueryDto): DateRange {
    const end = query.end ? new Date(query.end) : new Date();
    const start = query.start
      ? new Date(query.start)
      : new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException("Invalid date range");
    }
    const alignedStart = alignUtcDayStart(start);
    const alignedEnd = alignUtcDayEnd(end);

    if (alignedStart > alignedEnd) {
      throw new BadRequestException("Start must be before end");
    }

    return { start: alignedStart, end: alignedEnd };
  }

  getWarMapGeoJson(): WarMapGeoJsonResponse {
    const payload = worldGeoJson as { type?: string; features?: unknown };
    if (
      payload?.type !== "FeatureCollection" ||
      !Array.isArray(payload.features)
    ) {
      throw new Error("Invalid GeoJSON payload");
    }
    return {
      name: "world",
      geoJson: worldGeoJson,
      center: [0, 20],
      zoom: 1.1,
    };
  }

  async getWarMapLayers(
    options: WarMapLayersOptions = {},
  ): Promise<WarMapLayersResponse> {
    const response = buildWarMapLayersResponse();

    if (options.translateTarget === "zh-CN" && this.translation) {
      const targets = uniqStrings([
        ...response.hotspots.flatMap((item) => [item.name, item.description]),
        ...response.conflictZones.map((item) => item.name),
        ...response.chokepoints.flatMap((item) => [
          item.name,
          item.description,
        ]),
        ...response.cableLandings.flatMap((item) => [
          item.name,
          item.description,
        ]),
        ...response.nuclearSites.flatMap((item) => [
          item.name,
          item.description,
        ]),
        ...response.militaryBases.flatMap((item) => [
          item.name,
          item.description,
        ]),
      ]);
      const translatedByText =
        await this.translation.translateTextsToZhBestEffort(targets);

      const applyHotspot = (item: {
        name: string;
        nameZh?: string;
        description: string;
        descriptionZh?: string;
      }) => {
        const nameZh = translatedByText.get(item.name);
        if (nameZh) {
          item.nameZh = nameZh;
        }
        const descriptionZh = translatedByText.get(item.description);
        if (descriptionZh) {
          item.descriptionZh = descriptionZh;
        }
      };

      const applyZone = (item: { name: string; nameZh?: string }) => {
        const nameZh = translatedByText.get(item.name);
        if (nameZh) {
          item.nameZh = nameZh;
        }
      };

      const applyStrategic = (item: {
        name: string;
        nameZh?: string;
        description: string;
        descriptionZh?: string;
      }) => {
        const nameZh = translatedByText.get(item.name);
        if (nameZh) {
          item.nameZh = nameZh;
        }
        const descriptionZh = translatedByText.get(item.description);
        if (descriptionZh) {
          item.descriptionZh = descriptionZh;
        }
      };

      for (const item of response.hotspots) {
        applyHotspot(item);
      }
      for (const item of response.conflictZones) {
        applyZone(item);
      }
      for (const item of response.chokepoints) {
        applyStrategic(item);
      }
      for (const item of response.cableLandings) {
        applyStrategic(item);
      }
      for (const item of response.nuclearSites) {
        applyStrategic(item);
      }
      for (const item of response.militaryBases) {
        applyStrategic(item);
      }
    }

    return response;
  }

  async getWarMapEvents(
    range: DateRange,
    orgId: string,
    options: WarMapEventsOptions = {},
  ): Promise<WarMapEventsResponse> {
    const geoIndex = this.getGeoIndex();
    const signals = new Map<
      string,
      {
        name: string;
        lat: number;
        lng: number;
        alertCount: number;
        alertScore: number;
        maxAlertSeverityRank: number;
        newsCount: number;
        latestAt?: Date;
      }
    >();

    const [alertEvents, newsRecords] = await Promise.all([
      this.prisma.alertEvent.findMany({
        where: {
          triggeredAt: {
            gte: range.start,
            lte: range.end,
          },
          rule: {
            orgId,
          },
        },
        select: {
          triggeredAt: true,
          severity: true,
          context: true,
        },
        orderBy: { triggeredAt: "desc" },
      }),
      this.prisma.processedArticle.findMany({
        where: {
          status: ProcessedArticleStatus.completed,
          location: { not: null },
          OR: [
            {
              publishedAt: {
                gte: range.start,
                lte: range.end,
              },
              article: { orgId },
            },
            {
              publishedAt: null,
              article: {
                orgId,
                crawlAt: {
                  gte: range.start,
                  lte: range.end,
                },
              },
            },
          ],
        },
        select: {
          location: true,
          processedAt: true,
          publishedAt: true,
          article: {
            select: {
              crawlAt: true,
            },
          },
        },
        orderBy: { processedAt: "desc" },
        take: 2500,
      }),
    ]);

    for (const event of alertEvents) {
      const context =
        event.context &&
        typeof event.context === "object" &&
        !Array.isArray(event.context)
          ? (event.context as Record<string, unknown>)
          : null;
      const rawCountry =
        typeof context?.countryCode === "string"
          ? context?.countryCode
          : typeof context?.countryName === "string"
            ? context?.countryName
            : typeof context?.country === "string"
              ? context?.country
              : null;
      const resolvedCode =
        normalizeGeoId(rawCountry) ??
        extractCountryCodeFromText(rawCountry ?? null);
      if (!resolvedCode) {
        continue;
      }
      const geo = geoIndex.get(resolvedCode);
      if (!geo) {
        continue;
      }
      const entry = signals.get(resolvedCode) ?? {
        name: geo.name,
        lat: geo.lat,
        lng: geo.lng,
        alertCount: 0,
        alertScore: 0,
        maxAlertSeverityRank: 0,
        newsCount: 0,
      };
      const severityValue = alertSeverityRank[event.severity] ?? 1;
      entry.alertScore += severityValue;
      entry.alertCount += 1;
      entry.maxAlertSeverityRank = Math.max(
        entry.maxAlertSeverityRank,
        severityValue,
      );
      entry.latestAt =
        !entry.latestAt || event.triggeredAt > entry.latestAt
          ? event.triggeredAt
          : entry.latestAt;
      signals.set(resolvedCode, entry);
    }

    for (const record of newsRecords) {
      const location = record.location;
      if (!location || typeof location !== "string") {
        continue;
      }
      const resolvedCode = normalizeGeoId(
        extractCountryCodeFromText(location) ?? location,
      );
      if (!resolvedCode) {
        continue;
      }
      const geo = geoIndex.get(resolvedCode);
      if (!geo) {
        continue;
      }

      const entry = signals.get(resolvedCode) ?? {
        name: geo.name,
        lat: geo.lat,
        lng: geo.lng,
        alertCount: 0,
        alertScore: 0,
        maxAlertSeverityRank: 0,
        newsCount: 0,
        latestAt: undefined,
      };
      entry.newsCount += 1;
      const latestAt =
        record.publishedAt ?? record.article.crawlAt ?? record.processedAt;
      entry.latestAt =
        !entry.latestAt || latestAt > entry.latestAt
          ? latestAt
          : entry.latestAt;
      signals.set(resolvedCode, entry);
    }

    const events: WarMapEvent[] = [];
    let updatedAt: Date | undefined;

    for (const [code, entry] of signals.entries()) {
      if (!entry.latestAt) {
        continue;
      }
      const alertScore = Number(entry.alertScore.toFixed(2));
      const derivedScoreRaw = alertScore + entry.newsCount;
      const derivedScore = Math.max(1, derivedScoreRaw);
      const newsSeverityRank =
        entry.newsCount >= 8
          ? 3
          : entry.newsCount >= 4
            ? 2
            : entry.newsCount > 0
              ? 1
              : 0;
      const maxSeverityRank = Math.max(
        entry.maxAlertSeverityRank,
        newsSeverityRank,
      );
      const severity =
        maxSeverityRank > 0
          ? (alertSeverityByRank[maxSeverityRank] ?? AlertSeverity.low)
          : AlertSeverity.low;
      events.push({
        id: code.toLowerCase(),
        name: entry.name,
        lat: entry.lat,
        lng: entry.lng,
        severity,
        derivedScore,
        value: derivedScore,
        alertScore,
        alertCount: entry.alertCount,
        newsCount: entry.newsCount,
      });
      if (!updatedAt || entry.latestAt > updatedAt) {
        updatedAt = entry.latestAt;
      }
    }

    if (
      options.translateTarget === "zh-CN" &&
      this.translation &&
      events.length > 0
    ) {
      const translatedByText =
        await this.translation.translateTextsToZhBestEffort(
          events.map((event) => event.name),
        );
      for (const event of events) {
        const nameZh = translatedByText.get(event.name);
        if (nameZh) {
          event.nameZh = nameZh;
        }
      }
    }

    return {
      events,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }

  async getWarMapNewsMarkers(
    range: DateRange,
    orgId: string,
    options: WarMapNewsMarkersOptions = {},
  ): Promise<WarMapNewsMarkersResponse> {
    const geoIndex = this.getGeoIndex();
    const records = await this.prisma.processedArticle.findMany({
      where: {
        status: ProcessedArticleStatus.completed,
        location: { not: null },
        OR: [
          {
            publishedAt: {
              gte: range.start,
              lte: range.end,
            },
            article: { orgId },
          },
          {
            publishedAt: null,
            article: {
              orgId,
              crawlAt: {
                gte: range.start,
                lte: range.end,
              },
            },
          },
        ],
      },
      select: {
        id: true,
        title: true,
        location: true,
        publishedAt: true,
        processedAt: true,
        entities: true,
        article: {
          select: {
            url: true,
            crawlAt: true,
            titleGuess: true,
          },
        },
      },
      orderBy: { processedAt: "desc" },
      take: MAX_WAR_MAP_NEWS_MARKERS,
    });

    interface CleanedEntity {
      name: string;
      type: string;
      confidence: number;
    }

    const normalizeEntities = (input: unknown): CleanedEntity[] => {
      if (!Array.isArray(input)) {
        return [];
      }
      const entities: CleanedEntity[] = [];
      for (const entry of input) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const record = entry as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name.trim() : "";
        const type = typeof record.type === "string" ? record.type.trim() : "";
        const confidenceRaw = record.confidence;
        const confidence =
          typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
            ? confidenceRaw
            : 0;
        if (!name || !type) {
          continue;
        }
        entities.push({ name, type, confidence });
      }
      return entities;
    };

    const isLocationEntityType = (value: string) => {
      const normalized = value.trim().toLowerCase();
      return (
        normalized === "location" ||
        normalized.includes("loc") ||
        normalized.includes("place") ||
        normalized.includes("geo") ||
        normalized.includes("city") ||
        normalized.includes("country") ||
        normalized.includes("region") ||
        normalized.includes("state") ||
        normalized.includes("province") ||
        normalized.includes("地点") ||
        normalized.includes("地點") ||
        normalized.includes("地区") ||
        normalized.includes("地區") ||
        normalized.includes("城市") ||
        normalized.includes("国家") ||
        normalized.includes("國家")
      );
    };

    const resolveCountryAlpha3 = (
      location: string,
      entities: CleanedEntity[],
    ): string | null => {
      const fromLocation =
        extractCountryCodeFromText(location) ?? normalizeCountryCode(location);
      if (fromLocation) {
        return fromLocation;
      }
      for (const entity of entities) {
        const code =
          normalizeCountryCode(entity.name) ??
          extractCountryCodeFromText(entity.name);
        if (code) {
          return code;
        }
      }
      return null;
    };

    const buildCandidates = (
      location: string,
      entities: CleanedEntity[],
      countryName?: string | null,
    ) => {
      const candidates: string[] = [];
      const pushCandidate = (value: string) => {
        const normalized = value.trim();
        if (!normalized) return;
        candidates.push(normalized);
      };

      const locationEntities = entities
        .filter(
          (entity) =>
            entity.confidence >= 0.5 && isLocationEntityType(entity.type),
        )
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3);

      for (const entity of locationEntities) {
        if (
          countryName &&
          !entity.name.toLowerCase().includes(countryName.toLowerCase())
        ) {
          pushCandidate(`${entity.name}, ${countryName}`);
        }
        pushCandidate(entity.name);
      }

      const primaryLocationChunk =
        location.split(/[,，;；/|]/)[0]?.trim() ?? "";
      if (primaryLocationChunk && primaryLocationChunk !== location) {
        if (
          countryName &&
          !primaryLocationChunk
            .toLowerCase()
            .includes(countryName.toLowerCase())
        ) {
          pushCandidate(`${primaryLocationChunk}, ${countryName}`);
        }
        pushCandidate(primaryLocationChunk);
      }

      if (
        countryName &&
        !location.toLowerCase().includes(countryName.toLowerCase())
      ) {
        pushCandidate(`${location}, ${countryName}`);
      }
      pushCandidate(location);
      if (countryName) {
        pushCandidate(countryName);
      }

      return candidates;
    };

    let updatedAt: Date | undefined;
    let networkBudget = MAX_WAR_MAP_NEWS_GEOCODE_NETWORK;
    const markers: WarMapNewsMarker[] = [];

    for (const record of records) {
      const locationRaw = record.location;
      const location =
        typeof locationRaw === "string" ? locationRaw.trim() : "";
      if (!location) {
        continue;
      }

      const entities = normalizeEntities(record.entities);
      const countryAlpha3 = resolveCountryAlpha3(location, entities);
      const directCountryAlpha3 = normalizeCountryCode(location);
      const countryAlpha2 = countryAlpha3
        ? (getCountryAlpha2(countryAlpha3) ?? undefined)
        : undefined;
      const countryName = countryAlpha3 ? getCountryName(countryAlpha3) : null;

      const candidates = buildCandidates(location, entities, countryName);

      let geocode = await this.geocoding.resolveCandidates(candidates, {
        countryCodeAlpha2: countryAlpha2,
        allowNetwork: false,
      });
      if (!geocode && networkBudget > 0) {
        networkBudget -= 1;
        geocode = await this.geocoding.resolveCandidates(candidates, {
          countryCodeAlpha2: countryAlpha2,
          allowNetwork: true,
        });
      }

      let lat = geocode?.lat;
      let lng = geocode?.lng;
      let displayName = geocode?.displayName;
      let geoSource: WarMapNewsGeoSource = "geocoded";

      if (!geocode && directCountryAlpha3) {
        const fallback = geoIndex.get(directCountryAlpha3);
        if (fallback) {
          lat = fallback.lat;
          lng = fallback.lng;
          displayName = fallback.name;
          geoSource = "fallback-country";
        }
      }

      if (
        typeof lat !== "number" ||
        typeof lng !== "number" ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      ) {
        continue;
      }

      const title =
        (
          record.title ??
          record.article.titleGuess ??
          record.article.url ??
          ""
        ).trim() || location;
      const latestAt =
        record.publishedAt ??
        record.article.crawlAt ??
        record.processedAt ??
        undefined;

      markers.push({
        id: record.id,
        title,
        url: record.article.url ?? null,
        location,
        lat,
        lng,
        publishedAt: record.publishedAt
          ? record.publishedAt.toISOString()
          : undefined,
        ingestedAt: record.article.crawlAt
          ? record.article.crawlAt.toISOString()
          : undefined,
        displayName,
        geoSource,
      });

      if (latestAt && (!updatedAt || latestAt > updatedAt)) {
        updatedAt = latestAt;
      }
    }

    if (
      options.translateTarget === "zh-CN" &&
      this.translation &&
      markers.length > 0
    ) {
      const translatedByText =
        await this.translation.translateTextsToZhBestEffort(
          uniqStrings(
            markers.flatMap((marker) => [
              marker.title,
              marker.location,
              marker.displayName ?? "",
            ]),
          ),
        );
      for (const marker of markers) {
        const titleZh = translatedByText.get(marker.title);
        if (titleZh) {
          marker.titleZh = titleZh;
        }
        const locationZh = translatedByText.get(marker.location);
        if (locationZh) {
          marker.locationZh = locationZh;
        }
        if (marker.displayName) {
          const displayNameZh = translatedByText.get(marker.displayName);
          if (displayNameZh) {
            marker.displayNameZh = displayNameZh;
          }
        }
      }
    }

    return {
      markers,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }

  async getSpacetimeGeoHeatmap(
    range: DateRange,
    orgId: string,
    options: { eventId?: string; includeBuckets?: boolean } = {},
  ): Promise<SpacetimeGeoHeatmapResponse> {
    const geoIndex = this.getGeoIndex();
    const eventId =
      typeof options.eventId === "string" ? options.eventId.trim() : "";
    const includeBuckets = options.includeBuckets === true;
    const records = await this.prisma.processedArticle.findMany({
      where: {
        status: ProcessedArticleStatus.completed,
        location: { not: null },
        ...(eventId
          ? {
              newsEventItems: {
                some: {
                  orgId,
                  eventId,
                },
              },
            }
          : {}),
        OR: [
          {
            publishedAt: {
              gte: range.start,
              lte: range.end,
            },
            article: { orgId },
          },
          {
            publishedAt: null,
            article: {
              orgId,
              crawlAt: {
                gte: range.start,
                lte: range.end,
              },
            },
          },
        ],
      },
      select: {
        location: true,
        cleanedMarkdownRef: true,
        publishedAt: true,
        processedAt: true,
        article: {
          select: {
            crawlAt: true,
          },
        },
      },
      orderBy: { processedAt: "desc" },
      take: MAX_SPACETIME_GEO_RECORDS,
    });

    if (records.length === 0) {
      return { points: [] };
    }

    const processedItemIds = Array.from(
      new Set(
        records
          .map((record) =>
            typeof record.cleanedMarkdownRef === "string"
              ? record.cleanedMarkdownRef.trim()
              : "",
          )
          .filter((id) => id.length > 0),
      ),
    );

    const sentimentByProcessedItemId = new Map<
      string,
      SpacetimeSentimentLabel
    >();
    if (processedItemIds.length > 0) {
      try {
        const docs = (await ProcessedItemModel.find(
          { _id: { $in: processedItemIds }, orgId, status: "completed" },
          { _id: 1, result: 1 },
        )
          .lean()
          .exec()) as unknown;

        if (Array.isArray(docs)) {
          for (const doc of docs) {
            if (!doc || typeof doc !== "object") {
              continue;
            }
            const record = doc as Record<string, unknown>;
            const id = normalizeMongoId(record._id);
            if (!id) {
              continue;
            }
            const result =
              record.result &&
              typeof record.result === "object" &&
              !Array.isArray(record.result)
                ? (record.result as Record<string, unknown>)
                : null;
            const sentiment = normalizeSentimentLabel(
              result?.sentiment_label ??
                result?.sentimentLabel ??
                result?.sentiment,
            );
            sentimentByProcessedItemId.set(id, sentiment);
          }
        }
      } catch {
        // Sentiment is best-effort; heatmap still works with unknown sentiment.
      }
    }

    const createSentimentCounts = (): Record<
      SpacetimeSentimentLabel,
      number
    > => ({
      positive: 0,
      neutral: 0,
      negative: 0,
      unknown: 0,
    });

    const halfLifeMs = Math.max(1, SPACETIME_GEO_HEAT_HALF_LIFE_DAYS) * DAY_MS;
    const nowMs = range.end.getTime();

    interface BucketAgg {
      total: number;
      sentiment: Record<SpacetimeSentimentLabel, number>;
    }

    interface LocationAgg {
      key: string;
      candidates: Map<string, number>;
      heat: number;
      total: number;
      sentiment: Record<SpacetimeSentimentLabel, number>;
      buckets?: Map<string, BucketAgg>;
      lastAt?: Date;
    }

    const byLocation = new Map<string, LocationAgg>();
    let updatedAt: Date | undefined;

    for (const record of records) {
      const rawLocation =
        typeof record.location === "string" ? record.location.trim() : "";
      if (!rawLocation) {
        continue;
      }
      const key = normalizeLocationGroupKey(rawLocation);
      if (!key) {
        continue;
      }
      const candidate = normalizeLocationCandidate(rawLocation);
      const ts =
        record.publishedAt ?? record.article.crawlAt ?? record.processedAt;
      const ageMs = Math.max(0, nowMs - ts.getTime());
      const weight = Math.exp(-ageMs / halfLifeMs);

      const processedItemId =
        typeof record.cleanedMarkdownRef === "string"
          ? record.cleanedMarkdownRef.trim()
          : "";
      const sentiment = processedItemId
        ? (sentimentByProcessedItemId.get(processedItemId) ?? "unknown")
        : "unknown";
      const bucketStartIso = includeBuckets ? toUtcDayStartIso(ts) : null;

      const entry = byLocation.get(key) ?? {
        key,
        candidates: new Map<string, number>(),
        heat: 0,
        total: 0,
        sentiment: createSentimentCounts(),
        buckets: includeBuckets ? new Map() : undefined,
        lastAt: undefined,
      };

      entry.candidates.set(
        candidate,
        (entry.candidates.get(candidate) ?? 0) + 1,
      );
      entry.heat += weight;
      entry.total += 1;
      entry.sentiment[sentiment] = (entry.sentiment[sentiment] ?? 0) + 1;
      entry.lastAt = !entry.lastAt || ts > entry.lastAt ? ts : entry.lastAt;

      if (includeBuckets && bucketStartIso) {
        const buckets = entry.buckets ?? new Map<string, BucketAgg>();
        const bucket = buckets.get(bucketStartIso) ?? {
          total: 0,
          sentiment: createSentimentCounts(),
        };
        bucket.total += 1;
        bucket.sentiment[sentiment] = (bucket.sentiment[sentiment] ?? 0) + 1;
        buckets.set(bucketStartIso, bucket);
        entry.buckets = buckets;
      }

      byLocation.set(key, entry);

      updatedAt = !updatedAt || ts > updatedAt ? ts : updatedAt;
    }

    const sortedLocations = Array.from(byLocation.values())
      .sort((a, b) => b.heat - a.heat)
      .slice(0, MAX_SPACETIME_GEO_LOCATIONS);

    interface ClusterAgg {
      id: string;
      name: string;
      lat: number;
      lng: number;
      heat: number;
      total: number;
      sentiment: Record<SpacetimeSentimentLabel, number>;
      buckets?: Map<string, BucketAgg>;
    }

    const clusters = new Map<string, ClusterAgg>();
    const locationKeysByClusterKey = new Map<string, Set<string>>();
    let networkBudget = MAX_SPACETIME_GEO_GEOCODE_NETWORK;

    for (const loc of sortedLocations) {
      const candidates = Array.from(loc.candidates.entries())
        .sort((a, b) => {
          const lenDelta = b[0].length - a[0].length;
          if (lenDelta !== 0) return lenDelta;
          const countDelta = (b[1] ?? 0) - (a[1] ?? 0);
          if (countDelta !== 0) return countDelta;
          return a[0].localeCompare(b[0]);
        })
        .map(([value]) => value);
      if (!candidates.includes(loc.key)) {
        candidates.push(loc.key);
      }
      const trimmedCandidates = candidates.slice(0, 8);
      const resolvedCountry =
        trimmedCandidates
          .map((candidate) => extractCountryCodeFromText(candidate))
          .find(Boolean) ?? null;

      const countryHintAlpha3 = normalizeGeoId(resolvedCountry);
      const directAlpha3 = normalizeGeoId(trimmedCandidates[0] ?? "");
      const countryAlpha3 = countryHintAlpha3 ?? directAlpha3;
      const countryAlpha2 = countryAlpha3
        ? (getCountryAlpha2(countryAlpha3) ?? undefined)
        : undefined;

      let lat: number | undefined;
      let lng: number | undefined;
      let displayName: string | undefined;

      if (directAlpha3) {
        const geo = geoIndex.get(directAlpha3);
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
          displayName = geo.name;
        }
      }

      if (lat === undefined || lng === undefined) {
        let geocode = await this.geocoding.resolveCandidates(
          trimmedCandidates,
          {
            countryCodeAlpha2: countryAlpha2,
            allowNetwork: false,
          },
        );
        if (!geocode && networkBudget > 0) {
          networkBudget -= 1;
          geocode = await this.geocoding.resolveCandidates(trimmedCandidates, {
            countryCodeAlpha2: countryAlpha2,
            allowNetwork: true,
          });
        }
        lat = geocode?.lat;
        lng = geocode?.lng;
        displayName = geocode?.displayName ?? displayName;

        if ((lat === undefined || lng === undefined) && countryAlpha3) {
          const fallback = geoIndex.get(countryAlpha3);
          if (fallback) {
            lat = fallback.lat;
            lng = fallback.lng;
            displayName = fallback.name;
          }
        }
      }

      if (
        typeof lat !== "number" ||
        typeof lng !== "number" ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      ) {
        continue;
      }

      const clusterLat = roundToStep(
        clampFinite(lat, -90, 90),
        SPACETIME_GEO_CLUSTER_STEP_DEG,
      );
      const clusterLng = roundToStep(
        clampFinite(lng, -180, 180),
        SPACETIME_GEO_CLUSTER_STEP_DEG,
      );
      const clusterKey = `${clusterLat.toFixed(3)}:${clusterLng.toFixed(3)}`;

      const locationKeys =
        locationKeysByClusterKey.get(clusterKey) ?? new Set<string>();
      locationKeys.add(loc.key);
      locationKeysByClusterKey.set(clusterKey, locationKeys);

      const existing = clusters.get(clusterKey) ?? {
        id: clusterKey,
        name: displayName ?? loc.key,
        lat: clusterLat,
        lng: clusterLng,
        heat: 0,
        total: 0,
        sentiment: createSentimentCounts(),
        buckets: includeBuckets ? new Map<string, BucketAgg>() : undefined,
      };

      existing.heat += loc.heat;
      existing.total += loc.total;
      for (const label of Object.keys(
        existing.sentiment,
      ) as SpacetimeSentimentLabel[]) {
        existing.sentiment[label] += loc.sentiment[label] ?? 0;
      }

      if (includeBuckets && loc.buckets) {
        const bucketMap = existing.buckets ?? new Map<string, BucketAgg>();
        for (const [bucketStart, bucketAgg] of loc.buckets.entries()) {
          const existingBucket = bucketMap.get(bucketStart) ?? {
            total: 0,
            sentiment: createSentimentCounts(),
          };
          existingBucket.total += bucketAgg.total;
          for (const label of Object.keys(
            existingBucket.sentiment,
          ) as SpacetimeSentimentLabel[]) {
            existingBucket.sentiment[label] += bucketAgg.sentiment[label] ?? 0;
          }
          bucketMap.set(bucketStart, existingBucket);
        }
        existing.buckets = bucketMap;
      }
      clusters.set(clusterKey, existing);
    }

    const points = Array.from(clusters.values())
      .sort((a, b) => b.heat - a.heat)
      .slice(0, MAX_SPACETIME_GEO_POINTS)
      .map((point) => {
        const buckets =
          includeBuckets && point.buckets
            ? Array.from(point.buckets.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([bucketStart, agg]) => ({
                  bucketStart,
                  total: agg.total,
                  sentiment: agg.sentiment,
                }))
            : undefined;

        return {
          id: point.id,
          name: point.name,
          lat: point.lat,
          lng: point.lng,
          heat: Number(point.heat.toFixed(4)),
          total: point.total,
          sentiment: point.sentiment,
          ...(buckets ? { buckets } : {}),
        };
      });

    const pointToLocationKeys: Record<string, string[]> = {};
    for (const point of points) {
      const keys = locationKeysByClusterKey.get(point.id);
      if (!keys || keys.size === 0) {
        continue;
      }
      pointToLocationKeys[point.id] = Array.from(keys).sort((a, b) =>
        a.localeCompare(b),
      );
    }

    const snapshotBase: SpacetimeGeoHeatmapSnapshot | null =
      points.length > 0 && Object.keys(pointToLocationKeys).length > 0
        ? {
            v: 1,
            orgId,
            eventId: eventId ? eventId : null,
            rangeStart: range.start.toISOString(),
            rangeEnd: range.end.toISOString(),
            pointToLocationKeys: Object.fromEntries(
              Object.entries(pointToLocationKeys).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            ),
          }
        : null;

    const snapshotId = snapshotBase
      ? createHash("sha256").update(JSON.stringify(snapshotBase)).digest("hex")
      : "";
    const snapshotStored = snapshotBase
      ? await this.storeGeoHeatmapSnapshot(orgId, snapshotId, snapshotBase)
      : false;

    return {
      points,
      ...(snapshotStored ? { snapshotId } : {}),
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }

  async getSpacetimeGeoHeatmapArticles(
    range: DateRange,
    orgId: string,
    options: {
      eventId?: string;
      snapshotId?: string;
      pointId: string;
      bucketStart?: string;
      limit?: string;
    },
  ): Promise<SpacetimeGeoHeatmapArticlesResponse> {
    const rawPointId =
      typeof options.pointId === "string" ? options.pointId.trim() : "";
    const normalizePointId = (value: string): string => {
      const parts = value.split(":");
      if (parts.length !== 2) {
        throw new BadRequestException("Invalid pointId");
      }
      const lat = Number(parts[0]);
      const lng = Number(parts[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new BadRequestException("Invalid pointId");
      }
      const clusterLat = roundToStep(
        clampFinite(lat, -90, 90),
        SPACETIME_GEO_CLUSTER_STEP_DEG,
      );
      const clusterLng = roundToStep(
        clampFinite(lng, -180, 180),
        SPACETIME_GEO_CLUSTER_STEP_DEG,
      );
      return `${clusterLat.toFixed(3)}:${clusterLng.toFixed(3)}`;
    };
    if (!rawPointId) {
      throw new BadRequestException("pointId is required");
    }
    const pointId = normalizePointId(rawPointId);

    const limitRaw =
      typeof options.limit === "string" ? options.limit.trim() : "";
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
    const limit =
      Number.isFinite(limitParsed) && limitParsed > 0
        ? Math.min(80, limitParsed)
        : 30;

    const eventId =
      typeof options.eventId === "string" ? options.eventId.trim() : "";
    const snapshotId =
      typeof options.snapshotId === "string" ? options.snapshotId.trim() : "";

    let bucketStart: Date | null = null;
    let bucketEnd: Date | null = null;
    let bucketStartIso: string | undefined;
    if (typeof options.bucketStart === "string" && options.bucketStart.trim()) {
      const parsed = new Date(options.bucketStart);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException("Invalid bucketStart");
      }
      bucketStart = alignUtcDayStart(parsed);
      bucketEnd = new Date(bucketStart.getTime() + DAY_MS);
      bucketStartIso = bucketStart.toISOString();
    }

    const effectiveStart = bucketStart ?? range.start;
    const effectiveEnd = bucketEnd
      ? new Date(bucketEnd.getTime() - 1)
      : range.end;

    const records = await this.prisma.processedArticle.findMany({
      where: {
        status: ProcessedArticleStatus.completed,
        location: { not: null },
        ...(eventId
          ? {
              newsEventItems: {
                some: {
                  orgId,
                  eventId,
                },
              },
            }
          : {}),
        OR: [
          {
            publishedAt: {
              gte: effectiveStart,
              lte: effectiveEnd,
            },
            article: { orgId },
          },
          {
            publishedAt: null,
            article: {
              orgId,
              crawlAt: {
                gte: effectiveStart,
                lte: effectiveEnd,
              },
            },
          },
        ],
      },
      select: {
        id: true,
        title: true,
        location: true,
        cleanedMarkdownRef: true,
        publishedAt: true,
        processedAt: true,
        article: {
          select: {
            url: true,
            sourceLabel: true,
            crawlAt: true,
          },
        },
      },
      orderBy: { processedAt: "desc" },
      take: MAX_SPACETIME_GEO_RECORDS,
    });

    if (records.length === 0) {
      return {
        pointId,
        bucketStart: bucketStartIso,
        hasMore: false,
        articles: [],
      };
    }

    const resolveTimestamp = (record: (typeof records)[number]) =>
      record.publishedAt ?? record.article.crawlAt ?? record.processedAt;

    const sortedRecords = [...records].sort(
      (a, b) => resolveTimestamp(b).getTime() - resolveTimestamp(a).getTime(),
    );
    const first = sortedRecords[0];
    const updatedAt = first ? resolveTimestamp(first) : undefined;

    if (snapshotId) {
      const snapshot = await this.loadGeoHeatmapSnapshot(orgId, snapshotId);
      if (!snapshot) {
        throw new BadRequestException("Invalid snapshotId");
      }

      const snapshotEventId = snapshot.eventId ?? "";
      if (snapshotEventId !== eventId) {
        throw new BadRequestException("snapshotId does not match eventId");
      }

      const rangeStartIso = range.start.toISOString();
      const rangeEndIso = range.end.toISOString();
      if (
        snapshot.rangeStart !== rangeStartIso ||
        snapshot.rangeEnd !== rangeEndIso
      ) {
        throw new BadRequestException("snapshotId does not match range");
      }

      const allowedLocationKeysRaw = snapshot.pointToLocationKeys?.[pointId];
      const allowedLocationKeys = Array.isArray(allowedLocationKeysRaw)
        ? allowedLocationKeysRaw.filter(
            (value) => typeof value === "string" && value.trim(),
          )
        : [];
      if (allowedLocationKeys.length === 0) {
        return {
          pointId,
          bucketStart: bucketStartIso,
          hasMore: false,
          articles: [],
          updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
        };
      }

      const allowedLocationKeySet = new Set(allowedLocationKeys);

      const articles: SpacetimeGeoHeatmapArticle[] = [];
      const processedItemIdByIndex: (string | null)[] = [];
      const processedItemIds: string[] = [];
      let hasMore = false;

      for (const record of sortedRecords) {
        const rawLocation =
          typeof record.location === "string" ? record.location.trim() : "";
        if (!rawLocation) {
          continue;
        }
        const groupKey = normalizeLocationGroupKey(rawLocation);
        if (!groupKey) {
          continue;
        }
        if (!allowedLocationKeySet.has(groupKey)) {
          continue;
        }

        if (articles.length >= limit) {
          hasMore = true;
          break;
        }

        const url = record.article.url ?? null;
        const title = (record.title ?? "").trim() || url || groupKey;
        const publishedAtIso = record.publishedAt
          ? record.publishedAt.toISOString()
          : undefined;
        const ingestedAtIso = record.article.crawlAt
          ? record.article.crawlAt.toISOString()
          : undefined;
        const processedAtIso = record.processedAt
          ? record.processedAt.toISOString()
          : undefined;

        const cleanedMarkdownRef =
          typeof record.cleanedMarkdownRef === "string"
            ? record.cleanedMarkdownRef.trim()
            : "";
        const processedItemId = cleanedMarkdownRef || null;
        processedItemIdByIndex.push(processedItemId);
        if (processedItemId) {
          processedItemIds.push(processedItemId);
        }

        articles.push({
          id: record.id,
          title,
          url,
          sourceLabel: record.article.sourceLabel ?? null,
          location: rawLocation,
          publishedAt: publishedAtIso,
          ingestedAt: ingestedAtIso,
          processedAt: processedAtIso,
        });
      }

      const sentimentByProcessedItemId = new Map<
        string,
        SpacetimeSentimentLabel
      >();
      const uniqueProcessedItemIds = Array.from(new Set(processedItemIds));
      if (uniqueProcessedItemIds.length > 0) {
        try {
          const docs = (await ProcessedItemModel.find(
            {
              _id: { $in: uniqueProcessedItemIds },
              orgId,
              status: "completed",
            },
            { _id: 1, result: 1 },
          )
            .lean()
            .exec()) as unknown;

          if (Array.isArray(docs)) {
            for (const doc of docs) {
              if (!doc || typeof doc !== "object") {
                continue;
              }
              const payload = doc as Record<string, unknown>;
              const id = normalizeMongoId(payload._id);
              if (!id) {
                continue;
              }
              const result =
                payload.result &&
                typeof payload.result === "object" &&
                !Array.isArray(payload.result)
                  ? (payload.result as Record<string, unknown>)
                  : null;
              const sentiment = normalizeSentimentLabel(
                result?.sentiment_label ??
                  result?.sentimentLabel ??
                  result?.sentiment,
              );
              sentimentByProcessedItemId.set(id, sentiment);
            }
          }
        } catch {
          // Drilldown sentiment is best-effort.
        }
      }

      for (let i = 0; i < articles.length; i += 1) {
        const processedItemId = processedItemIdByIndex[i];
        if (!processedItemId) {
          continue;
        }
        const sentiment = sentimentByProcessedItemId.get(processedItemId);
        if (sentiment) {
          articles[i]!.sentiment = sentiment;
        }
      }

      return {
        pointId,
        bucketStart: bucketStartIso,
        hasMore,
        articles,
        updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
      };
    }

    const geoIndex = this.getGeoIndex();

    type CandidateAgg = Map<string, number>;
    const candidatesByGroupKey = new Map<string, CandidateAgg>();

    for (const record of records) {
      const rawLocation =
        typeof record.location === "string" ? record.location.trim() : "";
      if (!rawLocation) {
        continue;
      }
      const groupKey = normalizeLocationGroupKey(rawLocation);
      if (!groupKey) {
        continue;
      }
      const candidate = normalizeLocationCandidate(rawLocation);
      const agg =
        candidatesByGroupKey.get(groupKey) ?? new Map<string, number>();
      agg.set(candidate, (agg.get(candidate) ?? 0) + 1);
      candidatesByGroupKey.set(groupKey, agg);
    }

    const clusterByGroupKey = new Map<string, { clusterKey: string | null }>();
    let networkBudget = MAX_SPACETIME_GEO_GEOCODE_NETWORK;

    const resolveClusterForGroupKey = async (
      groupKey: string,
      candidatesAgg: CandidateAgg,
    ): Promise<string | null> => {
      const cached = clusterByGroupKey.get(groupKey);
      if (cached) {
        return cached.clusterKey;
      }

      const candidates = Array.from(candidatesAgg.entries())
        .sort((a, b) => {
          const lenDelta = b[0].length - a[0].length;
          if (lenDelta !== 0) return lenDelta;
          const countDelta = (b[1] ?? 0) - (a[1] ?? 0);
          if (countDelta !== 0) return countDelta;
          return a[0].localeCompare(b[0]);
        })
        .map(([value]) => value);

      if (!candidates.includes(groupKey)) {
        candidates.push(groupKey);
      }

      const trimmedCandidates = candidates.slice(0, 8);
      const resolvedCountry =
        trimmedCandidates
          .map((candidate) => extractCountryCodeFromText(candidate))
          .find(Boolean) ?? null;

      const countryHintAlpha3 = normalizeGeoId(resolvedCountry);
      const directAlpha3 = normalizeGeoId(trimmedCandidates[0] ?? "");
      const countryAlpha3 = countryHintAlpha3 ?? directAlpha3;
      const countryAlpha2 = countryAlpha3
        ? (getCountryAlpha2(countryAlpha3) ?? undefined)
        : undefined;

      let lat: number | undefined;
      let lng: number | undefined;

      if (directAlpha3) {
        const geo = geoIndex.get(directAlpha3);
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
        }
      }

      if (lat === undefined || lng === undefined) {
        let geocode = await this.geocoding.resolveCandidates(
          trimmedCandidates,
          {
            countryCodeAlpha2: countryAlpha2,
            allowNetwork: false,
          },
        );
        if (!geocode && networkBudget > 0) {
          networkBudget -= 1;
          geocode = await this.geocoding.resolveCandidates(trimmedCandidates, {
            countryCodeAlpha2: countryAlpha2,
            allowNetwork: true,
          });
        }
        lat = geocode?.lat;
        lng = geocode?.lng;

        if ((lat === undefined || lng === undefined) && countryAlpha3) {
          const fallback = geoIndex.get(countryAlpha3);
          if (fallback) {
            lat = fallback.lat;
            lng = fallback.lng;
          }
        }
      }

      if (
        typeof lat !== "number" ||
        typeof lng !== "number" ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      ) {
        clusterByGroupKey.set(groupKey, { clusterKey: null });
        return null;
      }

      const clusterLat = roundToStep(
        clampFinite(lat, -90, 90),
        SPACETIME_GEO_CLUSTER_STEP_DEG,
      );
      const clusterLng = roundToStep(
        clampFinite(lng, -180, 180),
        SPACETIME_GEO_CLUSTER_STEP_DEG,
      );
      const clusterKey = `${clusterLat.toFixed(3)}:${clusterLng.toFixed(3)}`;
      clusterByGroupKey.set(groupKey, { clusterKey });
      return clusterKey;
    };

    const articles: SpacetimeGeoHeatmapArticle[] = [];
    const processedItemIdByIndex: (string | null)[] = [];
    const processedItemIds: string[] = [];
    let hasMore = false;

    for (const record of sortedRecords) {
      const rawLocation =
        typeof record.location === "string" ? record.location.trim() : "";
      if (!rawLocation) {
        continue;
      }
      const groupKey = normalizeLocationGroupKey(rawLocation);
      if (!groupKey) {
        continue;
      }

      const candidatesAgg = candidatesByGroupKey.get(groupKey);
      if (!candidatesAgg) {
        continue;
      }

      const clusterKey = await resolveClusterForGroupKey(
        groupKey,
        candidatesAgg,
      );
      if (!clusterKey || clusterKey !== pointId) {
        continue;
      }

      if (articles.length >= limit) {
        hasMore = true;
        break;
      }

      const url = record.article.url ?? null;
      const title = (record.title ?? "").trim() || url || groupKey;
      const publishedAtIso = record.publishedAt
        ? record.publishedAt.toISOString()
        : undefined;
      const ingestedAtIso = record.article.crawlAt
        ? record.article.crawlAt.toISOString()
        : undefined;
      const processedAtIso = record.processedAt
        ? record.processedAt.toISOString()
        : undefined;

      const cleanedMarkdownRef =
        typeof record.cleanedMarkdownRef === "string"
          ? record.cleanedMarkdownRef.trim()
          : "";
      const processedItemId = cleanedMarkdownRef || null;
      processedItemIdByIndex.push(processedItemId);
      if (processedItemId) {
        processedItemIds.push(processedItemId);
      }

      articles.push({
        id: record.id,
        title,
        url,
        sourceLabel: record.article.sourceLabel ?? null,
        location: rawLocation,
        publishedAt: publishedAtIso,
        ingestedAt: ingestedAtIso,
        processedAt: processedAtIso,
      });
    }

    const sentimentByProcessedItemId = new Map<
      string,
      SpacetimeSentimentLabel
    >();
    const uniqueProcessedItemIds = Array.from(new Set(processedItemIds));
    if (uniqueProcessedItemIds.length > 0) {
      try {
        const docs = (await ProcessedItemModel.find(
          { _id: { $in: uniqueProcessedItemIds }, orgId, status: "completed" },
          { _id: 1, result: 1 },
        )
          .lean()
          .exec()) as unknown;

        if (Array.isArray(docs)) {
          for (const doc of docs) {
            if (!doc || typeof doc !== "object") {
              continue;
            }
            const payload = doc as Record<string, unknown>;
            const id = normalizeMongoId(payload._id);
            if (!id) {
              continue;
            }
            const result =
              payload.result &&
              typeof payload.result === "object" &&
              !Array.isArray(payload.result)
                ? (payload.result as Record<string, unknown>)
                : null;
            const sentiment = normalizeSentimentLabel(
              result?.sentiment_label ??
                result?.sentimentLabel ??
                result?.sentiment,
            );
            sentimentByProcessedItemId.set(id, sentiment);
          }
        }
      } catch {
        // Drilldown sentiment is best-effort.
      }
    }

    for (let i = 0; i < articles.length; i += 1) {
      const processedItemId = processedItemIdByIndex[i];
      if (!processedItemId) {
        continue;
      }
      const sentiment = sentimentByProcessedItemId.get(processedItemId);
      if (sentiment) {
        articles[i]!.sentiment = sentiment;
      }
    }

    return {
      pointId,
      bucketStart: bucketStartIso,
      hasMore,
      articles,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }

  async getSpacetimePropagation(
    range: DateRange,
    orgId: string,
    options: {
      eventId: string;
      windowHours?: string;
      maxNodes?: string;
      maxEdges?: string;
    },
  ): Promise<SpacetimePropagationResponse> {
    const eventId =
      typeof options.eventId === "string" ? options.eventId.trim() : "";
    if (!eventId) {
      throw new BadRequestException("eventId is required");
    }

    const parseBoundedInt = (
      raw: string | undefined,
      fallback: number,
      min: number,
      max: number,
    ) => {
      if (!raw) {
        return fallback;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) {
        return fallback;
      }
      return Math.max(min, Math.min(max, parsed));
    };

    const windowHours = parseBoundedInt(options.windowHours?.trim(), 12, 1, 72);
    const maxNodes = parseBoundedInt(options.maxNodes?.trim(), 140, 30, 600);
    const maxEdges = parseBoundedInt(options.maxEdges?.trim(), 320, 60, 2000);
    const windowMs = windowHours * 60 * 60 * 1000;

    const resolveSourceKey = (sourceLabel: unknown, url: unknown): string => {
      const label = typeof sourceLabel === "string" ? sourceLabel.trim() : "";
      if (label) {
        return label.slice(0, 120);
      }
      const rawUrl = typeof url === "string" ? url.trim() : "";
      if (rawUrl) {
        try {
          const host = new URL(rawUrl).hostname.trim();
          if (host) {
            return host.slice(0, 120);
          }
        } catch {
          // Ignore invalid URLs.
        }
      }
      return "unknown";
    };

    const rows = await this.prisma.newsEventItem.findMany({
      where: {
        orgId,
        eventId,
        processedArticle: {
          status: ProcessedArticleStatus.completed,
          OR: [
            {
              publishedAt: {
                gte: range.start,
                lte: range.end,
              },
              article: { orgId },
            },
            {
              publishedAt: null,
              article: {
                orgId,
                crawlAt: {
                  gte: range.start,
                  lte: range.end,
                },
              },
            },
          ],
        },
      },
      select: {
        processedItemId: true,
        createdAt: true,
        processedArticle: {
          select: {
            id: true,
            cleanedMarkdownRef: true,
            title: true,
            publishedAt: true,
            processedAt: true,
            article: {
              select: {
                url: true,
                sourceLabel: true,
                crawlAt: true,
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 2000,
    });

    interface Signal {
      processedArticleId: string;
      processedItemId: string | null;
      source: string;
      timestampMs: number;
    }

    const signals: Signal[] = [];
    const nodeAgg = new Map<
      string,
      { count: number; firstMs: number; lastMs: number }
    >();
    const signalByProcessedItemId = new Map<string, Signal>();
    let updatedAt: Date | undefined;

    for (const row of rows) {
      const processed = row.processedArticle;
      if (!processed) {
        continue;
      }
      const article = processed.article;
      const ts =
        processed.publishedAt ?? article?.crawlAt ?? processed.processedAt;
      if (!ts) {
        continue;
      }
      const tsMs = ts.getTime();
      if (!Number.isFinite(tsMs)) {
        continue;
      }

      const source = resolveSourceKey(article?.sourceLabel, article?.url);
      const processedItemIdCandidate =
        (typeof row.processedItemId === "string"
          ? row.processedItemId.trim()
          : "") ||
        (typeof processed.cleanedMarkdownRef === "string"
          ? processed.cleanedMarkdownRef.trim()
          : "");
      const processedItemId = processedItemIdCandidate
        ? processedItemIdCandidate
        : null;

      const signal: Signal = {
        processedArticleId: processed.id,
        processedItemId,
        source,
        timestampMs: tsMs,
      };
      signals.push(signal);

      const existing = nodeAgg.get(source);
      if (!existing) {
        nodeAgg.set(source, { count: 1, firstMs: tsMs, lastMs: tsMs });
      } else {
        existing.count += 1;
        existing.firstMs = Math.min(existing.firstMs, tsMs);
        existing.lastMs = Math.max(existing.lastMs, tsMs);
      }

      if (processedItemId) {
        const prior = signalByProcessedItemId.get(processedItemId);
        if (!prior || tsMs < prior.timestampMs) {
          signalByProcessedItemId.set(processedItemId, signal);
        }
      }

      updatedAt = !updatedAt || ts > updatedAt ? ts : updatedAt;
    }

    if (signals.length === 0) {
      return {
        eventId,
        windowHours,
        nodes: [],
        edges: [],
        updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
      };
    }

    interface EdgeAgg {
      kind: SpacetimePropagationEdgeKind;
      source: string;
      target: string;
      weight: number;
      lagSumMs: number;
      lagCount: number;
      firstMs: number;
      lastMs: number;
      similaritySum?: number;
      similarityCount?: number;
    }

    const edgeAgg = new Map<string, EdgeAgg>();

    const pushEdge = (
      kind: SpacetimePropagationEdgeKind,
      source: string,
      target: string,
      lagMs: number,
      tsMs: number,
      similarity?: number | null,
    ) => {
      if (!source || !target || source === target) {
        return;
      }
      const key = `${kind}:${source} -> ${target}`;
      const existing = edgeAgg.get(key);
      if (!existing) {
        edgeAgg.set(key, {
          kind,
          source,
          target,
          weight: 1,
          lagSumMs: lagMs,
          lagCount: 1,
          firstMs: tsMs,
          lastMs: tsMs,
          ...(kind === "duplicate" &&
          typeof similarity === "number" &&
          Number.isFinite(similarity)
            ? { similaritySum: similarity, similarityCount: 1 }
            : {}),
        });
        return;
      }
      existing.weight += 1;
      existing.lagSumMs += lagMs;
      existing.lagCount += 1;
      existing.firstMs = Math.min(existing.firstMs, tsMs);
      existing.lastMs = Math.max(existing.lastMs, tsMs);
      if (
        kind === "duplicate" &&
        typeof similarity === "number" &&
        Number.isFinite(similarity)
      ) {
        existing.similaritySum = (existing.similaritySum ?? 0) + similarity;
        existing.similarityCount = (existing.similarityCount ?? 0) + 1;
      }
    };

    const handledDuplicateChildren = new Set<string>();

    const processedItemIds = Array.from(
      new Set(
        signals
          .map((signal) => signal.processedItemId ?? "")
          .filter((id) => id.length > 0),
      ),
    );

    if (processedItemIds.length > 0) {
      try {
        const docs = (await ProcessedItemModel.find(
          { _id: { $in: processedItemIds }, orgId, status: "completed" },
          { _id: 1, duplicateOf: 1, duplicateSimilarity: 1 },
        )
          .lean()
          .exec()) as unknown;

        if (Array.isArray(docs)) {
          for (const doc of docs) {
            if (!doc || typeof doc !== "object") {
              continue;
            }
            const payload = doc as Record<string, unknown>;
            const childId = normalizeMongoId(payload._id);
            const parentId = normalizeMongoId(payload.duplicateOf);
            if (!childId || !parentId) {
              continue;
            }
            const child = signalByProcessedItemId.get(childId);
            const parent = signalByProcessedItemId.get(parentId);
            if (!child || !parent) {
              continue;
            }
            if (child.source === parent.source) {
              continue;
            }
            const lagMs = Math.abs(child.timestampMs - parent.timestampMs);
            const tsMs = Math.max(child.timestampMs, parent.timestampMs);
            const similarity =
              typeof payload.duplicateSimilarity === "number" &&
              Number.isFinite(payload.duplicateSimilarity)
                ? payload.duplicateSimilarity
                : null;

            const forward = parent.timestampMs <= child.timestampMs;
            const source = forward ? parent.source : child.source;
            const target = forward ? child.source : parent.source;
            pushEdge("duplicate", source, target, lagMs, tsMs, similarity);
            handledDuplicateChildren.add(childId);
          }
        }
      } catch {
        // Duplicate edges are best-effort; fall back to time-based edges.
      }
    }

    signals.sort((a, b) => a.timestampMs - b.timestampMs);

    for (let idx = 0; idx < signals.length; idx += 1) {
      const signal = signals[idx]!;
      if (
        signal.processedItemId &&
        handledDuplicateChildren.has(signal.processedItemId)
      ) {
        continue;
      }
      for (let prevIdx = idx - 1; prevIdx >= 0; prevIdx -= 1) {
        const prev = signals[prevIdx]!;
        const deltaMs = signal.timestampMs - prev.timestampMs;
        if (deltaMs > windowMs) {
          break;
        }
        if (prev.source === signal.source) {
          continue;
        }
        pushEdge(
          "time",
          prev.source,
          signal.source,
          deltaMs,
          signal.timestampMs,
        );
        break;
      }
    }

    const sortedNodes = Array.from(nodeAgg.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, maxNodes)
      .map(([source, agg]) => ({
        id: source,
        name: source,
        count: agg.count,
        firstAt: new Date(agg.firstMs).toISOString(),
        lastAt: new Date(agg.lastMs).toISOString(),
      }));

    const allowed = new Set(sortedNodes.map((node) => node.id));

    const sortedEdges = Array.from(edgeAgg.values())
      .filter((edge) => allowed.has(edge.source) && allowed.has(edge.target))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, maxEdges)
      .map((edge) => {
        const avgLagMs = edge.lagCount > 0 ? edge.lagSumMs / edge.lagCount : 0;
        const avgDuplicateSimilarity =
          edge.kind === "duplicate" &&
          edge.similarityCount &&
          edge.similarityCount > 0
            ? (edge.similaritySum ?? 0) / edge.similarityCount
            : undefined;
        return {
          source: edge.source,
          target: edge.target,
          kind: edge.kind,
          weight: edge.weight,
          avgLagMs,
          firstAt: new Date(edge.firstMs).toISOString(),
          lastAt: new Date(edge.lastMs).toISOString(),
          ...(avgDuplicateSimilarity !== undefined
            ? { avgDuplicateSimilarity }
            : {}),
        };
      });

    return {
      eventId,
      windowHours,
      nodes: sortedNodes,
      edges: sortedEdges,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }

  async getSpacetimePropagationArticles(
    range: DateRange,
    orgId: string,
    options: {
      eventId: string;
      source: string;
      cursorStart?: string;
      cursorEnd?: string;
      limit?: string;
    },
  ): Promise<SpacetimePropagationArticlesResponse> {
    const eventId =
      typeof options.eventId === "string" ? options.eventId.trim() : "";
    if (!eventId) {
      throw new BadRequestException("eventId is required");
    }
    const source =
      typeof options.source === "string" ? options.source.trim() : "";
    if (!source) {
      throw new BadRequestException("source is required");
    }

    const limitRaw =
      typeof options.limit === "string" ? options.limit.trim() : "";
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
    const limit =
      Number.isFinite(limitParsed) && limitParsed > 0
        ? Math.min(100, limitParsed)
        : 30;

    const parseIsoDate = (raw?: string): Date | null => {
      if (!raw || typeof raw !== "string") {
        return null;
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        return null;
      }
      const d = new Date(trimmed);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException("Invalid cursor date");
      }
      return d;
    };

    const cursorStart = parseIsoDate(options.cursorStart);
    const cursorEnd = parseIsoDate(options.cursorEnd);
    const cursorStartIso = cursorStart ? cursorStart.toISOString() : undefined;
    const cursorEndIso = cursorEnd ? cursorEnd.toISOString() : undefined;

    const resolveSourceKey = (sourceLabel: unknown, url: unknown): string => {
      const label = typeof sourceLabel === "string" ? sourceLabel.trim() : "";
      if (label) {
        return label.slice(0, 120);
      }
      const rawUrl = typeof url === "string" ? url.trim() : "";
      if (rawUrl) {
        try {
          const host = new URL(rawUrl).hostname.trim();
          if (host) {
            return host.slice(0, 120);
          }
        } catch {
          // Ignore invalid URLs.
        }
      }
      return "unknown";
    };

    const rows = await this.prisma.newsEventItem.findMany({
      where: {
        orgId,
        eventId,
        processedArticle: {
          status: ProcessedArticleStatus.completed,
          OR: [
            {
              publishedAt: {
                gte: range.start,
                lte: range.end,
              },
              article: { orgId },
            },
            {
              publishedAt: null,
              article: {
                orgId,
                crawlAt: {
                  gte: range.start,
                  lte: range.end,
                },
              },
            },
          ],
        },
      },
      select: {
        processedItemId: true,
        createdAt: true,
        processedArticle: {
          select: {
            id: true,
            cleanedMarkdownRef: true,
            title: true,
            publishedAt: true,
            processedAt: true,
            article: {
              select: {
                url: true,
                sourceLabel: true,
                crawlAt: true,
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }],
      take: 2000,
    });

    const matches: {
      processedArticleId: string;
      processedItemId: string | null;
      title: string;
      url: string | null;
      sourceLabel: string | null;
      publishedAt?: string;
      ingestedAt?: string;
      processedAt?: string;
      tsMs: number;
    }[] = [];

    let updatedAt: Date | undefined;

    for (const row of rows) {
      const processed = row.processedArticle;
      if (!processed) {
        continue;
      }
      const article = processed.article;
      const sourceKey = resolveSourceKey(article?.sourceLabel, article?.url);
      if (sourceKey !== source) {
        continue;
      }

      const ts =
        processed.publishedAt ?? article?.crawlAt ?? processed.processedAt;
      if (!ts) {
        continue;
      }
      if (cursorStart && ts < cursorStart) {
        continue;
      }
      if (cursorEnd && ts >= cursorEnd) {
        continue;
      }
      const tsMs = ts.getTime();
      if (!Number.isFinite(tsMs)) {
        continue;
      }

      const url = article?.url ?? null;
      const title = (processed.title ?? "").trim() || url || sourceKey;
      const publishedAtIso = processed.publishedAt
        ? processed.publishedAt.toISOString()
        : undefined;
      const ingestedAtIso = article?.crawlAt
        ? article.crawlAt.toISOString()
        : undefined;
      const processedAtIso = processed.processedAt
        ? processed.processedAt.toISOString()
        : undefined;

      const processedItemIdCandidate =
        (typeof row.processedItemId === "string"
          ? row.processedItemId.trim()
          : "") ||
        (typeof processed.cleanedMarkdownRef === "string"
          ? processed.cleanedMarkdownRef.trim()
          : "");
      const processedItemId = processedItemIdCandidate
        ? processedItemIdCandidate
        : null;

      matches.push({
        processedArticleId: processed.id,
        processedItemId,
        title,
        url,
        sourceLabel:
          typeof article?.sourceLabel === "string" ? article.sourceLabel : null,
        publishedAt: publishedAtIso,
        ingestedAt: ingestedAtIso,
        processedAt: processedAtIso,
        tsMs,
      });

      updatedAt = !updatedAt || ts > updatedAt ? ts : updatedAt;
    }

    matches.sort((a, b) => b.tsMs - a.tsMs);

    const selected = matches.slice(0, limit);
    const hasMore = matches.length > selected.length;

    const processedItemIds = Array.from(
      new Set(
        selected
          .map((row) => row.processedItemId ?? "")
          .filter((id) => id.length > 0),
      ),
    );

    const sentimentByProcessedItemId = new Map<
      string,
      SpacetimeSentimentLabel
    >();
    if (processedItemIds.length > 0) {
      try {
        const docs = (await ProcessedItemModel.find(
          { _id: { $in: processedItemIds }, orgId, status: "completed" },
          { _id: 1, result: 1 },
        )
          .lean()
          .exec()) as unknown;

        if (Array.isArray(docs)) {
          for (const doc of docs) {
            if (!doc || typeof doc !== "object") {
              continue;
            }
            const payload = doc as Record<string, unknown>;
            const id = normalizeMongoId(payload._id);
            if (!id) {
              continue;
            }
            const result =
              payload.result &&
              typeof payload.result === "object" &&
              !Array.isArray(payload.result)
                ? (payload.result as Record<string, unknown>)
                : null;
            const sentiment = normalizeSentimentLabel(
              result?.sentiment_label ??
                result?.sentimentLabel ??
                result?.sentiment,
            );
            sentimentByProcessedItemId.set(id, sentiment);
          }
        }
      } catch {
        // Sentiment is best-effort.
      }
    }

    const articles: SpacetimePropagationArticle[] = selected.map((row) => ({
      id: row.processedArticleId,
      title: row.title,
      url: row.url,
      sourceLabel: row.sourceLabel,
      publishedAt: row.publishedAt,
      ingestedAt: row.ingestedAt,
      processedAt: row.processedAt,
      ...(row.processedItemId &&
      sentimentByProcessedItemId.has(row.processedItemId)
        ? { sentiment: sentimentByProcessedItemId.get(row.processedItemId)! }
        : {}),
    }));

    return {
      eventId,
      source,
      cursorStart: cursorStartIso,
      cursorEnd: cursorEndIso,
      hasMore,
      articles,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }

  private getGeoIndex() {
    if (this.geoIndex) {
      return this.geoIndex;
    }
    const index = new Map<string, { name: string; lat: number; lng: number }>();
    const payload = worldGeoJson as GeoJsonFeatureCollection;
    for (const feature of payload.features) {
      const name =
        typeof feature.properties?.name === "string"
          ? feature.properties?.name
          : null;
      const id = typeof feature.id === "string" ? feature.id : null;
      const code = normalizeGeoId(id ?? name);
      if (!code || !name || !feature.geometry) {
        continue;
      }
      const centroid = this.resolveCentroid(feature.geometry);
      if (!centroid) {
        continue;
      }
      index.set(code, { name, lat: centroid.lat, lng: centroid.lng });
    }
    this.geoIndex = index;
    return index;
  }

  private resolveCentroid(
    geometry: GeoJsonGeometry,
  ): { lat: number; lng: number } | null {
    const positions: [number, number][] = [];
    const collectPositions = (input: unknown) => {
      if (!input) {
        return;
      }
      if (Array.isArray(input)) {
        if (
          input.length >= 2 &&
          typeof input[0] === "number" &&
          typeof input[1] === "number"
        ) {
          positions.push([input[0], input[1]]);
          return;
        }
        input.forEach((entry) => collectPositions(entry));
      }
    };

    if (
      geometry.type === "GeometryCollection" &&
      Array.isArray(geometry.geometries)
    ) {
      geometry.geometries.forEach((child) =>
        collectPositions(child.coordinates),
      );
    } else {
      collectPositions(geometry.coordinates);
    }

    if (!positions.length) {
      return null;
    }

    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;

    for (const [lng, lat] of positions) {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        continue;
      }
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }

    if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) {
      return null;
    }

    return {
      lng: (minLng + maxLng) / 2,
      lat: (minLat + maxLat) / 2,
    };
  }

  async getSectorHeatmap(range: DateRange): Promise<SectorHeatmapResponse> {
    const items = await this.prisma.economicDataItem.findMany({
      where: {
        isActive: true,
        categories: {
          some: {
            category: {
              key: DEFAULT_SECTOR_CATEGORY,
            },
          },
        },
      },
      select: {
        id: true,
        slug: true,
        displayName: true,
        defaultUnit: true,
        metadata: true,
      },
      orderBy: { displayName: "asc" },
      take: MAX_SECTOR_CELLS,
    });

    const xLabels = Array.from(
      { length: HEATMAP_COLUMNS },
      (_, idx) => `Group ${String.fromCharCode(65 + idx)}`,
    );
    const yLabels = Array.from(
      { length: Math.max(1, Math.ceil(MAX_SECTOR_CELLS / HEATMAP_COLUMNS)) },
      (_, idx) => `Row ${idx + 1}`,
    );

    if (items.length === 0) {
      return { xLabels, yLabels, cells: [] };
    }

    const seriesGroups = await this.prisma.economicDataPoint.groupBy({
      by: ["itemId", "sourceField"],
      where: {
        itemId: {
          in: items.map((item) => item.id),
        },
        recordedAt: {
          gte: range.start,
          lte: range.end,
        },
      },
      _count: { _all: true },
    });

    const availableFieldsByItemId = new Map<string, Set<string>>();
    for (const group of seriesGroups) {
      const itemId = group.itemId;
      const sourceField = group.sourceField;
      if (!itemId || !sourceField) {
        continue;
      }
      const existing = availableFieldsByItemId.get(itemId) ?? new Set<string>();
      existing.add(sourceField);
      availableFieldsByItemId.set(itemId, existing);
    }

    const cells: SectorHeatmapCell[] = [];
    let updatedAt: Date | undefined;
    const mappingErrors: {
      itemId: string;
      slug: string;
      displayName: string;
      preferredSourceFields: string[];
      availableSourceFields: string[];
    }[] = [];

    for (const item of items) {
      const fields = availableFieldsByItemId.get(item.id);
      if (!fields || fields.size === 0) {
        continue;
      }

      const config = getDataVizConfig(item.metadata);
      const preferredKeys =
        config.heatmap.preferredSourceFields &&
        config.heatmap.preferredSourceFields.length > 0
          ? uniqStrings(config.heatmap.preferredSourceFields)
          : [...PREFERRED_SOURCE_FIELDS];
      const labelToField = buildLabelToSourceFieldMap(item.metadata);
      const seriesByField = new Map<string, unknown[]>();
      Array.from(fields).forEach((field) => seriesByField.set(field, []));
      const fieldKey = resolvePreferredSourceField(
        seriesByField,
        preferredKeys,
        labelToField,
      );
      if (!fieldKey) {
        mappingErrors.push({
          itemId: item.id,
          slug: item.slug,
          displayName: item.displayName,
          preferredSourceFields: preferredKeys,
          availableSourceFields: Array.from(fields).sort((a, b) =>
            a.localeCompare(b),
          ),
        });
        continue;
      }

      const pointWhere = {
        itemId: item.id,
        sourceField: fieldKey,
        recordedAt: {
          gte: range.start,
          lte: range.end,
        },
      };

      const [firstPoint, lastPoint] = await Promise.all([
        this.prisma.economicDataPoint.findFirst({
          where: pointWhere,
          select: {
            recordedAt: true,
            value: true,
            unit: true,
          },
          orderBy: { recordedAt: "asc" },
        }),
        this.prisma.economicDataPoint.findFirst({
          where: pointWhere,
          select: {
            recordedAt: true,
            value: true,
            unit: true,
          },
          orderBy: { recordedAt: "desc" },
        }),
      ]);

      if (!firstPoint || !lastPoint) {
        continue;
      }

      const firstValue = Number(firstPoint.value ?? 0);
      const lastValue = Number(lastPoint.value ?? 0);
      const unit =
        (lastPoint.unit as string | null | undefined) ??
        item.defaultUnit ??
        null;
      const change =
        firstValue === 0
          ? 0
          : ((lastValue - firstValue) / Math.abs(firstValue)) * 100;

      const index = cells.length;
      const x = index % HEATMAP_COLUMNS;
      const y = Math.floor(index / HEATMAP_COLUMNS);
      cells.push({
        x,
        y,
        name: item.displayName,
        value: Number(lastValue.toFixed(2)),
        change: Number(change.toFixed(2)),
        unit,
        sourceField: fieldKey,
      });

      if (lastPoint && (!updatedAt || lastPoint.recordedAt > updatedAt)) {
        updatedAt = lastPoint.recordedAt;
      }

      if (cells.length >= MAX_SECTOR_CELLS) {
        break;
      }
    }

    if (mappingErrors.length > 0) {
      throw new InternalServerErrorException({
        code: "DASHBOARD_SECTOR_HEATMAP_FIELD_MAPPING_MISMATCH",
        message: "Sector heatmap field mapping mismatch",
        detail:
          "No preferred sourceField matched for one or more items. Configure EconomicDataItem.metadata.dataViz.heatmap.preferredSourceFields.",
        items: mappingErrors,
      });
    }

    const rowCount = Math.max(1, Math.ceil(cells.length / HEATMAP_COLUMNS));
    return {
      xLabels,
      yLabels: yLabels.slice(0, rowCount),
      cells,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }

  async getFinancialCandlestick(
    range: DateRange,
  ): Promise<FinancialCandlestickResponse> {
    const item = await this.prisma.economicDataItem.findUnique({
      where: { slug: DEFAULT_CANDLESTICK_SLUG },
      select: {
        id: true,
        displayName: true,
        defaultFrequency: true,
        defaultUnit: true,
        metadata: true,
      },
    });

    if (!item) {
      return {
        symbol: DEFAULT_CANDLESTICK_SLUG,
        interval: "daily",
        points: [],
      };
    }

    const config = getDataVizConfig(item.metadata);
    const labelToField = buildLabelToSourceFieldMap(item.metadata);
    const ohlcAliases = (Object.keys(OHLC_FIELD_ALIASES) as OhlcField[]).reduce(
      (acc, field) => {
        const configured = config.candlestick.ohlc?.[field];
        const merged =
          configured && configured.length > 0
            ? configured
            : OHLC_FIELD_ALIASES[field];
        const expanded: string[] = [];
        for (const alias of merged) {
          expanded.push(alias);
          const mapped = labelToField.get(alias);
          if (mapped) {
            expanded.push(mapped);
          }
        }
        acc[field] = uniqStrings(expanded);
        return acc;
      },
      {} as Record<OhlcField, string[]>,
    );

    const aliasToField = new Map<string, OhlcField>();
    const aliasRankByField = (
      Object.keys(OHLC_FIELD_ALIASES) as OhlcField[]
    ).reduce(
      (acc, field) => {
        acc[field] = new Map<string, number>();
        return acc;
      },
      {} as Record<OhlcField, Map<string, number>>,
    );

    for (const field of Object.keys(ohlcAliases) as OhlcField[]) {
      ohlcAliases[field].forEach((alias, index) => {
        const normalized = normalizeSourceFieldKey(alias);
        if (!normalized) return;
        if (!aliasToField.has(normalized)) {
          aliasToField.set(normalized, field);
        }
        if (!aliasRankByField[field].has(normalized)) {
          aliasRankByField[field].set(normalized, index);
        }
      });
    }

    const points = await this.prisma.economicDataPoint.findMany({
      where: {
        itemId: item.id,
        recordedAt: {
          gte: range.start,
          lte: range.end,
        },
        sourceField: {
          in: uniqStrings(Object.values(ohlcAliases).flat()),
        },
      },
      orderBy: { recordedAt: "asc" },
    });

    if (points.length === 0) {
      const totalPoints = await this.prisma.economicDataPoint.count({
        where: {
          itemId: item.id,
          recordedAt: {
            gte: range.start,
            lte: range.end,
          },
        },
      });
      if (totalPoints > 0) {
        const available = await this.prisma.economicDataPoint.findMany({
          where: {
            itemId: item.id,
            recordedAt: {
              gte: range.start,
              lte: range.end,
            },
          },
          distinct: ["sourceField"],
          select: { sourceField: true },
          take: 50,
        });

        throw new InternalServerErrorException({
          code: "DASHBOARD_CANDLESTICK_FIELD_MAPPING_MISMATCH",
          message: "Candlestick field mapping mismatch",
          detail:
            "No OHLC sourceField matched for this item in the requested range. Configure EconomicDataItem.metadata.dataViz.candlestick.ohlc.",
          item: {
            id: item.id,
            slug: DEFAULT_CANDLESTICK_SLUG,
            displayName: item.displayName,
          },
          expectedAliases: ohlcAliases,
          availableSourceFields: available
            .map((entry) => entry.sourceField)
            .sort((a, b) => a.localeCompare(b)),
        });
      }
    }

    const unit =
      (points.find((point) => point.unit)?.unit as string | null | undefined) ??
      item.defaultUnit ??
      null;
    const sourceFields: Partial<
      Record<keyof typeof OHLC_FIELD_ALIASES, string>
    > = {};
    const sourceFieldRanks: Partial<
      Record<keyof typeof OHLC_FIELD_ALIASES, number>
    > = {};
    const grouped = new Map<
      string,
      {
        timestamp: Date;
        open?: number;
        high?: number;
        low?: number;
        close?: number;
        ranks: Partial<Record<keyof typeof OHLC_FIELD_ALIASES, number>>;
      }
    >();

    for (const point of points) {
      const normalizedSourceField = normalizeSourceFieldKey(point.sourceField);
      const field = aliasToField.get(normalizedSourceField);
      if (!field) continue;
      const rank =
        aliasRankByField[field].get(normalizedSourceField) ??
        Number.MAX_SAFE_INTEGER;

      const key = point.recordedAt.toISOString();
      const entry = grouped.get(key) ?? {
        timestamp: point.recordedAt,
        ranks: {},
      };
      const existingRank = entry.ranks[field];
      if (existingRank === undefined || rank < existingRank) {
        entry[field] = Number(point.value);
        entry.ranks[field] = rank;
      }
      grouped.set(key, entry);

      const globalRank = sourceFieldRanks[field];
      if (globalRank === undefined || rank < globalRank) {
        sourceFields[field] = point.sourceField;
        sourceFieldRanks[field] = rank;
      }
    }

    const sorted = Array.from(grouped.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    const resultPoints: FinancialCandlestickPoint[] = [];
    let updatedAt: Date | undefined;
    for (const entry of sorted) {
      const missing: string[] = [];
      if (entry.open === undefined) missing.push("open");
      if (entry.high === undefined) missing.push("high");
      if (entry.low === undefined) missing.push("low");
      if (entry.close === undefined) missing.push("close");
      if (missing.length > 0) {
        throw new InternalServerErrorException({
          code: "DASHBOARD_CANDLESTICK_OHLC_INCOMPLETE",
          message: "Candlestick OHLC data incomplete",
          detail: `Missing ${missing.join(", ")} at ${entry.timestamp.toISOString()}`,
          item: {
            id: item.id,
            slug: DEFAULT_CANDLESTICK_SLUG,
            displayName: item.displayName,
          },
        });
      }

      const open = entry.open!;
      const close = entry.close!;
      const high = entry.high!;
      const low = entry.low!;

      resultPoints.push({
        timestamp: entry.timestamp.toISOString(),
        open,
        close,
        high,
        low,
      });

      updatedAt = entry.timestamp;
    }

    return {
      symbol: item.displayName,
      interval: item.defaultFrequency,
      points: resultPoints,
      unit,
      sourceFields:
        Object.keys(sourceFields).length > 0
          ? (sourceFields as Record<string, string>)
          : undefined,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
    };
  }
}
