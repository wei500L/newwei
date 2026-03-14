'use client';

import { CloseOutlined, ExpandOutlined, SettingOutlined } from '@ant-design/icons';
import { PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { MapboxOverlay } from '@deck.gl/mapbox';
import {
  type WarMapLayerDataset,
  type WarMapLayerFeature,
  type WarMapLayerId,
  type WarMapPreset,
  type WarMapTimeRangePreset,
  WAR_MAP_LAYER_IDS,
  WAR_MAP_PRESETS,
  WAR_MAP_TIME_RANGE_PRESETS,
} from '@modular/utils';
import { useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Drawer, Grid, List, Popover, Skeleton, Space, Tag, Typography } from 'antd';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useSession } from 'next-auth/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ChartEmptyState } from '@/components/chart-empty-state';
import { RequestErrorBanner } from '@/components/request-error-banner';
import { usePendingAction } from '@/hooks/use-pending-action';
import { createApiClient } from '@/lib/api-client';
import { formatDateTime, formatUpdatedAt, resolveLocale } from '@/lib/i18n';
import { captureClientError } from '@/lib/client-telemetry';
import { classifyMapLoadError, type MapLoadErrorPresentation } from '@/lib/map/map-load-error';
import { createDeckMapRuntime, extractMapBbox, setDeckOverlayProps } from '@/lib/map/map-runtime';
import { MAP_STYLE_URL } from '@/lib/map/map-style';
import { useRenderableContainer } from '@/lib/map/use-renderable-container';
import { safeHttpUrl } from '@/lib/url';
import { useDashboardRangeStore } from '@/store/time-range';
import { useWarMapSettingsStore } from '@/store/war-map-settings';

import type { StoredSituationMonitor } from '@/app/(app)/situation-monitor/types/situation-monitor-monitors';
import { SITUATION_MONITOR_MONITORS_UPDATED_EVENT } from '@/app/(app)/situation-monitor/utils/monitor-events';

import {
  clusterWarMapPoints,
  computeAverageClusterGeometry,
  computeWeightedClusterGeometry,
  sortWarMapEventClusterMembers,
  sortWarMapNewsClusterMembers,
} from './war-map-clustering';
import {
  buildSanitizedPathGeometry,
  buildSanitizedPolygonResult,
  isValidDeckCoordinate,
  type DeckCoordinate,
} from './war-map-geometry';
import { BBOX_QUERY_MIN_ZOOM, buildWarMapQueryBbox } from './query-viewport';
import { readWarMapUrlState, writeWarMapUrlState } from './url-state';

const ALL_TIME_START = new Date('1970-01-01T00:00:00.000Z');

type WarEventSeverity = 'low' | 'medium' | 'high';
type WarMapNewsGeoSource = 'geocoded' | 'fallback-country';

interface WarMapEvent {
  id: string;
  name: string;
  nameZh?: string;
  lat: number;
  lng: number;
  severity: WarEventSeverity;
  latestAt?: string;
  derivedScore?: number;
  value?: number;
  alertScore?: number;
  alertCount?: number;
  newsCount?: number;
  isCluster?: boolean;
  clusterId?: number;
  clusterCount?: number;
}

interface WarMapNewsMarker {
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

interface WarMapEventsResponse {
  events: WarMapEvent[];
  updatedAt?: string;
  clustered?: boolean;
}

interface WarMapNewsMarkersResponse {
  markers: WarMapNewsMarker[];
  updatedAt?: string;
  clustered?: boolean;
}

interface WarMapLayersResponse {
  updatedAt: string;
  layers: Partial<Record<WarMapLayerId, WarMapLayerDataset>>;
}

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
  severity?: WarEventSeverity;
  alertCount?: number;
  newsCount?: number;
  geoSource?: WarMapNewsGeoSource;
  query?: string;
  kind: 'event' | 'news' | 'news-cluster' | 'event-cluster' | 'layer' | 'monitor';
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
      kind: 'event';
      lat: number;
      lng: number;
      count: number;
      zoomTarget: number;
      members: RenderableWarMapEvent[];
    }
  | {
      key: string;
      kind: 'news';
      lat: number;
      lng: number;
      count: number;
      zoomTarget: number;
      members: RenderableWarMapNewsMarker[];
    };

export interface WarMapProps {
  className?: string;
  translateTarget?: 'zh-CN';
}

const PRESET_LABELS: Record<WarMapPreset, string> = {
  global: 'Global',
  america: 'America',
  mena: 'MENA',
  eu: 'Europe',
  asia: 'Asia',
  latam: 'LatAm',
  africa: 'Africa',
  oceania: 'Oceania',
};

const TIME_RANGE_LABELS: Record<WarMapTimeRangePreset, string> = {
  '1h': '1H',
  '6h': '6H',
  '24h': '24H',
  '48h': '48H',
  '7d': '7D',
  all: 'All',
};

