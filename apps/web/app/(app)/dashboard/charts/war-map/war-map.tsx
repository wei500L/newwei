"use client";

import { useQuery } from "@tanstack/react-query";
import {
  IconLayer,
  PathLayer,
  PolygonLayer,
  ScatterplotLayer,
} from "@deck.gl/layers";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import {
  type WarMapAisMode,
  type WarMapEventSeverity,
  type WarMapFlightMode,
  type WarMapLayerFeature,
  type WarMapLayerId,
  type WarMapNewsGeoSource,
  type WarMapPreset,
  type WarMapTransportDetailResponse,
  type WarMapTimeRangePreset,
  type WarMapTranslateTarget,
  WAR_MAP_LAYER_IDS,
  WAR_MAP_PRESETS,
  WAR_MAP_TIME_RANGE_PRESETS,
} from "@modular/utils";
import { Checkbox, Drawer, Grid, Space, Spin, Typography } from "antd";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useSession } from "next-auth/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import {
  GeoTransportKind,
  useRequestGeoTransportMutation,
} from "@/graphql/generated";
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
import { WarMapControlsPanel } from "./war-map-controls-panel";
import {
  OVERLAY_SURFACE_CLASS_NAME,
  buildWarMapOverlayLayout,
  buildWarMapOverlayViewModel,
  resolveOverlayDensity,
  type OverlayControlsSection,
  type OverlayPanelKey,
  type RenderableWarMapEvent,
  type RenderableWarMapNewsMarker,
  type RenderableWarMapTransportSelection,
  type SelectedInspector,
  type WarMapSelectableOption,
} from "./war-map-overlay-model";
import { WarMapInspectorPanel } from "./war-map-inspector-panel";
import { WarMapOverlayRail } from "./war-map-overlay-rail";
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

export interface WarMapProps {
  className?: string;
  translateTarget?: WarMapTranslateTarget;
  streamState?: DashboardStreamState;
  onEffectiveRangeChange?: (range: { start: Date; end: Date }) => void;
  onRealtimeQueryChange?: (query: {
    start: Date;
    end: Date;
    bbox?: string;
    zoom?: number;
    translateTarget?: WarMapTranslateTarget;
    flightMode?: WarMapFlightMode;
    aisMode?: WarMapAisMode;
  }) => void;
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
const TRANSPORT_ICON_SIZE = 128;

function toSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const AIRCRAFT_ICON = {
  url: toSvgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
      <path fill="#0f172a" d="M64 6c4 0 7 3 7 7v24l33 16c5 3 7 10 4 15l-3 5-34-8v23l13 10v10l-20-5-20 5V98l13-10V65L23 73l-3-5c-3-5-1-12 4-15l33-16V13c0-4 3-7 7-7Z"/>
    </svg>
  `),
  width: TRANSPORT_ICON_SIZE,
  height: TRANSPORT_ICON_SIZE,
  anchorX: TRANSPORT_ICON_SIZE / 2,
  anchorY: TRANSPORT_ICON_SIZE / 2,
  mask: true,
} as const;

const VESSEL_ICON = {
  url: toSvgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
      <path fill="#0f172a" d="M64 10 83 34h-9v22h20l18 34-17 18H33L16 90l18-34h20V34h-9L64 10Zm-18 58-8 15h52l-8-15H46Zm-1 25 5 7h28l5-7H45Z"/>
    </svg>
  `),
  width: TRANSPORT_ICON_SIZE,
  height: TRANSPORT_ICON_SIZE,
  anchorX: TRANSPORT_ICON_SIZE / 2,
  anchorY: TRANSPORT_ICON_SIZE / 2,
  mask: true,
} as const;

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

