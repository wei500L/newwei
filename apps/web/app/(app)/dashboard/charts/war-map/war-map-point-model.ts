import type {
  WarMapEventSeverity,
  WarMapLayerId,
} from "@modular/utils";

import {
  matchesWarMapLegendItem,
  type WarMapLegendItem,
  type WarMapSymbolKey,
  type WarMapSymbolState,
} from "./war-map-symbols";

/** War Map 统一 Deck 点位模型（FE-批4A：从 war-map.tsx 迁移，字段不变）。 */
export interface DeckPoint {
  id: string;
  interactionKey: string;
  lat: number;
  lng: number;
  label: string;
  color: [number, number, number, number];
  radius: number;
  symbolKey: WarMapSymbolKey;
  accentColor?: string;
  isCluster?: boolean;
  clusterCount?: number;
  selectionKey?: string;
  url?: string | null;
  publishedAt?: string;
  ingestedAt?: string;
  latestAt?: string;
  locationLabel?: string;
  severity?: WarMapEventSeverity;
  alertCount?: number;
  newsCount?: number;
  geoSource?: "geocoded" | "fallback-country";
  query?: string;
  layerId?: WarMapLayerId;
  sourceType?: "opensky" | "ais";
  aisFeatureKind?: "vessel" | "density" | "disruption";
  callsign?: string;
  icao24?: string;
  mmsi?: string;
  shipType?: number;
  registration?: string;
  aircraftType?: string;
  displayCategory?: string;
  displayCategoryZh?: string;
  role?: string;
  roleZh?: string;
  countryCode?: string;
  countryName?: string;
  heading?: number;
  altitudeFt?: number;
  groundSpeedKt?: number;
  speed?: number;
  course?: number;
  shipTypeLabel?: string;
  shipTypeLabelZh?: string;
  vesselRole?: string;
  vesselRoleZh?: string;
  isMilitaryCandidate?: boolean;
  intensity?: number;
  deltaPct?: number;
  shipsPerDay?: number;
  disruptionType?: string;
  vesselCount?: number;
  changePct?: number;
  windowHours?: number;
  region?: string;
  darkShips?: number;
  sourceUpdatedAt?: string;
  kind:
    | "event"
    | "news"
    | "news-cluster"
    | "event-cluster"
    | "layer"
    | "layer-cluster"
    | "monitor"
    | "ais-vessel"
    | "ais-disruption"
    | "ais-density";
  description?: string;
}

const WAR_MAP_SYMBOL_KEY_SET = new Set<WarMapSymbolKey>([
  "signal-high",
  "signal-medium",
  "signal-low",
  "news-geocoded",
  "news-fallback",
  "monitor",
  "flight",
  "ais-vessel-military",
  "ais-vessel-fishing",
  "ais-vessel-passenger",
  "ais-vessel-cargo",
  "ais-vessel-tanker",
  "ais-vessel-other",
  "ais-vessel-generic",
  "ais-density",
  "ais-disruption-high",
  "ais-disruption-medium",
  "ais-disruption-low",
  "generic-point",
]);

export function isWarMapSymbolKey(value: string): value is WarMapSymbolKey {
  return WAR_MAP_SYMBOL_KEY_SET.has(value as WarMapSymbolKey);
}

/** legend 聚焦/悬停时的高亮匹配器（hover/selected/cluster 交互项不可聚焦）。 */
export function resolveLegendMatcher(
  itemKey: string | null,
): Pick<
  WarMapLegendItem,
  "key" | "symbolKey" | "matchSymbolKeys" | "matchLayerIds"
> | null {
  if (!itemKey) {
    return null;
  }

  switch (itemKey) {
    case "ais-vessel-generic":
      return {
        key: itemKey,
        symbolKey: "ais-vessel-generic",
        matchSymbolKeys: [
          "ais-vessel-military",
          "ais-vessel-fishing",
          "ais-vessel-passenger",
          "ais-vessel-cargo",
          "ais-vessel-tanker",
          "ais-vessel-other",
          "ais-vessel-generic",
        ],
      };
    case "ais-disruption":
      return {
        key: itemKey,
        symbolKey: "ais-disruption-high",
        matchSymbolKeys: [
          "ais-disruption-high",
          "ais-disruption-medium",
          "ais-disruption-low",
        ],
      };
    case "hover":
    case "selected":
    case "cluster":
      return null;
    default:
      if (isWarMapSymbolKey(itemKey)) {
        return {
          key: itemKey,
          symbolKey: itemKey,
          matchSymbolKeys: [itemKey],
        };
      }

      return {
        key: itemKey,
        symbolKey: "generic-point",
        matchLayerIds: [itemKey],
      };
  }
}

