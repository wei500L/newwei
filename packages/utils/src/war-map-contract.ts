export const WAR_MAP_LAYER_IDS = [
  "conflicts",
  "bases",
  "cables",
  "pipelines",
  "hotspots",
  "ais",
  "nuclear",
  "irradiators",
  "sanctions",
  "weather",
  "economic",
  "waterways",
  "outages",
  "cyberThreats",
  "datacenters",
  "protests",
  "flights",
  "military",
  "natural",
  "spaceports",
  "minerals",
  "fires",
  "ucdpEvents",
  "displacement",
  "climate",
  "startupHubs",
  "cloudRegions",
  "accelerators",
  "techHQs",
  "techEvents",
  "stockExchanges",
  "financialCenters",
  "centralBanks",
  "commodityHubs",
  "gulfInvestments",
  "positiveEvents",
  "kindness",
  "happiness",
  "speciesRecovery",
  "renewableInstallations",
  "tradeRoutes",
  "iranAttacks",
  "gpsJamming",
  "dayNight",
  "monitors",
] as const;

export type WarMapLayerId = (typeof WAR_MAP_LAYER_IDS)[number];
export type WarMapLayerVisibility = Record<WarMapLayerId, boolean>;

export const LEGACY_WAR_MAP_LAYER_KEY_MAP = {
  conflictZones: "conflicts",
  chokepoints: "waterways",
  cableLandings: "cables",
  nuclearSites: "nuclear",
  militaryBases: "bases",
  hotspots: "hotspots",
  monitors: "monitors",
} as const;

export const WAR_MAP_DEFAULT_LAYER_VISIBILITY: WarMapLayerVisibility = {
  conflicts: true,
  bases: true,
  cables: false,
  pipelines: false,
  hotspots: true,
  ais: true,
  nuclear: true,
  irradiators: false,
  sanctions: true,
  weather: true,
  economic: true,
  waterways: true,
  outages: true,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: true,
  military: true,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: false,
  ucdpEvents: false,
  displacement: false,
  climate: false,
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  iranAttacks: true,
  gpsJamming: false,
  dayNight: false,
  monitors: true,
};

export const WAR_MAP_PRESETS = [
  "global",
  "america",
  "mena",
  "eu",
  "asia",
  "latam",
  "africa",
  "oceania",
] as const;

export type WarMapPreset = (typeof WAR_MAP_PRESETS)[number];
export type WarMapFlightMode = "military" | "all";
export type WarMapAisMode = "all" | "military" | "density";

export const WAR_MAP_TIME_RANGE_PRESETS = [
  "1h",
  "6h",
  "24h",
  "48h",
  "7d",
  "all",
] as const;

export type WarMapTimeRangePreset = (typeof WAR_MAP_TIME_RANGE_PRESETS)[number];

export interface WarMapViewState {
  lat: number;
  lon: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface WarMapSettings {
  layerVisibility: WarMapLayerVisibility;
  viewState: WarMapViewState;
  activePreset: WarMapPreset;
  timeRangePreset: WarMapTimeRangePreset;
  flightMode: WarMapFlightMode;
  aisMode: WarMapAisMode;
}

export type WarMapGeometryType = "point" | "path" | "polygon" | "raster";

export interface WarMapLayerRenderHints {
  minZoom?: number;
  maxZoom?: number;
  color?: string;
  opacity?: number;
  icon?: string;
  radiusScale?: number;
  pickable?: boolean;
  clusterable?: boolean;
}

export interface WarMapLayerFeature {
  id: string;
  lat?: number;
  lng?: number;
  path?: [number, number][];
  polygon?: [number, number][][];
  properties?: Record<string, unknown>;
  timestamp?: string;
}

export interface WarMapFlightProperties {
  sourceType: "opensky";
  source?: string;
  callsign?: string;
  icao24: string;
  registration?: string;
  aircraftType?: string;
  countryCode?: string;
  countryName?: string;
  heading?: number;
  altitudeFt?: number;
  groundSpeedKt?: number;
  observedAt?: string;
  sourceUpdatedAt?: string;
}

export type WarMapAisFeatureKind = "vessel" | "density" | "disruption";

export interface WarMapAisVesselProperties {
  sourceType: "ais";
  featureKind: "vessel";
  mmsi: string;
  name?: string;
  shipType?: number;
  heading?: number;
  speed?: number;
  course?: number;
  observedAt?: string;
}

export interface WarMapAisDensityProperties {
  sourceType: "ais";
  featureKind: "density";
  intensity: number;
  deltaPct?: number;
  shipsPerDay?: number;
  note?: string;
}

export interface WarMapAisDisruptionProperties {
  sourceType: "ais";
  featureKind: "disruption";
  name: string;
  disruptionType: string;
  severity: WarMapEventSeverity;
  vesselCount?: number;
  changePct?: number;
  windowHours?: number;
  region?: string;
  description?: string;
  darkShips?: number;
}

export interface WarMapLayerDataset {
  layerId: WarMapLayerId;
  geometryType: WarMapGeometryType;
  updatedAt?: string;
  renderHints?: WarMapLayerRenderHints;
  summary?: Record<string, unknown>;
  features: WarMapLayerFeature[];
}

export type WarMapTranslateTarget = "zh-CN";
export type WarMapEventSeverity = "low" | "medium" | "high";
export type WarMapNewsGeoSource = "geocoded" | "fallback-country";

export interface WarMapEvent {
  id: string;
  name: string;
  nameZh?: string;
  lat: number;
  lng: number;
  severity: WarMapEventSeverity;
  latestAt?: string;
  derivedScore: number;
  value: number;
  alertScore?: number;
  alertCount?: number;
  newsCount?: number;
  isCluster?: boolean;
  clusterId?: number;
  clusterCount?: number;
}

export interface WarMapNewsMarker {
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
  isCluster?: boolean;
  clusterId?: number;
  clusterCount?: number;
}

export interface WarMapEventsResponse {
  events: WarMapEvent[];
  updatedAt?: string;
  clustered?: boolean;
}

export interface WarMapNewsMarkersResponse {
  markers: WarMapNewsMarker[];
  updatedAt?: string;
  clustered?: boolean;
}

export interface WarMapLayersResponse {
  updatedAt: string;
  layers: Partial<Record<WarMapLayerId, WarMapLayerDataset>>;
}

export type WarMapLayersResponseV2 = WarMapLayersResponse;

export interface WarMapRequestParams {
  start?: string;
  end?: string;
  translate?: WarMapTranslateTarget;
  bbox?: string;
  zoom?: string;
  cluster?: string;
  flightMode?: WarMapFlightMode;
  aisMode?: WarMapAisMode;
}

export const DASHBOARD_STREAM_EVENT_TYPES = {
  warMapEvents: "war-map-events",
  warMapNewsMarkers: "war-map-news-markers",
  warMapLayers: "war-map-layers",
  financialCandlestick: "financial-candlestick",
  spacetimeGeoHeatmap: "spacetime-geo-heatmap",
  streamError: "stream-error",
  ping: "ping",
} as const;

export type DashboardStreamEventType =
  (typeof DASHBOARD_STREAM_EVENT_TYPES)[keyof typeof DASHBOARD_STREAM_EVENT_TYPES];

const DEFAULT_WAR_MAP_VIEW_STATE: WarMapViewState = {
  lat: 20,
  lon: 0,
  zoom: 1.8,
  bearing: 0,
  pitch: 0,
};

export function createDefaultWarMapViewState(): WarMapViewState {
  return { ...DEFAULT_WAR_MAP_VIEW_STATE };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeWarMapViewState(value: unknown): WarMapViewState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultWarMapViewState();
  }

