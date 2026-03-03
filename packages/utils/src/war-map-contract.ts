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
  ais: false,
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
  flights: false,
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

export interface WarMapLayerDataset {
  layerId: WarMapLayerId;
  geometryType: WarMapGeometryType;
  updatedAt?: string;
  renderHints?: WarMapLayerRenderHints;
  features: WarMapLayerFeature[];
}

export interface WarMapLayersResponseV2 {
  updatedAt: string;
  layers: Record<WarMapLayerId, WarMapLayerDataset>;
}

const DEFAULT_WAR_MAP_VIEW_STATE: WarMapViewState = {
  lat: 20,
  lon: 0,
  zoom: 1.8,
  bearing: 0,
  pitch: 30,
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
    bearing: isFiniteNumber(record.bearing) ? clamp(record.bearing, -180, 180) : DEFAULT_WAR_MAP_VIEW_STATE.bearing,
    pitch: isFiniteNumber(record.pitch) ? clamp(record.pitch, 0, 85) : DEFAULT_WAR_MAP_VIEW_STATE.pitch,
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
    };
  }

  const record = value as Record<string, unknown>;
  return {
    layerVisibility: coerceWarMapLayerVisibility(record.layerVisibility ?? record),
    viewState: normalizeWarMapViewState(record.viewState),
    activePreset: normalizeWarMapPreset(record.activePreset),
    timeRangePreset: normalizeWarMapTimeRangePreset(record.timeRangePreset),
  };
}
