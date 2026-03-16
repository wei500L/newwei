import { ProcessedItemModel, RawItemModel } from "@modular/mongo";
import {
  createLogger,
  extractCountryCodeFromText,
  getCountryAlpha2,
  getCountryName,
  type WarMapEvent,
  type WarMapEventsResponse,
  type WarMapFlightProperties,
  type WarMapLayerDataset,
  type WarMapLayerFeature,
  type WarMapLayerId,
  type WarMapNewsGeoSource,
  type WarMapNewsMarker,
  type WarMapNewsMarkersResponse,
  WAR_MAP_LAYER_IDS,
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
import { RealtimeSignalsSnapshotStore } from "../realtime-signals/realtime-signals.snapshot-store";
import type { RealtimeAdsbAircraftSnapshot } from "../realtime-signals/realtime-signals.types";
import { SituationMonitorTranslationService } from "../situation-monitor/situation-monitor-translation.service";

import worldGeoJson from "./assets/world.geo.json";
import type { DashboardTimeRangeQueryDto } from "./dto/dashboard-charts.dto";
import {
  buildWarMapLayersResponse,
  type WarMapLayersResponse as WarMapStaticLayersResponse,
} from "./war-map-layers";

const logger = createLogger({ name: "dashboard-charts" });
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;
const DEFAULT_SECTOR_CATEGORY = "economic-short";
const DEFAULT_CANDLESTICK_SLUG = "sp500_index";
const HEATMAP_COLUMNS = 4;
const MAX_SECTOR_CELLS = 8;
const MAX_WAR_MAP_NEWS_MARKERS = 500;
const MAX_WAR_MAP_NEWS_GEOCODE_NETWORK = 3;
const DEFAULT_WAR_MAP_CLUSTER_ZOOM = 2;
const MAX_WAR_MAP_CLUSTER_ZOOM = 16;
const DEFAULT_WAR_MAP_BBOX: [number, number, number, number] = [
  -180, -85, 180, 85,
];
const MIN_WAR_MAP_FLIGHT_CELL_SIZE_DEG = 0.15;
const MAX_WAR_MAP_FLIGHTS_GLOBAL_LOW_ZOOM = 180;
const MAX_WAR_MAP_FLIGHTS_GLOBAL_MID_ZOOM = 320;
const MAX_WAR_MAP_FLIGHTS_GLOBAL_HIGH_ZOOM = 520;
const MAX_WAR_MAP_FLIGHTS_GLOBAL_MAX = 720;
const MAX_WAR_MAP_FLIGHTS_VIEWPORT_LOW_ZOOM = 120;
const MAX_WAR_MAP_FLIGHTS_VIEWPORT_MID_ZOOM = 220;
const MAX_WAR_MAP_FLIGHTS_VIEWPORT_HIGH_ZOOM = 420;
const MAX_WAR_MAP_FLIGHTS_VIEWPORT_MAX = 900;
const MAX_SPACETIME_GEO_RECORDS = 2000;
const MAX_SPACETIME_GEO_LOCATIONS = 500;
const MAX_SPACETIME_GEO_POINTS = 300;
const MAX_SPACETIME_GEO_GEOCODE_NETWORK = 6;
const MAX_SPACETIME_PROPAGATION_WINDOW_HOURS = 24 * 31;
const DEFAULT_SPACETIME_PROPAGATION_WINDOW_HOURS = 24;
const MAX_SPACETIME_PROPAGATION_PREDECESSORS = 24;
const DEFAULT_SPACETIME_PROPAGATION_PREDECESSORS = 8;
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
  open: ["open", "开盘价", "今开"],
  high: ["high", "最高价", "最高"],
  low: ["low", "最低价", "最低"],
  close: ["close", "收盘价", "最新价"],
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

const MONGO_OBJECT_ID_TOKEN_REGEX =
  /(?:^|[^a-fA-F0-9])([a-fA-F0-9]{24})(?=$|[^a-fA-F0-9])/g;

const canonicalizeMongoLookupKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return /^[a-fA-F0-9]{24}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
};

const isMongoObjectIdLookupKey = (value: string): boolean =>
  /^[a-f0-9]{24}$/.test(value);

const extractMongoObjectIdLookupKey = (value: unknown): string => {
  const normalized = normalizeMongoId(value);
  if (!normalized) {
    return "";
  }
  const canonical = canonicalizeMongoLookupKey(normalized);
  if (isMongoObjectIdLookupKey(canonical)) {
    return canonical;
  }

  let last = "";
  for (const match of normalized.matchAll(MONGO_OBJECT_ID_TOKEN_REGEX)) {
    const candidate = canonicalizeMongoLookupKey(match[1] ?? "");
    if (isMongoObjectIdLookupKey(candidate)) {
      last = candidate;
    }
  }
  return last;
};

