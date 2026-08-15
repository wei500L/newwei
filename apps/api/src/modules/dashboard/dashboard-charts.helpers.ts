import {
  createLogger,
  extractCountryCodeFromText,
  type WarMapEventsResponse,
  type WarMapLayerId,
  type WarMapNewsMarkersResponse,
  type WarMapTransportKind,
  normalizeCountryCode,
} from '@modular/utils';
import { AlertSeverity, ProcessedArticleStatus, type Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

import type { CacheService } from '../cache/cache.service';

import worldGeoJson from './assets/world.geo.json';
import { type WarMapLayersResponse as WarMapStaticLayersResponse } from './war-map-layers';

export const logger = createLogger({ name: 'dashboard-charts' });
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RANGE_DAYS = 30;
export const DEFAULT_SECTOR_CATEGORY = 'economic-short';
export const DEFAULT_CANDLESTICK_SLUG = 'sp500_index';
export const HEATMAP_COLUMNS = 4;
export const MAX_SECTOR_CELLS = 8;
export const MAX_WAR_MAP_NEWS_MARKERS = 500;
export const MAX_WAR_MAP_NEWS_GEOCODE_NETWORK = 3;
export const DEFAULT_WAR_MAP_CLUSTER_ZOOM = 2;
export const MAX_WAR_MAP_CLUSTER_ZOOM = 16;
export const DEFAULT_WAR_MAP_BBOX: [number, number, number, number] = [-180, -85, 180, 85];
export const MIN_WAR_MAP_FLIGHT_CELL_SIZE_DEG = 0.15;
export const MIN_WAR_MAP_AIS_CELL_SIZE_DEG = 0.25;
export const MAX_WAR_MAP_AIS_CELL_SIZE_DEG = 18;
export const MAX_WAR_MAP_FLIGHTS_GLOBAL_LOW_ZOOM = 180;
export const MAX_WAR_MAP_FLIGHTS_GLOBAL_MID_ZOOM = 320;
export const MAX_WAR_MAP_FLIGHTS_GLOBAL_HIGH_ZOOM = 520;
export const MAX_WAR_MAP_FLIGHTS_GLOBAL_MAX = 720;
export const MAX_WAR_MAP_FLIGHTS_VIEWPORT_LOW_ZOOM = 120;
export const MAX_WAR_MAP_FLIGHTS_VIEWPORT_MID_ZOOM = 220;
export const MAX_WAR_MAP_FLIGHTS_VIEWPORT_HIGH_ZOOM = 420;
export const MAX_WAR_MAP_FLIGHTS_VIEWPORT_MAX = 900;
export const MAX_WAR_MAP_AIS_GLOBAL_LOW_ZOOM = 180;
export const MAX_WAR_MAP_AIS_GLOBAL_MID_ZOOM = 320;
export const MAX_WAR_MAP_AIS_GLOBAL_HIGH_ZOOM = 520;
export const MAX_WAR_MAP_AIS_GLOBAL_MAX = 720;
export const MAX_WAR_MAP_AIS_VIEWPORT_LOW_ZOOM = 120;
export const MAX_WAR_MAP_AIS_VIEWPORT_MID_ZOOM = 220;
export const MAX_WAR_MAP_AIS_VIEWPORT_HIGH_ZOOM = 420;
export const MAX_WAR_MAP_AIS_VIEWPORT_MAX = 900;
export const AIS_ALL_MODE_BLOCKED_REASON_CODES = {
  snapshotUnavailable: 'snapshot_unavailable',
  missingVesselsSnapshot: 'missing_vessels_snapshot',
} as const;
export const MAX_SPACETIME_GEO_RECORDS = 2000;
export const MAX_SPACETIME_GEO_LOCATIONS = 500;
export const MAX_SPACETIME_GEO_POINTS = 300;
export const MAX_SPACETIME_GEO_GEOCODE_NETWORK = 6;
export const MAX_SPACETIME_PROPAGATION_WINDOW_HOURS = 24 * 31;
export const DEFAULT_SPACETIME_PROPAGATION_WINDOW_HOURS = 24;
export const MAX_SPACETIME_PROPAGATION_PREDECESSORS = 24;
export const DEFAULT_SPACETIME_PROPAGATION_PREDECESSORS = 8;
export const SPACETIME_GEO_CLUSTER_STEP_DEG = 0.5;
export const SPACETIME_GEO_HEAT_HALF_LIFE_DAYS = 7;
export const SPACETIME_GEO_SNAPSHOT_TTL_SECONDS = 60 * 60;
export const DASHBOARD_SHARED_QUERY_TTL_SECONDS = 10;
export const PREFERRED_SOURCE_FIELDS = [
  'close',
  '收盘价',
  'value',
  'current_value',
  '今值',
  '最新值',
  'latest_price',
  '最新价',
  '现价',
  'current_price',
  '最新',
  '美元',
] as const;

export const OHLC_FIELD_ALIASES = {
  open: ['open', '开盘价', '今开'],
  high: ['high', '最高价', '最高'],
  low: ['low', '最低价', '最低'],
  close: ['close', '收盘价', '最新价'],
} as const;

export type OhlcField = keyof typeof OHLC_FIELD_ALIASES;

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const normalizeSourceFieldKey = (value: string) => value.trim().toLowerCase();

export const parseStringList = (value: unknown): string[] | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry);
  return result.length > 0 ? result : undefined;
};