function hasFiniteAngle(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function resolveAircraftIconAngle(point: DeckPoint): number | null {
  return hasFiniteAngle(point.heading) ? point.heading : null;
}

function resolveVesselIconAngle(point: DeckPoint): number | null {
  if (hasFiniteAngle(point.course)) {
    return point.course;
  }
  return hasFiniteAngle(point.heading) ? point.heading : null;
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

function readFlightBudgetSummary(summary: Record<string, unknown> | undefined) {
  const degradationLevel = readSummaryString(summary, "degradationLevel");
  return {
    remainingCredits: readSummaryNumber(summary, "remainingCredits"),
    dailyBudget: readSummaryNumber(summary, "dailyBudget"),
    dateHkt: readSummaryString(summary, "dateHkt"),
    statusReasonCode: readSummaryString(summary, "statusReasonCode"),
    statusReason: readSummaryString(summary, "statusReason"),
    degradationLevel:
      degradationLevel === "normal" ||
      degradationLevel === "warning" ||
      degradationLevel === "critical" ||
      degradationLevel === "exhausted"
        ? degradationLevel
        : undefined,
  };
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

function toTransportSelectionKey(
  kind: "aircraft" | "vessel",
  objectKey: string,
): string {
  return `transport:${kind}:${objectKey}`;
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
  onRealtimeQueryChange,
}: WarMapProps = {}) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const screens = Grid.useBreakpoint();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canRunAnalysis = permissions.includes("analysis.run");
  const [requestGeoTransport, { loading: submittingGeoTransport }] =
    useRequestGeoTransportMutation();

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);
  const overlayRailRef = useRef<HTMLDivElement | null>(null);
  const syncFromMapRef = useRef(false);
  const hasHydratedUrlRef = useRef(false);

  const [inView, setInView] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapLoadError, setMapLoadError] =
    useState<MapLoadErrorPresentation | null>(null);
  const [mapMountNonce, setMapMountNonce] = useState(0);
  const [rangeAnchorMs, setRangeAnchorMs] = useState(() => Date.now());
  const hasActivatedRangeAnchorRef = useRef(false);
  const [wrapperSize, setWrapperSize] = useState({ width: 0, height: 0 });
  const [openOverlayPanel, setOpenOverlayPanel] =
    useState<OverlayPanelKey | null>(null);
  const [controlsSection, setControlsSection] =
    useState<OverlayControlsSection>("view");
  const [desktopInspectorMinimized, setDesktopInspectorMinimized] =
    useState(false);
  const [selectedInspectorKey, setSelectedInspectorKey] = useState<
    string | null
  >(null);
  const [urlHydrated, setUrlHydrated] = useState(
    () => typeof window === "undefined",
  );
  const hasRenderableMapContainer = useRenderableContainer(
    mapContainerRef,
    inView,
  );
  const overlayDensity = useMemo(
    () => resolveOverlayDensity(wrapperSize.width, wrapperSize.height),
    [wrapperSize.height, wrapperSize.width],
  );
  const useDrawerControls = overlayDensity === "minimal";
  const useDesktopInspector = Boolean(
    screens.lg && overlayDensity !== "minimal",
  );

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
  const initialUrlState = useMemo(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return readWarMapUrlState(new URLSearchParams(window.location.search));
  }, []);
  const effectiveViewState = useMemo(
    () =>
      !urlHydrated && initialUrlState?.viewState
        ? {
            ...viewState,
            ...initialUrlState.viewState,
            bearing: 0,
            pitch: 0,
          }
        : viewState,
    [initialUrlState?.viewState, urlHydrated, viewState],
  );
  const effectiveTimeRangePreset =
    !urlHydrated && initialUrlState?.timeRangePreset
      ? initialUrlState.timeRangePreset
      : timeRangePreset;
  const [queryViewport, setQueryViewport] = useState<{
    bbox?: [number, number, number, number];
    zoom: number;
  }>(() => ({
    zoom: Number(effectiveViewState.zoom.toFixed(2)),
  }));

  useEffect(() => {
    viewStateRef.current = effectiveViewState;
  }, [effectiveViewState]);

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

  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) {
      return;
    }

    const updateSize = () => {
      const nextWidth = root.clientWidth;
      const nextHeight = root.clientHeight;
      setWrapperSize((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight },
      );
    };

    updateSize();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      updateSize();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const dataEnabled = Boolean(session?.accessToken && inView && urlHydrated);
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

    if (!hasActivatedRangeAnchorRef.current) {
      hasActivatedRangeAnchorRef.current = true;
      return;
    }

    refreshRangeAnchor();
  }, [effectiveTimeRangePreset, inView, refreshRangeAnchor]);

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
    if (effectiveTimeRangePreset === "all") {
      return { start: ALL_TIME_START, end };
    }
    const duration = TIME_RANGE_MS[effectiveTimeRangePreset];
    return {
      end,
      start: new Date(end.getTime() - duration),
    };
  }, [effectiveTimeRangePreset, rangeAnchorMs]);

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

  useEffect(() => {
    if (!onRealtimeQueryChange) {
      return;
    }
    onRealtimeQueryChange({
      start: effectiveRange.start,
      end: effectiveRange.end,
      bbox: queryBbox,
      zoom: queryZoom,
      translateTarget,
      flightMode,
      aisMode,
    });
  }, [
    aisMode,
    effectiveRange.end,
    effectiveRange.start,
    flightMode,
    onRealtimeQueryChange,
    queryBbox,
    queryZoom,
    translateTarget,
  ]);

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
    warMapStart: effectiveRange.start,
    warMapEnd: effectiveRange.end,
    warMapBBox: queryBbox,
    warMapZoom: queryZoom,
    warMapTranslateTarget: translateTarget,
    warMapFlightMode: flightMode,
    warMapAisMode: aisMode,
    enabled: !streamState && dataEnabled,
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
      Math.abs(center.lat - effectiveViewState.lat) > 0.0005 ||
      Math.abs(center.lng - effectiveViewState.lon) > 0.0005 ||
      Math.abs(map.getZoom() - effectiveViewState.zoom) > 0.02 ||
      Math.abs(map.getBearing() - effectiveViewState.bearing) > 0.1 ||
      Math.abs(map.getPitch() - effectiveViewState.pitch) > 0.1;

    if (!changed) {
      return;
    }

    map.easeTo({
      center: [effectiveViewState.lon, effectiveViewState.lat],
      zoom: effectiveViewState.zoom,
      bearing: effectiveViewState.bearing,
      pitch: effectiveViewState.pitch,
      duration: 450,
      essential: true,
    });
  }, [effectiveViewState, mapReady]);

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

    const parsed =
      initialUrlState ??
      readWarMapUrlState(new URLSearchParams(window.location.search));
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
    setUrlHydrated(true);
  }, [
    initialUrlState,
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

  const transportSelections = useMemo<
    Array<
      RenderableWarMapTransportSelection & {
        lat: number;
        lng: number;
        selectionKey: string;
      }
    >
  >(() => {
    const selections: Array<
      RenderableWarMapTransportSelection & {
        lat: number;
        lng: number;
        selectionKey: string;
      }
    > = [];
    const layers = layersQuery.data?.layers ?? {};

    const flightsDataset = layers.flights;
    if (flightsDataset?.geometryType === "point") {
      for (const feature of flightsDataset.features) {
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
        const flight = readWarMapFlightProperties(properties);
        if (!flight) {
          continue;
        }
        const objectKey = `opensky:${flight.icao24}`;
        selections.push({
          objectKey,
          transportKind: "aircraft",
          label: getWarMapFlightLabel(
            flight,
            flight.icao24.toUpperCase(),
          ),
          subtitle:
            flight.displayCategoryZh ??
            flight.displayCategory ??
            flight.roleZh ??
            flight.role,
          latestAt: flight.observedAt,
          sourceUpdatedAt: flight.sourceUpdatedAt,
          callsign: flight.callsign,
          icao24: flight.icao24,
          registration: flight.registration,
          aircraftType: flight.aircraftType,
          displayCategory: flight.displayCategory,
          displayCategoryZh: flight.displayCategoryZh,
          role: flight.role,
          roleZh: flight.roleZh,
          countryCode: flight.countryCode,
          countryName: flight.countryName,
          heading: flight.heading,
          altitudeFt: flight.altitudeFt,
          groundSpeedKt: flight.groundSpeedKt,
          lat: feature.lat,
          lng: feature.lng,
          selectionKey: toTransportSelectionKey("aircraft", objectKey),
        });
      }
    }

    const aisDataset = layers.ais;
    if (aisDataset?.geometryType === "point") {
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
        const ais = readWarMapAisProperties(properties);
        if (!ais || ais.featureKind !== "vessel") {
          continue;
        }
        const objectKey = `ais:${ais.mmsi}`;
        selections.push({
          objectKey,
          transportKind: "vessel",
          label: getWarMapAisLabel(ais, `MMSI ${ais.mmsi}`),
          subtitle:
            ais.vesselRoleZh ??
            ais.vesselRole ??
            ais.shipTypeLabelZh ??
            ais.shipTypeLabel,
          latestAt: ais.observedAt,
          sourceUpdatedAt: ais.sourceUpdatedAt,
          name: ais.name,
          mmsi: ais.mmsi,
          shipType: ais.shipType,
          shipTypeLabel: ais.shipTypeLabel,
          shipTypeLabelZh: ais.shipTypeLabelZh,
          vesselRole: ais.vesselRole,
          vesselRoleZh: ais.vesselRoleZh,
          heading: ais.heading,
          speed: ais.speed,
          course: ais.course,
          isMilitaryCandidate: ais.isMilitaryCandidate,
          lat: feature.lat,
          lng: feature.lng,
          selectionKey: toTransportSelectionKey("vessel", objectKey),
        });
      }
    }

    return selections;
  }, [layersQuery.data?.layers]);

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

    const transport = transportSelections.find(
      (entry) => entry.selectionKey === selectedInspectorKey,
    );
    if (transport) {
      return {
        key: selectedInspectorKey,
        kind: transport.transportKind === "aircraft" ? "flight" : "vessel",
        lat: transport.lat,
        lng: transport.lng,
        zoomTarget: 8,
        item: transport,
      };
    }

    return null;
  }, [
    clusteredEvents.clusters,
    clusteredNews.clusters,
    rawEvents,
    rawNewsMarkers,
    transportSelections,
    selectedInspectorKey,
  ]);

  useEffect(() => {
    if (selectedInspectorKey && !selectedInspector) {
      setSelectedInspectorKey(null);
    }
  }, [selectedInspector, selectedInspectorKey]);

  const selectedTransport = useMemo(() => {
    if (
      !selectedInspector ||
      (selectedInspector.kind !== "flight" && selectedInspector.kind !== "vessel")
    ) {
      return null;
    }
    return {
      kind:
        selectedInspector.kind === "flight"
          ? ("aircraft" as const)
          : ("vessel" as const),
      objectKey: selectedInspector.item.objectKey,
    };
  }, [selectedInspector]);

  const transportDetailQuery = useQuery({
    queryKey: [
      "dashboard",
      "war-map",
      "transport-detail",
      selectedTransport?.kind ?? null,
      selectedTransport?.objectKey ?? null,
      effectiveRange.start.toISOString(),
      effectiveRange.end.toISOString(),
    ],
    queryFn: async () => {
      if (!selectedTransport) {
        return { detail: null } satisfies WarMapTransportDetailResponse;
      }
      const response = await apiClient.get<WarMapTransportDetailResponse>(
        "dashboard/war-map/transport-detail",
        {
          params: {
            kind: selectedTransport.kind,
            objectKey: selectedTransport.objectKey,
            start: effectiveRange.start.toISOString(),
            end: effectiveRange.end.toISOString(),
            limit: "20",
          },
        },
      );
      return response.data;
    },
    enabled: Boolean(selectedTransport),
    staleTime: 15_000,
  });

  const handleAnalyzeCurrentView = useCallback(async () => {
    if (!canRunAnalysis) {
      toast.warning(
        t("analysis.runPermissionRequired", {
          defaultValue: "You do not have permission to run analyses.",
        }),
      );
      return;
    }

    const transportKinds: GeoTransportKind[] = [
      ...(layerVisibility.flights ? [GeoTransportKind.Aircraft] : []),
      ...(layerVisibility.ais ? [GeoTransportKind.Vessel] : []),
    ];
    if (transportKinds.length === 0) {
      toast.warning(
        t("dashboard.charts.warMap.actions.enableTransportLayers", {
          defaultValue:
            "Enable the flight or AIS layer before requesting transport analysis.",
        }),
      );
      return;
    }

    try {
      await requestGeoTransport({
        variables: {
          input: {
            transportKinds,
            startDate: effectiveRange.start.toISOString(),
            endDate: effectiveRange.end.toISOString(),
            ...(queryViewport.bbox ? { bbox: queryViewport.bbox } : {}),
          },
        },
      });
      toast.success(
        t("dashboard.charts.warMap.actions.analyzeCurrentViewSubmitted", {
          defaultValue: "Transport analysis submitted for the current view.",
        }),
      );
    } catch (error) {
      toast.error(
        t("dashboard.charts.warMap.actions.analyzeCurrentViewFailed", {
          defaultValue: "Failed to submit transport analysis.",
        }),
      );
      captureClientError(
        "Failed to submit transport analysis.",
        error,
        {
          tags: {
            context: "war-map-geo-transport-analysis",
          },
        },
      );
    }
  }, [
    canRunAnalysis,
    effectiveRange.end,
    effectiveRange.start,
    layerVisibility.ais,
    layerVisibility.flights,
    queryViewport.bbox,
    requestGeoTransport,
    t,
  ]);

  const closeSelectedInspector = useCallback(() => {
    setDesktopInspectorMinimized(false);
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

  useEffect(() => {
    if (selectedInspector) {
      setOpenOverlayPanel(null);
    }
    setDesktopInspectorMinimized(false);
  }, [selectedInspector?.key]);

  useEffect(() => {
    if (
      !openOverlayPanel ||
      useDrawerControls ||
      typeof document === "undefined"
    ) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (overlayRailRef.current?.contains(target)) {
        return;
      }
      setOpenOverlayPanel(null);
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [openOverlayPanel, useDrawerControls]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (openOverlayPanel) {
        setOpenOverlayPanel(null);
        return;
      }
      if (
        useDesktopInspector &&
        selectedInspector &&
        !desktopInspectorMinimized
      ) {
        closeSelectedInspector();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    closeSelectedInspector,
    desktopInspectorMinimized,
    openOverlayPanel,
    selectedInspector,
    useDesktopInspector,
  ]);

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

  const staticDeckData = useMemo(() => {
    const layersData = layersQuery.data?.layers ?? {};

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
                  selectionKey: toTransportSelectionKey(
                    "aircraft",
                    `opensky:${flight.icao24}`,
                  ),
                  sourceType: flight.sourceType,
                  callsign: flight.callsign,
                  icao24: flight.icao24,
                  registration: flight.registration,
                  aircraftType: flight.aircraftType,
                  displayCategory: flight.displayCategory,
                  displayCategoryZh: flight.displayCategoryZh,
                  role: flight.role,
                  roleZh: flight.roleZh,
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

      if (pointSingles.length > 0 && layerId === "flights") {
        const orientedFlightPoints = pointSingles.filter(
          (point) => resolveAircraftIconAngle(point) !== null,
        );
        const fallbackFlightPoints = pointSingles.filter(
          (point) => resolveAircraftIconAngle(point) === null,
        );

        if (orientedFlightPoints.length > 0) {
          staticLayers.push(
            new IconLayer({
              id: `wm-point-${layerId}-icons`,
              data: orientedFlightPoints,
              pickable: Boolean(dataset.renderHints?.pickable ?? true),
              billboard: true,
              sizeUnits: "pixels",
              getIcon: () => AIRCRAFT_ICON,
              getPosition: (point: DeckPoint) => [point.lng, point.lat],
              getColor: (point: DeckPoint) => point.color,
              getAngle: (point: DeckPoint) =>
                resolveAircraftIconAngle(point) ?? 0,
              getSize: (point: DeckPoint) => Math.max(20, point.radius * 3.4),
              sizeMinPixels: 18,
              sizeMaxPixels: 42,
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

        if (fallbackFlightPoints.length > 0) {
          staticLayers.push(
            new ScatterplotLayer({
              id: `wm-point-${layerId}-fallback`,
              data: fallbackFlightPoints,
              pickable: Boolean(dataset.renderHints?.pickable ?? true),
              getPosition: (point: DeckPoint) => [point.lng, point.lat],
              getFillColor: (point: DeckPoint) => point.color,
              getRadius: (point: DeckPoint) => point.radius,
              radiusMinPixels: 3,
              radiusMaxPixels: 30,
              stroked: false,
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
      } else if (pointSingles.length > 0) {
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
          const objectKey = `ais:${aisProperties.mmsi}`;
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
            selectionKey: toTransportSelectionKey("vessel", objectKey),
            mmsi: aisProperties.mmsi,
            shipType: aisProperties.shipType,
            shipTypeLabel: aisProperties.shipTypeLabel,
            shipTypeLabelZh: aisProperties.shipTypeLabelZh,
            vesselRole: aisProperties.vesselRole,
            vesselRoleZh: aisProperties.vesselRoleZh,
            isMilitaryCandidate: aisProperties.isMilitaryCandidate,
            heading: aisProperties.heading,
            speed: aisProperties.speed,
            course: aisProperties.course,
            latestAt: aisProperties.observedAt,
            sourceUpdatedAt: aisProperties.sourceUpdatedAt ?? aisDataset.updatedAt,
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
          new ScatterplotLayer({
            id: "wm-ais-density-glow",
            data: aisDensityZones,
            pickable: false,
            stroked: false,
            filled: true,
            getPosition: (point: DeckPoint) => [point.lng, point.lat],
            getFillColor: (point: DeckPoint) =>
              getAisDensityColor(
                point.intensity ?? 0.2,
                0.1 + (point.intensity ?? 0.2) * 0.18,
              ),
            getRadius: (point: DeckPoint) => point.radius * 2.6,
            radiusMinPixels: 22,
            radiusMaxPixels: 76,
          }),
        );
        aisLayers.push(
          new ScatterplotLayer({
            id: "wm-ais-density-core",
            data: aisDensityZones,
            pickable: false,
            stroked: false,
            filled: true,
            getPosition: (point: DeckPoint) => [point.lng, point.lat],
            getFillColor: (point: DeckPoint) =>
              getAisDensityColor(
                point.intensity ?? 0.2,
                0.22 + (point.intensity ?? 0.2) * 0.2,
              ),
            getRadius: (point: DeckPoint) => point.radius * 1.6,
            radiusMinPixels: 14,
            radiusMaxPixels: 48,
          }),
        );
        aisLayers.push(
          new ScatterplotLayer({
            id: "wm-ais-density-zones",
            data: aisDensityZones,
            pickable: true,
            stroked: false,
            filled: true,
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
        const orientedAisVessels = aisVessels.filter(
          (point) => resolveVesselIconAngle(point) !== null,
        );
        const fallbackAisVessels = aisVessels.filter(
          (point) => resolveVesselIconAngle(point) === null,
        );

        if (orientedAisVessels.length > 0) {
          aisLayers.push(
            new IconLayer({
              id: "wm-ais-vessels-icons",
              data: orientedAisVessels,
              pickable: true,
              billboard: true,
              sizeUnits: "pixels",
              getIcon: () => VESSEL_ICON,
              getPosition: (point: DeckPoint) => [point.lng, point.lat],
              getColor: (point: DeckPoint) => point.color,
              getAngle: (point: DeckPoint) => resolveVesselIconAngle(point) ?? 0,
              getSize: (point: DeckPoint) => Math.max(18, point.radius * 3.1),
              sizeMinPixels: 16,
              sizeMaxPixels: 34,
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

        if (fallbackAisVessels.length > 0) {
          aisLayers.push(
            new ScatterplotLayer({
              id: "wm-ais-vessels-fallback",
              data: fallbackAisVessels,
              pickable: true,
              stroked: true,
              getLineColor: [15, 23, 42, 180],
              lineWidthMinPixels: 1,
              getFillColor: (point: DeckPoint) => point.color,
              getRadius: (point: DeckPoint) => point.radius,
              radiusMinPixels: 3,
              radiusMaxPixels: 14,
              getPosition: (point: DeckPoint) => [point.lng, point.lat],
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
      }
    }

    return {
      deckLayers: [...staticLayers, ...aisLayers],
      staticVisibleCount: staticLayers.length + aisLayers.length,
      aisFeatureCount,
    };
  }, [
    layerVisibility,
    layersQuery.data?.layers,
    localClusterBbox,
    queryZoom,
    t,
    aisMode,
    flightMode,
    translateTarget,
    zoomToLayerCluster,
  ]);

  const monitorDeckLayers = useMemo(() => {
    if (!layerVisibility.monitors || monitorPoints.length === 0) {
      return [];
    }

    return [
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
    ];
  }, [layerVisibility.monitors, monitorPoints, t]);

  const eventDeckData = useMemo(() => {
    const eventPoints: DeckPoint[] = [];
    for (const event of clusteredEvents.singles) {
      const score =
        typeof event.derivedScore === "number"
          ? event.derivedScore
          : (event.value ?? 0);
      eventPoints.push({
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
      });
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

    const deckLayers: any[] = [];

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

    return {
      deckLayers,
      eventsCount: rawEvents.length,
      eventClustersCount: eventClusters.length,
    };
  }, [clusteredEvents.clusters, clusteredEvents.singles, rawEvents.length, t]);

  const newsDeckData = useMemo(() => {
    const newsPoints: DeckPoint[] = [];
    for (const marker of clusteredNews.singles) {
      const baseColor =
        marker.geoSource === "fallback-country" ? [8, 145, 178] : [5, 150, 105];
      const [baseR = 8, baseG = 145, baseB = 178] = baseColor;
      newsPoints.push({
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
      });
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

    const deckLayers: any[] = [];

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
            if (!object || object.isCluster || !object.selectionKey) {
              return;
            }
            setSelectedInspectorKey(object.selectionKey);
          },
        }),
      );
    }

    return {
      deckLayers,
      newsCount: rawNewsMarkers.length,
      newsClustersCount: newsClusters.length,
    };
  }, [clusteredNews.clusters, clusteredNews.singles, rawNewsMarkers.length, t]);

  const deckData = useMemo(
    () => ({
      deckLayers: [
        ...staticDeckData.deckLayers,
        ...monitorDeckLayers,
        ...eventDeckData.deckLayers,
        ...newsDeckData.deckLayers,
      ],
      eventsCount: eventDeckData.eventsCount,
      eventClustersCount: eventDeckData.eventClustersCount,
      newsCount: newsDeckData.newsCount,
      newsClustersCount: newsDeckData.newsClustersCount,
      staticVisibleCount: staticDeckData.staticVisibleCount,
      aisFeatureCount: staticDeckData.aisFeatureCount,
    }),
    [eventDeckData, monitorDeckLayers, newsDeckData, staticDeckData],
  );

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
            if (object.shipTypeLabelZh || object.shipTypeLabel) {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.shipType", {
                  defaultValue: "Ship type",
                })}: ${object.shipTypeLabelZh ?? object.shipTypeLabel}`,
              );
            } else if (typeof object.shipType === "number") {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.shipType", {
                  defaultValue: "Ship type",
                })}: ${formatAisShipTypeLabel(object.shipType)}`,
              );
            }
            if (object.vesselRoleZh || object.vesselRole) {
              lines.push(
                `${t("dashboard.charts.warMap.tooltip.type", {
                  defaultValue: "Type",
                })}: ${object.vesselRoleZh ?? object.vesselRole}`,
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
          if (object.displayCategoryZh || object.displayCategory) {
            lines.push(
              `${t("dashboard.charts.warMap.tooltip.type", {
                defaultValue: "Type",
              })}: ${object.displayCategoryZh ?? object.displayCategory}`,
            );
          }
          if (object.roleZh || object.role) {
            lines.push(
              `${t("dashboard.charts.warMap.tooltip.role", {
                defaultValue: "Role",
              })}: ${object.roleZh ?? object.role}`,
            );
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
  const flightsBudget = readFlightBudgetSummary(flightsSummary);
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
  const flightsBudgetReason =
    flightsFreshness === "budget_limited"
      ? flightsBudget.statusReasonCode === "opensky_budget_critical"
        ? t("dashboard.charts.warMap.stats.flightBudgetLimitedCritical", {
            defaultValue:
              "OpenSky all-flight mode is limited and military polling is using the night interval to preserve daily credits.",
          })
        : flightsBudget.statusReasonCode === "opensky_budget_exhausted"
          ? t("dashboard.charts.warMap.stats.flightBudgetLimitedExhausted", {
              defaultValue:
                "OpenSky daily credit budget is exhausted. All-flight mode is paused until the next HKT day begins.",
            })
          : flightsBudget.statusReasonCode ===
              "opensky_budget_insufficient_credits"
            ? t(
                "dashboard.charts.warMap.stats.flightBudgetLimitedInsufficient",
                {
                  defaultValue:
                    "OpenSky does not have enough remaining daily credits for this viewport request.",
                },
              )
            : t("dashboard.charts.warMap.stats.flightBudgetLimited", {
                defaultValue:
                  "OpenSky all-flight mode is temporarily limited to preserve the daily credit budget.",
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
      : flightsFreshness === "budget_limited"
        ? flightsBudgetReason
        : null,
    flightsFreshness === "budget_limited" &&
    typeof flightsBudget.remainingCredits === "number" &&
    typeof flightsBudget.dailyBudget === "number"
      ? t("dashboard.charts.warMap.stats.flightBudgetRemaining", {
          defaultValue: "Remaining {{remaining}} / {{budget}} credits",
          remaining: flightsBudget.remainingCredits,
          budget: flightsBudget.dailyBudget,
        })
      : null,
    flightsFreshness === "budget_limited" && flightsBudget.dateHkt
      ? t("dashboard.charts.warMap.stats.flightBudgetReset", {
          defaultValue: "Budget day {{date}} HKT. Resets at 00:00 HKT.",
          date: flightsBudget.dateHkt,
        })
      : null,
    flightsFreshness === "budget_limited" && flightsBudget.degradationLevel
      ? t("dashboard.charts.warMap.stats.flightBudgetDegradation", {
          defaultValue: "Degradation: {{value}}",
          value: flightsBudget.degradationLevel,
        })
      : null,
    flightsFreshness === "budget_limited" && flightsBudget.statusReason
      ? flightsBudget.statusReason
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
  const hasFatalDataError = !anyLoading && errors.length > 0 && !hasData;
  const fatalOverlay = mapLoadError
    ? {
        title: mapLoadError.title,
        description: mapLoadError.description,
        actionLabel: t("common.retry", { defaultValue: "Retry" }),
        actionLoading: false,
        onAction: retryMapLoad,
      }
    : hasFatalDataError
      ? {
          title: t("dashboard.dataAbnormal", { defaultValue: "Data error" }),
          description:
            getErrorMessage(errors[0]) ??
            t("common.serviceUnavailable", {
              defaultValue: "Service is unavailable. Please try again.",
            }),
          actionLabel: t("dashboard.actions.retryFetch", {
            defaultValue: "Retry fetch",
          }),
          actionLoading: refreshingMapData,
          onAction: () => {
            void refreshMapData();
          },
        }
      : null;
  const hasFatalOverlay = Boolean(fatalOverlay);
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
  const healthyChainCount = chainStatuses.filter(
    (status) => status.ready && !status.fetching && !status.error,
  ).length;
  const errorChainCount = chainStatuses.filter((status) => status.error).length;
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
        defaultValue: "Awaiting first refresh",
      })
    : anyFetching
      ? t("dashboard.charts.warMap.status.refreshingChains", {
          defaultValue: "Refreshing {{count}} chains",
          count: Math.max(refreshingChainCount, 1),
        })
      : t("dashboard.charts.warMap.overlay.updatedSummary", {
          defaultValue: "Last updated {{value}}",
          value:
            latestQueryUpdatedRelative ??
            latestQueryUpdatedExact ??
            t("common.justNow", { defaultValue: "just now" }),
        });
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
        ? `${t("dashboard.charts.warMap.overlay.lastUpdatedLabel", {
            defaultValue: "Last updated",
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

  const hasNonFatalDataError = errors.length > 0 && hasData;
  const summaryDataLabel = !latestQueryUpdatedAt
    ? t("dashboard.charts.warMap.status.waitingData", {
        defaultValue: "Awaiting first refresh",
      })
    : anyFetching
      ? t("dashboard.charts.warMap.status.refreshingChains", {
          defaultValue: "Refreshing {{count}} chains",
          count: Math.max(refreshingChainCount, 1),
        })
      : t("dashboard.charts.warMap.overlay.updatedSummary", {
          defaultValue: "Last updated {{value}}",
          value:
            latestQueryUpdatedRelative ??
            latestQueryUpdatedExact ??
            t("common.justNow", { defaultValue: "just now" }),
        });
  const overlayLayout = useMemo(
    () =>
      buildWarMapOverlayLayout({
        wrapperWidth: wrapperSize.width,
        wrapperHeight: wrapperSize.height,
        overlayDensity,
        hasNonFatalErrors: hasNonFatalDataError,
      }),
    [
      hasNonFatalDataError,
      overlayDensity,
      wrapperSize.height,
      wrapperSize.width,
    ],
  );
  const overlayViewModel = useMemo(
    () =>
      buildWarMapOverlayViewModel({
        t,
        rawEventsCount: rawEvents.length,
        rawNewsMarkersCount: rawNewsMarkers.length,
        monitorsCount: monitors.length,
        visibleLayerCount,
        streamStatusLabel,
        streamStatusColor,
        streamMessageRelative,
        streamMessageExact,
        streamError: resolvedStreamState.error ?? null,
        dataStatusLabel,
        dataStatusColor,
        latestQueryUpdatedRelative,
        latestQueryUpdatedExact,
        summaryDataLabel,
        healthyChainCount,
        refreshingChainCount,
        errorChainCount,
        detailedChainStatuses,
      }),
    [
      dataStatusColor,
      dataStatusLabel,
      detailedChainStatuses,
      errorChainCount,
      healthyChainCount,
      latestQueryUpdatedExact,
      latestQueryUpdatedRelative,
      monitors.length,
      rawEvents.length,
      rawNewsMarkers.length,
      refreshingChainCount,
      resolvedStreamState.error,
      streamMessageExact,
      streamMessageRelative,
      streamStatusColor,
      streamStatusLabel,
      summaryDataLabel,
      t,
      visibleLayerCount,
    ],
  );
  const presetOptions = useMemo<WarMapSelectableOption<WarMapPreset>[]>(
    () =>
      WAR_MAP_PRESETS.map((preset) => ({
        key: preset,
        label: t(`dashboard.charts.warMap.presets.${preset}`, {
          defaultValue: PRESET_LABELS[preset],
        }),
        active: activePreset === preset,
      })),
    [activePreset, t],
  );
  const timeRangeOptions = useMemo<
    WarMapSelectableOption<WarMapTimeRangePreset>[]
  >(
    () =>
      WAR_MAP_TIME_RANGE_PRESETS.map((preset) => ({
        key: preset,
        label: t(`dashboard.charts.warMap.timeRange.${preset}`, {
          defaultValue: TIME_RANGE_LABELS[preset],
        }),
        active: timeRangePreset === preset,
      })),
    [t, timeRangePreset],
  );
  const layerVisibilityControls = (
    <div className="grid gap-2 sm:grid-cols-2">
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
    </div>
  );
  const activeControlsSection =
    controlsSection === "overview" ? "view" : controlsSection;
  const controlsPanelContent: ReactNode = (
    <WarMapControlsPanel
      controlsSection={activeControlsSection}
      controlsSectionMeta={overlayViewModel.controlsSectionMeta}
      controlsTabs={overlayViewModel.controlsTabs}
      useDrawerControls={useDrawerControls}
      overlayPanelMaxHeight={overlayLayout.overlayPanelMaxHeight}
      overviewMetricCards={overlayViewModel.overviewMetricCards}
      summaryStatusCards={overlayViewModel.summaryStatusCards}
      summaryDataLabel={overlayViewModel.summaryDataLabel}
      overviewDataTagLabel={overlayViewModel.overviewDataTagLabel}
      windowLabel={windowLabel}
      feedSummaryCards={overlayViewModel.feedSummaryCards}
      detailedChainStatuses={overlayViewModel.detailedChainStatuses}
      view={{
        presets: presetOptions,
        timeRanges: timeRangeOptions,
        layerVisibilityControls,
        onPresetSelect: setActivePreset,
        onTimeRangeSelect: setTimeRangePreset,
        onResetLayers: resetLayers,
      }}
      transport={{
        flightMode,
        onFlightModeChange: setFlightMode,
        flightsLayerVisible: layerVisibility.flights,
        flightsSourceBadgeLabel,
        flightsTooltipText,
        flightsReturnedCount,
        flightsSnapshotCount,
        flightsRawLabel,
        flightsFreshness,
        flightsTruncated,
        aisLayerVisible: layerVisibility.ais,
        aisMode,
        onAisModeChange: setAisMode,
        aisAllModeDisabled,
        aisAllModeDisabledLabel,
        aisTooltipText,
        aisSourceStatusColor,
        aisSourceStatusLabel,
        aisFreshness,
        aisModeLabel,
        aisRelayVesselCount,
        aisSnapshotRelative,
        aisSnapshotExact,
        aisPrimaryCountValue,
        aisPrimaryCountLabel,
        aisDisruptionsCount,
        canAnalyzeCurrentView:
          canRunAnalysis && (layerVisibility.flights || layerVisibility.ais),
        analyzingCurrentView: submittingGeoTransport,
        onAnalyzeCurrentView: () => {
          void handleAnalyzeCurrentView();
        },
        onOpenLegend: () => setControlsSection("legend"),
      }}
      onControlsSectionChange={setControlsSection}
      t={t}
    />
  );
  const desktopControlsPanel = (
    <div
      className={`${OVERLAY_SURFACE_CLASS_NAME} pointer-events-auto self-end overflow-hidden`}
      style={{
        width: overlayLayout.controlsPanelWidth,
        maxHeight: overlayLayout.overlayPanelMaxHeight,
      }}
    >
      {controlsPanelContent}
    </div>
  );

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
      {!hasFatalOverlay ? (
        <>
          {hasNonFatalDataError ? (
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

          <WarMapOverlayRail
            overlayRailRef={overlayRailRef}
            overlayDensity={overlayDensity}
            overlayTopClassName={overlayLayout.overlayTopClassName}
            overlayRailWidth={overlayLayout.overlayRailWidth}
            useDrawerControls={useDrawerControls}
            summaryStatusCards={overlayViewModel.summaryStatusCards}
            summaryDataLabel={overlayViewModel.summaryDataLabel}
            refreshingMapData={refreshingMapData}
            showActionLabels={overlayLayout.showActionLabels}
            openOverlayPanel={openOverlayPanel}
            controlsSection={activeControlsSection}
            onRefresh={() => {
              void refreshMapData();
            }}
            onToggleControls={() => {
              setOpenOverlayPanel((current) =>
                current === "controls" ? null : "controls",
              );
            }}
            onOpenLegendDrawer={() => {
              setControlsSection("legend");
              setOpenOverlayPanel("controls");
            }}
            controlsPanel={desktopControlsPanel}
            t={t}
          />
        </>
      ) : null}

      <div
        ref={mapContainerRef}
        className="h-full w-full overflow-hidden rounded-lg"
      />

      {!hasFatalOverlay ? (
        <>
          <WarMapInspectorPanel
            selectedInspector={selectedInspector}
            transportDetail={transportDetailQuery.data?.detail ?? null}
            transportDetailLoading={transportDetailQuery.isLoading}
            useDesktopInspector={useDesktopInspector}
            desktopInspectorMinimized={desktopInspectorMinimized}
            inspectorPanelWidth={overlayLayout.inspectorPanelWidth}
            inspectorPanelHeight={overlayLayout.inspectorPanelHeight}
            locale={locale}
            onZoomToSelectedInspector={zoomToSelectedInspector}
            onMinimizeInspector={() => setDesktopInspectorMinimized(true)}
            onExpandInspector={() => setDesktopInspectorMinimized(false)}
            onCloseInspector={closeSelectedInspector}
            onOpenNewsLink={openNewsLink}
            t={t}
          />

          {useDrawerControls ? (
            <Drawer
              open={openOverlayPanel === "controls"}
              onClose={() => setOpenOverlayPanel(null)}
              placement="right"
              width="100%"
              destroyOnClose={false}
              title={
                overlayViewModel.controlsSectionMeta[activeControlsSection]
                  .label
              }
            >
              {controlsPanelContent}
            </Drawer>
          ) : null}
        </>
      ) : null}

      {showBootOverlay ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="rounded-xl border border-[var(--border)] bg-white/92 px-4 py-3 shadow-lg backdrop-blur dark:bg-slate-950/78 dark:shadow-[0_22px_40px_-30px_rgba(2,6,23,0.9)]">
            <Space size={10}>
              <Spin size="small" />
              <Typography.Text>{bootOverlayLabel}</Typography.Text>
            </Space>
          </div>
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

      {fatalOverlay ? (
        <div className="absolute inset-0 z-30 rounded-lg bg-white/80 backdrop-blur-sm dark:bg-slate-950/72">
          <ChartEmptyState
            variant="error"
            title={fatalOverlay.title}
            description={fatalOverlay.description}
            actionLabel={fatalOverlay.actionLabel}
            actionLoading={fatalOverlay.actionLoading}
            onAction={fatalOverlay.onAction}
          />
        </div>
      ) : null}
    </div>
  );
}
