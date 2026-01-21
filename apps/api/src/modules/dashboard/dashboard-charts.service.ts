import {
  extractCountryCodeFromText,
  getCountryAlpha2,
  getCountryName,
  normalizeCountryCode
} from "@modular/utils";
import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { AlertSeverity, ProcessedArticleStatus } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";
import { GeocodingService } from "../geo/geocoding.service";

import worldGeoJson from "./assets/world.geo.json";
import type { DashboardTimeRangeQueryDto } from "./dto/dashboard-charts.dto";
import {
  buildWarMapLayersResponse,
  type WarMapLayersResponse
} from "./war-map-layers";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;
const DEFAULT_SECTOR_CATEGORY = "economic-short";
const DEFAULT_CANDLESTICK_SLUG = "sp500_index";
const HEATMAP_COLUMNS = 4;
const MAX_SECTOR_CELLS = 8;
const MAX_WAR_MAP_NEWS_MARKERS = 500;
const MAX_WAR_MAP_NEWS_GEOCODE_NETWORK = 3;
const PREFERRED_SOURCE_FIELDS = [
  "close",
  "收盘价",
  "value",
  "latest_price",
  "current_price"
] as const;

const OHLC_FIELD_ALIASES = {
  open: ["open", "开盘价"],
  high: ["high", "最高价"],
  low: ["low", "最低价"],
  close: ["close", "收盘价"]
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

type DataVizConfig = {
  heatmap: { preferredSourceFields?: string[] };
  candlestick: { ohlc?: Partial<Record<OhlcField, string[]>> };
};

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
      preferredSourceFields
    },
    candlestick: {
      ohlc: Object.keys(ohlcFieldAliases).length > 0 ? ohlcFieldAliases : undefined
    }
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
    map.set(field, field);
    const label = entry.label;
    if (typeof label === "string" && label.trim()) {
      map.set(label, field);
    }
  }

  return map;
};