export const uniqStrings = (values: string[]) => {
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

export const normalizeMongoId = (value: unknown): string => {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'object') {
    const maybeHex = (value as { toHexString?: () => string }).toHexString?.();
    if (typeof maybeHex === 'string' && maybeHex.trim()) {
      return maybeHex.trim();
    }
    const maybeString = (value as { toString?: () => string }).toString?.();
    if (
      typeof maybeString === 'string' &&
      maybeString.trim() &&
      maybeString !== '[object Object]'
    ) {
      return maybeString.trim();
    }
  }
  return '';
};

export const MONGO_OBJECT_ID_TOKEN_REGEX = /(?:^|[^a-fA-F0-9])([a-fA-F0-9]{24})(?=$|[^a-fA-F0-9])/g;

export const canonicalizeMongoLookupKey = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return /^[a-fA-F0-9]{24}$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
};

export const isMongoObjectIdLookupKey = (value: string): boolean => /^[a-f0-9]{24}$/.test(value);

export const extractMongoObjectIdLookupKey = (value: unknown): string => {
  const normalized = normalizeMongoId(value);
  if (!normalized) {
    return '';
  }
  const canonical = canonicalizeMongoLookupKey(normalized);
  if (isMongoObjectIdLookupKey(canonical)) {
    return canonical;
  }

  let last = '';
  for (const match of normalized.matchAll(MONGO_OBJECT_ID_TOKEN_REGEX)) {
    const candidate = canonicalizeMongoLookupKey(match[1] ?? '');
    if (isMongoObjectIdLookupKey(candidate)) {
      last = candidate;
    }
  }
  return last;
};

export const resolveProcessedItemLookupKeys = (...candidates: unknown[]): string[] => {
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

export const serializeDate = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

export const deserializeDate = (value: string | null | undefined): Date | null =>
  value ? new Date(value) : null;

export interface DataVizConfig {
  heatmap: { preferredSourceFields?: string[] };
  candlestick: { ohlc?: Partial<Record<OhlcField, string[]>> };
}

export const getDataVizConfig = (metadata: unknown): DataVizConfig => {
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
      ohlc: Object.keys(ohlcFieldAliases).length > 0 ? ohlcFieldAliases : undefined,
    },
  };
};

export const buildLabelToSourceFieldMap = (metadata: unknown): Map<string, string> => {
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
    if (typeof field !== 'string' || !field.trim()) {
      continue;
    }
    const trimmedField = field.trim();
    map.set(trimmedField, trimmedField);
    map.set(normalizeSourceFieldKey(trimmedField), trimmedField);
    const label = entry.label;
    if (typeof label === 'string' && label.trim()) {
      const trimmedLabel = label.trim();
      map.set(trimmedLabel, trimmedField);
      map.set(normalizeSourceFieldKey(trimmedLabel), trimmedField);
    }
  }

  return map;
};

