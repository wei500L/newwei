import { BadRequestException, Injectable } from "@nestjs/common";
import { extractCountryCodeFromText, normalizeCountryCode } from "@modular/utils";
import { AlertSeverity } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";

import worldGeoJson from "./assets/world.geo.json";
import type { DashboardTimeRangeQueryDto } from "./dto/dashboard-charts.dto";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;
const DEFAULT_SECTOR_CATEGORY = "economic-short";
const DEFAULT_CANDLESTICK_SLUG = "sp500_index";
const HEATMAP_COLUMNS = 4;
const MAX_SECTOR_CELLS = 8;
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

interface WarMapGeoJsonResponse {
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
}

interface WarMapEventsResponse {
  events: WarMapEvent[];
  updatedAt?: string;
}

interface SectorHeatmapCell {
  x: number;
  y: number;
  name: string;
  value: number;
  change: number;
  unit?: string | null;
  sourceField?: string;
}

interface SectorHeatmapResponse {
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

interface FinancialCandlestickResponse {
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

  constructor(private readonly prisma: PrismaService) {}

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

  async getWarMapEvents(range: DateRange, orgId: string): Promise<WarMapEventsResponse> {
    const geoIndex = this.getGeoIndex();
    const signals = new Map<
      string,
      {
        name: string;
        lat: number;
        lng: number;
        alertScore: number;
        maxSeverityRank: number;
        latestAt?: Date;
      }
    >();

    const alertEvents = await this.prisma.alertEvent.findMany({
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
    });

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
        alertScore: 0,
        maxSeverityRank: 0
      };
      const severityValue = alertSeverityRank[event.severity] ?? 1;
      entry.alertScore += severityValue;
      entry.maxSeverityRank = Math.max(entry.maxSeverityRank, severityValue);
      entry.latestAt =
        !entry.latestAt || event.triggeredAt > entry.latestAt ? event.triggeredAt : entry.latestAt;
      signals.set(resolvedCode, entry);
    }

    let latestTimestamp: Date | undefined;
    const events: WarMapEvent[] = [];

    for (const [code, entry] of signals.entries()) {
      if (!entry.latestAt) {
        continue;
      }
      const derivedScore = Math.max(1, Number(entry.alertScore.toFixed(2)));
      const severity =
        entry.maxSeverityRank > 0
          ? (alertSeverityByRank[entry.maxSeverityRank] ?? AlertSeverity.low)
          : AlertSeverity.low;
      events.push({
        id: code.toLowerCase(),
        name: entry.name,
        lat: entry.lat,
        lng: entry.lng,
        severity,
        derivedScore,
        value: derivedScore
      });
      if (!latestTimestamp || entry.latestAt > latestTimestamp) {
        latestTimestamp = entry.latestAt;
      }
    }

    if (events.length > 0) {
      return {
        events,
        updatedAt: latestTimestamp ? latestTimestamp.toISOString() : undefined
      };
    }

    return this.getWarMapNewsSignals(range, orgId, geoIndex);
  }

  private async getWarMapNewsSignals(
    range: DateRange,
    orgId: string,
    geoIndex: Map<string, { name: string; lat: number; lng: number }>
  ): Promise<WarMapEventsResponse> {
    const records = await this.prisma.processedArticle.findMany({
      where: {
        location: { not: null },
        article: {
          orgId,
          crawlAt: {
            gte: range.start,
            lte: range.end
          }
        }
      },
      select: {
        location: true,
        processedAt: true,
        article: {
          select: {
            crawlAt: true
          }
        }
      },
      orderBy: { processedAt: "desc" },
      take: 2500
    });

    const signals = new Map<
      string,
      {
        name: string;
        lat: number;
        lng: number;
        count: number;
        latestAt?: Date;
      }
    >();

    for (const record of records) {
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
        count: 0,
        latestAt: undefined
      };
      entry.count += 1;
      const latestAt = record.article.crawlAt ?? record.processedAt;
      entry.latestAt =
        !entry.latestAt || latestAt > entry.latestAt ? latestAt : entry.latestAt;
      signals.set(resolvedCode, entry);
    }

    let updatedAt: Date | undefined;
    const events: WarMapEvent[] = [];
    for (const [code, entry] of signals.entries()) {
      if (!entry.latestAt) {
        continue;
      }
      const derivedScore = entry.count;
      const severity =
        derivedScore >= 8
          ? AlertSeverity.high
          : derivedScore >= 4
            ? AlertSeverity.medium
            : AlertSeverity.low;
      events.push({
        id: code.toLowerCase(),
        name: entry.name,
        lat: entry.lat,
        lng: entry.lng,
        severity,
        derivedScore,
        value: derivedScore
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
    const positions: Array<[number, number]> = [];
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
        displayName: true,
        defaultUnit: true
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
        },
        sourceField: {
          in: [...PREFERRED_SOURCE_FIELDS]
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

    for (const item of items) {
      const itemGroup = grouped.get(item.id);
      if (!itemGroup) {
        continue;
      }

      const fieldKey = PREFERRED_SOURCE_FIELDS.find((field) => itemGroup.has(field));
      if (!fieldKey) {
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
        defaultUnit: true
      }
    });

    if (!item) {
      return {
        symbol: DEFAULT_CANDLESTICK_SLUG,
        interval: "daily",
        points: []
      };
    }

    const aliasToField = new Map<string, keyof typeof OHLC_FIELD_ALIASES>();
    for (const [field, aliases] of Object.entries(OHLC_FIELD_ALIASES)) {
      aliases.forEach((alias) => aliasToField.set(alias, field as keyof typeof OHLC_FIELD_ALIASES));
    }

    const points = await this.prisma.economicDataPoint.findMany({
      where: {
        itemId: item.id,
        recordedAt: {
          gte: range.start,
          lte: range.end
        },
        sourceField: {
          in: Array.from(aliasToField.keys())
        }
      },
      orderBy: { recordedAt: "asc" }
    });

    const unit =
      (points.find((point) => point.unit)?.unit as string | null | undefined) ??
      item.defaultUnit ??
      null;
    const sourceFields: Partial<Record<keyof typeof OHLC_FIELD_ALIASES, string>> = {};
    const grouped = new Map<
      string,
      {
        timestamp: Date;
        open?: number;
        high?: number;
        low?: number;
        close?: number;
      }
    >();

    for (const point of points) {
      const field = aliasToField.get(point.sourceField);
      if (!field) continue;
      if (!sourceFields[field]) {
        sourceFields[field] = point.sourceField;
      }
      const key = point.recordedAt.toISOString();
      const entry =
        grouped.get(key) ?? {
          timestamp: point.recordedAt
        };
      entry[field] = Number(point.value);
      grouped.set(key, entry);
    }

    const sorted = Array.from(grouped.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );

    const resultPoints: FinancialCandlestickPoint[] = [];
    let updatedAt: Date | undefined;
    for (const entry of sorted) {
      const open = entry.open ?? entry.close ?? entry.high ?? entry.low;
      if (open === undefined) continue;
      const close = entry.close ?? open;
      const high = entry.high ?? Math.max(open, close);
      const low = entry.low ?? Math.min(open, close);

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