const TIME_RANGE_MS: Record<Exclude<WarMapTimeRangePreset, 'all'>, number> = {
  '1h': 1 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '48h': 48 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

const LAYER_LABEL_OVERRIDES: Partial<Record<WarMapLayerId, string>> = {
  ais: 'AIS',
  ucdpEvents: 'UCDP Events',
  cloudRegions: 'Cloud Regions',
  startupHubs: 'Startup Hubs',
  techHQs: 'Tech HQs',
  dayNight: 'Day/Night',
  gpsJamming: 'GPS Jamming',
  iranAttacks: 'Iran Attacks',
};

const warMapSanitizationWarningSignatures = new Map<string, string>();

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
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function warnWarMapGeometrySanitization(
  kind: 'path' | 'polygon',
  layerId: WarMapLayerId,
  payload: Record<string, unknown>,
): void {
  const warningKey = `${kind}:${layerId}`;
  const signature = JSON.stringify(payload);
  if (warMapSanitizationWarningSignatures.get(warningKey) === signature) {
    return;
  }
  warMapSanitizationWarningSignatures.set(warningKey, signature);
  console.warn(`[WarMap] ${kind} geometry sanitized for layer "${layerId}".`, payload);
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
  const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
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
  return typeof error === 'string' ? error : undefined;
}

function severityColor(severity: WarEventSeverity): [number, number, number, number] {
  switch (severity) {
    case 'high':
      return [220, 38, 38, 220];
    case 'medium':
      return [217, 119, 6, 210];
    case 'low':
    default:
      return [37, 99, 235, 195];
  }
}

function severityTagColor(severity: WarEventSeverity): string {
  switch (severity) {
    case 'high':
      return 'red';
    case 'medium':
      return 'gold';
    case 'low':
    default:
      return 'blue';
  }
}

function clusterRadius(count: number): number {
  return Math.max(12, Math.min(42, Math.sqrt(Math.max(1, count)) * 7));
}

function toClusterSelectionKey(kind: 'event' | 'news', memberKey: string): string {
  return `${kind}:${memberKey}`;
}

export function WarMap({ className, translateTarget }: WarMapProps = {}) {
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
  const [mapLoadError, setMapLoadError] = useState<MapLoadErrorPresentation | null>(null);
  const [mapMountNonce, setMapMountNonce] = useState(0);
  const [selectedClusterKey, setSelectedClusterKey] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<StoredSituationMonitor[]>([]);
  const hasRenderableMapContainer = useRenderableContainer(mapContainerRef, inView);
  const [queryViewport, setQueryViewport] = useState<{
    bbox?: [number, number, number, number];
    zoom: number;
  }>({ zoom: 2 });

  const { end } = useDashboardRangeStore();

  const layerVisibility = useWarMapSettingsStore((state) => state.layerVisibility);
  const viewState = useWarMapSettingsStore((state) => state.viewState);
  const activePreset = useWarMapSettingsStore((state) => state.activePreset);
  const timeRangePreset = useWarMapSettingsStore((state) => state.timeRangePreset);
  const setLayerVisible = useWarMapSettingsStore((state) => state.setLayerVisible);
  const setLayerVisibility = useWarMapSettingsStore((state) => state.setLayerVisibility);
  const setViewState = useWarMapSettingsStore((state) => state.setViewState);
  const setActivePreset = useWarMapSettingsStore((state) => state.setActivePreset);
  const setTimeRangePreset = useWarMapSettingsStore((state) => state.setTimeRangePreset);
  const resetAll = useWarMapSettingsStore((state) => state.resetAll);
  const viewStateRef = useRef(viewState);

  useEffect(() => {
    viewStateRef.current = viewState;
  }, [viewState]);

  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) {
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setInView(Boolean(entries[0]?.isIntersecting));
      },
      { rootMargin: '160px' },
    );

    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const enabled = Boolean(session?.accessToken && inView && hasRenderableMapContainer);
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const loadMonitors = useCallback(async () => {
    if (!session?.accessToken) {
      setMonitors([]);
      return;
    }

    try {
      const response = await apiClient.get<StoredSituationMonitor[]>(
        'situation-monitor/monitors',
      );
      setMonitors(response.data ?? []);
    } catch (error) {
      captureClientError('Failed to load situation monitor map markers', error);
    }
  }, [apiClient, session?.accessToken]);

  useEffect(() => {
    void loadMonitors();
  }, [loadMonitors]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleMonitorsUpdated = () => {
      void loadMonitors();
    };

    window.addEventListener(
      SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
      handleMonitorsUpdated,
    );
    return () => {
      window.removeEventListener(
        SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
        handleMonitorsUpdated,
      );
    };
  }, [loadMonitors]);
  const retryMapLoad = useCallback(() => {
    setMapLoadError(null);
    setMapReady(false);
    setMapMountNonce((value) => value + 1);
  }, []);

  const effectiveRange = useMemo(() => {
    if (timeRangePreset === 'all') {
      return { start: ALL_TIME_START, end };
    }
    const duration = TIME_RANGE_MS[timeRangePreset];
    return {
      end,
      start: new Date(end.getTime() - duration),
    };
  }, [end, timeRangePreset]);

  const queryZoom = useMemo(() => Number(queryViewport.zoom.toFixed(2)), [queryViewport.zoom]);

  const queryBbox = useMemo(() => {
    return buildWarMapQueryBbox(queryViewport.bbox, queryZoom);
  }, [queryViewport.bbox, queryZoom]);
  const localClusterBbox = useMemo(
    () => (queryZoom >= BBOX_QUERY_MIN_ZOOM ? queryViewport.bbox : undefined),
    [queryViewport.bbox, queryZoom],
  );

  const eventsQuery = useQuery({
    queryKey: [
      'dashboard',
      'war-map',
      'events',
      effectiveRange.start.toISOString(),
      effectiveRange.end.toISOString(),
      queryBbox ?? null,
      queryZoom,
      translateTarget ?? null,
    ],
    queryFn: async () => {
      const response = await apiClient.get<WarMapEventsResponse>('dashboard/war-map/events', {
        params: {
          start: effectiveRange.start.toISOString(),
          end: effectiveRange.end.toISOString(),
          translate: translateTarget,
          bbox: queryBbox,
          zoom: queryZoom.toFixed(2),
          cluster: '0',
        },
      });
      return response.data;
    },
    staleTime: 15_000,
    enabled,
    placeholderData: (previous) => previous,
  });

  const newsQuery = useQuery({
    queryKey: [
      'dashboard',
      'war-map',
      'news-markers',
      effectiveRange.start.toISOString(),
      effectiveRange.end.toISOString(),
      queryBbox ?? null,
      queryZoom,
      translateTarget ?? null,
    ],
    queryFn: async () => {
      const response = await apiClient.get<WarMapNewsMarkersResponse>(
        'dashboard/war-map/news-markers',
        {
          params: {
            start: effectiveRange.start.toISOString(),
            end: effectiveRange.end.toISOString(),
            translate: translateTarget,
            bbox: queryBbox,
            zoom: queryZoom.toFixed(2),
            cluster: '0',
          },
        },
      );
      return response.data;
    },
    staleTime: 15_000,
    enabled,
    placeholderData: (previous) => previous,
  });

  const layersQuery = useQuery({
    queryKey: [
      'dashboard',
      'war-map',
      'layers',
      effectiveRange.start.toISOString(),
      effectiveRange.end.toISOString(),
      translateTarget ?? null,
    ],
    queryFn: async () => {
      const response = await apiClient.get<WarMapLayersResponse>('dashboard/war-map/layers', {
        params: {
          start: effectiveRange.start.toISOString(),
          end: effectiveRange.end.toISOString(),
          translate: translateTarget,
        },
      });
      return response.data;
    },
    staleTime: 30_000,
    enabled,
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    if (!mapContainerRef.current || !inView || !hasRenderableMapContainer || mapRef.current) {
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
        captureClientError('War map basemap load failed', detail.error ?? detail);
        const presentation = classifyMapLoadError(detail);
        setMapReady(false);
        setMapLoadError(presentation);
        toast.error(`${presentation.title}. ${presentation.rawMessage ?? presentation.description}`);
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
    if (hasHydratedUrlRef.current || typeof window === 'undefined') {
      return;
    }

    const parsed = readWarMapUrlState(new URLSearchParams(window.location.search));
    if (parsed.layerVisibility) {
      setLayerVisibility(parsed.layerVisibility);
    }
    if (parsed.activePreset) {
      setActivePreset(parsed.activePreset);
    }
    if (parsed.timeRangePreset) {
      setTimeRangePreset(parsed.timeRangePreset);
    }
    if (parsed.viewState) {
      setViewState(parsed.viewState);
    }

    hasHydratedUrlRef.current = true;
  }, [setActivePreset, setLayerVisibility, setTimeRangePreset, setViewState]);

  useEffect(() => {
    if (!hasHydratedUrlRef.current || typeof window === 'undefined') {
      return;
    }

    const timer = window.setTimeout(() => {
      const current = new URL(window.location.href);
      const nextParams = writeWarMapUrlState(current.searchParams, {
        viewState,
        activePreset,
        timeRangePreset,
        layerVisibility,
      });
      const nextSearch = nextParams.toString();
      const currentSearch = current.searchParams.toString();
      if (nextSearch !== currentSearch) {
        const nextUrl = `${current.pathname}${nextSearch ? `?${nextSearch}` : ''}${current.hash}`;
        window.history.replaceState(null, '', nextUrl);
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [activePreset, layerVisibility, timeRangePreset, viewState]);

  const monitorPoints = useMemo(
    () =>
      monitors
        .filter((monitor) => monitor.enabled && monitor.location)
        .filter((monitor) => isValidLatLng(monitor.location!.lat, monitor.location!.lng))
        .map((monitor) => ({
          query:
            monitor.rawKeywords.find((keyword: string) => keyword.trim().length > 0)?.trim() ??
            monitor.name,
          id: monitor.id,
          lat: monitor.location!.lat,
          lng: monitor.location!.lng,
          label: monitor.name,
          color: toRgba(monitor.color, 0.9, [79, 70, 229]),
          radius: 8,
          kind: 'monitor' as const,
          description: monitor.location!.name,
        })),
    [monitors],
  );

  const openNewsLink = useCallback(
    (url?: string | null) => {
      const safeUrl = typeof url === 'string' ? safeHttpUrl(url) : null;
      if (!safeUrl) {
        toast.warning(
          t('dashboard.charts.warMap.missingNewsUrl', {
            defaultValue: 'No link available for this news marker.',
          }),
        );
        return;
      }
      window.open(safeUrl, '_blank', 'noopener,noreferrer');
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
            translateTarget === 'zh-CN' && typeof event.nameZh === 'string'
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
            translateTarget === 'zh-CN' && typeof marker.titleZh === 'string'
              ? marker.titleZh
              : marker.title,
          locationLabel:
            translateTarget === 'zh-CN'
              ? marker.displayNameZh ?? marker.locationZh ?? marker.displayName ?? marker.location
              : marker.displayName ?? marker.location,
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

  const selectedCluster = useMemo<SelectedCluster | null>(() => {
    if (!selectedClusterKey) {
      return null;
    }

    const eventCluster = clusteredEvents.clusters.find(
      (cluster) => toClusterSelectionKey('event', cluster.memberKey) === selectedClusterKey,
    );
    if (eventCluster) {
      return {
        key: selectedClusterKey,
        kind: 'event',
        lat: eventCluster.lat,
        lng: eventCluster.lng,
        count: eventCluster.count,
        zoomTarget: 8,
        members: eventCluster.members,
      };
    }

    const newsCluster = clusteredNews.clusters.find(
      (cluster) => toClusterSelectionKey('news', cluster.memberKey) === selectedClusterKey,
    );
    if (newsCluster) {
      return {
        key: selectedClusterKey,
        kind: 'news',
        lat: newsCluster.lat,
        lng: newsCluster.lng,
        count: newsCluster.count,
        zoomTarget: 9,
        members: newsCluster.members,
      };
    }

    return null;
  }, [clusteredEvents.clusters, clusteredNews.clusters, selectedClusterKey]);

  useEffect(() => {
    if (selectedClusterKey && !selectedCluster) {
      setSelectedClusterKey(null);
    }
  }, [selectedCluster, selectedClusterKey]);

  const closeSelectedCluster = useCallback(() => {
    setSelectedClusterKey(null);
  }, []);

  const zoomToSelectedCluster = useCallback(() => {
    const map = mapRef.current;
    if (!map || !selectedCluster) {
      return;
    }

    map.easeTo({
      center: [selectedCluster.lng, selectedCluster.lat],
      zoom: Math.min(selectedCluster.zoomTarget, map.getZoom() + 2),
      duration: 350,
      essential: true,
    });
  }, [selectedCluster]);

  const deckData = useMemo(() => {
    const layersData = layersQuery.data?.layers ?? {};
    const events = clusteredEvents.singles;
    const newsMarkers = clusteredNews.singles;

    const staticLayers: any[] = [];

    for (const layerId of WAR_MAP_LAYER_IDS) {
      if (layerId === 'monitors' || !layerVisibility[layerId]) {
        continue;
      }

      const dataset = layersData[layerId];
      if (!dataset || !Array.isArray(dataset.features) || dataset.features.length === 0) {
        continue;
      }

      const color = toRgba(dataset.renderHints?.color, dataset.renderHints?.opacity ?? 0.72, [59, 130, 246]);
      const minZoom = dataset.renderHints?.minZoom;
      const maxZoom = dataset.renderHints?.maxZoom;
      const isZoomVisible =
        (typeof minZoom !== 'number' || queryZoom >= minZoom) &&
        (typeof maxZoom !== 'number' || queryZoom <= maxZoom);
      if (!isZoomVisible) {
        continue;
      }

      if (dataset.geometryType === 'path') {
        const paths: Array<WarMapLayerFeature & { path: DeckCoordinate[] }> = [];
        const pathFallbackPoints: Array<WarMapLayerFeature & { lat: number; lng: number }> = [];
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
          const invalidCoordinateCount = countInvalidPathCoordinates(feature.path);
          const wasSplit = sanitized.pathFeatures.length > 1;
          const hadPointFallback = sanitized.pointFeatures.length > 0;
          if (invalidCoordinateCount > 0 || wasSplit || hadPointFallback) {
            pathSanitizationSummary.affectedFeatureCount += 1;
            pathSanitizationSummary.invalidCoordinateCount += invalidCoordinateCount;
            pathSanitizationSummary.renderedPathSegmentCount += sanitized.pathFeatures.length;
            pathSanitizationSummary.pointFallbackCount += sanitized.pointFeatures.length;
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
          warnWarMapGeometrySanitization('path', layerId, pathSanitizationSummary);
        }
        if (paths.length > 0) {
          staticLayers.push(
            new PathLayer({
              id: `wm-path-${layerId}`,
              data: paths,
              pickable: Boolean(dataset.renderHints?.pickable ?? true),
              getPath: (feature: WarMapLayerFeature & { path: DeckCoordinate[] }) => feature.path,
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
              getPosition: (feature: WarMapLayerFeature & { lat: number; lng: number }) => [
                feature.lng,
                feature.lat,
              ],
              getFillColor: color,
              getRadius: () =>
                Math.max(4, Math.min(14, Math.round((dataset.renderHints?.radiusScale ?? 1) * 5))),
              radiusMinPixels: 3,
              radiusMaxPixels: 18,
              stroked: false,
            }),
          );
        }
        continue;
      }

      if (dataset.geometryType === 'polygon') {
        const polygons: Array<WarMapLayerFeature & { polygon: DeckCoordinate[][] }> = [];
        const polygonOutlineFeatures: Array<WarMapLayerFeature & { path: DeckCoordinate[] }> = [];
        const polygonFallbackPoints: Array<WarMapLayerFeature & { lat: number; lng: number }> = [];
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
            polygonSanitizationSummary.invalidCoordinateCount += inputSummary.invalidCoordinateCount;
            polygonSanitizationSummary.malformedRingCount += inputSummary.malformedRingCount;
            polygonSanitizationSummary.outlineFragmentCount += sanitized.outlineFeatures.length;
            polygonSanitizationSummary.pointFallbackCount += sanitized.pointFeatures.length;
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
          warnWarMapGeometrySanitization('polygon', layerId, polygonSanitizationSummary);
        }
        if (polygons.length > 0) {
          staticLayers.push(
            new PolygonLayer({
              id: `wm-polygon-${layerId}`,
              data: polygons,
              pickable: Boolean(dataset.renderHints?.pickable ?? true),
              getPolygon: (feature: WarMapLayerFeature & { polygon: DeckCoordinate[][] }) =>
                feature.polygon[0] ?? [],
              getFillColor: color,
              getLineColor: toRgba(dataset.renderHints?.color, 0.85, [59, 130, 246]),
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
              getPath: (feature: WarMapLayerFeature & { path: DeckCoordinate[] }) => feature.path,
              getColor: toRgba(dataset.renderHints?.color, 0.92, [59, 130, 246]),
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
              getPosition: (feature: WarMapLayerFeature & { lat: number; lng: number }) => [
                feature.lng,
                feature.lat,
              ],
              getFillColor: color,
              getRadius: () =>
                Math.max(4, Math.min(14, Math.round((dataset.renderHints?.radiusScale ?? 1) * 5))),
              radiusMinPixels: 3,
              radiusMaxPixels: 18,
              stroked: false,
            }),
          );
        }
        continue;
      }

      if (dataset.geometryType === 'raster') {
        continue;
      }

      const points: DeckPoint[] = dataset.features
        .filter(
          (feature): feature is WarMapLayerFeature & { lat: number; lng: number } =>
            typeof feature.lat === 'number' &&
            typeof feature.lng === 'number' &&
            isValidLatLng(feature.lat, feature.lng),
        )
        .map((feature) => {
          const name =
            typeof feature.properties?.nameZh === 'string' && translateTarget === 'zh-CN'
              ? feature.properties.nameZh
              : typeof feature.properties?.name === 'string'
                ? feature.properties.name
                : toLayerLabel(layerId);
          const description =
            typeof feature.properties?.descriptionZh === 'string' && translateTarget === 'zh-CN'
              ? feature.properties.descriptionZh
              : typeof feature.properties?.description === 'string'
                ? feature.properties.description
                : undefined;
          return {
            id: `${layerId}-${feature.id}`,
            lat: feature.lat,
            lng: feature.lng,
            label: name,
            description,
            color,
            radius: Math.max(4, Math.min(18, Math.round((dataset.renderHints?.radiusScale ?? 1) * 6))),
            kind: 'layer',
          };
        });

      if (points.length > 0) {
        staticLayers.push(
          new ScatterplotLayer({
            id: `wm-point-${layerId}`,
            data: points,
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

    const eventPoints: DeckPoint[] = [];
    for (const event of events) {
      const score =
        typeof event.derivedScore === 'number' ? event.derivedScore : event.value ?? 0;
      const point: DeckPoint = {
        id: event.id,
        lat: event.lat,
        lng: event.lng,
        label: event.label,
        kind: 'event',
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
      const selectionKey = toClusterSelectionKey('event', cluster.memberKey);
      eventClusters.push({
        id: selectionKey,
        lat: cluster.lat,
        lng: cluster.lng,
        label: t('dashboard.charts.warMap.panel.signalsTitle', {
          defaultValue: 'Nearby signals',
        }),
        kind: 'event-cluster',
        color: [180, 83, 9, 188],
        radius: clusterRadius(cluster.count),
        isCluster: true,
        clusterCount: cluster.count,
        selectionKey,
        description: t('dashboard.charts.warMap.tooltip.clusterSignals', {
          defaultValue: '{{count}} nearby signals. Click to inspect.',
          count: cluster.count,
        }),
      });
    }

    const newsPoints: DeckPoint[] = [];
    for (const marker of newsMarkers) {
      const baseColor = marker.geoSource === 'fallback-country' ? [8, 145, 178] : [5, 150, 105];
      const [baseR = 8, baseG = 145, baseB = 178] = baseColor;
      const point: DeckPoint = {
        id: marker.id,
        lat: marker.lat,
        lng: marker.lng,
        label: marker.label,
        kind: 'news',
        color: [baseR, baseG, baseB, marker.geoSource === 'fallback-country' ? 110 : 200],
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
      const selectionKey = toClusterSelectionKey('news', cluster.memberKey);
      newsClusters.push({
        id: selectionKey,
        lat: cluster.lat,
        lng: cluster.lng,
        label: t('dashboard.charts.warMap.panel.newsTitle', {
          defaultValue: 'Nearby news',
        }),
        kind: 'news-cluster',
        color: [21, 128, 61, 176],
        radius: clusterRadius(cluster.count),
        isCluster: true,
        clusterCount: cluster.count,
        selectionKey,
        description: t('dashboard.charts.warMap.tooltip.clusterNews', {
          defaultValue: '{{count}} nearby news items. Click to inspect.',
          count: cluster.count,
        }),
      });
    }

    const deckLayers: any[] = [...staticLayers];

    if (layerVisibility.monitors && monitorPoints.length > 0) {
      deckLayers.push(
        new ScatterplotLayer({
          id: 'wm-monitors',
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
                t('dashboard.charts.warMap.missingMonitorQuery', {
                  defaultValue: 'No keywords available for this monitor.',
                }),
              );
              return;
            }
            window.open(
              `/search?q=${encodeURIComponent(query)}`,
              '_blank',
              'noopener,noreferrer',
            );
          },
        }),
      );
    }

    if (eventClusters.length > 0) {
      deckLayers.push(
        new ScatterplotLayer({
          id: 'wm-events-clusters',
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
            setSelectedClusterKey(object.selectionKey);
          },
        }),
      );
    }

    if (eventPoints.length > 0) {
      deckLayers.push(
        new ScatterplotLayer({
          id: 'wm-events',
          data: eventPoints,
          pickable: true,
          getPosition: (point: DeckPoint) => [point.lng, point.lat],
          getFillColor: (point: DeckPoint) => point.color,
          getRadius: (point: DeckPoint) => point.radius,
          radiusMinPixels: 4,
          radiusMaxPixels: 34,
        }),
      );
    }

    if (newsClusters.length > 0) {
      deckLayers.push(
        new ScatterplotLayer({
          id: 'wm-news-clusters',
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
            setSelectedClusterKey(object.selectionKey);
          },
        }),
      );
    }

    if (newsPoints.length > 0) {
      deckLayers.push(
        new ScatterplotLayer({
          id: 'wm-news',
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
            openNewsLink(object.url);
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
      staticVisibleCount: staticLayers.length,
    };
  }, [
    clusteredEvents.clusters,
    clusteredEvents.singles,
    layerVisibility,
    layersQuery.data?.layers,
    monitorPoints,
    clusteredNews.clusters,
    clusteredNews.singles,
    openNewsLink,
    rawEvents.length,
    rawNewsMarkers.length,
    queryZoom,
    t,
    translateTarget,
  ]);

  const tooltipGetter = useMemo(
    () =>
      ({ object }: { object?: DeckPoint }) => {
        if (!object) {
          return null;
        }
        if (object.kind === 'event-cluster') {
          const count = object.clusterCount ?? 0;
          return {
            text: t('dashboard.charts.warMap.tooltip.clusterSignals', {
              defaultValue: '{{count}} nearby signals. Click to inspect.',
              count,
            }),
          };
        }
        if (object.kind === 'news-cluster') {
          const count = object.clusterCount ?? 0;
          return {
            text: t('dashboard.charts.warMap.tooltip.clusterNews', {
              defaultValue: '{{count}} nearby news items. Click to inspect.',
              count,
            }),
          };
        }

        const latestTimestamp = object.publishedAt ?? object.ingestedAt ?? object.latestAt;
        const latestLabel =
          object.kind === 'event'
            ? t('dashboard.charts.warMap.panel.latest', {
                defaultValue: 'Latest',
              })
            : object.publishedAt
              ? t('dashboard.charts.warMap.tooltip.published', {
                  defaultValue: 'Published',
                })
              : object.ingestedAt
                ? t('dashboard.charts.warMap.tooltip.ingested', {
                    defaultValue: 'Ingested',
                  })
                : null;

        const formattedTimestamp = latestTimestamp
          ? formatDateTime(latestTimestamp, locale, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })
          : null;

        const lines = [object.label];
        if (object.description) {
          lines.push(object.description);
        }
        if (object.kind === 'event' && object.severity) {
          lines.push(
            `${t('dashboard.charts.warMap.tooltip.severity', {
              defaultValue: 'Severity',
            })}: ${t(`dashboard.charts.warMap.stats.${object.severity}`, {
              defaultValue: object.severity,
            })}`,
          );
        }
        if (object.kind === 'event') {
          lines.push(
            `${t('dashboard.charts.warMap.tooltip.alerts', {
              defaultValue: 'Alerts',
            })}: ${object.alertCount ?? 0}`,
          );
          lines.push(
            `${t('dashboard.charts.warMap.stats.news', {
              defaultValue: 'News',
            })}: ${object.newsCount ?? 0}`,
          );
        }
        if (object.kind === 'news' && object.locationLabel) {
          lines.push(
            `${t('dashboard.charts.warMap.tooltip.location', {
              defaultValue: 'Location',
            })}: ${object.locationLabel}`,
          );
        }
        if (formattedTimestamp && latestLabel) {
          lines.push(`${latestLabel}: ${formattedTimestamp}`);
        }
        if (object.kind === 'news') {
          lines.push(
            t('dashboard.charts.warMap.tooltip.clickOpenOriginal', {
              defaultValue: 'Click to open original link',
            }),
          );
        }
        return { text: lines.join('\n') };
      },
    [locale, t],
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

  const anyLoading = eventsQuery.isLoading || newsQuery.isLoading || layersQuery.isLoading;
  const errors = [eventsQuery.error, newsQuery.error, layersQuery.error].filter(Boolean);
  const { pending: refreshingMapData, run: refreshMapData } = usePendingAction(
    async () => {
      await Promise.all([
        eventsQuery.refetch(),
        newsQuery.refetch(),
        layersQuery.refetch(),
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

  const windowLabel = `${formatDateTime(effectiveRange.start, locale, {
    dateStyle: 'medium',
  })} - ${formatDateTime(effectiveRange.end, locale, { dateStyle: 'medium' })}`;

  const eventsUpdatedAt = eventsQuery.data?.updatedAt
    ? formatUpdatedAt(eventsQuery.data.updatedAt, locale)
    : null;
  const newsUpdatedAt = newsQuery.data?.updatedAt
    ? formatUpdatedAt(newsQuery.data.updatedAt, locale)
    : null;

  const layerSelector = (
    <div style={{ minWidth: 260, maxHeight: 360, overflowY: 'auto' }}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        {WAR_MAP_LAYER_IDS.map((layerId) => {
          const disabled = layerId === 'monitors' ? monitorPoints.length === 0 : false;
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
        <Button
          type="link"
          size="small"
          style={{ padding: 0, height: 'auto' }}
          onClick={() => resetAll()}
        >
          {t('common.reset', { defaultValue: 'Reset' })}
        </Button>
      </Space>
    </div>
  );

  const clusterPanelContent = selectedCluster ? (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur">
      <div className="border-b border-slate-200 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Space size={[6, 6]} wrap>
              <Tag color={selectedCluster.kind === 'event' ? 'gold' : 'green'}>
                {selectedCluster.kind === 'event'
                  ? t('dashboard.charts.warMap.panel.signalsTitle', {
                      defaultValue: 'Nearby signals',
                    })
                  : t('dashboard.charts.warMap.panel.newsTitle', {
                      defaultValue: 'Nearby news',
                    })}
              </Tag>
              <Tag color="default">
                {t('dashboard.charts.warMap.panel.count', {
                  defaultValue: '{{count}} items',
                  count: selectedCluster.count,
                })}
              </Tag>
            </Space>
            <Typography.Title level={5} className="!mb-1 !mt-3">
              {selectedCluster.kind === 'event'
                ? t('dashboard.charts.warMap.panel.signalsTitle', {
                    defaultValue: 'Nearby signals',
                  })
                : t('dashboard.charts.warMap.panel.newsTitle', {
                    defaultValue: 'Nearby news',
                  })}
            </Typography.Title>
            <Typography.Text type="secondary">
              {selectedCluster.kind === 'event'
                ? t('dashboard.charts.warMap.panel.signalsSummary', {
                    defaultValue: '{{count}} nearby signals at this zoom level.',
                    count: selectedCluster.count,
                  })
                : t('dashboard.charts.warMap.panel.newsSummary', {
                    defaultValue: '{{count}} nearby news items at this zoom level.',
                    count: selectedCluster.count,
                  })}
            </Typography.Text>
          </div>
          <Space size={8}>
            <Button
              size="small"
              icon={<ExpandOutlined />}
              onClick={zoomToSelectedCluster}
            >
              {t('dashboard.charts.warMap.panel.zoomIn', {
                defaultValue: 'Zoom in',
              })}
            </Button>
            {useDesktopInspector ? (
              <Button
                size="small"
                type="text"
                icon={<CloseOutlined />}
                onClick={closeSelectedCluster}
                aria-label={t('common.close', {
                  defaultValue: 'Close',
                })}
              />
            ) : null}
          </Space>
        </div>
      </div>

      {selectedCluster.kind === 'event' ? (
        <List
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
          dataSource={selectedCluster.members}
          renderItem={(item) => (
            <List.Item key={item.id}>
              <List.Item.Meta
                title={
                  <div className="flex items-start justify-between gap-3">
                    <Typography.Text strong>{item.label}</Typography.Text>
                    <Tag color={severityTagColor(item.severity)}>
                      {t(`dashboard.charts.warMap.stats.${item.severity}`, {
                        defaultValue:
                          item.severity.charAt(0).toUpperCase() + item.severity.slice(1),
                      })}
                    </Tag>
                  </div>
                }
                description={
                  <div className="flex flex-col gap-2">
                    <Space size={[6, 6]} wrap>
                      <Tag>
                        {t('dashboard.charts.warMap.tooltip.alerts', {
                          defaultValue: 'Alerts',
                        })}
                        : {item.alertCount ?? 0}
                      </Tag>
                      <Tag>
                        {t('dashboard.charts.warMap.stats.news', {
                          defaultValue: 'News',
                        })}
                        : {item.newsCount ?? 0}
                      </Tag>
                    </Space>
                    {item.latestAt ? (
                      <Typography.Text type="secondary" className="text-xs">
                        {t('dashboard.charts.warMap.panel.latest', {
                          defaultValue: 'Latest',
                        })}
                        :{' '}
                        {formatDateTime(item.latestAt, locale, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </Typography.Text>
                    ) : null}
                  </div>
                }
              />
            </List.Item>
          )}
        />
      ) : (
        <List
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
          dataSource={selectedCluster.members}
          renderItem={(item) => {
            const timestampLabel = item.publishedAt
              ? t('dashboard.charts.warMap.tooltip.published', {
                  defaultValue: 'Published',
                })
              : item.ingestedAt
                ? t('dashboard.charts.warMap.tooltip.ingested', {
                    defaultValue: 'Ingested',
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
                    {t('dashboard.charts.warMap.panel.openOriginal', {
                      defaultValue: 'Open',
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
                            item.geoSource === 'fallback-country'
                              ? 'dashboard.charts.warMap.stats.fallbackCountry'
                              : 'dashboard.charts.warMap.stats.geocoded',
                            {
                              defaultValue:
                                item.geoSource === 'fallback-country'
                                  ? 'Fallback country'
                                  : 'Geocoded',
                            },
                          )}
                        </Tag>
                      </Space>
                      {timestamp && timestampLabel ? (
                        <Typography.Text type="secondary" className="text-xs">
                          {timestampLabel}:{' '}
                          {formatDateTime(timestamp, locale, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
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
      )}
    </div>
  ) : null;

  const containerClassName = ['relative', className ?? 'h-[430px]'].filter(Boolean).join(' ');

  if (!inView) {
    return (
      <div ref={wrapperRef} className={containerClassName}>
        <div className="h-full flex items-center">
          <Skeleton active paragraph={{ rows: 6 }} />
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
          <Tag color="default" className="text-xs">
            {t('dashboard.charts.warMap.stats.window', { defaultValue: 'Window' })}: {windowLabel}
          </Tag>
          <Tag color="geekblue" className="text-xs">
            {t('dashboard.charts.warMap.stats.signals', { defaultValue: 'Signals' })}: {rawEvents.length}
          </Tag>
          <Tag color="green" className="text-xs">
            {t('dashboard.charts.warMap.stats.news', { defaultValue: 'News' })}: {rawNewsMarkers.length}
          </Tag>
          {eventsUpdatedAt ? (
            <Tag color="default" className="text-xs">
              {t('dashboard.charts.warMap.stats.signalsUpdated', {
                defaultValue: 'Signals updated',
              })}
              : {eventsUpdatedAt}
            </Tag>
          ) : null}
          {newsUpdatedAt ? (
            <Tag color="default" className="text-xs">
              {t('dashboard.charts.warMap.stats.newsUpdated', {
                defaultValue: 'News updated',
              })}
              : {newsUpdatedAt}
            </Tag>
          ) : null}
        </Space>
        <Space size={6} wrap>
          {WAR_MAP_PRESETS.map((preset) => (
            <Button
              key={preset}
              size="small"
              type={activePreset === preset ? 'primary' : 'default'}
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
              type={timeRangePreset === preset ? 'primary' : 'default'}
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
        <Popover
          content={layerSelector}
          title={t('dashboard.charts.warMap.layers', { defaultValue: 'Layers' })}
          trigger="click"
          placement="bottomRight"
        >
          <Button size="small" type="default" icon={<SettingOutlined />} />
        </Popover>
      </div>

      <div ref={mapContainerRef} className="h-full w-full overflow-hidden rounded-lg" />

      {useDesktopInspector && clusterPanelContent ? (
        <div className="absolute bottom-4 right-4 top-16 z-20 hidden w-[360px] lg:block">
          {clusterPanelContent}
        </div>
      ) : null}

      {!useDesktopInspector ? (
        <Drawer
          open={Boolean(clusterPanelContent)}
          onClose={closeSelectedCluster}
          placement="right"
          width="100%"
          destroyOnClose={false}
          title={null}
        >
          {clusterPanelContent}
        </Drawer>
      ) : null}

      {anyLoading && !hasData ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Skeleton active paragraph={{ rows: 6 }} />
        </div>
      ) : null}

      {!anyLoading && errors.length > 0 && !hasData ? (
        <div className="absolute inset-0">
          <ChartEmptyState
            variant="error"
            title={t('dashboard.dataAbnormal', { defaultValue: 'Data error' })}
            description={
              getErrorMessage(errors[0]) ??
              t('common.serviceUnavailable', {
                defaultValue: 'Service is unavailable. Please try again.',
              })
            }
            actionLabel={t('dashboard.actions.retryFetch', {
              defaultValue: 'Retry fetch',
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
            description={t('pages.map.empty', {
              defaultValue: 'No alerts or geo-tagged news signals in the selected range.',
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
            actionLabel={t('common.retry', { defaultValue: 'Retry' })}
            onAction={retryMapLoad}
          />
        </div>
      ) : null}

      {!mapLoadError && !mapReady ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Skeleton active paragraph={{ rows: 4 }} />
        </div>
      ) : null}
    </div>
  );
}
