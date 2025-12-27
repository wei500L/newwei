import { BadRequestException, Injectable } from "@nestjs/common";

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

const WAR_EVENT_SEEDS = [
  {
    id: "taiwan-strait",
    name: "Taiwan Strait",
    lat: 23.7,
    lng: 121.0,
    metricSlug: "global-conflict-index",
    weight: 1
  },
  {
    id: "eastern-europe",
    name: "Eastern Europe",
    lat: 49.0,
    lng: 31.0,
    metricSlug: "resource-scarcity",
    weight: 0.9
  },
  {
    id: "middle-east",
    name: "Levant Corridor",
    lat: 33.5,
    lng: 36.2,
    metricSlug: "market-sentiment",
    weight: 0.8
  },
  {
    id: "sahel",
    name: "Sahel Region",
    lat: 15.2,
    lng: 15.2,
    metricSlug: "supply-chain-stability",
    weight: 0.75
  }
] as const;

type WarEventSeverity = "high" | "medium" | "low";

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
  severity: WarEventSeverity;
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
  updatedAt?: string;
}

interface DateRange {
  start: Date;
  end: Date;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const resolveSeverity = (value: number): WarEventSeverity => {
  if (value >= 70) return "high";
  if (value >= 40) return "medium";
  return "low";
};

@Injectable()
export class DashboardChartsService {
  constructor(private readonly prisma: PrismaService) {}

  resolveRange(query: DashboardTimeRangeQueryDto): DateRange {
    const end = query.end ? new Date(query.end) : new Date();
    const start = query.start
      ? new Date(query.start)
      : new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException("Invalid date range");
    }
    if (start > end) {
      throw new BadRequestException("Start must be before end");
    }

    return { start, end };
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

  async getWarMapEvents(range: DateRange): Promise<WarMapEventsResponse> {
    const slugs = Array.from(new Set(WAR_EVENT_SEEDS.map((seed) => seed.metricSlug)));
    const points = await this.prisma.economicDataPoint.findMany({
      where: {
        recordedAt: {
          gte: range.start,
          lte: range.end
        },
        sourceField: "value",
        item: {
          slug: { in: slugs }
        }
      },
      include: {
        item: true
      },
      orderBy: { recordedAt: "asc" }
    });

    const latestBySlug = new Map<string, { value: number; timestamp: Date }>();
    for (const point of points) {
      latestBySlug.set(point.item.slug, {
        value: Number(point.value),
        timestamp: point.recordedAt
      });
    }

    let latestTimestamp: Date | undefined;
    const events: WarMapEvent[] = [];
    for (const seed of WAR_EVENT_SEEDS) {
      const metric = latestBySlug.get(seed.metricSlug);
      if (!metric) {
        continue;
      }
      const weighted = clamp(metric.value * seed.weight, 0, 100);
      events.push({
        id: seed.id,
        name: seed.name,
        lat: seed.lat,
        lng: seed.lng,
        severity: resolveSeverity(weighted),
        value: Number(weighted.toFixed(2))
      });
      if (!latestTimestamp || metric.timestamp > latestTimestamp) {
        latestTimestamp = metric.timestamp;
      }
    }

    return {
      events,
      updatedAt: latestTimestamp ? latestTimestamp.toISOString() : undefined
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
        displayName: true
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
        change: Number(change.toFixed(2))
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
        defaultFrequency: true
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
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined
    };
  }
}