const resolvePreferredSourceField = (
  seriesByField: Map<string, unknown[]>,
  preferredKeys: string[],
  labelToField: Map<string, string>
) => {
  for (const key of preferredKeys) {
    if (seriesByField.has(key)) {
      return key;
    }
    const mapped = labelToField.get(key);
    if (mapped && seriesByField.has(mapped)) {
      return mapped;
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
  url?: string | null;
  location: string;
  lat: number;
  lng: number;
  publishedAt?: string;
  ingestedAt?: string;
  displayName?: string;
  geoSource: WarMapNewsGeoSource;
}

export interface WarMapNewsMarkersResponse {
  markers: WarMapNewsMarker[];
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

const alertSeverityRank: Record<AlertSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3
};

const alertSeverityByRank: Record<number, AlertSeverity> = {
  1: AlertSeverity.low,
  2: AlertSeverity.medium,
  3: AlertSeverity.high
};

@Injectable()
export class DashboardChartsService {
  private geoIndex: Map<string, { name: string; lat: number; lng: number }> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocoding: GeocodingService
  ) {}

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
    if (payload?.type !== "FeatureCollection" || !Array.isArray(payload.features)) {
      throw new Error("Invalid GeoJSON payload");
    }
    return {
      name: "world",
      geoJson: worldGeoJson,
      center: [0, 20],
      zoom: 1.1
    };
  }

  getWarMapLayers(): WarMapLayersResponse {
    return buildWarMapLayersResponse();
  }

  async getWarMapEvents(range: DateRange, orgId: string): Promise<WarMapEventsResponse> {
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
            lte: range.end
          },
          rule: {
            orgId
          }
        },
        select: {
          triggeredAt: true,
          severity: true,
          context: true
        },
        orderBy: { triggeredAt: "desc" }
      }),
      this.prisma.processedArticle.findMany({
        where: {
          status: ProcessedArticleStatus.completed,
          location: { not: null },
          OR: [
            {
              publishedAt: {
                gte: range.start,
                lte: range.end
              },
              article: { orgId }
            },
            {
              publishedAt: null,
              article: {
                orgId,
                crawlAt: {
                  gte: range.start,
                  lte: range.end
                }
              }
            }
          ]
        },
        select: {
          location: true,
          processedAt: true,
          publishedAt: true,
          article: {
            select: {
              crawlAt: true
            }
          }
        },
        orderBy: { processedAt: "desc" },
        take: 2500
      })
    ]);

    for (const event of alertEvents) {
      const context =
        event.context && typeof event.context === "object" && !Array.isArray(event.context)
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
        normalizeGeoId(rawCountry) ?? extractCountryCodeFromText(rawCountry ?? null);
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
        newsCount: 0
      };
      const severityValue = alertSeverityRank[event.severity] ?? 1;
      entry.alertScore += severityValue;
      entry.alertCount += 1;
      entry.maxAlertSeverityRank = Math.max(entry.maxAlertSeverityRank, severityValue);
      entry.latestAt =
        !entry.latestAt || event.triggeredAt > entry.latestAt ? event.triggeredAt : entry.latestAt;
      signals.set(resolvedCode, entry);
    }

    for (const record of newsRecords) {
      const location = record.location;
      if (!location || typeof location !== "string") {
        continue;
      }
      const resolvedCode = normalizeGeoId(extractCountryCodeFromText(location) ?? location);
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
        latestAt: undefined
      };
      entry.newsCount += 1;
      const latestAt = record.publishedAt ?? record.article.crawlAt ?? record.processedAt;
      entry.latestAt =
        !entry.latestAt || latestAt > entry.latestAt ? latestAt : entry.latestAt;
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
        entry.newsCount >= 8 ? 3 : entry.newsCount >= 4 ? 2 : entry.newsCount > 0 ? 1 : 0;
      const maxSeverityRank = Math.max(entry.maxAlertSeverityRank, newsSeverityRank);
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
        newsCount: entry.newsCount
      });
      if (!updatedAt || entry.latestAt > updatedAt) {
        updatedAt = entry.latestAt;
      }
    }

    return {
      events,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined
    };
  }

  async getWarMapNewsMarkers(
    range: DateRange,
    orgId: string
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
              lte: range.end
            },
            article: { orgId }
          },
          {
            publishedAt: null,
            article: {
              orgId,
              crawlAt: {
                gte: range.start,
                lte: range.end
              }
            }
          }
        ]
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
            titleGuess: true
          }
        }
      },
      orderBy: { processedAt: "desc" },
      take: MAX_WAR_MAP_NEWS_MARKERS
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

    const resolveCountryAlpha3 = (location: string, entities: CleanedEntity[]): string | null => {
      const fromLocation = extractCountryCodeFromText(location) ?? normalizeCountryCode(location);
      if (fromLocation) {
        return fromLocation;
      }
      for (const entity of entities) {
        const code = normalizeCountryCode(entity.name) ?? extractCountryCodeFromText(entity.name);
        if (code) {
          return code;
        }
      }
      return null;
    };

    const buildCandidates = (location: string, entities: CleanedEntity[], countryName?: string | null) => {
      const candidates: string[] = [];
      const pushCandidate = (value: string) => {
        const normalized = value.trim();
        if (!normalized) return;
        candidates.push(normalized);
      };

      const locationEntities = entities
        .filter((entity) => entity.confidence >= 0.5 && isLocationEntityType(entity.type))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3);

      for (const entity of locationEntities) {
        if (countryName && !entity.name.toLowerCase().includes(countryName.toLowerCase())) {
          pushCandidate(`${entity.name}, ${countryName}`);
        }
        pushCandidate(entity.name);
      }

      const primaryLocationChunk = location.split(/[,，;；/|]/)[0]?.trim() ?? "";
      if (primaryLocationChunk && primaryLocationChunk !== location) {
        if (
          countryName &&
          !primaryLocationChunk.toLowerCase().includes(countryName.toLowerCase())
        ) {
          pushCandidate(`${primaryLocationChunk}, ${countryName}`);
        }
        pushCandidate(primaryLocationChunk);
      }

      if (countryName && !location.toLowerCase().includes(countryName.toLowerCase())) {
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
      const location = typeof locationRaw === "string" ? locationRaw.trim() : "";
      if (!location) {
        continue;
      }

      const entities = normalizeEntities(record.entities);
      const countryAlpha3 = resolveCountryAlpha3(location, entities);
      const directCountryAlpha3 = normalizeCountryCode(location);
      const countryAlpha2 = countryAlpha3 ? getCountryAlpha2(countryAlpha3) ?? undefined : undefined;
      const countryName = countryAlpha3 ? getCountryName(countryAlpha3) : null;

      const candidates = buildCandidates(location, entities, countryName);

      let geocode = await this.geocoding.resolveCandidates(candidates, {
        countryCodeAlpha2: countryAlpha2,
        allowNetwork: false
      });
      if (!geocode && networkBudget > 0) {
        networkBudget -= 1;
        geocode = await this.geocoding.resolveCandidates(candidates, {
          countryCodeAlpha2: countryAlpha2,
          allowNetwork: true
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
        (record.title ?? record.article.titleGuess ?? record.article.url ?? "").trim() ||
        location;
      const latestAt = record.publishedAt ?? record.article.crawlAt ?? record.processedAt ?? undefined;

      markers.push({
        id: record.id,
        title,
        url: record.article.url ?? null,
        location,
        lat,
        lng,
        publishedAt: record.publishedAt ? record.publishedAt.toISOString() : undefined,
        ingestedAt: record.article.crawlAt ? record.article.crawlAt.toISOString() : undefined,
        displayName,
        geoSource
      });

      if (latestAt && (!updatedAt || latestAt > updatedAt)) {
        updatedAt = latestAt;
      }
    }

    return {
      markers,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined
    };
  }

  private getGeoIndex() {
    if (this.geoIndex) {
      return this.geoIndex;
    }
    const index = new Map<string, { name: string; lat: number; lng: number }>();
    const payload = worldGeoJson as GeoJsonFeatureCollection;
    for (const feature of payload.features) {
      const name = typeof feature.properties?.name === "string" ? feature.properties?.name : null;
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

  private resolveCentroid(geometry: GeoJsonGeometry): { lat: number; lng: number } | null {
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

    if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
      geometry.geometries.forEach((child) => collectPositions(child.coordinates));
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
      lat: (minLat + maxLat) / 2
    };
  }

  async getSectorHeatmap(range: DateRange): Promise<SectorHeatmapResponse> {
    const items = await this.prisma.economicDataItem.findMany({
      where: {
        isActive: true,
        categories: {
          some: {
            category: {
              key: DEFAULT_SECTOR_CATEGORY
            }
          }
        }
      },
      select: {
        id: true,
        slug: true,
        displayName: true,
        defaultUnit: true,
        metadata: true
      },
      orderBy: { displayName: "asc" },
      take: MAX_SECTOR_CELLS
    });

    const xLabels = Array.from({ length: HEATMAP_COLUMNS }, (_, idx) => `Group ${String.fromCharCode(65 + idx)}`);
    const yLabels = Array.from({ length: Math.max(1, Math.ceil(MAX_SECTOR_CELLS / HEATMAP_COLUMNS)) }, (_, idx) =>
      `Row ${idx + 1}`
    );

    if (items.length === 0) {
      return { xLabels, yLabels, cells: [] };
    }

    const points = await this.prisma.economicDataPoint.findMany({
      where: {
        itemId: {
          in: items.map((item) => item.id)
        },
        recordedAt: {
          gte: range.start,
          lte: range.end
        }
      },
      orderBy: { recordedAt: "asc" }
    });

    const grouped = new Map<string, Map<string, typeof points>>();
    for (const point of points) {
      const itemGroup = grouped.get(point.itemId) ?? new Map();
      const fieldGroup = itemGroup.get(point.sourceField) ?? [];
      fieldGroup.push(point);
      itemGroup.set(point.sourceField, fieldGroup);
      grouped.set(point.itemId, itemGroup);
    }

    const cells: SectorHeatmapCell[] = [];
    let updatedAt: Date | undefined;
    const mappingErrors: Array<{
      itemId: string;
      slug: string;
      displayName: string;
      preferredSourceFields: string[];
      availableSourceFields: string[];
    }> = [];

    for (const item of items) {
      const itemGroup = grouped.get(item.id);
      if (!itemGroup) {
        continue;
      }

      const config = getDataVizConfig(item.metadata);
      const preferredKeys =
        config.heatmap.preferredSourceFields && config.heatmap.preferredSourceFields.length > 0
          ? uniqStrings(config.heatmap.preferredSourceFields)
          : [...PREFERRED_SOURCE_FIELDS];
      const labelToField = buildLabelToSourceFieldMap(item.metadata);
      const fieldKey = resolvePreferredSourceField(itemGroup as Map<string, unknown[]>, preferredKeys, labelToField);
      if (!fieldKey) {
        mappingErrors.push({
          itemId: item.id,
          slug: item.slug,
          displayName: item.displayName,
          preferredSourceFields: preferredKeys,
          availableSourceFields: Array.from(itemGroup.keys()).sort((a, b) => a.localeCompare(b))
        });
        continue;
      }
      const series = itemGroup.get(fieldKey) ?? [];
      if (series.length === 0) {
        continue;
      }

      const firstValue = Number(series[0]?.value ?? 0);
      const lastPoint = series[series.length - 1];
      const lastValue = Number(lastPoint?.value ?? 0);
      const unit = (lastPoint?.unit as string | null | undefined) ?? item.defaultUnit ?? null;
      const change =
        firstValue === 0 ? 0 : ((lastValue - firstValue) / Math.abs(firstValue)) * 100;

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
        sourceField: fieldKey
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
        items: mappingErrors
      });
    }

    const rowCount = Math.max(1, Math.ceil(cells.length / HEATMAP_COLUMNS));
    return {
      xLabels,
      yLabels: yLabels.slice(0, rowCount),
      cells,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined
    };
  }

  async getFinancialCandlestick(range: DateRange): Promise<FinancialCandlestickResponse> {
    const item = await this.prisma.economicDataItem.findUnique({
      where: { slug: DEFAULT_CANDLESTICK_SLUG },
      select: {
        id: true,
        displayName: true,
        defaultFrequency: true,
        defaultUnit: true,
        metadata: true
      }
    });

    if (!item) {
      return {
        symbol: DEFAULT_CANDLESTICK_SLUG,
        interval: "daily",
        points: []
      };
    }

    const config = getDataVizConfig(item.metadata);
    const labelToField = buildLabelToSourceFieldMap(item.metadata);
    const ohlcAliases = (Object.keys(OHLC_FIELD_ALIASES) as OhlcField[]).reduce(
      (acc, field) => {
        const configured = config.candlestick.ohlc?.[field];
        const merged = configured && configured.length > 0 ? configured : OHLC_FIELD_ALIASES[field];
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
      {} as Record<OhlcField, string[]>
    );

    const aliasToField = new Map<string, OhlcField>();
    const aliasRankByField = (Object.keys(OHLC_FIELD_ALIASES) as OhlcField[]).reduce(
      (acc, field) => {
        acc[field] = new Map<string, number>();
        return acc;
      },
      {} as Record<OhlcField, Map<string, number>>
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
          lte: range.end
        },
        sourceField: {
          in: uniqStrings(Object.values(ohlcAliases).flat())
        }
      },
      orderBy: { recordedAt: "asc" }
    });

    if (points.length === 0) {
      const totalPoints = await this.prisma.economicDataPoint.count({
        where: {
          itemId: item.id,
          recordedAt: {
            gte: range.start,
            lte: range.end
          }
        }
      });
      if (totalPoints > 0) {
        const available = await this.prisma.economicDataPoint.findMany({
          where: {
            itemId: item.id,
            recordedAt: {
              gte: range.start,
              lte: range.end
            }
          },
          distinct: ["sourceField"],
          select: { sourceField: true },
          take: 50
        });

        throw new InternalServerErrorException({
          code: "DASHBOARD_CANDLESTICK_FIELD_MAPPING_MISMATCH",
          message: "Candlestick field mapping mismatch",
          detail:
            "No OHLC sourceField matched for this item in the requested range. Configure EconomicDataItem.metadata.dataViz.candlestick.ohlc.",
          item: {
            id: item.id,
            slug: DEFAULT_CANDLESTICK_SLUG,
            displayName: item.displayName
          },
          expectedAliases: ohlcAliases,
          availableSourceFields: available.map((entry) => entry.sourceField).sort((a, b) => a.localeCompare(b))
        });
      }
    }

    const unit =
      (points.find((point) => point.unit)?.unit as string | null | undefined) ??
      item.defaultUnit ??
      null;
    const sourceFields: Partial<Record<keyof typeof OHLC_FIELD_ALIASES, string>> = {};
    const sourceFieldRanks: Partial<Record<keyof typeof OHLC_FIELD_ALIASES, number>> = {};
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
      const rank = aliasRankByField[field].get(normalizedSourceField) ?? Number.MAX_SAFE_INTEGER;

      const key = point.recordedAt.toISOString();
      const entry =
        grouped.get(key) ?? {
          timestamp: point.recordedAt,
          ranks: {}
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
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
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
            displayName: item.displayName
          }
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
        low
      });

      updatedAt = entry.timestamp;
    }

    return {
      symbol: item.displayName,
      interval: item.defaultFrequency,
      points: resultPoints,
      unit,
      sourceFields: Object.keys(sourceFields).length > 0 ? (sourceFields as Record<string, string>) : undefined,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined
    };
  }
}