const resolveProcessedItemLookupKeys = (...candidates: unknown[]): string[] => {
  const keys: string[] = [];
  const seen = new Set<string>();

  const append = (raw: string) => {
    const canonical = canonicalizeMongoLookupKey(raw);
    if (!canonical || seen.has(canonical)) {
      return;
    }
    seen.add(canonical);
    keys.push(canonical);
  };

  for (const candidate of candidates) {
    const normalized = normalizeMongoId(candidate);
    if (normalized) {
      append(normalized);
    }
    const extractedObjectId = extractMongoObjectIdLookupKey(candidate);
    if (extractedObjectId) {
      append(extractedObjectId);
    }
  }

  return keys;
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

interface WarMapNewsMarkersOptions {
  translateTarget?: "zh-CN";
  bbox?: [number, number, number, number];
  zoom?: number;
  cluster?: boolean;
}

interface WarMapLayersOptions {
  translateTarget?: "zh-CN";
  orgId?: string;
  range?: DateRange;
  bbox?: [number, number, number, number];
  zoom?: number;
}

interface WarMapEventsOptions {
  translateTarget?: "zh-CN";
  bbox?: [number, number, number, number];
  zoom?: number;
  cluster?: boolean;
}

interface WarMapCleanedEntity {
  name: string;
  type: string;
  confidence: number;
}

interface WarMapMongoLocationRecord {
  id: string;
  location: string;
  entities: unknown;
  title?: string;
  url?: string | null;
  sortAt?: Date;
  ingestedAt?: Date;
  createdAt?: Date;
  publishedAt?: Date;
}

interface WarMapSourceNewsRecord {
  id: string;
  title?: string | null;
  location: string;
  entities: unknown;
  url?: string | null;
  publishedAt?: Date;
  processedAt?: Date;
  crawlAt?: Date;
  titleGuess?: string | null;
}

interface WarMapRealtimeLayerSeedPoint {
  id: string;
  lat: number;
  lng: number;
  name: string;
  nameZh?: string;
  description?: string;
  descriptionZh?: string;
  timestamp?: string;
  textCorpus: string;
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

export { type WarMapStaticLayersResponse as WarMapLayersResponse };

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

interface ResolveRangeOptions {
  alignToUtcDay?: boolean;
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

const readCountryCodesFromAlertContext = (
  context: Record<string, unknown> | null,
): string[] => {
  const countries = new Set<string>();
  const addCandidate = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const resolvedCode =
      normalizeGeoId(value) ?? extractCountryCodeFromText(value) ?? null;
    if (!resolvedCode) {
      return;
    }
    countries.add(resolvedCode);
  };

  addCandidate(context?.countryCode);
  addCandidate(context?.countryName);
  addCandidate(context?.country);

  if (Array.isArray(context?.countryCodes)) {
    for (const code of context.countryCodes) {
      addCandidate(code);
    }
  }

  if (Array.isArray(context?.hotspots)) {
    for (const hotspot of context.hotspots) {
      if (!hotspot || typeof hotspot !== "object") {
        continue;
      }
      const record = hotspot as Record<string, unknown>;
      addCandidate(record.countryCode);
      addCandidate(record.countryName);
      addCandidate(record.country);
      if (Array.isArray(record.countryCodes)) {
        for (const code of record.countryCodes) {
          addCandidate(code);
        }
      }
    }
  }

  return Array.from(countries);
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

const WAR_MAP_LAYER_COLORS: Partial<Record<WarMapLayerId, string>> = {
  conflicts: "#ef4444",
  bases: "#ec4899",
  cables: "#8b5cf6",
  pipelines: "#0ea5e9",
  hotspots: "#f59e0b",
  ais: "#2563eb",
  nuclear: "#eab308",
  irradiators: "#f97316",
  sanctions: "#f43f5e",
  weather: "#06b6d4",
  economic: "#10b981",
  waterways: "#0284c7",
  outages: "#f97316",
  cyberThreats: "#a855f7",
  datacenters: "#6366f1",
  protests: "#dc2626",
  flights: "#2563eb",
  military: "#b91c1c",
  natural: "#16a34a",
  spaceports: "#0f172a",
  minerals: "#a16207",
  fires: "#dc2626",
  ucdpEvents: "#ef4444",
  displacement: "#14b8a6",
  climate: "#059669",
  startupHubs: "#0ea5e9",
  cloudRegions: "#6366f1",
  accelerators: "#2563eb",
  techHQs: "#1d4ed8",
  techEvents: "#0284c7",
  stockExchanges: "#0ea5e9",
  financialCenters: "#1d4ed8",
  centralBanks: "#1e3a8a",
  commodityHubs: "#a16207",
  gulfInvestments: "#0891b2",
  positiveEvents: "#22c55e",
  kindness: "#14b8a6",
  happiness: "#10b981",
  speciesRecovery: "#15803d",
  renewableInstallations: "#16a34a",
  tradeRoutes: "#0284c7",
  iranAttacks: "#ef4444",
  gpsJamming: "#f97316",
};

const WAR_MAP_LAYER_KEYWORDS: Partial<Record<WarMapLayerId, string[]>> = {
  conflicts: ["war", "conflict", "battle", "invasion", "frontline"],
  bases: ["base", "airbase", "garrison", "fleet", "command"],
  cables: ["cable", "subsea", "fiber", "landing"],
  pipelines: ["pipeline", "gas", "oil", "lpg", "lng"],
  hotspots: ["crisis", "tension", "escalation", "urgent", "alert"],
  ais: ["ship", "vessel", "shipping", "port", "maritime", "ais"],
  nuclear: ["nuclear", "reactor", "uranium", "enrichment"],
  irradiators: ["radiation", "irradiat", "isotope"],
  sanctions: ["sanction", "export control", "embargo"],
  weather: ["weather", "storm", "hurricane", "typhoon", "flood", "snow"],
  economic: ["economy", "inflation", "gdp", "market", "rates"],
  waterways: ["strait", "canal", "waterway", "chokepoint", "shipping lane"],
  outages: ["outage", "blackout", "power cut", "grid failure"],
  cyberThreats: ["cyber", "malware", "ddos", "ransomware", "hack"],
  datacenters: ["datacenter", "data center", "server", "colo"],
  protests: ["protest", "riot", "demonstration", "strike"],
  flights: ["flight", "aviation", "airport", "airspace"],
  military: ["military", "troop", "defense", "drill", "exercise"],
  natural: ["earthquake", "volcano", "landslide", "natural disaster"],
  spaceports: ["spaceport", "launch", "rocket", "orbital"],
  minerals: ["lithium", "copper", "nickel", "cobalt", "rare earth"],
  fires: ["fire", "wildfire", "burn"],
  ucdpEvents: ["ucdp", "armed conflict", "fatality"],
  displacement: ["refugee", "displacement", "evacuation", "idp"],
  climate: ["climate", "emission", "heatwave", "drought", "co2"],
  startupHubs: ["startup", "founder", "seed round", "venture"],
  cloudRegions: ["cloud", "region", "availability zone"],
  accelerators: ["accelerator", "incubator"],
  techHQs: ["hq", "headquarters", "campus"],
  techEvents: ["conference", "summit", "expo", "developer event"],
  stockExchanges: ["exchange", "stock", "index"],
  financialCenters: ["financial center", "banking hub"],
  centralBanks: ["central bank", "rate decision", "monetary"],
  commodityHubs: ["commodity", "trading hub", "futures"],
  gulfInvestments: ["gulf", "sovereign fund", "pif", "adq"],
  positiveEvents: ["ceasefire", "agreement", "breakthrough", "recovery"],
  kindness: ["aid", "humanitarian", "rescue", "donation"],
  happiness: ["happiness", "wellbeing", "quality of life"],
  speciesRecovery: ["species", "wildlife", "recovery", "conservation"],
  renewableInstallations: ["renewable", "solar", "wind", "battery", "hydro"],
  tradeRoutes: ["trade route", "shipping route", "corridor"],
  iranAttacks: ["iran", "tehran", "isfahan", "missile", "drone"],
  gpsJamming: ["gps", "jamming", "spoofing", "navigation disruption"],
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
    private readonly realtimeSignalsStore?: RealtimeSignalsSnapshotStore,
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

  private parseWarMapDate(value: unknown): Date | undefined {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value;
    }
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      if (Number.isFinite(parsed.getTime())) {
        return parsed;
      }
    }
    return undefined;
  }

  private buildWarMapMongoRangeFilter(range: DateRange): Record<string, unknown> {
    return {
      $or: [
        { sortAt: { $gte: range.start, $lte: range.end } },
        {
          sortAt: { $exists: false },
          ingestedAt: { $gte: range.start, $lte: range.end },
        },
        {
          sortAt: null,
          ingestedAt: { $gte: range.start, $lte: range.end },
        },
        {
          sortAt: { $exists: false },
          ingestedAt: { $exists: false },
          createdAt: { $gte: range.start, $lte: range.end },
        },
        {
          sortAt: null,
          ingestedAt: { $exists: false },
          createdAt: { $gte: range.start, $lte: range.end },
        },
      ],
    };
  }

  private normalizeWarMapEntities(input: unknown): WarMapCleanedEntity[] {
    if (!Array.isArray(input)) {
      return [];
    }
    const entities: WarMapCleanedEntity[] = [];
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
  }

  private isWarMapLocationEntityType(value: string): boolean {
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
  }

  private resolveWarMapCountryAlpha3(
    location: string,
    entities: WarMapCleanedEntity[],
  ): string | null {
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
  }

  private buildWarMapGeocodeCandidates(
    location: string,
    entities: WarMapCleanedEntity[],
    countryName?: string | null,
  ): string[] {
    const candidates: string[] = [];
    const pushCandidate = (value: string) => {
      const normalized = value.trim();
      if (!normalized) return;
      candidates.push(normalized);
    };

    const locationEntities = entities
      .filter(
        (entity) =>
          entity.confidence >= 0.5 &&
          this.isWarMapLocationEntityType(entity.type),
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
        !primaryLocationChunk.toLowerCase().includes(countryName.toLowerCase())
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
  }

  private async loadMongoWarMapLocationRecords(
    range: DateRange,
    orgId: string,
    limit: number,
  ): Promise<WarMapMongoLocationRecord[]> {
    const normalizedLimit = Math.max(1, Math.min(2_500, Math.round(limit)));
    const rawDocs = (await ProcessedItemModel.find(
      {
        orgId,
        status: "completed",
        duplicateOf: null,
        "result.location": { $exists: true, $nin: [null, ""] },
        ...this.buildWarMapMongoRangeFilter(range),
      },
      {
        _id: 1,
        rawItemId: 1,
        sortAt: 1,
        ingestedAt: 1,
        createdAt: 1,
        "result.location": 1,
        "result.title": 1,
        "result.entities": 1,
        "result.published_at": 1,
      },
    )
      .sort({ sortAt: -1, ingestedAt: -1, createdAt: -1 })
      .limit(normalizedLimit)
      .lean()
      .exec()) as unknown;

    if (!Array.isArray(rawDocs) || rawDocs.length === 0) {
      return [];
    }

    const rawItemIds = Array.from(
      new Set(
        rawDocs
          .map((entry) =>
            entry && typeof entry === "object"
              ? normalizeMongoId((entry as Record<string, unknown>).rawItemId)
              : "",
          )
          .filter((value) => value.length > 0),
      ),
    );

    const rawUrlByRawItemId = new Map<string, string>();
    if (rawItemIds.length > 0) {
      try {
        const rawItems = (await RawItemModel.find(
          { _id: { $in: rawItemIds } },
          { _id: 1, payload: 1 },
        )
          .lean()
          .exec()) as unknown;

        if (Array.isArray(rawItems)) {
          for (const rawItem of rawItems) {
            if (!rawItem || typeof rawItem !== "object") {
              continue;
            }
            const payload = rawItem as Record<string, unknown>;
            const rawItemId = normalizeMongoId(payload._id);
            if (!rawItemId) {
              continue;
            }
            const rawPayload =
              payload.payload &&
              typeof payload.payload === "object" &&
              !Array.isArray(payload.payload)
                ? (payload.payload as Record<string, unknown>)
                : null;
            const url =
              typeof rawPayload?.url === "string"
                ? rawPayload.url.trim()
                : "";
            if (url) {
              rawUrlByRawItemId.set(rawItemId, url);
            }
          }
        }
      } catch {
        // URL enrichment is best-effort for Mongo fallback records.
      }
    }

    const records: WarMapMongoLocationRecord[] = [];
    for (const entry of rawDocs) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const doc = entry as Record<string, unknown>;
      const result =
        doc.result && typeof doc.result === "object" && !Array.isArray(doc.result)
          ? (doc.result as Record<string, unknown>)
          : null;
      const location =
        typeof result?.location === "string" ? result.location.trim() : "";
      if (!location) {
        continue;
      }

      const id = normalizeMongoId(doc._id);
      if (!id) {
        continue;
      }
      const rawItemId = normalizeMongoId(doc.rawItemId);
      const url = rawItemId ? rawUrlByRawItemId.get(rawItemId) ?? null : null;
      const title =
        typeof result?.title === "string" ? result.title.trim() : undefined;

      records.push({
        id,
        location,
        entities: result?.entities,
        title: title && title.length > 0 ? title : undefined,
        url,
        sortAt: this.parseWarMapDate(doc.sortAt),
        ingestedAt: this.parseWarMapDate(doc.ingestedAt),
        createdAt: this.parseWarMapDate(doc.createdAt),
        publishedAt: this.parseWarMapDate(result?.published_at),
      });
    }

    return records;
  }

  private resolveWarMapClusterBbox(
    bbox?: [number, number, number, number],
  ): [number, number, number, number] {
    if (!bbox) {
      return DEFAULT_WAR_MAP_BBOX;
    }
    const [minLng, minLat, maxLng, maxLat] = bbox;
    return [
      clampFinite(minLng, -180, 180),
      clampFinite(minLat, -90, 90),
      clampFinite(maxLng, -180, 180),
      clampFinite(maxLat, -90, 90),
    ];
  }

  private resolveWarMapClusterZoom(zoom?: number): number {
    const normalized =
      typeof zoom === "number" && Number.isFinite(zoom)
        ? Math.round(zoom)
        : DEFAULT_WAR_MAP_CLUSTER_ZOOM;
    return Math.max(0, Math.min(MAX_WAR_MAP_CLUSTER_ZOOM, normalized));
  }

  private resolveWarMapClusterCellSizeDegrees(zoom?: number): number {
    const normalizedZoom = this.resolveWarMapClusterZoom(zoom);
    const scale = Math.pow(2, normalizedZoom / 2);
    const rawCellSize = 24 / scale;
    return clampFinite(rawCellSize, 0.35, 32);
  }

  private buildWarMapClusterCellKey(
    lat: number,
    lng: number,
    bbox: [number, number, number, number],
    cellSizeDeg: number,
  ): string {
    const [minLng, minLat] = bbox;
    const x = Math.floor((lng - minLng) / cellSizeDeg);
    const y = Math.floor((lat - minLat) / cellSizeDeg);
    return `${x}:${y}`;
  }

  private isWithinWarMapBbox(
    lat: number,
    lng: number,
    bbox: [number, number, number, number],
  ): boolean {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
  }

  private filterWarMapPointsByBbox<T extends { lat: number; lng: number }>(
    points: T[],
    bbox?: [number, number, number, number],
  ): T[] {
    if (!bbox) {
      return points;
    }
    return points.filter((point) =>
      this.isWithinWarMapBbox(point.lat, point.lng, bbox),
    );
  }

  private isAdsbSnapshotFresh(
    snapshot: {
      updatedAt: string;
      latestObservedAt?: string;
      validPositionCount: number;
      diagnostics: { staleThresholdSec: number; latestObservedAt?: string };
    },
    nowMs: number,
  ): boolean {
    if (snapshot.validPositionCount <= 0) {
      return false;
    }
    const staleThresholdMs = Math.max(
      60_000,
      snapshot.diagnostics.staleThresholdSec * 1_000,
    );
    const updatedAtMs = Date.parse(snapshot.updatedAt);
    if (!Number.isFinite(updatedAtMs) || nowMs - updatedAtMs > staleThresholdMs) {
      return false;
    }
    const latestObservedAt =
      snapshot.latestObservedAt ?? snapshot.diagnostics.latestObservedAt;
    const latestObservedAtMs = latestObservedAt
      ? Date.parse(latestObservedAt)
      : Number.NaN;
    if (!Number.isFinite(latestObservedAtMs)) {
      return false;
    }
    return nowMs - latestObservedAtMs <= staleThresholdMs;
  }

  private resolveWarMapFlightsMaxPoints(
    options: Pick<WarMapLayersOptions, "bbox" | "zoom">,
  ): number {
    const normalizedZoom = this.resolveWarMapClusterZoom(options.zoom);
    if (!options.bbox) {
      if (normalizedZoom <= 2) {
        return MAX_WAR_MAP_FLIGHTS_GLOBAL_LOW_ZOOM;
      }
      if (normalizedZoom <= 4) {
        return MAX_WAR_MAP_FLIGHTS_GLOBAL_MID_ZOOM;
      }
      if (normalizedZoom <= 6) {
        return MAX_WAR_MAP_FLIGHTS_GLOBAL_HIGH_ZOOM;
      }
      return MAX_WAR_MAP_FLIGHTS_GLOBAL_MAX;
    }

    if (normalizedZoom <= 2) {
      return MAX_WAR_MAP_FLIGHTS_VIEWPORT_LOW_ZOOM;
    }
    if (normalizedZoom <= 4) {
      return MAX_WAR_MAP_FLIGHTS_VIEWPORT_MID_ZOOM;
    }
    if (normalizedZoom <= 6) {
      return MAX_WAR_MAP_FLIGHTS_VIEWPORT_HIGH_ZOOM;
    }
    return MAX_WAR_MAP_FLIGHTS_VIEWPORT_MAX;
  }

  private resolveWarMapFlightsPerCellLimit(zoom?: number): number {
    const normalizedZoom = this.resolveWarMapClusterZoom(zoom);
    if (normalizedZoom <= 2) {
      return 1;
    }
    if (normalizedZoom <= 4) {
      return 2;
    }
    if (normalizedZoom <= 6) {
      return 3;
    }
    if (normalizedZoom <= 8) {
      return 5;
    }
    return 8;
  }

  private shapeWarMapFlightsForViewport(
    aircraft: RealtimeAdsbAircraftSnapshot[],
    options: Pick<WarMapLayersOptions, "bbox" | "zoom">,
  ): RealtimeAdsbAircraftSnapshot[] {
    const filtered = this.filterWarMapPointsByBbox(aircraft, options.bbox);
    const maxPoints = this.resolveWarMapFlightsMaxPoints(options);
    if (filtered.length <= maxPoints) {
      return filtered;
    }

    const bbox = this.resolveWarMapClusterBbox(options.bbox);
    const cellSizeDeg = clampFinite(
      this.resolveWarMapClusterCellSizeDegrees(options.zoom) * 0.75,
      MIN_WAR_MAP_FLIGHT_CELL_SIZE_DEG,
      24,
    );
    const perCellLimit = this.resolveWarMapFlightsPerCellLimit(options.zoom);
    const cellCounts = new Map<string, number>();
    const selected: RealtimeAdsbAircraftSnapshot[] = [];

    for (const entry of filtered) {
      const cellKey = this.buildWarMapClusterCellKey(
        entry.lat,
        entry.lng,
        bbox,
        cellSizeDeg,
      );
      const currentCount = cellCounts.get(cellKey) ?? 0;
      if (currentCount >= perCellLimit) {
        continue;
      }
      cellCounts.set(cellKey, currentCount + 1);
      selected.push(entry);
      if (selected.length >= maxPoints) {
        break;
      }
    }

    return selected.length > 0 ? selected : filtered.slice(0, maxPoints);
  }

  private clusterWarMapEvents(
    events: WarMapEvent[],
    options: Pick<WarMapEventsOptions, "bbox" | "zoom" | "cluster">,
  ): WarMapEvent[] {
    const filteredEvents = this.filterWarMapPointsByBbox(events, options.bbox);
    if (!options.cluster) {
      return filteredEvents;
    }
    const clusterBbox = this.resolveWarMapClusterBbox(options.bbox);
    const eventsForClustering = this.filterWarMapPointsByBbox(
      filteredEvents,
      clusterBbox,
    );
    if (eventsForClustering.length === 0) {
      return [];
    }
    const cellSizeDeg = this.resolveWarMapClusterCellSizeDegrees(options.zoom);
    const groups = new Map<
      string,
      {
        clusterId: number;
        events: WarMapEvent[];
        weightTotal: number;
        latWeighted: number;
        lngWeighted: number;
        maxSeverityRank: number;
        derivedScore: number;
        alertScore: number;
        alertCount: number;
        newsCount: number;
        latestEpoch: number;
      }
    >();
    let clusterIdSeq = 1;

    for (const event of eventsForClustering) {
      const key = this.buildWarMapClusterCellKey(
        event.lat,
        event.lng,
        clusterBbox,
        cellSizeDeg,
      );
      const group = groups.get(key) ?? {
        clusterId: clusterIdSeq,
        events: [],
        weightTotal: 0,
        latWeighted: 0,
        lngWeighted: 0,
        maxSeverityRank: 0,
        derivedScore: 0,
        alertScore: 0,
        alertCount: 0,
        newsCount: 0,
        latestEpoch: 0,
      };
      if (!groups.has(key)) {
        clusterIdSeq += 1;
      }

      const weight = Math.max(1, event.derivedScore ?? event.value ?? 1);
      group.events.push(event);
      group.weightTotal += weight;
      group.latWeighted += event.lat * weight;
      group.lngWeighted += event.lng * weight;
      group.maxSeverityRank = Math.max(
        group.maxSeverityRank,
        alertSeverityRank[event.severity] ?? 1,
      );
      group.derivedScore += event.derivedScore;
      group.alertScore += event.alertScore ?? 0;
      group.alertCount += event.alertCount ?? 0;
      group.newsCount += event.newsCount ?? 0;
      const latestEpochRaw = event.latestAt ? Date.parse(event.latestAt) : NaN;
      const latestEpoch = Number.isFinite(latestEpochRaw) ? latestEpochRaw : 0;
      group.latestEpoch = Math.max(group.latestEpoch, latestEpoch);
      groups.set(key, group);
    }

    const result: WarMapEvent[] = [];
    for (const group of groups.values()) {
      if (group.events.length <= 1) {
        const single = group.events[0];
        if (single) {
          result.push(single);
        }
        continue;
      }

      const severityRank = Math.max(1, Math.round(group.maxSeverityRank));
      const severity = alertSeverityByRank[severityRank] ?? AlertSeverity.low;
      const derivedScore = Number(group.derivedScore.toFixed(2));
      const centerLat =
        group.weightTotal > 0
          ? group.latWeighted / group.weightTotal
          : group.events[0]?.lat ?? 0;
      const centerLng =
        group.weightTotal > 0
          ? group.lngWeighted / group.weightTotal
          : group.events[0]?.lng ?? 0;

      result.push({
        id: `cluster-${group.clusterId}`,
        name: `Cluster (${group.events.length})`,
        lat: clampFinite(centerLat, -90, 90),
        lng: clampFinite(centerLng, -180, 180),
        severity,
        isCluster: true,
        clusterId: group.clusterId,
        clusterCount: group.events.length,
        latestAt:
          group.latestEpoch > 0
            ? new Date(group.latestEpoch).toISOString()
            : undefined,
        derivedScore,
        value: derivedScore,
        alertScore: Number(group.alertScore.toFixed(2)),
        alertCount: group.alertCount,
        newsCount: group.newsCount,
      });
    }

    return result;
  }

  private clusterWarMapNewsMarkers(
    markers: WarMapNewsMarker[],
    options: Pick<WarMapNewsMarkersOptions, "bbox" | "zoom" | "cluster">,
  ): WarMapNewsMarker[] {
    const filteredMarkers = this.filterWarMapPointsByBbox(markers, options.bbox);
    if (!options.cluster) {
      return filteredMarkers;
    }
    const clusterBbox = this.resolveWarMapClusterBbox(options.bbox);
    const markersForClustering = this.filterWarMapPointsByBbox(
      filteredMarkers,
      clusterBbox,
    );
    if (markersForClustering.length === 0) {
      return [];
    }
    const cellSizeDeg = this.resolveWarMapClusterCellSizeDegrees(options.zoom);
    const groups = new Map<
      string,
      {
        clusterId: number;
        markers: WarMapNewsMarker[];
        latTotal: number;
        lngTotal: number;
        latestEpoch: number;
      }
    >();
    let clusterIdSeq = 1;

    for (const marker of markersForClustering) {
      const key = this.buildWarMapClusterCellKey(
        marker.lat,
        marker.lng,
        clusterBbox,
        cellSizeDeg,
      );
      const group = groups.get(key) ?? {
        clusterId: clusterIdSeq,
        markers: [],
        latTotal: 0,
        lngTotal: 0,
        latestEpoch: 0,
      };
      if (!groups.has(key)) {
        clusterIdSeq += 1;
      }

      group.markers.push(marker);
      group.latTotal += marker.lat;
      group.lngTotal += marker.lng;
      const latestIso = marker.publishedAt ?? marker.ingestedAt;
      const latestEpochRaw = latestIso ? Date.parse(latestIso) : NaN;
      const latestEpoch = Number.isFinite(latestEpochRaw) ? latestEpochRaw : 0;
      group.latestEpoch = Math.max(group.latestEpoch, latestEpoch);
      groups.set(key, group);
    }

    const result: WarMapNewsMarker[] = [];
    for (const group of groups.values()) {
      if (group.markers.length <= 1) {
        const single = group.markers[0];
        if (single) {
          result.push(single);
        }
        continue;
      }

      result.push({
        id: `cluster-${group.clusterId}`,
        title: `Cluster (${group.markers.length})`,
        location: "Multiple locations",
        lat: clampFinite(group.latTotal / group.markers.length, -90, 90),
        lng: clampFinite(group.lngTotal / group.markers.length, -180, 180),
        geoSource: "geocoded",
        isCluster: true,
        clusterId: group.clusterId,
        clusterCount: group.markers.length,
        publishedAt:
          group.latestEpoch > 0
            ? new Date(group.latestEpoch).toISOString()
            : undefined,
      });
    }

    return result;
  }

  private hashString(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  private buildWarMapRealtimeLayerSeedPoints(
    events: WarMapEvent[],
    markers: WarMapNewsMarker[],
  ): WarMapRealtimeLayerSeedPoint[] {
    const points: WarMapRealtimeLayerSeedPoint[] = [];

    for (const event of events) {
      if (
        typeof event.lat !== "number" ||
        typeof event.lng !== "number" ||
        !Number.isFinite(event.lat) ||
        !Number.isFinite(event.lng)
      ) {
        continue;
      }
      const description = `severity=${event.severity}; alerts=${event.alertCount ?? 0}; news=${event.newsCount ?? 0}; score=${event.derivedScore ?? event.value ?? 0}`;
      const textCorpus = `${event.name} ${event.nameZh ?? ""} ${description}`.toLowerCase();
      points.push({
        id: `evt-${event.id}`,
        lat: event.lat,
        lng: event.lng,
        name: event.name,
        nameZh: event.nameZh,
        description,
        timestamp: event.latestAt,
        textCorpus,
      });
    }

    for (const marker of markers) {
      if (
        typeof marker.lat !== "number" ||
        typeof marker.lng !== "number" ||
        !Number.isFinite(marker.lat) ||
        !Number.isFinite(marker.lng)
      ) {
        continue;
      }
      const name = marker.displayName?.trim() || marker.location;
      const nameZh = marker.displayNameZh?.trim() || marker.locationZh;
      const description = marker.title;
      const descriptionZh = marker.titleZh;
      const textCorpus = `${name} ${nameZh ?? ""} ${description} ${descriptionZh ?? ""} ${marker.location}`.toLowerCase();
      points.push({
        id: `news-${marker.id}`,
        lat: marker.lat,
        lng: marker.lng,
        name,
        nameZh,
        description,
        descriptionZh,
        timestamp: marker.publishedAt ?? marker.ingestedAt,
        textCorpus,
      });
    }

    return points;
  }

  private pickWarMapSeedPointsForLayer(
    layerId: WarMapLayerId,
    points: WarMapRealtimeLayerSeedPoint[],
  ): WarMapRealtimeLayerSeedPoint[] {
    if (points.length === 0) {
      return [];
    }

    const keywords = WAR_MAP_LAYER_KEYWORDS[layerId] ?? [];
    let selected =
      keywords.length > 0
        ? points.filter((point) =>
            keywords.some((keyword) => point.textCorpus.includes(keyword)),
          )
        : points.slice();

    if (selected.length === 0) {
      const seed = this.hashString(layerId);
      const modulo = Math.max(2, (seed % 7) + 2);
      selected = points.filter((_, index) => (index + seed) % modulo === 0);
    }

    if (selected.length === 0) {
      selected = points.slice(0, 24);
    }

    selected.sort((a, b) => {
      const aEpochRaw = a.timestamp ? Date.parse(a.timestamp) : 0;
      const bEpochRaw = b.timestamp ? Date.parse(b.timestamp) : 0;
      const aEpoch = Number.isFinite(aEpochRaw) ? aEpochRaw : 0;
      const bEpoch = Number.isFinite(bEpochRaw) ? bEpochRaw : 0;
      return bEpoch - aEpoch;
    });

    return selected;
  }

  private buildWarMapLayerFeaturesFromSeedPoints(
    layerId: WarMapLayerId,
    geometryType: WarMapLayerDataset["geometryType"],
    points: WarMapRealtimeLayerSeedPoint[],
  ): WarMapLayerFeature[] {
    if (points.length === 0 || geometryType === "raster") {
      return [];
    }

    if (geometryType === "path") {
      const features: WarMapLayerFeature[] = [];
      if (points.length === 1) {
        const point = points[0];
        if (!point) {
          return features;
        }
        const lngOffset = 1.2;
        const latOffset = 0.6;
        features.push({
          id: `${layerId}-path-0-${point.id}`,
          path: [
            [clampFinite(point.lng - lngOffset, -180, 180), clampFinite(point.lat - latOffset, -90, 90)],
            [clampFinite(point.lng + lngOffset, -180, 180), clampFinite(point.lat + latOffset, -90, 90)],
          ],
          properties: {
            name: point.name,
            nameZh: point.nameZh,
            description: point.description,
            descriptionZh: point.descriptionZh,
          },
          timestamp: point.timestamp,
        });
        return features;
      }

      const maxPaths = Math.min(24, Math.floor(points.length / 2));
      for (let index = 0; index < maxPaths; index += 1) {
        const from = points[index * 2];
        const to = points[index * 2 + 1];
        if (!from || !to) {
          continue;
        }
        features.push({
          id: `${layerId}-path-${index}-${from.id}-${to.id}`,
          path: [
            [from.lng, from.lat],
            [to.lng, to.lat],
          ],
          properties: {
            name: `${from.name} -> ${to.name}`,
            nameZh:
              from.nameZh && to.nameZh
                ? `${from.nameZh} -> ${to.nameZh}`
                : undefined,
            description: from.description ?? to.description,
          },
          timestamp: from.timestamp ?? to.timestamp,
        });
      }
      return features;
    }

    if (geometryType === "polygon") {
      const maxPolygons = Math.min(18, points.length);
      const features: WarMapLayerFeature[] = [];
      for (let index = 0; index < maxPolygons; index += 1) {
        const point = points[index];
        if (!point) {
          continue;
        }
        const offset = 0.8 + ((index % 3) * 0.35);
        const minLng = clampFinite(point.lng - offset, -180, 180);
        const maxLng = clampFinite(point.lng + offset, -180, 180);
        const minLat = clampFinite(point.lat - offset, -90, 90);
        const maxLat = clampFinite(point.lat + offset, -90, 90);

        features.push({
          id: `${layerId}-polygon-${index}-${point.id}`,
          polygon: [
            [
              [minLng, minLat],
              [maxLng, minLat],
              [maxLng, maxLat],
              [minLng, maxLat],
              [minLng, minLat],
            ],
          ],
          properties: {
            name: point.name,
            nameZh: point.nameZh,
            description: point.description,
            descriptionZh: point.descriptionZh,
          },
          timestamp: point.timestamp,
        });
      }
      return features;
    }

    const maxPoints = Math.min(140, points.length);
    return points.slice(0, maxPoints).map((point, index) => ({
      id: `${layerId}-point-${index}-${point.id}`,
      lat: point.lat,
      lng: point.lng,
      properties: {
        name: point.name,
        nameZh: point.nameZh,
        description: point.description,
        descriptionZh: point.descriptionZh,
      },
      timestamp: point.timestamp,
    }));
  }

  private mergeWarMapLayerFeatures(
    existing: WarMapLayerFeature[],
    incoming: WarMapLayerFeature[],
    maxItems: number,
  ): WarMapLayerFeature[] {
    const merged: WarMapLayerFeature[] = [];
    const seen = new Set<string>();

    const append = (feature: WarMapLayerFeature) => {
      if (seen.has(feature.id)) {
        return;
      }
      seen.add(feature.id);
      merged.push(feature);
    };

    for (const feature of existing) {
      append(feature);
      if (merged.length >= maxItems) {
        return merged;
      }
    }
    for (const feature of incoming) {
      append(feature);
      if (merged.length >= maxItems) {
        break;
      }
    }
    return merged;
  }

  private collectWarMapLayerFeatureTexts(
    layers: Record<WarMapLayerId, WarMapLayerDataset>,
  ): string[] {
    const texts: string[] = [];
    for (const layerId of WAR_MAP_LAYER_IDS) {
      const layer = layers[layerId];
      if (!layer || !Array.isArray(layer.features)) {
        continue;
      }
      for (const feature of layer.features) {
        const properties =
          feature.properties &&
          typeof feature.properties === "object" &&
          !Array.isArray(feature.properties)
            ? (feature.properties as Record<string, unknown>)
            : null;
        if (!properties) {
          continue;
        }
        const name = properties.name;
        const description = properties.description;
        if (typeof name === "string" && name.trim()) {
          texts.push(name.trim());
        }
        if (typeof description === "string" && description.trim()) {
          texts.push(description.trim());
        }
      }
    }
    return texts;
  }

  private applyWarMapLayerFeatureTranslations(
    layers: Record<WarMapLayerId, WarMapLayerDataset>,
    translatedByText: Map<string, string>,
  ): void {
    for (const layerId of WAR_MAP_LAYER_IDS) {
      const layer = layers[layerId];
      if (!layer || !Array.isArray(layer.features)) {
        continue;
      }
      for (const feature of layer.features) {
        const properties =
          feature.properties &&
          typeof feature.properties === "object" &&
          !Array.isArray(feature.properties)
            ? (feature.properties as Record<string, unknown>)
            : null;
        if (!properties) {
          continue;
        }
        if (typeof properties.name === "string") {
          const nameZh = translatedByText.get(properties.name);
          if (nameZh) {
            properties.nameZh = nameZh;
          }
        }
        if (typeof properties.description === "string") {
          const descriptionZh = translatedByText.get(properties.description);
          if (descriptionZh) {
            properties.descriptionZh = descriptionZh;
          }
        }
      }
    }
  }

  private async enrichWarMapLayersWithRealtimeData(
    response: WarMapStaticLayersResponse,
    orgId: string,
    range: DateRange,
  ): Promise<void> {
    const [eventsResponse, newsMarkersResponse] = await Promise.all([
      this.getWarMapEvents(range, orgId, { cluster: false }),
      this.getWarMapNewsMarkers(range, orgId, { cluster: false }),
    ]);

    const points = this.buildWarMapRealtimeLayerSeedPoints(
      eventsResponse.events,
      newsMarkersResponse.markers,
    );
    if (points.length === 0) {
      return;
    }

    for (const layerId of WAR_MAP_LAYER_IDS) {
      if (
        layerId === "monitors" ||
        layerId === "dayNight" ||
        layerId === "flights"
      ) {
        continue;
      }
      const dataset = response.layers[layerId];
      if (!dataset) {
        continue;
      }

      const selectedPoints = this.pickWarMapSeedPointsForLayer(layerId, points);
      const generatedFeatures = this.buildWarMapLayerFeaturesFromSeedPoints(
        layerId,
        dataset.geometryType,
        selectedPoints,
      );
      if (generatedFeatures.length === 0) {
        continue;
      }

      dataset.features = this.mergeWarMapLayerFeatures(
        dataset.features,
        generatedFeatures,
        240,
      );
      dataset.renderHints = {
        ...dataset.renderHints,
        pickable: true,
        color: dataset.renderHints?.color ?? WAR_MAP_LAYER_COLORS[layerId],
        clusterable:
          dataset.renderHints?.clusterable ??
          (dataset.geometryType === "point" || dataset.geometryType === "path"),
        radiusScale:
          dataset.renderHints?.radiusScale ??
          (dataset.geometryType === "point" ? 1 : undefined),
      };
    }
  }

  private async enrichWarMapFlightsLayer(
    response: WarMapStaticLayersResponse,
    orgId: string,
    options: Pick<WarMapLayersOptions, "bbox" | "zoom">,
  ): Promise<void> {
    const dataset = response.layers.flights;
    if (!dataset || !this.realtimeSignalsStore) {
      return;
    }

    const snapshot = await this.realtimeSignalsStore.getLatestAdsbSnapshot(orgId);
    dataset.renderHints = {
      ...dataset.renderHints,
      pickable: true,
      clusterable: true,
      color: WAR_MAP_LAYER_COLORS.flights,
      radiusScale: 1.15,
    };
    const summaryBase = {
      source: "adsb",
      scope: "military",
    } as const;

    if (!snapshot) {
      dataset.features = [];
      dataset.updatedAt = undefined;
      dataset.summary = {
        ...summaryBase,
        freshness: "missing",
        rawAircraftCount: 0,
        snapshotValidPositionCount: 0,
        returnedCount: 0,
        truncated: false,
        retainedPreviousSnapshot: false,
      };
      return;
    }

    if (!this.isAdsbSnapshotFresh(snapshot, Date.now())) {
      dataset.features = [];
      dataset.updatedAt = snapshot.updatedAt;
      dataset.summary = {
        ...summaryBase,
        sourceEndpoint: snapshot.sourceEndpoint,
        freshness: "stale",
        rawAircraftCount: snapshot.totalAircraft,
        snapshotValidPositionCount: snapshot.validPositionCount,
        returnedCount: 0,
        truncated: false,
        retainedPreviousSnapshot: snapshot.diagnostics.retainedPreviousSnapshot,
      };
      return;
    }

    const rawAircraft = snapshot.aircraft.map((entry) => ({
      ...entry,
      lat: clampFinite(entry.lat, -90, 90),
      lng: clampFinite(entry.lng, -180, 180),
    }));
    const aircraft = this.shapeWarMapFlightsForViewport(
      rawAircraft,
      options,
    );

    dataset.features = aircraft.map((entry) =>
      this.buildWarMapFlightFeature(entry, snapshot.updatedAt),
    );
    dataset.updatedAt = snapshot.updatedAt;
    dataset.summary = {
      ...summaryBase,
      sourceEndpoint: snapshot.sourceEndpoint,
      freshness: "fresh",
      rawAircraftCount: snapshot.totalAircraft,
      snapshotValidPositionCount: snapshot.validPositionCount,
      returnedCount: aircraft.length,
      maxReturned: this.resolveWarMapFlightsMaxPoints(options),
      truncated: aircraft.length < this.filterWarMapPointsByBbox(rawAircraft, options.bbox).length,
      retainedPreviousSnapshot: snapshot.diagnostics.retainedPreviousSnapshot,
    };
  }

  private buildWarMapFlightFeature(
    aircraft: RealtimeAdsbAircraftSnapshot,
    sourceUpdatedAt: string,
  ): WarMapLayerFeature {
    const properties: WarMapFlightProperties & {
      name: string;
      description: string;
    } = {
      sourceType: "adsb",
      source: aircraft.source,
      sourceUpdatedAt,
      ...(aircraft.callsign ? { callsign: aircraft.callsign } : {}),
      icao24: aircraft.icao24,
      ...(aircraft.registration ? { registration: aircraft.registration } : {}),
      ...(aircraft.aircraftType ? { aircraftType: aircraft.aircraftType } : {}),
      ...(aircraft.countryCode ? { countryCode: aircraft.countryCode } : {}),
      ...(aircraft.countryName ? { countryName: aircraft.countryName } : {}),
      ...(typeof aircraft.heading === "number"
        ? { heading: aircraft.heading }
        : {}),
      ...(typeof aircraft.altitudeFt === "number"
        ? { altitudeFt: aircraft.altitudeFt }
        : {}),
      ...(typeof aircraft.groundSpeedKt === "number"
        ? { groundSpeedKt: aircraft.groundSpeedKt }
        : {}),
      observedAt: aircraft.observedAt,
      name:
        aircraft.callsign ??
        aircraft.registration ??
        aircraft.icao24.toUpperCase(),
      description: aircraft.aircraftType
        ? `ADS-B ${aircraft.aircraftType}`
        : "ADS-B military flight",
    };

    return {
      id: aircraft.id,
      lat: aircraft.lat,
      lng: aircraft.lng,
      timestamp: aircraft.observedAt,
      properties: properties as unknown as Record<string, unknown>,
    };
  }

  resolveRange(
    query: DashboardTimeRangeQueryDto,
    options: ResolveRangeOptions = {},
  ): DateRange {
    const end = query.end ? new Date(query.end) : new Date();
    const start = query.start
      ? new Date(query.start)
      : new Date(end.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
    const alignToUtcDay = options.alignToUtcDay ?? true;

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException("Invalid date range");
    }
    const resolvedStart = alignToUtcDay ? alignUtcDayStart(start) : new Date(start);
    const resolvedEnd = alignToUtcDay ? alignUtcDayEnd(end) : new Date(end);

    if (resolvedStart > resolvedEnd) {
      throw new BadRequestException("Start must be before end");
    }

    return { start: resolvedStart, end: resolvedEnd };
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
  ): Promise<WarMapStaticLayersResponse> {
    const response = buildWarMapLayersResponse();

    if (options.orgId && options.range) {
      await this.enrichWarMapFlightsLayer(response, options.orgId, {
        bbox: options.bbox,
        zoom: options.zoom,
      });
      await this.enrichWarMapLayersWithRealtimeData(
        response,
        options.orgId,
        options.range,
      );
    }

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
        ...this.collectWarMapLayerFeatureTexts(response.layers),
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

      this.applyWarMapLayerFeatureTranslations(
        response.layers,
        translatedByText,
      );
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

    let mongoFallbackRecords: WarMapMongoLocationRecord[] = [];
    if (newsRecords.length === 0) {
      try {
        mongoFallbackRecords = await this.loadMongoWarMapLocationRecords(
          range,
          orgId,
          2_500,
        );
      } catch (error) {
        logger.warn(
          { orgId, range, err: error },
          "War map event aggregation mongo fallback failed",
        );
      }
    }

    for (const event of alertEvents) {
      const context =
        event.context &&
        typeof event.context === "object" &&
        !Array.isArray(event.context)
          ? (event.context as Record<string, unknown>)
          : null;
      const resolvedCodes = readCountryCodesFromAlertContext(context);
      if (resolvedCodes.length === 0) {
        continue;
      }
      for (const resolvedCode of resolvedCodes) {
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

    for (const record of mongoFallbackRecords) {
      const location = record.location.trim();
      if (!location) {
        continue;
      }
      const entities = this.normalizeWarMapEntities(record.entities);
      const resolvedCode =
        this.resolveWarMapCountryAlpha3(location, entities) ?? null;
      if (!resolvedCode) {
        continue;
      }
      const geo = geoIndex.get(resolvedCode);
      if (!geo) {
        continue;
      }
      const latestAt =
        record.publishedAt ??
        record.sortAt ??
        record.ingestedAt ??
        record.createdAt;
      if (!latestAt) {
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
        latestAt: entry.latestAt.toISOString(),
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

    const shapedEvents = this.clusterWarMapEvents(events, options);

    return {
      events: shapedEvents,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
      clustered: options.cluster === true,
    };
  }

  async getWarMapNewsMarkers(
    range: DateRange,
    orgId: string,
    options: WarMapNewsMarkersOptions = {},
  ): Promise<WarMapNewsMarkersResponse> {
    const geoIndex = this.getGeoIndex();
    const prismaRecords = await this.prisma.processedArticle.findMany({
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

    let records: WarMapSourceNewsRecord[] = prismaRecords.map((record) => ({
      id: record.id,
      title: record.title,
      location: typeof record.location === "string" ? record.location : "",
      entities: record.entities,
      url: record.article.url ?? null,
      publishedAt: record.publishedAt ?? undefined,
      processedAt: record.processedAt ?? undefined,
      crawlAt: record.article.crawlAt ?? undefined,
      titleGuess: record.article.titleGuess ?? null,
    }));

    if (records.length === 0) {
      try {
        const mongoFallbackRecords = await this.loadMongoWarMapLocationRecords(
          range,
          orgId,
          MAX_WAR_MAP_NEWS_MARKERS,
        );
        records = mongoFallbackRecords.map((record) => ({
          id: record.id,
          title: record.title ?? null,
          location: record.location,
          entities: record.entities,
          url: record.url ?? null,
          publishedAt: record.publishedAt,
          processedAt: record.sortAt ?? record.ingestedAt ?? record.createdAt,
          crawlAt: record.ingestedAt,
          titleGuess: null,
        }));
      } catch (error) {
        logger.warn(
          { orgId, range, err: error },
          "War map marker mongo fallback failed",
        );
      }
    }

    let updatedAt: Date | undefined;
    let networkBudget = MAX_WAR_MAP_NEWS_GEOCODE_NETWORK;
    const markers: WarMapNewsMarker[] = [];

    for (const record of records) {
      const location = record.location.trim();
      if (!location) {
        continue;
      }

      const entities = this.normalizeWarMapEntities(record.entities);
      const countryAlpha3 = this.resolveWarMapCountryAlpha3(location, entities);
      const directCountryAlpha3 = normalizeCountryCode(location);
      const countryAlpha2 = countryAlpha3
        ? (getCountryAlpha2(countryAlpha3) ?? undefined)
        : undefined;
      const countryName = countryAlpha3 ? getCountryName(countryAlpha3) : null;

      const candidates = this.buildWarMapGeocodeCandidates(
        location,
        entities,
        countryName,
      );

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
        (record.title ?? record.titleGuess ?? record.url ?? "").trim() ||
        location;
      const latestAt =
        record.publishedAt ??
        record.crawlAt ??
        record.processedAt ??
        undefined;

      markers.push({
        id: record.id,
        title,
        url: record.url ?? null,
        location,
        lat,
        lng,
        publishedAt: record.publishedAt
          ? record.publishedAt.toISOString()
          : undefined,
        ingestedAt: record.crawlAt
          ? record.crawlAt.toISOString()
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

    const shapedMarkers = this.clusterWarMapNewsMarkers(markers, options);

    return {
      markers: shapedMarkers,
      updatedAt: updatedAt ? updatedAt.toISOString() : undefined,
      clustered: options.cluster === true,
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
      maxPredecessorsPerSignal?: string;
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

    const windowHours = parseBoundedInt(
      options.windowHours?.trim(),
      DEFAULT_SPACETIME_PROPAGATION_WINDOW_HOURS,
      1,
      MAX_SPACETIME_PROPAGATION_WINDOW_HOURS,
    );
    const maxNodes = parseBoundedInt(options.maxNodes?.trim(), 140, 30, 600);
    const maxEdges = parseBoundedInt(options.maxEdges?.trim(), 320, 60, 2000);
    const maxPredecessorsPerSignal = parseBoundedInt(
      options.maxPredecessorsPerSignal?.trim(),
      DEFAULT_SPACETIME_PROPAGATION_PREDECESSORS,
      1,
      MAX_SPACETIME_PROPAGATION_PREDECESSORS,
    );
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
      processedItemLookupKeys: string[];
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
      const processedItemLookupKeys = resolveProcessedItemLookupKeys(
        row.processedItemId,
        processed.cleanedMarkdownRef,
      );
      const processedItemId = processedItemLookupKeys[0] ?? null;

      const signal: Signal = {
        processedArticleId: processed.id,
        processedItemId,
        processedItemLookupKeys,
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

      if (processedItemLookupKeys.length > 0) {
        for (const lookupKey of processedItemLookupKeys) {
          const prior = signalByProcessedItemId.get(lookupKey);
          if (!prior || tsMs < prior.timestampMs) {
            signalByProcessedItemId.set(lookupKey, signal);
          }
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
          .flatMap((signal) => signal.processedItemLookupKeys)
          .filter(isMongoObjectIdLookupKey),
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
            const childId = extractMongoObjectIdLookupKey(payload._id);
            const parentId = extractMongoObjectIdLookupKey(payload.duplicateOf);
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
        signal.processedItemLookupKeys.length > 0 &&
        signal.processedItemLookupKeys.some((lookupKey) =>
          handledDuplicateChildren.has(lookupKey),
        )
      ) {
        continue;
      }
      const linkedSources = new Set<string>();
      for (let prevIdx = idx - 1; prevIdx >= 0; prevIdx -= 1) {
        if (linkedSources.size >= maxPredecessorsPerSignal) {
          break;
        }
        const prev = signals[prevIdx]!;
        const deltaMs = signal.timestampMs - prev.timestampMs;
        if (deltaMs > windowMs) {
          break;
        }
        if (prev.source === signal.source || linkedSources.has(prev.source)) {
          continue;
        }
        pushEdge(
          "time",
          prev.source,
          signal.source,
          deltaMs,
          signal.timestampMs,
        );
        linkedSources.add(prev.source);
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
      const code = normalizeGeoId(id) ?? normalizeGeoId(name);
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