export const resolvePreferredSourceField = (
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
      const normalizedMapped = normalizedToActual.get(normalizeSourceFieldKey(mapped));
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

export const resolveFallbackSourceField = (
  availableFields: Iterable<string>,
  labelToField: Map<string, string>,
) => {
  const normalizedFields = uniqStrings(Array.from(availableFields));
  if (normalizedFields.length === 0) {
    return undefined;
  }

  const seriesByField = new Map<string, unknown[]>();
  normalizedFields.forEach((field) => seriesByField.set(field, []));

  const defaultMatch = resolvePreferredSourceField(
    seriesByField,
    [...PREFERRED_SOURCE_FIELDS],
    labelToField,
  );
  if (defaultMatch) {
    return defaultMatch;
  }

  return [...normalizedFields].sort((a, b) => a.localeCompare(b))[0];
};

export interface GeoJsonGeometry {
  type:
    | 'Point'
    | 'MultiPoint'
    | 'LineString'
    | 'MultiLineString'
    | 'Polygon'
    | 'MultiPolygon'
    | 'GeometryCollection';
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
  [key: string]: unknown;
}

export interface GeoJsonFeature {
  type: 'Feature';
  geometry: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
  id?: string;
  [key: string]: unknown;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
  [key: string]: unknown;
}

export interface WarMapGeoJsonResponse {
  name: string;
  geoJson: typeof worldGeoJson;
  center?: [number, number];
  zoom?: number;
}

export interface WarMapNewsMarkersOptions {
  translateTarget?: 'zh-CN';
  bbox?: [number, number, number, number];
  zoom?: number;
  cluster?: boolean;
}

export interface WarMapLayersOptions {
  translateTarget?: 'zh-CN';
  orgId?: string;
  range?: DateRange;
  bbox?: [number, number, number, number];
  zoom?: number;
  flightMode?: 'military' | 'all';
  aisMode?: 'all' | 'military' | 'density';
  /**
   * Pre-computed events/news markers for the same org+range: the SSE stream
   * already fetched them in this tick, so layers can reuse the SAME promises
   * instead of re-running the heavy aggregations a second time.
   */
  realtimeData?: {
    events: Promise<WarMapEventsResponse>;
    newsMarkers: Promise<WarMapNewsMarkersResponse>;
  };
}

export interface WarMapEventsOptions {
  translateTarget?: 'zh-CN';
  bbox?: [number, number, number, number];
  zoom?: number;
  cluster?: boolean;
}

export interface WarMapTransportDetailOptions {
  orgId: string;
  kind: WarMapTransportKind;
  objectKey: string;
  range: DateRange;
  limit: number;
}

export interface WarMapCleanedEntity {
  name: string;
  type: string;
  confidence: number;
}

export interface WarMapMongoLocationRecord {
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

export interface WarMapSourceNewsRecord {
  id: string;
  title?: string | null;
  location: string;
  entities: unknown;
  url?: string | null;
  publishedAt?: Date;
  sortAt?: Date;
  processedAt?: Date;
  crawlAt?: Date;
  titleGuess?: string | null;
}

export interface SharedWarMapEventArticleRow {
  location: string | null;
  processedAt: Date | null;
  eventAt: Date | null;
}

export interface CachedWarMapEventArticleRow {
  location: string | null;
  processedAt: string | null;
  eventAt: string | null;
}

export interface SharedWarMapNewsMarkerArticleRow {
  id: string;
  title: string | null;
  location: string | null;
  publishedAt: Date | null;
  eventAt: Date | null;
  processedAt: Date | null;
  entities: Prisma.JsonValue;
  article: {
    url: string | null;
    crawlAt: Date | null;
    titleGuess: string | null;
  };
}

export interface CachedWarMapNewsMarkerArticleRow {
  id: string;
  title: string | null;
  location: string | null;
  publishedAt: string | null;
  eventAt: string | null;
  processedAt: string | null;
  entities: Prisma.JsonValue;
  article: {
    url: string | null;
    crawlAt: string | null;
    titleGuess: string | null;
  };
}

export interface WarMapRealtimeLayerSeedPoint {
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

export type SpacetimeSentimentLabel = 'positive' | 'neutral' | 'negative' | 'unknown';

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

export interface SharedSpacetimeGeoHeatmapRecord {
  location: string | null;
  cleanedMarkdownRef: string | null;
  eventAt: Date | null;
  processedAt: Date | null;
}

export interface CachedSpacetimeGeoHeatmapRecord {
  location: string | null;
  cleanedMarkdownRef: string | null;
  eventAt: string | null;
  processedAt: string | null;
}

export interface SpacetimeGeoHeatmapSnapshot {
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

export type SpacetimePropagationEdgeKind = 'duplicate' | 'time';

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

export interface SectorHeatmapCell {
  x: number;
  y: number;
  name: string;
  value: number;
  change: number;
  unit?: string | null;
  sourceField?: string;
}

export interface SectorHeatmapWarning {
  code: 'SOURCE_FIELD_FALLBACK';
  itemId: string;
  slug: string;
  displayName: string;
  preferredSourceFields: string[];
  availableSourceFields: string[];
  selectedSourceField: string;
}

export interface SectorHeatmapResponse {
  xLabels: string[];
  yLabels: string[];
  cells: SectorHeatmapCell[];
  updatedAt?: string;
  warnings?: SectorHeatmapWarning[];
}

export interface FinancialCandlestickPoint {
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
  latestObservedAt?: string;
  skippedIncompleteCount?: number;
}

export interface DateRange {
  start: Date;
  end: Date;
}

export interface ResolveRangeOptions {
  alignToUtcDay?: boolean;
}

export const alignUtcDayStart = (value: Date) => {
  const normalized = new Date(value);
  normalized.setUTCHours(0, 0, 0, 0);
  return normalized;
};

export const alignUtcDayEnd = (value: Date) => {
  const normalized = new Date(value);
  normalized.setUTCHours(23, 59, 59, 999);
  return normalized;
};

export const normalizeGeoId = (input?: string | null): string | null => {
  if (!input || typeof input !== 'string') {
    return null;
  }
  const normalized = normalizeCountryCode(input);
  return normalized ? normalized.toUpperCase() : null;
};

export const readCountryCodesFromAlertContext = (
  context: Record<string, unknown> | null,
): string[] => {
  const countries = new Set<string>();
  const addCandidate = (value: unknown) => {
    if (typeof value !== 'string') {
      return;
    }
    const resolvedCode = normalizeGeoId(value) ?? extractCountryCodeFromText(value) ?? null;
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
      if (!hotspot || typeof hotspot !== 'object') {
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

export const normalizeLocationCandidate = (input: string): string => {
  return input
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
};

// Group key is used for aggregation; keep it stable but avoid losing useful country context for geocoding.
export const normalizeLocationGroupKey = (input: string): string => {
  const trimmed = normalizeLocationCandidate(input);
  const primaryChunk = trimmed.split(/[,;/|]/)[0]?.trim() ?? '';
  return (primaryChunk || trimmed).slice(0, 120);
};

export const clampFinite = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;

export const roundToStep = (value: number, step: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
    return value;
  }
  return Math.round(value / step) * step;
};

export const normalizeSentimentLabel = (raw: unknown): SpacetimeSentimentLabel => {
  if (typeof raw !== 'string') {
    return 'unknown';
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'positive') return 'positive';
  if (normalized === 'neutral') return 'neutral';
  if (normalized === 'negative') return 'negative';
  return 'unknown';
};

export const toUtcDayStartIso = (value: Date) => {
  const d = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  return d.toISOString();
};

export const alertSeverityRank: Record<AlertSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export const alertSeverityByRank: Record<number, AlertSeverity> = {
  1: AlertSeverity.low,
  2: AlertSeverity.medium,
  3: AlertSeverity.high,
};

export const WAR_MAP_ALERT_EVENT_SCAN_LIMIT = 1_000;

export const WAR_MAP_LAYER_COLORS: Partial<Record<WarMapLayerId, string>> = {
  conflicts: '#ef4444',
  bases: '#ec4899',
  cables: '#8b5cf6',
  pipelines: '#0ea5e9',
  hotspots: '#f59e0b',
  ais: '#2563eb',
  nuclear: '#eab308',
  irradiators: '#f97316',
  sanctions: '#f43f5e',
  weather: '#06b6d4',
  economic: '#10b981',
  waterways: '#0284c7',
  outages: '#f97316',
  cyberThreats: '#a855f7',
  datacenters: '#6366f1',
  protests: '#dc2626',
  flights: '#2563eb',
  military: '#b91c1c',
  natural: '#16a34a',
  spaceports: '#0f172a',
  minerals: '#a16207',
  fires: '#dc2626',
  ucdpEvents: '#ef4444',
  displacement: '#14b8a6',
  climate: '#059669',
  startupHubs: '#0ea5e9',
  cloudRegions: '#6366f1',
  accelerators: '#2563eb',
  techHQs: '#1d4ed8',
  techEvents: '#0284c7',
  stockExchanges: '#0ea5e9',
  financialCenters: '#1d4ed8',
  centralBanks: '#1e3a8a',
  commodityHubs: '#a16207',
  gulfInvestments: '#0891b2',
  positiveEvents: '#22c55e',
  kindness: '#14b8a6',
  happiness: '#10b981',
  speciesRecovery: '#15803d',
  renewableInstallations: '#16a34a',
  tradeRoutes: '#0284c7',
  iranAttacks: '#ef4444',
  gpsJamming: '#f97316',
};

export const WAR_MAP_LAYER_KEYWORDS: Partial<Record<WarMapLayerId, string[]>> = {
  conflicts: ['war', 'conflict', 'battle', 'invasion', 'frontline'],
  bases: ['base', 'airbase', 'garrison', 'fleet', 'command'],
  cables: ['cable', 'subsea', 'fiber', 'landing'],
  pipelines: ['pipeline', 'gas', 'oil', 'lpg', 'lng'],
  hotspots: ['crisis', 'tension', 'escalation', 'urgent', 'alert'],
  ais: ['ship', 'vessel', 'shipping', 'port', 'maritime', 'ais'],
  nuclear: ['nuclear', 'reactor', 'uranium', 'enrichment'],
  irradiators: ['radiation', 'irradiat', 'isotope'],
  sanctions: ['sanction', 'export control', 'embargo'],
  weather: ['weather', 'storm', 'hurricane', 'typhoon', 'flood', 'snow'],
  economic: ['economy', 'inflation', 'gdp', 'market', 'rates'],
  waterways: ['strait', 'canal', 'waterway', 'chokepoint', 'shipping lane'],
  outages: ['outage', 'blackout', 'power cut', 'grid failure'],
  cyberThreats: ['cyber', 'malware', 'ddos', 'ransomware', 'hack'],
  datacenters: ['datacenter', 'data center', 'server', 'colo'],
  protests: ['protest', 'riot', 'demonstration', 'strike'],
  flights: ['flight', 'aviation', 'airport', 'airspace'],
  military: ['military', 'troop', 'defense', 'drill', 'exercise'],
  natural: ['earthquake', 'volcano', 'landslide', 'natural disaster'],
  spaceports: ['spaceport', 'launch', 'rocket', 'orbital'],
  minerals: ['lithium', 'copper', 'nickel', 'cobalt', 'rare earth'],
  fires: ['fire', 'wildfire', 'burn'],
  ucdpEvents: ['ucdp', 'armed conflict', 'fatality'],
  displacement: ['refugee', 'displacement', 'evacuation', 'idp'],
  climate: ['climate', 'emission', 'heatwave', 'drought', 'co2'],
  startupHubs: ['startup', 'founder', 'seed round', 'venture'],
  cloudRegions: ['cloud', 'region', 'availability zone'],
  accelerators: ['accelerator', 'incubator'],
  techHQs: ['hq', 'headquarters', 'campus'],
  techEvents: ['conference', 'summit', 'expo', 'developer event'],
  stockExchanges: ['exchange', 'stock', 'index'],
  financialCenters: ['financial center', 'banking hub'],
  centralBanks: ['central bank', 'rate decision', 'monetary'],
  commodityHubs: ['commodity', 'trading hub', 'futures'],
  gulfInvestments: ['gulf', 'sovereign fund', 'pif', 'adq'],
  positiveEvents: ['ceasefire', 'agreement', 'breakthrough', 'recovery'],
  kindness: ['aid', 'humanitarian', 'rescue', 'donation'],
  happiness: ['happiness', 'wellbeing', 'quality of life'],
  speciesRecovery: ['species', 'wildlife', 'recovery', 'conservation'],
  renewableInstallations: ['renewable', 'solar', 'wind', 'battery', 'hydro'],
  tradeRoutes: ['trade route', 'shipping route', 'corridor'],
  iranAttacks: ['iran', 'tehran', 'isfahan', 'missile', 'drone'],
  gpsJamming: ['gps', 'jamming', 'spoofing', 'navigation disruption'],
};

export { type WarMapStaticLayersResponse as WarMapLayersResponse };

export const buildDashboardQueryCacheKey = (scope: string, payload: unknown): string => {
  const hash = createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  return `dashboard:query:${scope}:${hash}`;
};

export async function loadSharedDashboardQuery<T, TCached = T>(
  cache: CacheService,
  scope: string,
  payload: unknown,
  loader: () => Promise<T>,
  options?: {
    serialize?: (value: T) => TCached;
    deserialize?: (value: TCached) => T;
  },
): Promise<T> {
  const cached = await cache.wrap(
    buildDashboardQueryCacheKey(scope, payload),
    DASHBOARD_SHARED_QUERY_TTL_SECONDS,
    async () => {
      const value = await loader();
      return options?.serialize ? options.serialize(value) : (value as unknown as TCached);
    },
    {
      lockTtlMs: 5_000,
      retryDelayMs: 50,
      maxWaitMs: 5_000,
    },
  );
  return options?.deserialize ? options.deserialize(cached) : (cached as unknown as T);
}

export function buildProcessedArticleRangeWhere(
  orgId: string,
  range: DateRange,
  options: {
    requireLocation?: boolean;
    extra?: Prisma.ProcessedArticleWhereInput;
  } = {},
): Prisma.ProcessedArticleWhereInput {
  return {
    orgId,
    status: ProcessedArticleStatus.completed,
    eventAt: {
      gte: range.start,
      lte: range.end,
    },
    ...(options.requireLocation ? { hasLocation: true } : {}),
    ...(options.extra ?? {}),
  };
}

let geoIndex: Map<string, { name: string; lat: number; lng: number }> | null = null;

const resolveCentroid = (geometry: GeoJsonGeometry): { lat: number; lng: number } | null => {
  const positions: [number, number][] = [];
  const collectPositions = (input: unknown) => {
    if (!input) {
      return;
    }
    if (Array.isArray(input)) {
      if (input.length >= 2 && typeof input[0] === 'number' && typeof input[1] === 'number') {
        positions.push([input[0], input[1]]);
        return;
      }
      input.forEach((entry) => collectPositions(entry));
    }
  };

  if (geometry.type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
    geometry.geometries.forEach((child) => collectPositions(child.coordinates));
  } else {
    collectPositions(geometry.coordinates);
  }

  if (!positions.length) {
    return null;
  }

  // Antimeridian handling: for geometries spanning the 180° meridian (e.g.
  // Russia, Fiji), the naive bounding-box center collapses to lng=0 — the
  // middle of the Atlantic. Detect the wrap, shift the western hemisphere
  // longitudes by +360, take the bounding-box center in that space, and
  // normalize back.
  let hasFarWest = false;
  let hasFarEast = false;
  for (const [lng] of positions) {
    if (lng < -90) {
      hasFarWest = true;
    }
    if (lng > 90) {
      hasFarEast = true;
    }
  }
  const wrapOffset = hasFarWest && hasFarEast ? 360 : 0;

  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const [lng, lat] of positions) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      continue;
    }
    const shiftedLng = wrapOffset > 0 && lng < 0 ? lng + wrapOffset : lng;
    minLng = Math.min(minLng, shiftedLng);
    maxLng = Math.max(maxLng, shiftedLng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) {
    return null;
  }

  let centerLng = (minLng + maxLng) / 2;
  if (centerLng > 180) {
    centerLng -= 360;
  }

  return {
    lng: centerLng,
    lat: (minLat + maxLat) / 2,
  };
};

export function getGeoIndex(): Map<string, { name: string; lat: number; lng: number }> {
  if (geoIndex) {
    return geoIndex;
  }
  const index = new Map<string, { name: string; lat: number; lng: number }>();
  const payload = worldGeoJson as GeoJsonFeatureCollection;
  for (const feature of payload.features) {
    const name = typeof feature.properties?.name === 'string' ? feature.properties?.name : null;
    const id = typeof feature.id === 'string' ? feature.id : null;
    const code = normalizeGeoId(id) ?? normalizeGeoId(name);
    if (!code || !name || !feature.geometry) {
      continue;
    }
    const centroid = resolveCentroid(feature.geometry);
    if (!centroid) {
      continue;
    }
    index.set(code, { name, lat: centroid.lat, lng: centroid.lng });
  }
  geoIndex = index;
  return index;
}