/** legend 高亮匹配（symbolKey / layerId 两个维度）。 */
export function createWarMapLegendPointMatcher(
  itemKey: string | null,
): ((point: DeckPoint) => boolean) | null {
  const matcher = resolveLegendMatcher(itemKey);
  if (!matcher) {
    return null;
  }
  return (point: DeckPoint) =>
    matchesWarMapLegendItem(matcher, {
      symbolKey: point.symbolKey,
      layerId: point.layerId,
    });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

function hasFiniteAngle(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function resolveAircraftIconAngle(point: DeckPoint): number | null {
  return hasFiniteAngle(point.heading) ? point.heading : null;
}

export function resolveVesselIconAngle(point: DeckPoint): number | null {
  if (hasFiniteAngle(point.course)) {
    return point.course;
  }
  return hasFiniteAngle(point.heading) ? point.heading : null;
}

const LAYER_LABEL_OVERRIDES: Partial<Record<WarMapLayerId, string>> = {
  ais: "AIS",
  ucdpEvents: "UCDP Events",
  cloudRegions: "Cloud Regions",
  startupHubs: "Startup Hubs",
  techHQs: "Tech HQs",
  dayNight: "Day/Night",
  gpsJamming: "GPS Jamming",
  iranAttacks: "Iran Attacks",
};

export function toLayerLabel(layerId: WarMapLayerId): string {
  const override = LAYER_LABEL_OVERRIDES[layerId];
  if (override) {
    return override;
  }
  return layerId
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function parseHexColor(color: string): [number, number, number] | null {
  const trimmed = color.trim();
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const rChar = hex.charAt(0);
    const gChar = hex.charAt(1);
    const bChar = hex.charAt(2);
    const r = Number.parseInt(rChar + rChar, 16);
    const g = Number.parseInt(gChar + gChar, 16);
    const b = Number.parseInt(bChar + bChar, 16);
    return [r, g, b];
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return [r, g, b];
  }
  return null;
}

export function toRgba(
  color: string | undefined,
  alpha: number,
  fallback: [number, number, number],
): [number, number, number, number] {
  const parsed = color ? parseHexColor(color) : null;
  const [r, g, b] = parsed ?? fallback;
  return [r, g, b, clamp(Math.round(alpha * 255), 0, 255)];
}

function interpolateColorChannel(
  start: number,
  end: number,
  progress: number,
): number {
  return Math.round(start + (end - start) * progress);
}

export function getAisDensityColor(
  intensity: number,
  alpha = 0.72,
): [number, number, number, number] {
  const progress = clamp((intensity - 0.2) / 0.8, 0, 1);
  const start: [number, number, number] = [147, 197, 253];
  const end: [number, number, number] = [185, 28, 28];
  return [
    interpolateColorChannel(start[0], end[0], progress),
    interpolateColorChannel(start[1], end[1], progress),
    interpolateColorChannel(start[2], end[2], progress),
    clamp(Math.round(alpha * 255), 0, 255),
  ];
}

export function getAisDisruptionColor(
  severity: WarMapEventSeverity,
): [number, number, number, number] {
  switch (severity) {
    case "high":
      return [220, 38, 38, 235];
    case "medium":
      return [234, 88, 12, 225];
    case "low":
    default:
      return [245, 158, 11, 215];
  }
}

export function getAisShipTypeColor(
  shipType?: number,
): [number, number, number, number] {
  if (typeof shipType !== "number" || !Number.isFinite(shipType)) {
    return [248, 250, 252, 220];
  }
  if (
    shipType === 35 ||
    shipType === 55 ||
    (shipType >= 50 && shipType <= 59)
  ) {
    return [220, 38, 38, 235];
  }
  if (shipType >= 30 && shipType <= 39) {
    return [34, 197, 94, 225];
  }
  if (shipType >= 60 && shipType <= 69) {
    return [59, 130, 246, 225];
  }
  if (shipType >= 70 && shipType <= 79) {
    return [148, 163, 184, 225];
  }
  if (shipType >= 80 && shipType <= 89) {
    return [249, 115, 22, 235];
  }
  return [248, 250, 252, 220];
}

export function formatAisShipTypeLabel(shipType?: number): string {
  if (typeof shipType !== "number" || !Number.isFinite(shipType)) {
    return "Unknown";
  }
  const normalized = Math.trunc(shipType);
  let label = "Other";
  if (
    normalized === 35 ||
    normalized === 55 ||
    (normalized >= 50 && normalized <= 59)
  ) {
    label = "Military / government";
  } else if (normalized >= 30 && normalized <= 39) {
    label = "Fishing";
  } else if (normalized >= 60 && normalized <= 69) {
    label = "Passenger";
  } else if (normalized >= 70 && normalized <= 79) {
    label = "Cargo";
  } else if (normalized >= 80 && normalized <= 89) {
    label = "Tanker";
  }
  return `${label} (${normalized})`;
}

export function severityColor(
  severity: WarMapEventSeverity,
): [number, number, number, number] {
  switch (severity) {
    case "high":
      return [220, 38, 38, 220];
    case "medium":
      return [217, 119, 6, 210];
    case "low":
    default:
      return [37, 99, 235, 195];
  }
}

export function clusterRadius(count: number): number {
  return Math.max(12, Math.min(42, Math.sqrt(Math.max(1, count)) * 7));
}

export function resolveAisVesselSymbolKey(shipType?: number): WarMapSymbolKey {
  if (typeof shipType !== "number" || !Number.isFinite(shipType)) {
    return "ais-vessel-other";
  }
  if (
    shipType === 35 ||
    shipType === 55 ||
    (shipType >= 50 && shipType <= 59)
  ) {
    return "ais-vessel-military";
  }
  if (shipType >= 30 && shipType <= 39) {
    return "ais-vessel-fishing";
  }
  if (shipType >= 60 && shipType <= 69) {
    return "ais-vessel-passenger";
  }
  if (shipType >= 70 && shipType <= 79) {
    return "ais-vessel-cargo";
  }
  if (shipType >= 80 && shipType <= 89) {
    return "ais-vessel-tanker";
  }
  return "ais-vessel-other";
}

export function resolveAisDisruptionSymbolKey(
  severity: WarMapEventSeverity,
): WarMapSymbolKey {
  switch (severity) {
    case "high":
      return "ais-disruption-high";
    case "medium":
      return "ais-disruption-medium";
    case "low":
    default:
      return "ais-disruption-low";
  }
}

export function resolveDeckPointSymbolState({
  point,
  hoveredInteractionKey,
  selectedInspectorKey,
}: {
  point: DeckPoint;
  hoveredInteractionKey: string | null;
  selectedInspectorKey: string | null;
}): WarMapSymbolState {
  if (point.isCluster) {
    return "cluster";
  }
  if (point.selectionKey && point.selectionKey === selectedInspectorKey) {
    return "selected";
  }
  if (point.interactionKey === hoveredInteractionKey) {
    return "hover";
  }
  return "default";
}

export function resolveDeckPointSymbolSize({
  point,
  hoveredInteractionKey,
  selectedInspectorKey,
}: {
  point: DeckPoint;
  hoveredInteractionKey: string | null;
  selectedInspectorKey: string | null;
}): number {
  const isSelected =
    Boolean(point.selectionKey) && point.selectionKey === selectedInspectorKey;
  const isHovered = point.interactionKey === hoveredInteractionKey;
  const stateBoost = isSelected ? 2.5 : isHovered ? 1 : 0;

  let baseSize = 22;
  if (point.isCluster) {
    baseSize = clamp(point.radius * 1.18, 30, 40);
  } else if (point.kind === "event") {
    baseSize = clamp(15 + point.radius * 0.84, 19, 31);
  } else if (
    point.kind === "layer" &&
    (point.layerId === "flights" || point.layerId === "ais")
  ) {
    baseSize = clamp(15 + point.radius * 0.98, 20, 31);
  } else if (point.kind === "monitor") {
    baseSize = clamp(15 + point.radius * 0.74, 17, 23);
  } else if (point.kind === "news") {
    baseSize = clamp(11.5 + point.radius * 0.7, 15, 19);
  } else if (point.kind === "layer") {
    baseSize = clamp(13 + point.radius * 0.76, 17, 23);
  }

  return baseSize + stateBoost;
}

export function resolveDeckPointClusterTextSize(point: DeckPoint): number {
  return clamp(point.radius * 0.34, 11, 15.5);
}

export function resolveDeckPointClusterTextOffset(
  point: DeckPoint,
): [number, number] {
  const count = point.clusterCount ?? 0;
  return [0, count >= 100 ? 0.7 : 0.45];
}
