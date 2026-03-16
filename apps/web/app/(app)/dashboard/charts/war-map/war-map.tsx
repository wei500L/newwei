"use client";

import {
  CloseOutlined,
  ExpandOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { HeatmapLayer } from "@deck.gl/aggregation-layers";
import { PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import {
  type WarMapEvent,
  type WarMapEventSeverity,
  type WarMapLayerFeature,
  type WarMapLayerId,
  type WarMapNewsGeoSource,
  type WarMapNewsMarker,
  type WarMapPreset,
  type WarMapTimeRangePreset,
  type WarMapTranslateTarget,
  WAR_MAP_LAYER_IDS,
  WAR_MAP_PRESETS,
  WAR_MAP_TIME_RANGE_PRESETS,
} from "@modular/utils";
import {
  Button,
  Checkbox,
  Drawer,
  Grid,
  List,
  Popover,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { usePendingAction } from "@/hooks/use-pending-action";
import { createApiClient } from "@/lib/api-client";
import {
  formatDateTime,
  formatRelativeTime,
  formatUpdatedAt,
  resolveLocale,
} from "@/lib/i18n";
import { captureClientError } from "@/lib/client-telemetry";
import {
  classifyMapLoadError,
  type MapLoadErrorPresentation,
} from "@/lib/map/map-load-error";
import {
  createDeckMapRuntime,
  extractMapBbox,
  setDeckOverlayProps,
} from "@/lib/map/map-runtime";
import { MAP_STYLE_URL } from "@/lib/map/map-style";
import { useRenderableContainer } from "@/lib/map/use-renderable-container";
import { safeHttpUrl } from "@/lib/url";
import { useWarMapSettingsStore } from "@/store/war-map-settings";

import {
  clusterWarMapPoints,
  computeAverageClusterGeometry,
  computeWeightedClusterGeometry,
  sortWarMapEventClusterMembers,
  sortWarMapNewsClusterMembers,
} from "./war-map-clustering";
import {
  buildSanitizedPathGeometry,
  buildSanitizedPolygonResult,
  isValidDeckCoordinate,
  type DeckCoordinate,
} from "./war-map-geometry";
import { WAR_MAP_UNSUPPORTED_LAYER_IDS } from "./war-map-data";
import { getWarMapAisLabel, readWarMapAisProperties } from "./war-map-ais";
import {
  getWarMapFlightLabel,
  readWarMapFlightProperties,
} from "./war-map-flights";
import { BBOX_QUERY_MIN_ZOOM, buildWarMapQueryBbox } from "./query-viewport";
import { readWarMapUrlState, writeWarMapUrlState } from "./url-state";
import { useWarMapData } from "./use-war-map-data";
import {
  useDashboardStream,
  type DashboardStreamState,
} from "../../use-dashboard-stream";

const ALL_TIME_START = new Date("1970-01-01T00:00:00.000Z");

interface DeckPoint {
  id: string;
  lat: number;
  lng: number;
  label: string;
  color: [number, number, number, number];
  radius: number;
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
  geoSource?: WarMapNewsGeoSource;
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
  countryCode?: string;
  countryName?: string;
  heading?: number;
  altitudeFt?: number;
  groundSpeedKt?: number;
  speed?: number;
  course?: number;
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

interface RenderableWarMapEvent extends WarMapEvent {
  label: string;
}

interface RenderableWarMapNewsMarker extends WarMapNewsMarker {
  label: string;
  locationLabel: string;
  latestAt?: string;
}

type SelectedCluster =
  | {
      key: string;
      kind: "event-cluster";
      lat: number;
      lng: number;
      count: number;
      zoomTarget: number;
      members: RenderableWarMapEvent[];
    }
  | {
      key: string;
      kind: "news-cluster";
      lat: number;
      lng: number;
      count: number;
      zoomTarget: number;
      members: RenderableWarMapNewsMarker[];
    };

type SelectedInspector =
  | SelectedCluster
  | {
      key: string;
      kind: "event";
      lat: number;
      lng: number;
      zoomTarget: number;
      item: RenderableWarMapEvent;
    }
  | {
      key: string;
      kind: "news";
      lat: number;
      lng: number;
      zoomTarget: number;
      item: RenderableWarMapNewsMarker;
    };

export interface WarMapProps {
  className?: string;
  translateTarget?: WarMapTranslateTarget;
  streamState?: DashboardStreamState;
  onEffectiveRangeChange?: (range: { start: Date; end: Date }) => void;
}

const PRESET_LABELS: Record<WarMapPreset, string> = {
  global: "Global",
  america: "America",
  mena: "MENA",
  eu: "Europe",
  asia: "Asia",
  latam: "LatAm",
  africa: "Africa",
  oceania: "Oceania",
};

const TIME_RANGE_LABELS: Record<WarMapTimeRangePreset, string> = {
  "1h": "1H",
  "6h": "6H",
  "24h": "24H",
  "48h": "48H",
  "7d": "7D",
  all: "All",
};

const TIME_RANGE_MS: Record<Exclude<WarMapTimeRangePreset, "all">, number> = {
  "1h": 1 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "48h": 48 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

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

const warMapSanitizationWarningSignatures = new Map<string, string>();
const DISPLAYABLE_WAR_MAP_LAYER_IDS = WAR_MAP_LAYER_IDS.filter(
  (layerId) => !WAR_MAP_UNSUPPORTED_LAYER_IDS.has(layerId),
);
const STREAM_MESSAGE_STALE_MS = 45_000;
const DATA_REFRESH_STALE_MS = 150_000;
const AIS_HEATMAP_COLOR_RANGE: Array<[number, number, number, number]> = [
  [191, 219, 254, 0],
  [147, 197, 253, 100],
  [96, 165, 250, 155],
  [249, 115, 22, 210],
  [185, 28, 28, 240],
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

function toLayerLabel(layerId: WarMapLayerId): string {
  const override = LAYER_LABEL_OVERRIDES[layerId];
  if (override) {
    return override;
  }
  return layerId
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function warnWarMapGeometrySanitization(
  kind: "path" | "polygon",
  layerId: WarMapLayerId,
  payload: Record<string, unknown>,
): void {
  const warningKey = `${kind}:${layerId}`;
  const signature = JSON.stringify(payload);
  if (warMapSanitizationWarningSignatures.get(warningKey) === signature) {
    return;
  }
  warMapSanitizationWarningSignatures.set(warningKey, signature);
  console.warn(
    `[WarMap] ${kind} geometry sanitized for layer "${layerId}".`,
    payload,
  );
}

function countInvalidPathCoordinates(path: unknown): number {
  if (!Array.isArray(path)) {
    return 0;
  }

  let invalidCount = 0;
  for (const coordinate of path) {
    if (!isValidDeckCoordinate(coordinate)) {
      invalidCount += 1;
    }
  }
  return invalidCount;
}

function summarizePolygonInput(polygon: unknown): {
  invalidCoordinateCount: number;
  malformedRingCount: number;
  ringCount: number;
} {
  if (!Array.isArray(polygon)) {
    return {
      invalidCoordinateCount: 0,
      malformedRingCount: 0,
      ringCount: 0,
    };
  }

  let invalidCoordinateCount = 0;
  let malformedRingCount = 0;
  for (const ring of polygon) {
    if (!Array.isArray(ring)) {
      malformedRingCount += 1;
      continue;
    }

    for (const coordinate of ring) {
      if (!isValidDeckCoordinate(coordinate)) {
        invalidCoordinateCount += 1;
      }
    }
  }

  return {
    invalidCoordinateCount,
    malformedRingCount,
    ringCount: polygon.length,
  };
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

function toRgba(
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

function getAisDensityColor(
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

function getAisDisruptionColor(
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

function getAisShipTypeColor(
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

function formatAisShipTypeLabel(shipType?: number): string {
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

function getErrorMessage(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof Error) {
    const withResponse = error as Error & {
      response?: { data?: { message?: string; error?: { message?: string } } };
    };
    const data = withResponse.response?.data;
    return data?.error?.message ?? data?.message ?? withResponse.message;
  }
  return typeof error === "string" ? error : undefined;
}

function readSummaryNumber(
  summary: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readSummaryString(
  summary: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = summary?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSummaryBoolean(
  summary: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = summary?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function severityColor(
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

function severityTagColor(severity: WarMapEventSeverity): string {
  switch (severity) {
    case "high":
      return "red";
    case "medium":
      return "gold";
    case "low":
    default:
      return "blue";
  }
}

function clusterRadius(count: number): number {
  return Math.max(12, Math.min(42, Math.sqrt(Math.max(1, count)) * 7));
}

function toClusterSelectionKey(
  kind: "event" | "news",
  memberKey: string,
): string {
  return `${kind}-cluster:${memberKey}`;
}

function toSingleSelectionKey(kind: "event" | "news", id: string): string {
  return `${kind}:${id}`;
}

function formatWarMapRelativeTimestamp(
  value: string | number | Date | undefined,
  locale: ReturnType<typeof resolveLocale>,
  base: number,
): string | null {
  if (value === undefined) {
    return null;
  }

  return (
    formatRelativeTime(value, locale, {
      base,
      style: "short",
    }) || formatUpdatedAt(value, locale)
  );
}

export function WarMap({
  className,
  translateTarget,
  streamState,
  onEffectiveRangeChange,
}: WarMapProps = {}) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const screens = Grid.useBreakpoint();
  const useDesktopInspector = Boolean(screens.lg);
  const { data: session } = useSession();

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);
  const syncFromMapRef = useRef(false);
  const hasHydratedUrlRef = useRef(false);

  const [inView, setInView] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapLoadError, setMapLoadError] =
    useState<MapLoadErrorPresentation | null>(null);
  const [mapMountNonce, setMapMountNonce] = useState(0);
  const [rangeAnchorMs, setRangeAnchorMs] = useState(() => Date.now());
  const [selectedInspectorKey, setSelectedInspectorKey] = useState<
    string | null
  >(null);
  const hasRenderableMapContainer = useRenderableContainer(
    mapContainerRef,
    inView,
  );
  const [queryViewport, setQueryViewport] = useState<{
    bbox?: [number, number, number, number];
    zoom: number;
  }>({ zoom: 2 });

  const layerVisibility = useWarMapSettingsStore(
    (state) => state.layerVisibility,
  );
  const viewState = useWarMapSettingsStore((state) => state.viewState);
  const activePreset = useWarMapSettingsStore((state) => state.activePreset);
  const timeRangePreset = useWarMapSettingsStore(
    (state) => state.timeRangePreset,
  );
  const flightMode = useWarMapSettingsStore((state) => state.flightMode);
  const aisMode = useWarMapSettingsStore((state) => state.aisMode);
  const setLayerVisible = useWarMapSettingsStore(
    (state) => state.setLayerVisible,
  );
  const setLayerVisibility = useWarMapSettingsStore(
    (state) => state.setLayerVisibility,
  );
  const setViewState = useWarMapSettingsStore((state) => state.setViewState);
  const setActivePreset = useWarMapSettingsStore(
    (state) => state.setActivePreset,
  );
  const setTimeRangePreset = useWarMapSettingsStore(
    (state) => state.setTimeRangePreset,
  );
  const setFlightMode = useWarMapSettingsStore((state) => state.setFlightMode);
  const setAisMode = useWarMapSettingsStore((state) => state.setAisMode);
  const resetLayers = useWarMapSettingsStore((state) => state.resetLayers);
  const viewStateRef = useRef(viewState);

  useEffect(() => {
    viewStateRef.current = viewState;
  }, [viewState]);

  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setInView(Boolean(entries[0]?.isIntersecting));
      },
      { rootMargin: "160px" },
    );

    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const dataEnabled = Boolean(session?.accessToken && inView);
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const retryMapLoad = useCallback(() => {
    setMapLoadError(null);
    setMapReady(false);
    setMapMountNonce((value) => value + 1);
  }, []);

  const refreshRangeAnchor = useCallback(() => {
    setRangeAnchorMs(Date.now());
  }, []);

  useEffect(() => {
    if (!inView) {
      return;
    }
    refreshRangeAnchor();
  }, [inView, refreshRangeAnchor, timeRangePreset]);

  useEffect(() => {
    if (!inView || typeof window === "undefined") {
      return;
    }
    const interval = window.setInterval(() => {
      refreshRangeAnchor();
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [inView, refreshRangeAnchor]);

  const effectiveRange = useMemo(() => {
    const end = new Date(rangeAnchorMs);
    if (timeRangePreset === "all") {
      return { start: ALL_TIME_START, end };
    }
    const duration = TIME_RANGE_MS[timeRangePreset];
    return {
      end,
      start: new Date(end.getTime() - duration),
    };
  }, [rangeAnchorMs, timeRangePreset]);

  useEffect(() => {
    if (!onEffectiveRangeChange) {
      return;
    }
    onEffectiveRangeChange({
      start: effectiveRange.start,
      end: effectiveRange.end,
    });
  }, [effectiveRange.end, effectiveRange.start, onEffectiveRangeChange]);

  const queryZoom = useMemo(
    () => Number(queryViewport.zoom.toFixed(2)),
    [queryViewport.zoom],
  );

  const queryBbox = useMemo(() => {
    return buildWarMapQueryBbox(queryViewport.bbox, queryZoom);
  }, [queryViewport.bbox, queryZoom]);
  const localClusterBbox = useMemo(
    () => (queryZoom >= BBOX_QUERY_MIN_ZOOM ? queryViewport.bbox : undefined),
    [queryViewport.bbox, queryZoom],
  );
  const { eventsQuery, newsQuery, layersQuery, monitorsQuery } = useWarMapData({
    apiClient,
    enabled: dataEnabled,
    start: effectiveRange.start.toISOString(),
    end: effectiveRange.end.toISOString(),
    translateTarget,
    bbox: queryBbox,
    zoom: queryZoom,
    flightMode,
    aisMode,
  });
  const monitors = monitorsQuery.data ?? [];
  const internalStreamState = useDashboardStream({
    accessToken: session?.accessToken,
    start: effectiveRange.start,
    end: effectiveRange.end,
    enabled: !streamState && Boolean(session?.accessToken) && inView,
  });
  const resolvedStreamState = streamState ?? internalStreamState;

  useEffect(() => {
    if (
      !mapContainerRef.current ||
      !inView ||
      !hasRenderableMapContainer ||
      mapRef.current
    ) {
      return;
    }

    const initialViewState = viewStateRef.current;
    setMapLoadError(null);
    const syncFromMap = (map: MapLibreMap) => {
      const center = map.getCenter();
      syncFromMapRef.current = true;
      setViewState({
        lat: center.lat,
        lon: center.lng,
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      });
      setQueryViewport({
        bbox: extractMapBbox(map),
        zoom: map.getZoom(),
      });
      window.setTimeout(() => {
        syncFromMapRef.current = false;
      }, 0);
    };

    const runtime = createDeckMapRuntime({
      container: mapContainerRef.current,
      initialViewState,
      force2D: true,
      style: MAP_STYLE_URL,
      onMoveEnd: syncFromMap,
      onMapReady: (map) => {
        setMapLoadError(null);
        setMapReady(true);
        syncFromMap(map);
      },
      onMapError: (_map, detail) => {
        captureClientError(
          "War map basemap load failed",
          detail.error ?? detail,
        );
        const presentation = classifyMapLoadError(detail);
        setMapReady(false);
        setMapLoadError(presentation);
        toast.error(
          `${presentation.title}. ${presentation.rawMessage ?? presentation.description}`,
        );
      },
    });

    mapRef.current = runtime.map;
    deckOverlayRef.current = runtime.overlay;

    return () => {
      deckOverlayRef.current = null;
      mapRef.current = null;
      runtime.destroy();
      setMapReady(false);
    };
  }, [hasRenderableMapContainer, inView, mapMountNonce, setViewState]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || syncFromMapRef.current) {
      return;
    }

    const center = map.getCenter();
    const changed =
      Math.abs(center.lat - viewState.lat) > 0.0005 ||
      Math.abs(center.lng - viewState.lon) > 0.0005 ||
      Math.abs(map.getZoom() - viewState.zoom) > 0.02 ||
      Math.abs(map.getBearing() - viewState.bearing) > 0.1 ||
      Math.abs(map.getPitch() - viewState.pitch) > 0.1;

    if (!changed) {
      return;
    }

    map.easeTo({
      center: [viewState.lon, viewState.lat],
      zoom: viewState.zoom,
      bearing: viewState.bearing,
      pitch: viewState.pitch,
      duration: 450,
      essential: true,
    });
  }, [mapReady, viewState]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !inView || !hasRenderableMapContainer) {
      return;
    }
    map.resize();
  }, [hasRenderableMapContainer, inView, mapReady]);

  useEffect(() => {
    if (hasHydratedUrlRef.current || typeof window === "undefined") {
      return;
    }

    const parsed = readWarMapUrlState(
      new URLSearchParams(window.location.search),
    );
    if (parsed.layerVisibility) {
      setLayerVisibility(parsed.layerVisibility);
    }
    if (parsed.activePreset) {
      setActivePreset(parsed.activePreset);
    }
    if (parsed.timeRangePreset) {
      setTimeRangePreset(parsed.timeRangePreset);
    }
    if (parsed.flightMode) {
      setFlightMode(parsed.flightMode);
    }
    if (parsed.aisMode) {
      setAisMode(parsed.aisMode);
    }
    if (parsed.viewState) {
      setViewState(parsed.viewState);
    }

    hasHydratedUrlRef.current = true;
  }, [
    setActivePreset,
    setAisMode,
    setFlightMode,
    setLayerVisibility,
    setTimeRangePreset,
    setViewState,
  ]);

  useEffect(() => {
    if (!hasHydratedUrlRef.current || typeof window === "undefined") {
      return;
    }

    const timer = window.setTimeout(() => {
      const current = new URL(window.location.href);
      const nextParams = writeWarMapUrlState(current.searchParams, {
        viewState,
        activePreset,
        timeRangePreset,
        layerVisibility,
        flightMode,
        aisMode,
      });
      const nextSearch = nextParams.toString();
      const currentSearch = current.searchParams.toString();
      if (nextSearch !== currentSearch) {
        const nextUrl = `${current.pathname}${nextSearch ? `?${nextSearch}` : ""}${current.hash}`;
        window.history.replaceState(null, "", nextUrl);
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [
    activePreset,
    aisMode,
    flightMode,
    layerVisibility,
    timeRangePreset,
    viewState,
  ]);

  const monitorPoints = useMemo(
    () =>
      monitors
        .filter((monitor) => monitor.enabled && monitor.location)
        .filter((monitor) =>
          isValidLatLng(monitor.location!.lat, monitor.location!.lng),
        )
        .map((monitor) => ({
          query:
            monitor.rawKeywords
              .find((keyword: string) => keyword.trim().length > 0)
              ?.trim() ?? monitor.name,
          id: monitor.id,
          lat: monitor.location!.lat,
          lng: monitor.location!.lng,
          label: monitor.name,
          color: toRgba(monitor.color, 0.9, [79, 70, 229]),
          radius: 8,
          kind: "monitor" as const,
          description: monitor.location!.name,
        })),
    [monitors],
  );

  const openNewsLink = useCallback(
    (url?: string | null) => {
      const safeUrl = typeof url === "string" ? safeHttpUrl(url) : null;
      if (!safeUrl) {
        toast.warning(
          t("dashboard.charts.warMap.missingNewsUrl", {
            defaultValue: "No link available for this news marker.",
          }),
        );
        return;
      }
      window.open(safeUrl, "_blank", "noopener,noreferrer");
    },
    [t],
  );

  const rawEvents = useMemo<RenderableWarMapEvent[]>(
    () =>
      (eventsQuery.data?.events ?? [])
        .filter((event) => isValidLatLng(event.lat, event.lng))
        .map((event) => ({
          ...event,
          label:
            translateTarget === "zh-CN" && typeof event.nameZh === "string"
              ? event.nameZh
              : event.name,
        })),
    [eventsQuery.data?.events, translateTarget],
  );

  const rawNewsMarkers = useMemo<RenderableWarMapNewsMarker[]>(
    () =>
      (newsQuery.data?.markers ?? [])
        .filter((marker) => isValidLatLng(marker.lat, marker.lng))
        .map((marker) => ({
          ...marker,
          label:
            translateTarget === "zh-CN" && typeof marker.titleZh === "string"
              ? marker.titleZh
              : marker.title,
          locationLabel:
            translateTarget === "zh-CN"
              ? (marker.displayNameZh ??
                marker.locationZh ??
                marker.displayName ??
                marker.location)
              : (marker.displayName ?? marker.location),
          latestAt: marker.publishedAt ?? marker.ingestedAt,
        })),
    [newsQuery.data?.markers, translateTarget],
  );

  const clusteredEvents = useMemo(
    () =>
      clusterWarMapPoints(rawEvents, {
        bbox: localClusterBbox,
        zoom: queryZoom,
        sortMembers: sortWarMapEventClusterMembers,
        getClusterGeometry: (members) =>
          computeWeightedClusterGeometry(members, (event) =>
            Math.max(1, event.derivedScore ?? event.value ?? 1),
          ),
      }),
    [localClusterBbox, queryZoom, rawEvents],
  );

  const clusteredNews = useMemo(
    () =>
      clusterWarMapPoints(rawNewsMarkers, {
        bbox: localClusterBbox,
        zoom: queryZoom,
        sortMembers: sortWarMapNewsClusterMembers,
        getClusterGeometry: (members) => computeAverageClusterGeometry(members),
      }),
    [localClusterBbox, queryZoom, rawNewsMarkers],
  );

  const selectedInspector = useMemo<SelectedInspector | null>(() => {
    if (!selectedInspectorKey) {
      return null;
    }

    const eventCluster = clusteredEvents.clusters.find(
      (cluster) =>
        toClusterSelectionKey("event", cluster.memberKey) ===
        selectedInspectorKey,
    );
    if (eventCluster) {
      return {
        key: selectedInspectorKey,
        kind: "event-cluster",
        lat: eventCluster.lat,
        lng: eventCluster.lng,
        count: eventCluster.count,
        zoomTarget: 8,
        members: eventCluster.members,
      };
    }

    const newsCluster = clusteredNews.clusters.find(
      (cluster) =>
        toClusterSelectionKey("news", cluster.memberKey) ===
        selectedInspectorKey,
    );
    if (newsCluster) {
      return {
        key: selectedInspectorKey,
        kind: "news-cluster",
        lat: newsCluster.lat,
        lng: newsCluster.lng,
        count: newsCluster.count,
        zoomTarget: 9,
        members: newsCluster.members,
      };
    }

    const event = rawEvents.find(
      (entry) =>
        toSingleSelectionKey("event", entry.id) === selectedInspectorKey,
    );
    if (event) {
      return {
        key: selectedInspectorKey,
        kind: "event",
        lat: event.lat,
        lng: event.lng,
        zoomTarget: 7,
        item: event,
      };
    }

    const newsItem = rawNewsMarkers.find(
      (entry) =>
        toSingleSelectionKey("news", entry.id) === selectedInspectorKey,
    );
    if (newsItem) {
      return {
        key: selectedInspectorKey,
        kind: "news",
        lat: newsItem.lat,
        lng: newsItem.lng,
        zoomTarget: 8,
        item: newsItem,
      };
    }

    return null;
  }, [
    clusteredEvents.clusters,
    clusteredNews.clusters,
    rawEvents,
    rawNewsMarkers,
    selectedInspectorKey,
  ]);

  useEffect(() => {
    if (selectedInspectorKey && !selectedInspector) {
      setSelectedInspectorKey(null);
    }
  }, [selectedInspector, selectedInspectorKey]);

  const closeSelectedInspector = useCallback(() => {
    setSelectedInspectorKey(null);
  }, []);

  const zoomToSelectedInspector = useCallback(() => {
    const map = mapRef.current;
    if (!map || !selectedInspector) {
      return;
    }

    map.easeTo({
      center: [selectedInspector.lng, selectedInspector.lat],
      zoom: Math.min(selectedInspector.zoomTarget, map.getZoom() + 2),
      duration: 350,
      essential: true,
    });
  }, [selectedInspector]);

  const zoomToLayerCluster = useCallback(
    (point?: DeckPoint) => {
      const map = mapRef.current;
      if (!map || !point) {
        return;
      }

      map.easeTo({
        center: [point.lng, point.lat],
        zoom: Math.min(Math.max(5, queryZoom + 2), 10),
        duration: 350,
        essential: true,
      });
    },
    [queryZoom],
  );

  const deckData = useMemo(() => {
    const layersData = layersQuery.data?.layers ?? {};
    const events = clusteredEvents.singles;
    const newsMarkers = clusteredNews.singles;

    const staticLayers: any[] = [];

    for (const layerId of WAR_MAP_LAYER_IDS) {
      if (
        layerId === "monitors" ||
        layerId === "ais" ||
        WAR_MAP_UNSUPPORTED_LAYER_IDS.has(layerId) ||
        !layerVisibility[layerId]
      ) {
        continue;
      }

      const dataset = layersData[layerId];
      if (
        !dataset ||
        !Array.isArray(dataset.features) ||
        dataset.features.length === 0
      ) {
        continue;
      }

      const color = toRgba(
        dataset.renderHints?.color,
        dataset.renderHints?.opacity ?? 0.72,
        [59, 130, 246],
      );
      const minZoom = dataset.renderHints?.minZoom;
      const maxZoom = dataset.renderHints?.maxZoom;
      const isZoomVisible =
        (typeof minZoom !== "number" || queryZoom >= minZoom) &&
        (typeof maxZoom !== "number" || queryZoom <= maxZoom);
      if (!isZoomVisible) {
        continue;
      }

      if (dataset.geometryType === "path") {
        const paths: Array<WarMapLayerFeature & { path: DeckCoordinate[] }> =
          [];
        const pathFallbackPoints: Array<
          WarMapLayerFeature & { lat: number; lng: number }
        > = [];
        const pathSanitizationSummary = {
          affectedFeatureCount: 0,
          invalidCoordinateCount: 0,
          splitFeatureCount: 0,
          renderedPathSegmentCount: 0,
          pointFallbackCount: 0,
          sampleFeatureIds: [] as string[],
        };
        for (const feature of dataset.features) {
          const sanitized = buildSanitizedPathGeometry(feature);
          const invalidCoordinateCount = countInvalidPathCoordinates(
            feature.path,
          );
          const wasSplit = sanitized.pathFeatures.length > 1;
          const hadPointFallback = sanitized.pointFeatures.length > 0;
          if (invalidCoordinateCount > 0 || wasSplit || hadPointFallback) {
            pathSanitizationSummary.affectedFeatureCount += 1;
            pathSanitizationSummary.invalidCoordinateCount +=
              invalidCoordinateCount;
            pathSanitizationSummary.renderedPathSegmentCount +=
              sanitized.pathFeatures.length;
            pathSanitizationSummary.pointFallbackCount +=
              sanitized.pointFeatures.length;
            if (wasSplit) {
              pathSanitizationSummary.splitFeatureCount += 1;
            }
            if (pathSanitizationSummary.sampleFeatureIds.length < 5) {
              pathSanitizationSummary.sampleFeatureIds.push(feature.id);
            }
          }
          paths.push(...sanitized.pathFeatures);
          pathFallbackPoints.push(...sanitized.pointFeatures);
        }
        if (pathSanitizationSummary.affectedFeatureCount > 0) {
          warnWarMapGeometrySanitization(
            "path",
            layerId,
            pathSanitizationSummary,
          );
        }
        if (paths.length > 0) {
          staticLayers.push(
            new PathLayer({
              id: `wm-path-${layerId}`,
              data: paths,
              pickable: Boolean(dataset.renderHints?.pickable ?? true),
              getPath: (
                feature: WarMapLayerFeature & { path: DeckCoordinate[] },
              ) => feature.path,
              getColor: color,
              getWidth: 2,
              widthMinPixels: 1.4,
              widthMaxPixels: 5,
            }),
          );
        }
        if (pathFallbackPoints.length > 0) {
          staticLayers.push(
            new ScatterplotLayer({
              id: `wm-path-${layerId}-points`,
              data: pathFallbackPoints,
              pickable: Boolean(dataset.renderHints?.pickable ?? true),
              getPosition: (
                feature: WarMapLayerFeature & { lat: number; lng: number },
              ) => [feature.lng, feature.lat],
              getFillColor: color,
              getRadius: () =>
                Math.max(
                  4,
                  Math.min(
                    14,
                    Math.round((dataset.renderHints?.radiusScale ?? 1) * 5),
                  ),
                ),
              radiusMinPixels: 3,
              radiusMaxPixels: 18,
              stroked: false,
            }),
          );
        }
        continue;
      }

      if (dataset.geometryType === "polygon") {
        const polygons: Array<
          WarMapLayerFeature & { polygon: DeckCoordinate[][] }
        > = [];
        const polygonOutlineFeatures: Array<
          WarMapLayerFeature & { path: DeckCoordinate[] }
        > = [];
        const polygonFallbackPoints: Array<
          WarMapLayerFeature & { lat: number; lng: number }
        > = [];
        const polygonSanitizationSummary = {
          affectedFeatureCount: 0,
          invalidCoordinateCount: 0,
          malformedRingCount: 0,
          degradedFillCount: 0,
          outlineFragmentCount: 0,
          pointFallbackCount: 0,
          sampleFeatureIds: [] as string[],
        };
        for (const feature of dataset.features) {
          const sanitized = buildSanitizedPolygonResult(feature);
          const inputSummary = summarizePolygonInput(feature.polygon);
          const degradedFill =
            Array.isArray(feature.polygon) &&
            feature.polygon.length > 0 &&
            sanitized.polygonFeature === null;
          if (
            inputSummary.invalidCoordinateCount > 0 ||
            inputSummary.malformedRingCount > 0 ||
            degradedFill ||
            sanitized.outlineFeatures.length > 0 ||
            sanitized.pointFeatures.length > 0
          ) {
            polygonSanitizationSummary.affectedFeatureCount += 1;
            polygonSanitizationSummary.invalidCoordinateCount +=
              inputSummary.invalidCoordinateCount;
            polygonSanitizationSummary.malformedRingCount +=
              inputSummary.malformedRingCount;
            polygonSanitizationSummary.outlineFragmentCount +=
              sanitized.outlineFeatures.length;
            polygonSanitizationSummary.pointFallbackCount +=
              sanitized.pointFeatures.length;
            if (degradedFill) {
              polygonSanitizationSummary.degradedFillCount += 1;
            }
            if (polygonSanitizationSummary.sampleFeatureIds.length < 5) {
              polygonSanitizationSummary.sampleFeatureIds.push(feature.id);
            }
          }
          if (sanitized.polygonFeature) {
            polygons.push(sanitized.polygonFeature);
          }
          polygonOutlineFeatures.push(...sanitized.outlineFeatures);
          polygonFallbackPoints.push(...sanitized.pointFeatures);
        }
        if (polygonSanitizationSummary.affectedFeatureCount > 0) {
          warnWarMapGeometrySanitization(
            "polygon",
            layerId,
            polygonSanitizationSummary,
          );
        }
        if (polygons.length > 0) {
          staticLayers.push(
            new PolygonLayer({
              id: `wm-polygon-${layerId}`,
              data: polygons,
              pickable: Boolean(dataset.renderHints?.pickable ?? true),
              getPolygon: (
                feature: WarMapLayerFeature & { polygon: DeckCoordinate[][] },
              ) => feature.polygon[0] ?? [],
              getFillColor: color,
              getLineColor: toRgba(
                dataset.renderHints?.color,
                0.85,
                [59, 130, 246],
              ),
              lineWidthMinPixels: 1,
              filled: true,
              stroked: true,
            }),
          );
        }
        if (polygonOutlineFeatures.length > 0) {
          staticLayers.push(
            new PathLayer({
              id: `wm-polygon-${layerId}-fragments`,
              data: polygonOutlineFeatures,
              pickable: Boolean(dataset.renderHints?.pickable ?? true),
              getPath: (
                feature: WarMapLayerFeature & { path: DeckCoordinate[] },
              ) => feature.path,
              getColor: toRgba(
                dataset.renderHints?.color,
                0.92,
                [59, 130, 246],
              ),
              getWidth: 2,
              widthMinPixels: 1.2,
              widthMaxPixels: 4,
            }),
          );
        }
        if (polygonFallbackPoints.length > 0) {
          staticLayers.push(
            new ScatterplotLayer({
              id: `wm-polygon-${layerId}-points`,
              data: polygonFallbackPoints,
              pickable: Boolean(dataset.renderHints?.pickable ?? true),
              getPosition: (
                feature: WarMapLayerFeature & { lat: number; lng: number },
              ) => [feature.lng, feature.lat],
              getFillColor: color,
              getRadius: () =>
                Math.max(
                  4,
                  Math.min(
                    14,
                    Math.round((dataset.renderHints?.radiusScale ?? 1) * 5),
                  ),
                ),
              radiusMinPixels: 3,
              radiusMaxPixels: 18,
              stroked: false,
            }),
          );
        }
        continue;
      }

      if (dataset.geometryType === "raster") {
        continue;
      }

      const layerLabel = t(`dashboard.charts.warMap.layerNames.${layerId}`, {
        defaultValue: toLayerLabel(layerId),
      });
      const points: DeckPoint[] = dataset.features
        .filter(
          (
            feature,
          ): feature is WarMapLayerFeature & { lat: number; lng: number } =>
            typeof feature.lat === "number" &&
            typeof feature.lng === "number" &&
            isValidLatLng(feature.lat, feature.lng),
        )
        .map((feature) => {
          const properties =
            feature.properties &&
            typeof feature.properties === "object" &&
            !Array.isArray(feature.properties)
              ? (feature.properties as Record<string, unknown>)
              : undefined;
          const translatedName =
            typeof properties?.nameZh === "string" &&
            translateTarget === "zh-CN"
              ? properties.nameZh
              : typeof properties?.name === "string"
                ? properties.name
                : layerLabel;
          const description =
            typeof properties?.descriptionZh === "string" &&
            translateTarget === "zh-CN"
              ? properties.descriptionZh
              : typeof properties?.description === "string"
                ? properties.description
                : undefined;
          const flight = readWarMapFlightProperties(properties);
          return {
            id: `${layerId}-${feature.id}`,
            lat: feature.lat,
            lng: feature.lng,
            label: flight
              ? getWarMapFlightLabel(flight, translatedName)
              : translatedName,
            description,
            color,
            radius: Math.max(
              4,
              Math.min(
                18,
                Math.round((dataset.renderHints?.radiusScale ?? 1) * 6),
              ),
            ),
            kind: "layer",
            layerId,
            ...(flight
              ? {
                  sourceType: flight.sourceType,
                  callsign: flight.callsign,
                  icao24: flight.icao24,
                  registration: flight.registration,
                  aircraftType: flight.aircraftType,
                  countryCode: flight.countryCode,
                  countryName: flight.countryName,
                  heading: flight.heading,
                  altitudeFt: flight.altitudeFt,
                  groundSpeedKt: flight.groundSpeedKt,
                  latestAt: flight.observedAt,
                  sourceUpdatedAt: flight.sourceUpdatedAt,
                }
              : {}),
          };
        });

      const clusterablePartition = dataset.renderHints?.clusterable
        ? clusterWarMapPoints(points, {
            bbox: localClusterBbox,
            zoom: queryZoom,
            getClusterGeometry: (members) =>
              computeAverageClusterGeometry(members),
          })
        : null;
      const pointSingles = clusterablePartition
        ? clusterablePartition.singles
        : points;
      const pointClusters: DeckPoint[] = clusterablePartition
        ? clusterablePartition.clusters.map((cluster) => ({
            id: `layer-cluster:${layerId}:${cluster.memberKey}`,
            lat: cluster.lat,
            lng: cluster.lng,
            label: layerLabel,
            description:
              layerId === "flights"
                ? t("dashboard.charts.warMap.tooltip.clusterFlights", {
                    defaultValue:
                      flightMode === "all"
                        ? "{{count}} flights. Click to zoom in."
                        : "{{count}} military/possible military flights. Click to zoom in.",
                    count: cluster.count,
                  })
                : t("dashboard.charts.warMap.tooltip.clusterLayer", {
                    defaultValue:
                      "{{count}} {{layer}} items. Click to zoom in.",
                    count: cluster.count,
                    layer: layerLabel,
                  }),
            color,
            radius: clusterRadius(cluster.count),
            kind: "layer-cluster",
            layerId,
            isCluster: true,
            clusterCount: cluster.count,
          }))
        : [];

      if (pointClusters.length > 0) {
        staticLayers.push(
          new ScatterplotLayer({
            id: `wm-point-${layerId}-clusters`,
            data: pointClusters,
            pickable: Boolean(dataset.renderHints?.pickable ?? true),
            getPosition: (point: DeckPoint) => [point.lng, point.lat],
            getFillColor: (point: DeckPoint) => point.color,
            getRadius: (point: DeckPoint) => point.radius,
            radiusMinPixels: 10,
            radiusMaxPixels: 42,
            stroked: false,
            onClick: (info: { object?: DeckPoint }) => {
              zoomToLayerCluster(info.object);
            },
          }),
        );
      }

      if (pointSingles.length > 0) {
        staticLayers.push(
          new ScatterplotLayer({
            id: `wm-point-${layerId}`,
            data: pointSingles,
            pickable: Boolean(dataset.renderHints?.pickable ?? true),
            getPosition: (point: DeckPoint) => [point.lng, point.lat],
            getFillColor: (point: DeckPoint) => point.color,
            getRadius: (point: DeckPoint) => point.radius,
            radiusMinPixels: 3,
            radiusMaxPixels: 30,
            stroked: false,
          }),
        );
      }
    }

    const aisLayers: any[] = [];
    const aisDataset =
      layerVisibility.ais && layersData.ais ? layersData.ais : null;
    let aisFeatureCount = 0;

    if (aisDataset?.geometryType === "point") {
      const aisVessels: DeckPoint[] = [];
      const aisDensityZones: DeckPoint[] = [];
      const aisDisruptions: DeckPoint[] = [];

      for (const feature of aisDataset.features) {
        if (
          typeof feature.lat !== "number" ||
          typeof feature.lng !== "number" ||
          !isValidLatLng(feature.lat, feature.lng)
        ) {
          continue;
        }
        const properties =
          feature.properties &&
          typeof feature.properties === "object" &&
          !Array.isArray(feature.properties)
            ? (feature.properties as Record<string, unknown>)
            : undefined;
        const aisProperties = readWarMapAisProperties(properties);
        if (!aisProperties) {
          continue;
        }

        const label = getWarMapAisLabel(
          aisProperties,
          t("dashboard.charts.warMap.layerNames.ais", {
            defaultValue: "AIS traffic",
          }),
        );

        if (aisProperties.featureKind === "vessel") {
          aisVessels.push({
            id: `ais-vessel-${feature.id}`,
            lat: feature.lat,
            lng: feature.lng,
            label,
            color: getAisShipTypeColor(aisProperties.shipType),
            radius: aisMode === "military" ? 7 : 5,
            kind: "layer",
            layerId: "ais",
            sourceType: "ais",
            aisFeatureKind: "vessel",
            mmsi: aisProperties.mmsi,
            shipType: aisProperties.shipType,
            heading: aisProperties.heading,
            speed: aisProperties.speed,
            course: aisProperties.course,
            latestAt: aisProperties.observedAt,
            sourceUpdatedAt: aisDataset.updatedAt,
            description:
              aisMode === "military"
                ? t("dashboard.charts.warMap.stats.aisMilitaryCandidates", {
                    defaultValue: "Military / government candidate vessel",
                  })
                : t("dashboard.charts.warMap.stats.aisVessels", {
                    defaultValue: "AIS vessel",
                  }),
          });
          continue;
        }

        if (aisProperties.featureKind === "density") {
          const intensity = Math.max(0, Math.min(1, aisProperties.intensity));
          aisDensityZones.push({
            id: `ais-density-${feature.id}`,
            lat: feature.lat,
            lng: feature.lng,
            label,
            color: getAisDensityColor(intensity, 0.34),
            radius: 12 + intensity * 18,
            kind: "layer",
            layerId: "ais",
            sourceType: "ais",
            aisFeatureKind: "density",
            intensity,
            deltaPct: aisProperties.deltaPct,
            shipsPerDay: aisProperties.shipsPerDay,
            latestAt: feature.timestamp ?? aisDataset.updatedAt,
            sourceUpdatedAt: aisDataset.updatedAt,
            description:
              aisProperties.description ??
              aisProperties.note ??
              t("dashboard.charts.warMap.stats.aisDensityZones", {
                defaultValue: "AIS traffic density zone",
              }),
          });
          continue;
        }

        aisDisruptions.push({
          id: `ais-disruption-${feature.id}`,
          lat: feature.lat,
          lng: feature.lng,
          label,
          color: getAisDisruptionColor(aisProperties.severity),
          radius:
            aisProperties.severity === "high"
              ? 18
              : aisProperties.severity === "medium"
                ? 14
                : 11,
          kind: "layer",
          layerId: "ais",
          sourceType: "ais",
          aisFeatureKind: "disruption",
          severity: aisProperties.severity,
          disruptionType: aisProperties.disruptionType,
          vesselCount: aisProperties.vesselCount,
          changePct: aisProperties.changePct,
          windowHours: aisProperties.windowHours,
          region: aisProperties.region,
          darkShips: aisProperties.darkShips,
          latestAt: feature.timestamp ?? aisDataset.updatedAt,
          sourceUpdatedAt: aisDataset.updatedAt,
          description: aisProperties.description,
        });
      }

      aisFeatureCount =
        aisVessels.length + aisDensityZones.length + aisDisruptions.length;

      if (aisDensityZones.length > 0) {
        aisLayers.push(
          new HeatmapLayer({
            id: "wm-ais-density-heatmap",
            data: aisDensityZones,
            pickable: false,
            getPosition: (point: DeckPoint) => [point.lng, point.lat],
            getWeight: (point: DeckPoint) => point.intensity ?? 0.2,
            colorRange: AIS_HEATMAP_COLOR_RANGE,
            radiusPixels: 45,
            intensity: 1,
            threshold: 0.03,
          }),
        );
        aisLayers.push(
          new ScatterplotLayer({
            id: "wm-ais-density-zones",
            data: aisDensityZones,
            pickable: true,
            stroked: false,
            getFillColor: (point: DeckPoint) => point.color,
            getRadius: (point: DeckPoint) => point.radius,
            radiusMinPixels: 10,
            radiusMaxPixels: 34,
            getPosition: (point: DeckPoint) => [point.lng, point.lat],
          }),
        );
      }

      if (aisDisruptions.length > 0) {
        aisLayers.push(
          new ScatterplotLayer({
            id: "wm-ais-disruptions-ring",
            data: aisDisruptions,
            pickable: true,
            stroked: true,
            filled: false,
            lineWidthMinPixels: 2,
            getLineColor: (point: DeckPoint) => point.color,
            getRadius: (point: DeckPoint) => point.radius * 1.45,
            radiusMinPixels: 12,
            radiusMaxPixels: 42,
            getPosition: (point: DeckPoint) => [point.lng, point.lat],
          }),
        );
        aisLayers.push(
          new ScatterplotLayer({
            id: "wm-ais-disruptions-core",
            data: aisDisruptions,
            pickable: true,
            stroked: false,
            getFillColor: (point: DeckPoint) => point.color,
            getRadius: (point: DeckPoint) => point.radius * 0.55,
            radiusMinPixels: 5,
            radiusMaxPixels: 18,
            getPosition: (point: DeckPoint) => [point.lng, point.lat],
          }),
        );
      }

      if (aisVessels.length > 0) {
        aisLayers.push(
          new ScatterplotLayer({
            id: "wm-ais-vessels",
            data: aisVessels,
            pickable: true,
            stroked: true,
            getLineColor: [15, 23, 42, 180],
            lineWidthMinPixels: 1,
            getFillColor: (point: DeckPoint) => point.color,
            getRadius: (point: DeckPoint) => point.radius,
            radiusMinPixels: 3,
            radiusMaxPixels: 14,
            getPosition: (point: DeckPoint) => [point.lng, point.lat],
          }),
        );
      }
    }

    const eventPoints: DeckPoint[] = [];
    for (const event of events) {
      const score =
        typeof event.derivedScore === "number"
          ? event.derivedScore
          : (event.value ?? 0);
      const point: DeckPoint = {
        id: event.id,
        lat: event.lat,
        lng: event.lng,
        label: event.label,
        kind: "event",
        selectionKey: toSingleSelectionKey("event", event.id),
        color: severityColor(event.severity),
        radius: Math.max(5, Math.min(24, Math.sqrt(Math.max(1, score)) * 2.5)),
        severity: event.severity,
        alertCount: event.alertCount,
        newsCount: event.newsCount,
        latestAt: event.latestAt,
      };
      eventPoints.push(point);
    }

    const eventClusters: DeckPoint[] = [];
    for (const cluster of clusteredEvents.clusters) {
      const selectionKey = toClusterSelectionKey("event", cluster.memberKey);
      eventClusters.push({
        id: selectionKey,
        lat: cluster.lat,
        lng: cluster.lng,
        label: t("dashboard.charts.warMap.panel.signalsTitle", {
          defaultValue: "Nearby signals",
        }),
        kind: "event-cluster",
        color: [180, 83, 9, 188],
        radius: clusterRadius(cluster.count),
        isCluster: true,
        clusterCount: cluster.count,
        selectionKey,
        description: t("dashboard.charts.warMap.tooltip.clusterSignals", {
          defaultValue: "{{count}} nearby signals. Click to inspect.",
          count: cluster.count,
        }),
      });
    }

    const newsPoints: DeckPoint[] = [];
    for (const marker of newsMarkers) {
      const baseColor =
        marker.geoSource === "fallback-country" ? [8, 145, 178] : [5, 150, 105];
      const [baseR = 8, baseG = 145, baseB = 178] = baseColor;
      const point: DeckPoint = {
        id: marker.id,
        lat: marker.lat,
        lng: marker.lng,
        label: marker.label,
        kind: "news",
        selectionKey: toSingleSelectionKey("news", marker.id),
        color: [
          baseR,
          baseG,
          baseB,
          marker.geoSource === "fallback-country" ? 110 : 200,
        ],
        radius: 5,
        url: marker.url ?? null,
        publishedAt: marker.publishedAt,
        ingestedAt: marker.ingestedAt,
        locationLabel: marker.locationLabel,
        geoSource: marker.geoSource,
      };
      newsPoints.push(point);
    }

    const newsClusters: DeckPoint[] = [];
    for (const cluster of clusteredNews.clusters) {
      const selectionKey = toClusterSelectionKey("news", cluster.memberKey);
      newsClusters.push({
        id: selectionKey,
        lat: cluster.lat,
        lng: cluster.lng,
        label: t("dashboard.charts.warMap.panel.newsTitle", {
          defaultValue: "Nearby news",
        }),
        kind: "news-cluster",
        color: [21, 128, 61, 176],
        radius: clusterRadius(cluster.count),
        isCluster: true,
        clusterCount: cluster.count,
        selectionKey,
        description: t("dashboard.charts.warMap.tooltip.clusterNews", {
          defaultValue: "{{count}} nearby news items. Click to inspect.",
          count: cluster.count,
        }),
      });
    }

    const deckLayers: any[] = [...staticLayers, ...aisLayers];

    if (layerVisibility.monitors && monitorPoints.length > 0) {
      deckLayers.push(
        new ScatterplotLayer({
          id: "wm-monitors",
          data: monitorPoints,
          pickable: true,
          getPosition: (point: DeckPoint) => [point.lng, point.lat],
          getFillColor: (point: DeckPoint) => point.color,
          getRadius: (point: DeckPoint) => point.radius,
          radiusMinPixels: 5,
          radiusMaxPixels: 24,
          onClick: (info: { object?: DeckPoint }) => {
            const object = info.object;
            if (!object) {
              return;
            }
            const query = (object.query ?? object.label).trim();
            if (!query) {
              toast.warning(
                t("dashboard.charts.warMap.missingMonitorQuery", {
                  defaultValue: "No keywords available for this monitor.",
                }),
              );
              return;
            }
            window.open(
              `/search?q=${encodeURIComponent(query)}`,
              "_blank",
              "noopener,noreferrer",
            );
          },
        }),
      );
    }

    if (eventClusters.length > 0) {
      deckLayers.push(
        new ScatterplotLayer({
          id: "wm-events-clusters",
          data: eventClusters,
          pickable: true,
          getPosition: (point: DeckPoint) => [point.lng, point.lat],
          getFillColor: (point: DeckPoint) => point.color,
          getRadius: (point: DeckPoint) => point.radius,
          radiusMinPixels: 10,
          radiusMaxPixels: 50,
          onClick: (info: { object?: DeckPoint }) => {
            const object = info.object;
            if (!object?.selectionKey) {
              return;
            }
            setSelectedInspectorKey(object.selectionKey);
          },
        }),
      );
    }

    if (eventPoints.length > 0) {
      deckLayers.push(
        new ScatterplotLayer({
          id: "wm-events",
          data: eventPoints,
          pickable: true,
          getPosition: (point: DeckPoint) => [point.lng, point.lat],
          getFillColor: (point: DeckPoint) => point.color,
          getRadius: (point: DeckPoint) => point.radius,
          radiusMinPixels: 4,
          radiusMaxPixels: 34,
          onClick: (info: { object?: DeckPoint }) => {
            const object = info.object;
            if (!object?.selectionKey) {
              return;
            }
            setSelectedInspectorKey(object.selectionKey);
          },
        }),
      );
    }

    if (newsClusters.length > 0) {
      deckLayers.push(
        new ScatterplotLayer({
          id: "wm-news-clusters",
          data: newsClusters,
          pickable: true,
          getPosition: (point: DeckPoint) => [point.lng, point.lat],
          getFillColor: (point: DeckPoint) => point.color,
          getRadius: (point: DeckPoint) => point.radius,
          radiusMinPixels: 10,
          radiusMaxPixels: 50,
          onClick: (info: { object?: DeckPoint }) => {
            const object = info.object;
            if (!object?.selectionKey) {
              return;
            }
            setSelectedInspectorKey(object.selectionKey);
          },
        }),
      );
    }

    if (newsPoints.length > 0) {
      deckLayers.push(
        new ScatterplotLayer({
          id: "wm-news",
          data: newsPoints,
          pickable: true,
          getPosition: (point: DeckPoint) => [point.lng, point.lat],
          getFillColor: (point: DeckPoint) => point.color,
          getRadius: (point: DeckPoint) => point.radius,
          radiusMinPixels: 4,
          radiusMaxPixels: 18,
          onClick: (info: { object?: DeckPoint }) => {
            const object = info.object;
            if (!object || object.isCluster) {
              return;
            }
            if (!object.selectionKey) {
              return;
            }
            setSelectedInspectorKey(object.selectionKey);
          },
        }),
      );
    }

    return {
      deckLayers,
      eventsCount: rawEvents.length,
      eventClustersCount: eventClusters.length,
      newsCount: rawNewsMarkers.length,
      newsClustersCount: newsClusters.length,
      staticVisibleCount: staticLayers.length + aisLayers.length,
      aisFeatureCount,
    };
  }, [
    clusteredEvents.clusters,
    clusteredEvents.singles,
    layerVisibility,
    layersQuery.data?.layers,
    localClusterBbox,
    monitorPoints,
    clusteredNews.clusters,
    clusteredNews.singles,
    rawEvents.length,
    rawNewsMarkers.length,
    queryZoom,
    t,
    aisMode,
    flightMode,
    translateTarget,
    zoomToLayerCluster,
  ]);

  const tooltipGetter = useMemo(
    () =>
      ({ object }: { object?: DeckPoint }) => {
        if (!object) {
          return null;
        }
        if (object.kind === "event-cluster") {
          const count = object.clusterCount ?? 0;
          return {
            text: t("dashboard.charts.warMap.tooltip.clusterSignals", {
              defaultValue: "{{count}} nearby signals. Click to inspect.",
              count,
            }),
          };
        }
        if (object.kind === "news-cluster") {
          const count = object.clusterCount ?? 0;
          return {
            text: t("dashboard.charts.warMap.tooltip.clusterNews", {
              defaultValue: "{{count}} nearby news items. Click to inspect.",
              count,
            }),
          };
        }
        if (object.kind === "layer-cluster") {
          const count = object.clusterCount ?? 0;
          const layerLabel = object.layerId
            ? t(`dashboard.charts.warMap.layerNames.${object.layerId}`, {
                defaultValue: toLayerLabel(object.layerId),
              })
            : object.label;
          return {
            text:
              object.layerId === "flights"
                ? t("dashboard.charts.warMap.tooltip.clusterFlights", {
                    defaultValue:
                      flightMode === "all"
                        ? "{{count}} flights. Click to zoom in."
                        : "{{count}} military/possible military flights. Click to zoom in.",
                    count,
                  })
                : t("dashboard.charts.warMap.tooltip.clusterLayer", {
                    defaultValue:
                      "{{count}} {{layer}} items. Click to zoom in.",
                    count,
                    layer: layerLabel,
                  }),
          };
        }

        const latestTimestamp =
          object.publishedAt ?? object.ingestedAt ?? object.latestAt;
        const latestLabel =
          object.kind === "event"
            ? t("dashboard.charts.warMap.panel.latest", {
                defaultValue: "Latest",
              })
            : object.kind === "layer" &&
                (object.layerId === "flights" || object.layerId === "ais")
              ? t("dashboard.charts.warMap.tooltip.observed", {
                  defaultValue: "Observed",
                })
              : object.publishedAt
                ? t("dashboard.charts.warMap.tooltip.published", {
                    defaultValue: "Published",
                  })
                : object.ingestedAt
                  ? t("dashboard.charts.warMap.tooltip.ingested", {
                      defaultValue: "Ingested",
                    })
                  : null;

        const formattedTimestamp = latestTimestamp
          ? formatDateTime(latestTimestamp, locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : null;

        const lines = [object.label];
        if (object.description) {
          lines.push(object.description);
        }
        if (object.kind === "event" && object.severity) {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.severity", {
              defaultValue: "Severity",
            })}: ${t(`dashboard.charts.warMap.stats.${object.severity}`, {
              defaultValue: object.severity,
            })}`,
          );
        }
        if (object.kind === "event") {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.alerts", {
              defaultValue: "Alerts",
            })}: ${object.alertCount ?? 0}`,
          );
          lines.push(
            `${t("dashboard.charts.warMap.stats.news", {
              defaultValue: "News",
            })}: ${object.newsCount ?? 0}`,
          );
        }
        if (object.kind === "news" && object.locationLabel) {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.location", {
              defaultValue: "Location",
            })}: ${object.locationLabel}`,
          );
        }
        if (object.kind === "layer" && object.layerId === "ais") {
          if (object.aisFeatureKind === "vessel") {
            if (object.mmsi) {
              lines.push(`MMSI: ${object.mmsi}`);
            }
            if (typeof object.shipType === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.shipType", {
                  defaultValue: "Ship type",
                })}: ${formatAisShipTypeLabel(object.shipType)}`,
              );
            }
            if (typeof object.heading === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.heading", {
                  defaultValue: "Heading",
                })}: ${Math.round(object.heading)}°`,
              );
            }
            if (typeof object.speed === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.speed", {
                  defaultValue: "Speed",
                })}: ${Math.round(object.speed)} kn`,
              );
            }
            if (typeof object.course === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.course", {
                  defaultValue: "Course",
                })}: ${Math.round(object.course)}°`,
              );
            }
          } else if (object.aisFeatureKind === "density") {
            if (typeof object.intensity === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.intensity", {
                  defaultValue: "Intensity",
                })}: ${object.intensity.toFixed(2)}`,
              );
            }
            if (typeof object.deltaPct === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.change", {
                  defaultValue: "Change",
                })}: ${object.deltaPct > 0 ? "+" : ""}${Math.round(object.deltaPct)}%`,
              );
            }
            if (typeof object.shipsPerDay === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.shipsPerDay", {
                  defaultValue: "Ships/day",
                })}: ${Math.round(object.shipsPerDay)}`,
              );
            }
          } else if (object.aisFeatureKind === "disruption") {
            if (object.disruptionType) {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.type", {
                  defaultValue: "Type",
                })}: ${object.disruptionType}`,
              );
            }
            if (object.severity) {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.severity", {
                  defaultValue: "Severity",
                })}: ${t(`dashboard.charts.warMap.stats.${object.severity}`, {
                  defaultValue: object.severity,
                })}`,
              );
            }
            if (typeof object.vesselCount === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.vessels", {
                  defaultValue: "Vessels",
                })}: ${object.vesselCount}`,
              );
            }
            if (typeof object.changePct === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.change", {
                  defaultValue: "Change",
                })}: ${object.changePct > 0 ? "+" : ""}${Math.round(object.changePct)}%`,
              );
            }
            if (typeof object.darkShips === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.darkShips", {
                  defaultValue: "Dark ships",
                })}: ${object.darkShips}`,
              );
            }
            if (typeof object.windowHours === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.window", {
                  defaultValue: "Window",
                })}: ${object.windowHours}h`,
              );
            }
            if (object.region) {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.region", {
                  defaultValue: "Region",
                })}: ${object.region}`,
              );
            }
          }
        }
        if (object.kind === "layer" && object.layerId === "flights") {
          if (object.icao24) {
            lines.push(`ICAO24: ${object.icao24.toUpperCase()}`);
          }
          if (object.registration) {
            lines.push(
              `${t("dashboard.charts.warMap.tooltip.registration", {
                defaultValue: "Registration",
              })}: ${object.registration}`,
            );
          }
          if (object.aircraftType) {
            lines.push(
              `${t("dashboard.charts.warMap.tooltip.aircraftType", {
                defaultValue: "Type",
              })}: ${object.aircraftType}`,
            );
          }
          if (object.countryCode || object.countryName) {
            lines.push(
              `${t("dashboard.charts.warMap.tooltip.country", {
                defaultValue: "Country",
              })}: ${object.countryName ? `${object.countryName}${object.countryCode ? ` (${object.countryCode})` : ""}` : object.countryCode}`,
            );
          }
          if (typeof object.heading === "number") {
            lines.push(
              `${t("dashboard.charts.warMap.tooltip.heading", {
                defaultValue: "Heading",
              })}: ${Math.round(object.heading)}°`,
            );
          }
          if (typeof object.altitudeFt === "number") {
            lines.push(
              `${t("dashboard.charts.warMap.tooltip.altitude", {
                defaultValue: "Altitude",
              })}: ${Math.round(object.altitudeFt)} ft`,
            );
          }
          if (typeof object.groundSpeedKt === "number") {
            lines.push(
              `${t("dashboard.charts.warMap.tooltip.speed", {
                defaultValue: "Speed",
              })}: ${Math.round(object.groundSpeedKt)} kt`,
            );
          }
        }
        if (formattedTimestamp && latestLabel) {
          lines.push(`${latestLabel}: ${formattedTimestamp}`);
        }
        if (
          object.kind === "layer" &&
          (object.layerId === "flights" || object.layerId === "ais") &&
          object.sourceUpdatedAt
        ) {
          lines.push(
            `${t("dashboard.charts.warMap.tooltip.updated", {
              defaultValue: "Updated",
            })}: ${formatDateTime(object.sourceUpdatedAt, locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })}`,
          );
        }
        if (object.kind === "news") {
          lines.push(
            t("dashboard.charts.warMap.tooltip.clickInspect", {
              defaultValue: "Click to inspect details",
            }),
          );
        }
        return { text: lines.join("\n") };
      },
    [flightMode, locale, t],
  );

  useEffect(() => {
    if (!deckOverlayRef.current) {
      return;
    }
    setDeckOverlayProps(deckOverlayRef.current, {
      layers: hasRenderableMapContainer ? deckData.deckLayers : [],
      getTooltip: tooltipGetter,
    });
  }, [deckData.deckLayers, hasRenderableMapContainer, tooltipGetter]);

  const anyLoading =
    eventsQuery.isLoading ||
    newsQuery.isLoading ||
    layersQuery.isLoading ||
    monitorsQuery.isLoading;
  const anyFetching =
    eventsQuery.isFetching ||
    newsQuery.isFetching ||
    layersQuery.isFetching ||
    monitorsQuery.isFetching;
  const errors = [
    eventsQuery.error,
    newsQuery.error,
    layersQuery.error,
    monitorsQuery.error,
  ].filter(Boolean);
  const { pending: refreshingMapData, run: refreshMapData } = usePendingAction(
    async () => {
      await Promise.all([
        eventsQuery.refetch(),
        newsQuery.refetch(),
        layersQuery.refetch(),
        monitorsQuery.refetch(),
      ]);
    },
  );
  const hasData =
    deckData.eventsCount +
      deckData.newsCount +
      deckData.eventClustersCount +
      deckData.newsClustersCount +
      deckData.staticVisibleCount +
      (layerVisibility.monitors ? monitorPoints.length : 0) >
    0;

  const nowMs = Date.now();
  const windowLabel = `${formatDateTime(effectiveRange.start, locale, {
    dateStyle: "medium",
  })} - ${formatDateTime(effectiveRange.end, locale, { dateStyle: "medium" })}`;
  const flightsSummary =
    layersQuery.data?.layers.flights?.summary &&
    typeof layersQuery.data.layers.flights.summary === "object" &&
    !Array.isArray(layersQuery.data.layers.flights.summary)
      ? (layersQuery.data.layers.flights.summary as Record<string, unknown>)
      : undefined;
  const flightsReturnedCount = readSummaryNumber(
    flightsSummary,
    "returnedCount",
  );
  const flightsSnapshotCount = readSummaryNumber(
    flightsSummary,
    "snapshotValidPositionCount",
  );
  const flightsRawCount = readSummaryNumber(flightsSummary, "rawAircraftCount");
  const flightsMaxReturned = readSummaryNumber(flightsSummary, "maxReturned");
  const flightsTruncated = flightsSummary?.truncated === true;
  const flightsFreshness =
    typeof flightsSummary?.freshness === "string"
      ? flightsSummary.freshness
      : undefined;
  const flightsSource = readSummaryString(flightsSummary, "source");
  const flightsScope = readSummaryString(flightsSummary, "scope");
  const flightsSourceEndpoint = readSummaryString(
    flightsSummary,
    "sourceEndpoint",
  );
  const flightsSourceLabel =
    flightsSource === "opensky"
      ? t("dashboard.charts.warMap.stats.flightSourceOpensky", {
          defaultValue: "OpenSky",
        })
      : flightsSource
        ? flightsSource.toUpperCase()
        : undefined;
  const flightsScopeLabel =
    flightsScope === "military"
      ? t("dashboard.charts.warMap.stats.flightScopeMilitary", {
          defaultValue: "Military / possible military",
        })
      : flightsScope === "all"
        ? t("dashboard.charts.warMap.stats.flightScopeAll", {
            defaultValue: "All flights",
          })
        : flightsScope;
  const flightsSourceBadgeLabel =
    flightsSourceLabel && flightsScopeLabel
      ? `${flightsSourceLabel} / ${flightsScopeLabel}`
      : (flightsSourceLabel ?? flightsScopeLabel ?? null);
  const flightsCoverageLabel =
    typeof flightsSnapshotCount === "number" &&
    typeof flightsRawCount === "number"
      ? t("dashboard.charts.warMap.stats.flightCoverage", {
          defaultValue: "Positioned {{positioned}} / Raw {{raw}}",
          positioned: flightsSnapshotCount,
          raw: flightsRawCount,
        })
      : null;
  const flightsRawLabel =
    typeof flightsRawCount === "number"
      ? t("dashboard.charts.warMap.stats.flightsRaw", {
          defaultValue: "raw {{count}}",
          count: flightsRawCount,
        })
      : null;
  const flightsTooltipText = [
    flightsSourceLabel
      ? `${t("dashboard.charts.warMap.stats.flightSource", {
          defaultValue: "Flight source",
        })}: ${flightsSourceLabel}`
      : null,
    flightsScopeLabel
      ? `${t("dashboard.charts.warMap.stats.flightScope", {
          defaultValue: "Scope",
        })}: ${flightsScopeLabel}`
      : null,
    flightsCoverageLabel
      ? `${t("dashboard.charts.warMap.stats.flightCoverageLabel", {
          defaultValue: "Coverage",
        })}: ${flightsCoverageLabel}`
      : null,
    typeof flightsReturnedCount === "number"
      ? `${t("dashboard.charts.warMap.stats.flightRendered", {
          defaultValue: "Rendered",
        })}: ${flightsReturnedCount}${typeof flightsMaxReturned === "number" ? ` / ${flightsMaxReturned}` : ""}`
      : null,
    flightsSourceEndpoint
      ? `${t("dashboard.charts.warMap.stats.flightEndpoint", {
          defaultValue: "Endpoint",
        })}: ${flightsSourceEndpoint}`
      : null,
    flightsFreshness === "zoom_required"
      ? t("dashboard.charts.warMap.stats.flightZoomRequired", {
          defaultValue:
            "Zoom in to request all-flight OpenSky data for the current viewport.",
        })
      : null,
    flightsFreshness === "not_configured"
      ? t("dashboard.charts.warMap.stats.flightNotConfigured", {
          defaultValue: "OpenSky OAuth client credentials are not configured.",
        })
      : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const aisSummary =
    layersQuery.data?.layers.ais?.summary &&
    typeof layersQuery.data.layers.ais.summary === "object" &&
    !Array.isArray(layersQuery.data.layers.ais.summary)
      ? (layersQuery.data.layers.ais.summary as Record<string, unknown>)
      : undefined;
  const aisConnected = readSummaryBoolean(aisSummary, "connected") ?? false;
  const aisConfigured = readSummaryBoolean(aisSummary, "configured") ?? true;
  const aisFreshness = readSummaryString(aisSummary, "freshness");
  const aisSnapshotUpdatedAt = readSummaryString(
    aisSummary,
    "snapshotUpdatedAt",
  );
  const aisSourceEndpoint = readSummaryString(aisSummary, "sourceEndpoint");
  const aisRelayVesselCount = readSummaryNumber(aisSummary, "relayVesselCount");
  const aisDisruptionsCount = readSummaryNumber(aisSummary, "disruptionsCount");
  const aisDensityCount = readSummaryNumber(aisSummary, "densityCount");
  const aisCandidateCount = readSummaryNumber(aisSummary, "candidateCount");
  const aisRenderedVesselCount = readSummaryNumber(
    aisSummary,
    "renderedVesselCount",
  );
  const aisAllVesselsAvailable =
    readSummaryBoolean(aisSummary, "allVesselsAvailable") ?? false;
  const aisMessageCount = readSummaryNumber(aisSummary, "messageCount");
  const aisClientCount = readSummaryNumber(aisSummary, "clientCount");
  const aisDroppedMessages = readSummaryNumber(aisSummary, "droppedMessages");
  const aisBlockedReasonCode = readSummaryString(
    aisSummary,
    "blockedReasonCode",
  );
  const aisBlockedReason = readSummaryString(aisSummary, "blockedReason");
  const aisResolvedBlockedReason =
    aisBlockedReasonCode === "missing_vessels_snapshot"
      ? t("dashboard.charts.warMap.stats.aisAllUnavailableHint", {
          defaultValue:
            "All vessels mode will unlock after the relay exposes vessels[] in its snapshot payload.",
        })
      : aisBlockedReasonCode === "snapshot_unavailable"
        ? t("dashboard.charts.warMap.stats.aisSnapshotUnavailable", {
            defaultValue: "AIS snapshot is not available yet.",
          })
        : aisBlockedReason;
  const aisSnapshotRelative = aisSnapshotUpdatedAt
    ? formatWarMapRelativeTimestamp(aisSnapshotUpdatedAt, locale, nowMs)
    : null;
  const aisSnapshotExact = aisSnapshotUpdatedAt
    ? formatUpdatedAt(aisSnapshotUpdatedAt, locale)
    : null;
  const aisSourceStatusColor = !aisConfigured
    ? "red"
    : !aisConnected
      ? "gold"
      : aisFreshness === "stale"
        ? "gold"
        : "cyan";
  const aisSourceStatusLabel = !aisConfigured
    ? t("dashboard.charts.warMap.stats.aisNotConfigured", {
        defaultValue: "AIS not configured",
      })
    : !aisConnected
      ? t("dashboard.charts.warMap.stats.aisDisconnected", {
          defaultValue: "AIS disconnected",
        })
      : aisFreshness === "stale"
        ? t("dashboard.charts.warMap.status.stale", {
            defaultValue: "Stale",
          })
        : t("dashboard.stream.status.live", {
            defaultValue: "Live",
          });
  const aisModeLabel =
    aisMode === "all"
      ? t("dashboard.charts.warMap.stats.aisModeAll", {
          defaultValue: "All vessels",
        })
      : aisMode === "density"
        ? t("dashboard.charts.warMap.stats.aisModeDensity", {
            defaultValue: "Density only",
          })
        : t("dashboard.charts.warMap.stats.aisModeMilitary", {
            defaultValue: "Military candidates",
          });
  const aisTooltipText = [
    `${t("dashboard.charts.warMap.layerNames.ais", {
      defaultValue: "AIS traffic",
    })}: ${aisSourceStatusLabel}`,
    `${t("dashboard.charts.warMap.stats.mode", {
      defaultValue: "Mode",
    })}: ${aisModeLabel}`,
    typeof aisRelayVesselCount === "number"
      ? `${t("dashboard.charts.warMap.stats.aisTrackedVessels", {
          defaultValue: "Tracked vessels",
        })}: ${aisRelayVesselCount}`
      : null,
    typeof aisRenderedVesselCount === "number"
      ? `${t("dashboard.charts.warMap.stats.aisRenderedVessels", {
          defaultValue: "Rendered vessels",
        })}: ${aisRenderedVesselCount}`
      : null,
    typeof aisCandidateCount === "number"
      ? `${t("dashboard.charts.warMap.stats.aisCandidates", {
          defaultValue: "Candidates",
        })}: ${aisCandidateCount}`
      : null,
    typeof aisDensityCount === "number"
      ? `${t("dashboard.charts.warMap.stats.aisDensityZones", {
          defaultValue: "Density zones",
        })}: ${aisDensityCount}`
      : null,
    typeof aisDisruptionsCount === "number"
      ? `${t("dashboard.charts.warMap.stats.aisDisruptions", {
          defaultValue: "Disruptions",
        })}: ${aisDisruptionsCount}`
      : null,
    typeof aisMessageCount === "number"
      ? `${t("dashboard.charts.warMap.stats.aisMessages", {
          defaultValue: "Messages",
        })}: ${aisMessageCount}`
      : null,
    typeof aisDroppedMessages === "number"
      ? `${t("dashboard.charts.warMap.stats.aisDroppedMessages", {
          defaultValue: "Dropped messages",
        })}: ${aisDroppedMessages}`
      : null,
    typeof aisClientCount === "number"
      ? `${t("dashboard.charts.warMap.stats.aisClients", {
          defaultValue: "Relay clients",
        })}: ${aisClientCount}`
      : null,
    aisSourceEndpoint
      ? `${t("dashboard.charts.warMap.stats.aisSourceEndpoint", {
          defaultValue: "Endpoint",
        })}: ${aisSourceEndpoint}`
      : null,
    aisSnapshotExact
      ? `${t("dashboard.charts.warMap.stats.aisSnapshotUpdated", {
          defaultValue: "AIS updated",
        })}: ${aisSnapshotExact}`
      : null,
    aisResolvedBlockedReason ?? null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const aisAllModeDisabled = !aisAllVesselsAvailable;
  const aisAllModeDisabledLabel =
    aisResolvedBlockedReason ??
    t("dashboard.charts.warMap.stats.aisAllUnavailable", {
      defaultValue: "All vessels mode is waiting for relay vessel snapshots.",
    });
  const aisPrimaryCountLabel =
    aisMode === "density"
      ? t("dashboard.charts.warMap.stats.aisDensityZones", {
          defaultValue: "Density zones",
        })
      : aisMode === "military"
        ? t("dashboard.charts.warMap.stats.aisCandidates", {
            defaultValue: "Candidates",
          })
        : t("dashboard.charts.warMap.stats.aisRenderedVessels", {
            defaultValue: "Rendered vessels",
          });
  const aisPrimaryCountValue =
    aisMode === "density"
      ? aisDensityCount
      : aisMode === "military"
        ? (aisRenderedVesselCount ?? aisCandidateCount)
        : aisRenderedVesselCount;
  const visibleLayerCount =
    DISPLAYABLE_WAR_MAP_LAYER_IDS.filter((layerId) => layerVisibility[layerId])
      .length + (layerVisibility.monitors ? 1 : 0);
  const chainStatuses = [
    {
      key: "signals",
      label: t("dashboard.charts.warMap.stats.signals", {
        defaultValue: "Signals",
      }),
      fetching: eventsQuery.isFetching,
      error: Boolean(eventsQuery.error),
      ready: Boolean(eventsQuery.data),
      errorMessage: getErrorMessage(eventsQuery.error),
      dataUpdatedAt: eventsQuery.dataUpdatedAt || undefined,
      sourceUpdatedAt: eventsQuery.data?.updatedAt,
      sourceUpdatedLabel: t("dashboard.charts.warMap.stats.signalsUpdated", {
        defaultValue: "Signals updated",
      }),
    },
    {
      key: "news",
      label: t("dashboard.charts.warMap.stats.news", { defaultValue: "News" }),
      fetching: newsQuery.isFetching,
      error: Boolean(newsQuery.error),
      ready: Boolean(newsQuery.data),
      errorMessage: getErrorMessage(newsQuery.error),
      dataUpdatedAt: newsQuery.dataUpdatedAt || undefined,
      sourceUpdatedAt: newsQuery.data?.updatedAt,
      sourceUpdatedLabel: t("dashboard.charts.warMap.stats.newsUpdated", {
        defaultValue: "News updated",
      }),
    },
    {
      key: "layers",
      label: t("dashboard.charts.warMap.layers", { defaultValue: "Layers" }),
      fetching: layersQuery.isFetching,
      error: Boolean(layersQuery.error),
      ready: Boolean(layersQuery.data),
      errorMessage: getErrorMessage(layersQuery.error),
      dataUpdatedAt: layersQuery.dataUpdatedAt || undefined,
      sourceUpdatedAt: layersQuery.data?.updatedAt,
      sourceUpdatedLabel: t("dashboard.charts.warMap.stats.layersUpdated", {
        defaultValue: "Layers updated",
      }),
    },
    {
      key: "monitors",
      label: t("dashboard.charts.warMap.stats.monitors", {
        defaultValue: "Monitors",
      }),
      fetching: monitorsQuery.isFetching,
      error: Boolean(monitorsQuery.error),
      ready: Boolean(monitorsQuery.data),
      errorMessage: getErrorMessage(monitorsQuery.error),
      dataUpdatedAt: monitorsQuery.dataUpdatedAt || undefined,
      sourceUpdatedAt: monitorsQuery.dataUpdatedAt || undefined,
      sourceUpdatedLabel: t("dashboard.charts.warMap.stats.monitorsUpdated", {
        defaultValue: "Monitors updated",
      }),
    },
  ] as const;
  const showBootOverlay =
    !mapLoadError && (!mapReady || (anyLoading && !hasData));
  const bootOverlayLabel = !mapReady
    ? t("dashboard.charts.warMap.status.loadingMap", {
        defaultValue: "Loading map base layer…",
      })
    : t("dashboard.charts.warMap.status.loadingData", {
        defaultValue: "Loading map data…",
      });
  const latestQueryUpdatedAt = chainStatuses.reduce<number | null>(
    (latest, status) => {
      if (!status.dataUpdatedAt) {
        return latest;
      }
      if (latest === null || status.dataUpdatedAt > latest) {
        return status.dataUpdatedAt;
      }
      return latest;
    },
    null,
  );
  const latestQueryUpdatedRelative = latestQueryUpdatedAt
    ? formatWarMapRelativeTimestamp(latestQueryUpdatedAt, locale, nowMs)
    : null;
  const latestQueryUpdatedExact = latestQueryUpdatedAt
    ? formatUpdatedAt(latestQueryUpdatedAt, locale)
    : null;
  const streamMessageRelative = resolvedStreamState.lastMessageAt
    ? formatWarMapRelativeTimestamp(
        resolvedStreamState.lastMessageAt,
        locale,
        nowMs,
      )
    : null;
  const streamMessageExact = resolvedStreamState.lastMessageAt
    ? formatUpdatedAt(resolvedStreamState.lastMessageAt, locale)
    : null;
  const streamLagging =
    resolvedStreamState.status === "live" &&
    (!resolvedStreamState.lastMessageAt ||
      nowMs - resolvedStreamState.lastMessageAt > STREAM_MESSAGE_STALE_MS);
  const streamStatusColor =
    resolvedStreamState.status !== "live"
      ? "red"
      : streamLagging
        ? "gold"
        : "green";
  const streamStatusLabel =
    resolvedStreamState.status !== "live"
      ? t("dashboard.stream.status.offline", { defaultValue: "Offline" })
      : streamLagging
        ? t("dashboard.charts.warMap.status.lagging", {
            defaultValue: "Lagging",
          })
        : t("dashboard.stream.status.live", { defaultValue: "Live" });
  const refreshingChainCount = chainStatuses.filter(
    (status) => status.fetching,
  ).length;
  const hasErroredChain = chainStatuses.some((status) => status.error);
  const dataStatusColor = !latestQueryUpdatedAt
    ? "default"
    : anyFetching
      ? "processing"
      : hasErroredChain
        ? "gold"
        : nowMs - latestQueryUpdatedAt > DATA_REFRESH_STALE_MS
          ? "gold"
          : "blue";
  const dataStatusLabel = !latestQueryUpdatedAt
    ? t("dashboard.charts.warMap.status.waitingData", {
        defaultValue: "Waiting for first data",
      })
    : anyFetching
      ? t("dashboard.charts.warMap.status.refreshingChains", {
          defaultValue: "Refreshing {{count}} chains",
          count: Math.max(refreshingChainCount, 1),
        })
      : `${t("dashboard.charts.warMap.stats.dataUpdated", {
          defaultValue: "Data updated",
        })}: ${latestQueryUpdatedRelative ?? latestQueryUpdatedExact}`;
  const detailedChainStatuses = chainStatuses.map((status) => {
    const isStale =
      Boolean(status.dataUpdatedAt) &&
      !status.fetching &&
      nowMs - (status.dataUpdatedAt ?? 0) > DATA_REFRESH_STALE_MS;
    const stateLabel = status.error
      ? t("dashboard.charts.warMap.status.error", { defaultValue: "Error" })
      : status.fetching
        ? t("dashboard.charts.warMap.status.refreshing", {
            defaultValue: "Refreshing",
          })
        : !status.ready
          ? t("dashboard.charts.warMap.status.waiting", {
              defaultValue: "Waiting",
            })
          : isStale
            ? t("dashboard.charts.warMap.status.stale", {
                defaultValue: "Stale",
              })
            : t("dashboard.charts.warMap.status.updated", {
                defaultValue: "Updated",
              });
    const relativeUpdated = status.dataUpdatedAt
      ? formatWarMapRelativeTimestamp(status.dataUpdatedAt, locale, nowMs)
      : null;
    const exactUpdated = status.dataUpdatedAt
      ? formatUpdatedAt(status.dataUpdatedAt, locale)
      : null;
    const sourceUpdated = status.sourceUpdatedAt
      ? formatUpdatedAt(status.sourceUpdatedAt, locale)
      : null;
    const color = status.error
      ? "red"
      : status.fetching
        ? "processing"
        : !status.ready
          ? "default"
          : isStale
            ? "gold"
            : "green";
    const text =
      status.ready && relativeUpdated && !status.fetching && !status.error
        ? `${status.label}: ${relativeUpdated}`
        : `${status.label}: ${stateLabel}`;
    const tooltipLines = [
      `${status.label}: ${stateLabel}`,
      exactUpdated
        ? `${t("dashboard.charts.warMap.stats.dataUpdated", {
            defaultValue: "Data updated",
          })}: ${exactUpdated}`
        : null,
      sourceUpdated ? `${status.sourceUpdatedLabel}: ${sourceUpdated}` : null,
      status.errorMessage ?? null,
    ].filter(Boolean);
    return {
      ...status,
      color,
      text,
      tooltip: tooltipLines.join("\n"),
    };
  });

  const layerSelector = (
    <div style={{ minWidth: 260, maxHeight: 360, overflowY: "auto" }}>
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        {DISPLAYABLE_WAR_MAP_LAYER_IDS.map((layerId) => {
          const disabled =
            layerId === "monitors" ? monitorPoints.length === 0 : false;
          return (
            <Checkbox
              key={layerId}
              checked={layerVisibility[layerId]}
              disabled={disabled}
              onChange={(event) => {
                setLayerVisible(layerId, event.target.checked);
              }}
            >
              {t(`dashboard.charts.warMap.layerNames.${layerId}`, {
                defaultValue: toLayerLabel(layerId),
              })}
            </Checkbox>
          );
        })}
        <div className="pt-2">
          <Typography.Text type="secondary" className="text-xs">
            {t("dashboard.charts.warMap.layerNames.ais", {
              defaultValue: "AIS traffic",
            })}
          </Typography.Text>
          <Space size={4} wrap className="mt-2">
            <Button
              size="small"
              type={aisMode === "military" ? "primary" : "default"}
              onClick={() => setAisMode("military")}
            >
              {t("dashboard.charts.warMap.stats.aisModeMilitary", {
                defaultValue: "Military candidates",
              })}
            </Button>
            <Button
              size="small"
              type={aisMode === "density" ? "primary" : "default"}
              onClick={() => setAisMode("density")}
            >
              {t("dashboard.charts.warMap.stats.aisModeDensity", {
                defaultValue: "Density only",
              })}
            </Button>
            <Tooltip
              title={aisAllModeDisabled ? aisAllModeDisabledLabel : null}
            >
              <Button
                size="small"
                type={aisMode === "all" ? "primary" : "default"}
                disabled={aisAllModeDisabled}
                onClick={() => setAisMode("all")}
              >
                {t("dashboard.charts.warMap.stats.aisModeAll", {
                  defaultValue: "All vessels",
                })}
              </Button>
            </Tooltip>
          </Space>
        </div>
        <Button
          type="link"
          size="small"
          style={{ padding: 0, height: "auto" }}
          onClick={() => resetLayers()}
        >
          {t("common.reset", { defaultValue: "Reset" })}
        </Button>
      </Space>
    </div>
  );

  const inspectorPanelContent = selectedInspector ? (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur">
      <div className="border-b border-slate-200 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Space size={[6, 6]} wrap>
              <Tag
                color={
                  selectedInspector.kind === "event" ||
                  selectedInspector.kind === "event-cluster"
                    ? "gold"
                    : "green"
                }
              >
                {selectedInspector.kind === "event" ||
                selectedInspector.kind === "event-cluster"
                  ? t("dashboard.charts.warMap.panel.signalsTitle", {
                      defaultValue: "Nearby signals",
                    })
                  : t("dashboard.charts.warMap.panel.newsTitle", {
                      defaultValue: "Nearby news",
                    })}
              </Tag>
              {"count" in selectedInspector ? (
                <Tag color="default">
                  {t("dashboard.charts.warMap.panel.count", {
                    defaultValue: "{{count}} items",
                    count: selectedInspector.count,
                  })}
                </Tag>
              ) : null}
            </Space>
            <Typography.Title level={5} className="!mb-1 !mt-3">
              {"item" in selectedInspector
                ? selectedInspector.item.label
                : selectedInspector.kind === "event-cluster"
                  ? t("dashboard.charts.warMap.panel.signalsTitle", {
                      defaultValue: "Nearby signals",
                    })
                  : t("dashboard.charts.warMap.panel.newsTitle", {
                      defaultValue: "Nearby news",
                    })}
            </Typography.Title>
            <Typography.Text type="secondary">
              {"item" in selectedInspector
                ? selectedInspector.kind === "event"
                  ? t("dashboard.charts.warMap.panel.signalDetailSummary", {
                      defaultValue: "Signal details for the selected location.",
                    })
                  : t("dashboard.charts.warMap.panel.newsDetailSummary", {
                      defaultValue: "News details for the selected marker.",
                    })
                : selectedInspector.kind === "event-cluster"
                  ? t("dashboard.charts.warMap.panel.signalsSummary", {
                      defaultValue:
                        "{{count}} nearby signals at this zoom level.",
                      count: selectedInspector.count,
                    })
                  : t("dashboard.charts.warMap.panel.newsSummary", {
                      defaultValue:
                        "{{count}} nearby news items at this zoom level.",
                      count: selectedInspector.count,
                    })}
            </Typography.Text>
          </div>
          <Space size={8}>
            <Button
              size="small"
              icon={<ExpandOutlined />}
              onClick={zoomToSelectedInspector}
            >
              {t("dashboard.charts.warMap.panel.zoomIn", {
                defaultValue: "Zoom in",
              })}
            </Button>
            {useDesktopInspector ? (
              <Button
                size="small"
                type="text"
                icon={<CloseOutlined />}
                onClick={closeSelectedInspector}
                aria-label={t("common.close", {
                  defaultValue: "Close",
                })}
              />
            ) : null}
          </Space>
        </div>
      </div>

      {selectedInspector.kind === "event-cluster" ? (
        <List
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
          dataSource={selectedInspector.members}
          renderItem={(item) => (
            <List.Item key={item.id}>
              <List.Item.Meta
                title={
                  <div className="flex items-start justify-between gap-3">
                    <Typography.Text strong>{item.label}</Typography.Text>
                    <Tag color={severityTagColor(item.severity)}>
                      {t(`dashboard.charts.warMap.stats.${item.severity}`, {
                        defaultValue:
                          item.severity.charAt(0).toUpperCase() +
                          item.severity.slice(1),
                      })}
                    </Tag>
                  </div>
                }
                description={
                  <div className="flex flex-col gap-2">
                    <Space size={[6, 6]} wrap>
                      <Tag>
                        {t("dashboard.charts.warMap.tooltip.alerts", {
                          defaultValue: "Alerts",
                        })}
                        : {item.alertCount ?? 0}
                      </Tag>
                      <Tag>
                        {t("dashboard.charts.warMap.stats.news", {
                          defaultValue: "News",
                        })}
                        : {item.newsCount ?? 0}
                      </Tag>
                    </Space>
                    {item.latestAt ? (
                      <Typography.Text type="secondary" className="text-xs">
                        {t("dashboard.charts.warMap.panel.latest", {
                          defaultValue: "Latest",
                        })}
                        :{" "}
                        {formatDateTime(item.latestAt, locale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </Typography.Text>
                    ) : null}
                  </div>
                }
              />
            </List.Item>
          )}
        />
      ) : selectedInspector.kind === "news-cluster" ? (
        <List
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
          dataSource={selectedInspector.members}
          renderItem={(item) => {
            const timestampLabel = item.publishedAt
              ? t("dashboard.charts.warMap.tooltip.published", {
                  defaultValue: "Published",
                })
              : item.ingestedAt
                ? t("dashboard.charts.warMap.tooltip.ingested", {
                    defaultValue: "Ingested",
                  })
                : null;
            const timestamp = item.publishedAt ?? item.ingestedAt;

            return (
              <List.Item
                key={item.id}
                actions={[
                  <Button
                    key="open"
                    size="small"
                    type="link"
                    disabled={!item.url}
                    onClick={() => openNewsLink(item.url)}
                  >
                    {t("dashboard.charts.warMap.panel.openOriginal", {
                      defaultValue: "Open",
                    })}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Typography.Text
                      strong
                      className="block"
                      ellipsis={{ tooltip: item.label }}
                    >
                      {item.label}
                    </Typography.Text>
                  }
                  description={
                    <div className="flex flex-col gap-2">
                      <Space size={[6, 6]} wrap>
                        <Tag>{item.locationLabel}</Tag>
                        <Tag>
                          {t(
                            item.geoSource === "fallback-country"
                              ? "dashboard.charts.warMap.stats.fallbackCountry"
                              : "dashboard.charts.warMap.stats.geocoded",
                            {
                              defaultValue:
                                item.geoSource === "fallback-country"
                                  ? "Fallback country"
                                  : "Geocoded",
                            },
                          )}
                        </Tag>
                      </Space>
                      {timestamp && timestampLabel ? (
                        <Typography.Text type="secondary" className="text-xs">
                          {timestampLabel}:{" "}
                          {formatDateTime(timestamp, locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </Typography.Text>
                      ) : null}
                    </div>
                  }
                />
              </List.Item>
            );
          }}
        />
      ) : selectedInspector.kind === "event" ? (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          <Space size={[6, 6]} wrap>
            <Tag color={severityTagColor(selectedInspector.item.severity)}>
              {t(
                `dashboard.charts.warMap.stats.${selectedInspector.item.severity}`,
                {
                  defaultValue:
                    selectedInspector.item.severity.charAt(0).toUpperCase() +
                    selectedInspector.item.severity.slice(1),
                },
              )}
            </Tag>
            <Tag>
              {t("dashboard.charts.warMap.tooltip.alerts", {
                defaultValue: "Alerts",
              })}
              : {selectedInspector.item.alertCount ?? 0}
            </Tag>
            <Tag>
              {t("dashboard.charts.warMap.stats.news", {
                defaultValue: "News",
              })}
              : {selectedInspector.item.newsCount ?? 0}
            </Tag>
          </Space>
          {selectedInspector.item.latestAt ? (
            <Typography.Text type="secondary">
              {t("dashboard.charts.warMap.panel.latest", {
                defaultValue: "Latest",
              })}
              :{" "}
              {formatDateTime(selectedInspector.item.latestAt, locale, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </Typography.Text>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          <Space size={[6, 6]} wrap>
            <Tag>{selectedInspector.item.locationLabel}</Tag>
            <Tag>
              {t(
                selectedInspector.item.geoSource === "fallback-country"
                  ? "dashboard.charts.warMap.stats.fallbackCountry"
                  : "dashboard.charts.warMap.stats.geocoded",
                {
                  defaultValue:
                    selectedInspector.item.geoSource === "fallback-country"
                      ? "Fallback country"
                      : "Geocoded",
                },
              )}
            </Tag>
          </Space>
          {selectedInspector.item.publishedAt ||
          selectedInspector.item.ingestedAt ? (
            <Typography.Text type="secondary">
              {selectedInspector.item.publishedAt
                ? t("dashboard.charts.warMap.tooltip.published", {
                    defaultValue: "Published",
                  })
                : t("dashboard.charts.warMap.tooltip.ingested", {
                    defaultValue: "Ingested",
                  })}
              :{" "}
              {formatDateTime(
                selectedInspector.item.publishedAt ??
                  selectedInspector.item.ingestedAt ??
                  "",
                locale,
                {
                  dateStyle: "medium",
                  timeStyle: "short",
                },
              )}
            </Typography.Text>
          ) : null}
          <Button
            type="primary"
            size="small"
            disabled={!selectedInspector.item.url}
            onClick={() => openNewsLink(selectedInspector.item.url)}
          >
            {t("dashboard.charts.warMap.panel.openOriginal", {
              defaultValue: "Open original",
            })}
          </Button>
        </div>
      )}
    </div>
  ) : null;

  const containerClassName = ["relative", className ?? "h-[430px]"]
    .filter(Boolean)
    .join(" ");

  if (!inView) {
    return (
      <div ref={wrapperRef} className={containerClassName}>
        <div className="flex h-full items-center justify-center">
          <Space size={8}>
            <Spin size="small" />
            <Typography.Text type="secondary">
              {t("dashboard.charts.warMap.status.preparing", {
                defaultValue: "Preparing map…",
              })}
            </Typography.Text>
          </Space>
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className={containerClassName}>
      {errors.length > 0 && hasData ? (
        <div className="absolute left-4 right-4 top-4 z-20">
          <RequestErrorBanner
            error={errors[0]}
            showCachedDataHint
            actionLoading={refreshingMapData}
            onRetry={() => {
              void refreshMapData();
            }}
          />
        </div>
      ) : null}

      <div className="absolute left-4 top-4 z-10 flex flex-col gap-2">
        <Space size={6} wrap>
          <Tooltip
            title={
              streamMessageExact
                ? `${t("dashboard.charts.warMap.stats.streamMessage", {
                    defaultValue: "Stream message",
                  })}: ${streamMessageExact}`
                : (resolvedStreamState.error ?? undefined)
            }
          >
            <Tag color={streamStatusColor} className="text-xs">
              {streamStatusLabel}
            </Tag>
          </Tooltip>
          {streamMessageRelative ? (
            <Tooltip
              title={`${t("dashboard.charts.warMap.stats.streamMessage", {
                defaultValue: "Stream message",
              })}: ${streamMessageExact}`}
            >
              <Tag
                color={streamLagging ? "gold" : "default"}
                className="text-xs"
              >
                {t("dashboard.charts.warMap.stats.streamMessage", {
                  defaultValue: "Stream message",
                })}
                : {streamMessageRelative}
              </Tag>
            </Tooltip>
          ) : null}
          <Tooltip
            title={
              latestQueryUpdatedExact
                ? `${t("dashboard.charts.warMap.stats.dataUpdated", {
                    defaultValue: "Data updated",
                  })}: ${latestQueryUpdatedExact}`
                : undefined
            }
          >
            <Tag color={dataStatusColor} className="text-xs">
              {dataStatusLabel}
            </Tag>
          </Tooltip>
          <Tag color="default" className="text-xs">
            {t("dashboard.charts.warMap.stats.window", {
              defaultValue: "Window",
            })}
            : {windowLabel}
          </Tag>
          <Tag color="geekblue" className="text-xs">
            {t("dashboard.charts.warMap.stats.signals", {
              defaultValue: "Signals",
            })}
            : {rawEvents.length}
          </Tag>
          <Tag color="green" className="text-xs">
            {t("dashboard.charts.warMap.stats.news", { defaultValue: "News" })}:{" "}
            {rawNewsMarkers.length}
          </Tag>
          <Tag color="cyan" className="text-xs">
            {t("dashboard.charts.warMap.stats.monitors", {
              defaultValue: "Monitors",
            })}
            : {monitors.length}
          </Tag>
          <Tag color="purple" className="text-xs">
            {t("dashboard.charts.warMap.stats.visibleLayers", {
              defaultValue: "Visible layers",
            })}
            : {visibleLayerCount}
          </Tag>
          <Space size={4}>
            <Button
              size="small"
              type={flightMode === "military" ? "primary" : "default"}
              onClick={() => setFlightMode("military")}
            >
              {t("dashboard.charts.warMap.stats.flightModeMilitary", {
                defaultValue: "Military",
              })}
            </Button>
            <Button
              size="small"
              type={flightMode === "all" ? "primary" : "default"}
              onClick={() => setFlightMode("all")}
            >
              {t("dashboard.charts.warMap.stats.flightModeAll", {
                defaultValue: "All",
              })}
            </Button>
          </Space>
          {layerVisibility.ais ? (
            <Space size={4}>
              <Button
                size="small"
                type={aisMode === "military" ? "primary" : "default"}
                onClick={() => setAisMode("military")}
              >
                {t("dashboard.charts.warMap.stats.aisModeMilitary", {
                  defaultValue: "Military candidates",
                })}
              </Button>
              <Button
                size="small"
                type={aisMode === "density" ? "primary" : "default"}
                onClick={() => setAisMode("density")}
              >
                {t("dashboard.charts.warMap.stats.aisModeDensity", {
                  defaultValue: "Density only",
                })}
              </Button>
              <Tooltip
                title={aisAllModeDisabled ? aisAllModeDisabledLabel : null}
              >
                <Button
                  size="small"
                  type={aisMode === "all" ? "primary" : "default"}
                  disabled={aisAllModeDisabled}
                  onClick={() => setAisMode("all")}
                >
                  {t("dashboard.charts.warMap.stats.aisModeAll", {
                    defaultValue: "All vessels",
                  })}
                </Button>
              </Tooltip>
            </Space>
          ) : null}
          {layerVisibility.flights && flightsSourceBadgeLabel ? (
            <Tooltip
              title={
                flightsTooltipText ? (
                  <span className="whitespace-pre-line">
                    {flightsTooltipText}
                  </span>
                ) : null
              }
            >
              <Tag color="geekblue" className="text-xs">
                {flightsSourceBadgeLabel}
              </Tag>
            </Tooltip>
          ) : null}
          {layerVisibility.flights &&
          typeof flightsReturnedCount === "number" ? (
            <Tooltip
              title={
                flightsTooltipText ? (
                  <span className="whitespace-pre-line">
                    {flightsTooltipText}
                  </span>
                ) : null
              }
            >
              <Tag
                color={
                  flightsFreshness === "stale"
                    ? "orange"
                    : flightsFreshness === "zoom_required"
                      ? "purple"
                      : flightsFreshness === "not_configured"
                        ? "red"
                        : flightsFreshness === "missing"
                          ? "default"
                          : flightsTruncated
                            ? "gold"
                            : "cyan"
                }
                className="text-xs"
              >
                {t("dashboard.charts.warMap.stats.flights", {
                  defaultValue: "Flights",
                })}
                : {flightsReturnedCount}
                {typeof flightsSnapshotCount === "number"
                  ? `/${flightsSnapshotCount}`
                  : ""}
                {flightsRawLabel ? ` ${flightsRawLabel}` : ""}
              </Tag>
            </Tooltip>
          ) : null}
          {layerVisibility.ais ? (
            <Tooltip
              title={
                aisTooltipText ? (
                  <span className="whitespace-pre-line">{aisTooltipText}</span>
                ) : null
              }
            >
              <Tag color={aisSourceStatusColor} className="text-xs">
                {t("dashboard.charts.warMap.layerNames.ais", {
                  defaultValue: "AIS traffic",
                })}
                : {aisSourceStatusLabel}
              </Tag>
            </Tooltip>
          ) : null}
          {layerVisibility.ais ? (
            <Tooltip
              title={
                aisTooltipText ? (
                  <span className="whitespace-pre-line">{aisTooltipText}</span>
                ) : null
              }
            >
              <Tag color="cyan" className="text-xs">
                {aisModeLabel}
              </Tag>
            </Tooltip>
          ) : null}
          {layerVisibility.ais && typeof aisRelayVesselCount === "number" ? (
            <Tooltip
              title={
                aisTooltipText ? (
                  <span className="whitespace-pre-line">{aisTooltipText}</span>
                ) : null
              }
            >
              <Tag color="blue" className="text-xs">
                {t("dashboard.charts.warMap.stats.aisTrackedVessels", {
                  defaultValue: "Tracked vessels",
                })}
                : {aisRelayVesselCount}
              </Tag>
            </Tooltip>
          ) : null}
          {layerVisibility.ais && aisSnapshotRelative ? (
            <Tooltip
              title={
                aisSnapshotExact
                  ? `${t("dashboard.charts.warMap.stats.aisSnapshotUpdated", {
                      defaultValue: "AIS updated",
                    })}: ${aisSnapshotExact}`
                  : undefined
              }
            >
              <Tag
                color={aisFreshness === "stale" ? "gold" : "default"}
                className="text-xs"
              >
                {t("dashboard.charts.warMap.stats.aisSnapshotUpdated", {
                  defaultValue: "AIS updated",
                })}
                : {aisSnapshotRelative}
              </Tag>
            </Tooltip>
          ) : null}
          {layerVisibility.ais && typeof aisPrimaryCountValue === "number" ? (
            <Tooltip
              title={
                aisTooltipText ? (
                  <span className="whitespace-pre-line">{aisTooltipText}</span>
                ) : null
              }
            >
              <Tag color="geekblue" className="text-xs">
                {aisPrimaryCountLabel}: {aisPrimaryCountValue}
              </Tag>
            </Tooltip>
          ) : null}
          {layerVisibility.ais && typeof aisDisruptionsCount === "number" ? (
            <Tooltip
              title={
                aisTooltipText ? (
                  <span className="whitespace-pre-line">{aisTooltipText}</span>
                ) : null
              }
            >
              <Tag color="orange" className="text-xs">
                {t("dashboard.charts.warMap.stats.aisDisruptions", {
                  defaultValue: "Disruptions",
                })}
                : {aisDisruptionsCount}
              </Tag>
            </Tooltip>
          ) : null}
          {layerVisibility.ais && aisMode === "all" && aisAllModeDisabled ? (
            <Tooltip title={aisAllModeDisabledLabel}>
              <Tag color="magenta" className="text-xs">
                {t("dashboard.charts.warMap.stats.aisAllUnavailable", {
                  defaultValue: "All vessels unavailable",
                })}
              </Tag>
            </Tooltip>
          ) : null}
        </Space>
        <Space size={6} wrap>
          {detailedChainStatuses.map((status) => (
            <Tooltip key={status.key} title={status.tooltip}>
              <Tag color={status.color} className="text-xs">
                {status.text}
              </Tag>
            </Tooltip>
          ))}
        </Space>
        <Space size={6} wrap>
          {WAR_MAP_PRESETS.map((preset) => (
            <Button
              key={preset}
              size="small"
              type={activePreset === preset ? "primary" : "default"}
              onClick={() => setActivePreset(preset)}
            >
              {t(`dashboard.charts.warMap.presets.${preset}`, {
                defaultValue: PRESET_LABELS[preset],
              })}
            </Button>
          ))}
        </Space>
        <Space size={6} wrap>
          {WAR_MAP_TIME_RANGE_PRESETS.map((preset) => (
            <Button
              key={preset}
              size="small"
              type={timeRangePreset === preset ? "primary" : "default"}
              onClick={() => setTimeRangePreset(preset)}
            >
              {t(`dashboard.charts.warMap.timeRange.${preset}`, {
                defaultValue: TIME_RANGE_LABELS[preset],
              })}
            </Button>
          ))}
        </Space>
      </div>

      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <Button
          size="small"
          type="default"
          loading={refreshingMapData}
          onClick={() => {
            void refreshMapData();
          }}
        >
          {t("dashboard.actions.fetchLatest", { defaultValue: "Refresh" })}
        </Button>
        <Popover
          content={layerSelector}
          title={t("dashboard.charts.warMap.layers", {
            defaultValue: "Layers",
          })}
          trigger="click"
          placement="bottomRight"
        >
          <Button size="small" type="default" icon={<SettingOutlined />} />
        </Popover>
      </div>

      <div
        ref={mapContainerRef}
        className="h-full w-full overflow-hidden rounded-lg"
      />

      <div className="pointer-events-none absolute bottom-4 left-4 z-10 max-w-sm rounded-xl border border-slate-200/80 bg-white/90 px-3 py-3 shadow-lg backdrop-blur">
        <Space direction="vertical" size={4}>
          <Typography.Text
            strong
            className="text-xs uppercase tracking-[0.18em] text-slate-500"
          >
            {t("dashboard.charts.warMap.legend.title", {
              defaultValue: "Legend",
            })}
          </Typography.Text>
          <Space size={[6, 6]} wrap>
            <Tag color="red">
              {t("dashboard.charts.warMap.stats.high", {
                defaultValue: "High",
              })}
            </Tag>
            <Tag color="gold">
              {t("dashboard.charts.warMap.stats.medium", {
                defaultValue: "Medium",
              })}
            </Tag>
            <Tag color="blue">
              {t("dashboard.charts.warMap.stats.low", { defaultValue: "Low" })}
            </Tag>
          </Space>
          <Space size={[6, 6]} wrap>
            <Tag color="green">
              {t("dashboard.charts.warMap.stats.geocoded", {
                defaultValue: "Geocoded news",
              })}
            </Tag>
            <Tag color="cyan">
              {t("dashboard.charts.warMap.stats.fallbackCountry", {
                defaultValue: "Fallback country",
              })}
            </Tag>
            <Tag color="purple">
              {t("dashboard.charts.warMap.stats.monitors", {
                defaultValue: "Monitors",
              })}
            </Tag>
          </Space>
          {layerVisibility.ais ? (
            <Space direction="vertical" size={4}>
              <Typography.Text
                strong
                className="text-[11px] uppercase tracking-[0.16em] text-slate-500"
              >
                {t("dashboard.charts.warMap.legend.aisTitle", {
                  defaultValue: "AIS",
                })}
              </Typography.Text>
              <Space size={[6, 6]} wrap>
                {[
                  {
                    key: "military",
                    color: "rgb(220 38 38)",
                    label: t("dashboard.charts.warMap.legend.aisMilitary", {
                      defaultValue: "Military / government",
                    }),
                  },
                  {
                    key: "fishing",
                    color: "rgb(34 197 94)",
                    label: t("dashboard.charts.warMap.legend.aisFishing", {
                      defaultValue: "Fishing",
                    }),
                  },
                  {
                    key: "passenger",
                    color: "rgb(59 130 246)",
                    label: t("dashboard.charts.warMap.legend.aisPassenger", {
                      defaultValue: "Passenger",
                    }),
                  },
                  {
                    key: "cargo",
                    color: "rgb(148 163 184)",
                    label: t("dashboard.charts.warMap.legend.aisCargo", {
                      defaultValue: "Cargo",
                    }),
                  },
                  {
                    key: "tanker",
                    color: "rgb(249 115 22)",
                    label: t("dashboard.charts.warMap.legend.aisTanker", {
                      defaultValue: "Tanker",
                    }),
                  },
                  {
                    key: "other",
                    color: "rgb(248 250 252)",
                    label: t("dashboard.charts.warMap.legend.aisOther", {
                      defaultValue: "Other",
                    }),
                  },
                ].map((item) => (
                  <span
                    key={item.key}
                    className="inline-flex items-center gap-1 rounded-full border border-slate-200/80 bg-white/85 px-2 py-1 text-[11px] text-slate-700"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full border border-slate-300/80"
                      style={{ backgroundColor: item.color }}
                    />
                    <span>{item.label}</span>
                  </span>
                ))}
              </Space>
              <Space size={[6, 6]} wrap>
                {[
                  {
                    key: "density",
                    color:
                      "linear-gradient(90deg, rgb(147 197 253), rgb(185 28 28))",
                    label: t("dashboard.charts.warMap.legend.aisDensity", {
                      defaultValue: "Traffic density heatmap",
                    }),
                    gradient: true,
                  },
                  {
                    key: "disruption",
                    color: "rgb(220 38 38)",
                    label: t("dashboard.charts.warMap.legend.aisDisruption", {
                      defaultValue: "Chokepoint disruption",
                    }),
                  },
                ].map((item) => (
                  <span
                    key={item.key}
                    className="inline-flex items-center gap-1 rounded-full border border-slate-200/80 bg-white/85 px-2 py-1 text-[11px] text-slate-700"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full border border-slate-300/80"
                      style={
                        item.gradient
                          ? { backgroundImage: item.color }
                          : { backgroundColor: item.color }
                      }
                    />
                    <span>{item.label}</span>
                  </span>
                ))}
              </Space>
            </Space>
          ) : null}
          <Typography.Text type="secondary" className="text-xs">
            {t("dashboard.charts.warMap.legend.radius", {
              defaultValue:
                "Larger points indicate stronger aggregated signal density.",
            })}
          </Typography.Text>
        </Space>
      </div>

      {useDesktopInspector && inspectorPanelContent ? (
        <div className="absolute bottom-4 right-4 top-16 z-20 hidden w-[360px] lg:block">
          {inspectorPanelContent}
        </div>
      ) : null}

      {!useDesktopInspector ? (
        <Drawer
          open={Boolean(inspectorPanelContent)}
          onClose={closeSelectedInspector}
          placement="right"
          width="100%"
          destroyOnClose={false}
          title={null}
        >
          {inspectorPanelContent}
        </Drawer>
      ) : null}

      {showBootOverlay ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-xl border border-slate-200/80 bg-white/92 px-4 py-3 shadow-lg backdrop-blur">
            <Space size={10}>
              <Spin size="small" />
              <Typography.Text>{bootOverlayLabel}</Typography.Text>
            </Space>
          </div>
        </div>
      ) : null}

      {!anyLoading && errors.length > 0 && !hasData ? (
        <div className="absolute inset-0">
          <ChartEmptyState
            variant="error"
            title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
            description={
              getErrorMessage(errors[0]) ??
              t("common.serviceUnavailable", {
                defaultValue: "Service is unavailable. Please try again.",
              })
            }
            actionLabel={t("dashboard.actions.retryFetch", {
              defaultValue: "Retry fetch",
            })}
            actionLoading={refreshingMapData}
            onAction={() => {
              void refreshMapData();
            }}
          />
        </div>
      ) : null}

      {!anyLoading && !errors.length && !hasData && mapReady ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <ChartEmptyState
            description={t("pages.map.empty", {
              defaultValue:
                "No alerts or geo-tagged news signals in the selected range.",
            })}
          />
        </div>
      ) : null}

      {mapLoadError ? (
        <div className="absolute inset-0">
          <ChartEmptyState
            variant="error"
            title={mapLoadError.title}
            description={mapLoadError.description}
            actionLabel={t("common.retry", { defaultValue: "Retry" })}
            onAction={retryMapLoad}
          />
        </div>
      ) : null}
    </div>
  );
}