  const record = value as Record<string, unknown>;
  return {
    lat: isFiniteNumber(record.lat) ? clamp(record.lat, -90, 90) : DEFAULT_WAR_MAP_VIEW_STATE.lat,
    lon: isFiniteNumber(record.lon) ? clamp(record.lon, -180, 180) : DEFAULT_WAR_MAP_VIEW_STATE.lon,
    zoom: isFiniteNumber(record.zoom) ? clamp(record.zoom, 0.5, 18) : DEFAULT_WAR_MAP_VIEW_STATE.zoom,
    // Force a flat camera in the normalized shared contract.
    bearing: DEFAULT_WAR_MAP_VIEW_STATE.bearing,
    pitch: DEFAULT_WAR_MAP_VIEW_STATE.pitch,
  };
}

export function normalizeWarMapPreset(value: unknown): WarMapPreset {
  return WAR_MAP_PRESETS.includes(value as WarMapPreset) ? (value as WarMapPreset) : "global";
}

export function normalizeWarMapTimeRangePreset(value: unknown): WarMapTimeRangePreset {
  return WAR_MAP_TIME_RANGE_PRESETS.includes(value as WarMapTimeRangePreset)
    ? (value as WarMapTimeRangePreset)
    : "7d";
}

export function coerceWarMapLayerVisibility(value: unknown): WarMapLayerVisibility {
  const normalized: WarMapLayerVisibility = { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY };

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return normalized;
  }

  const root = value as Record<string, unknown>;
  const rawVisibility =
    root.layerVisibility && typeof root.layerVisibility === "object" && !Array.isArray(root.layerVisibility)
      ? (root.layerVisibility as Record<string, unknown>)
      : root;

  for (const layerId of WAR_MAP_LAYER_IDS) {
    const raw = rawVisibility[layerId];
    if (typeof raw === "boolean") {
      normalized[layerId] = raw;
      continue;
    }

    const legacyKey = Object.keys(LEGACY_WAR_MAP_LAYER_KEY_MAP).find(
      (key) => LEGACY_WAR_MAP_LAYER_KEY_MAP[key as keyof typeof LEGACY_WAR_MAP_LAYER_KEY_MAP] === layerId,
    );
    if (legacyKey) {
      const legacyValue = rawVisibility[legacyKey];
      if (typeof legacyValue === "boolean") {
        normalized[layerId] = legacyValue;
      }
    }
  }

  return normalized;
}

export function normalizeWarMapSettings(value: unknown): WarMapSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      layerVisibility: { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY },
      viewState: createDefaultWarMapViewState(),
      activePreset: "global",
      timeRangePreset: "7d",
      flightMode: "military",
      aisMode: "military",
    };
  }

  const record = value as Record<string, unknown>;
  return {
    layerVisibility: coerceWarMapLayerVisibility(record.layerVisibility ?? record),
    viewState: normalizeWarMapViewState(record.viewState),
    activePreset: normalizeWarMapPreset(record.activePreset),
    timeRangePreset: normalizeWarMapTimeRangePreset(record.timeRangePreset),
    flightMode: record.flightMode === "all" ? "all" : "military",
    aisMode:
      record.aisMode === "all"
        ? "all"
        : record.aisMode === "density"
          ? "density"
          : "military",
  };
}
