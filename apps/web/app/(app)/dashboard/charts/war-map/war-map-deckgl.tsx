'use client';

import { SettingOutlined } from '@ant-design/icons';
import { PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
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
import { Button, Checkbox, Popover, Skeleton, Space, Tag, Tooltip } from 'antd';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import { useSession } from 'next-auth/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ChartEmptyState } from '@/components/chart-empty-state';
import { RequestErrorBanner } from '@/components/request-error-banner';
import { createApiClient } from '@/lib/api-client';
import { formatDateTime, formatUpdatedAt, resolveLocale } from '@/lib/i18n';
import { safeHttpUrl } from '@/lib/url';
import { useSituationMonitorMonitorsStore } from '@/store/situation-monitor-monitors';
import { useDashboardRangeStore } from '@/store/time-range';
import { useWarMapSettingsStore } from '@/store/war-map-settings';

import { buildWarMapQueryBbox } from './query-viewport';
import { readWarMapUrlState, writeWarMapUrlState } from './url-state';

const MAP_STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const DEFAULT_MAP_BBOX: [number, number, number, number] = [-180, -85, 180, 85];
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
  url?: string | null;
  publishedAt?: string;
  query?: string;
  kind: 'event' | 'news' | 'news-cluster' | 'event-cluster' | 'layer' | 'monitor';
  description?: string;
}

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

function extractBbox(map: MapLibreMap): [number, number, number, number] {
  const bounds = map.getBounds();
  if (!bounds) {
    return DEFAULT_MAP_BBOX;
  }
  return [
    clamp(bounds.getWest(), -180, 180),
    clamp(bounds.getSouth(), -90, 90),
    clamp(bounds.getEast(), -180, 180),
    clamp(bounds.getNorth(), -90, 90),
  ];
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

export function WarMapDeckGl({ className, translateTarget }: WarMapProps = {}) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);
  const syncFromMapRef = useRef(false);
  const hasHydratedUrlRef = useRef(false);

  const [inView, setInView] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [queryViewport, setQueryViewport] = useState<{
    bbox?: [number, number, number, number];
    zoom: number;
  }>({ zoom: 2 });

  const { start, end } = useDashboardRangeStore();
  const monitors = useSituationMonitorMonitorsStore((state) => state.monitors);

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

  const enabled = Boolean(session?.accessToken && inView);
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const effectiveRange = useMemo(() => {
    if (timeRangePreset === 'all') {
      return { start: ALL_TIME_START, end };
    }
    const duration = TIME_RANGE_MS[timeRangePreset];
    return {
      end,
      start: new Date(end.getTime() - duration),
    };
  }, [end, start, timeRangePreset]);

  const queryBbox = useMemo(() => {
    return buildWarMapQueryBbox(queryViewport.bbox, queryViewport.zoom);
  }, [queryViewport.bbox, queryViewport.zoom]);

  const eventsQuery = useQuery({
    queryKey: [
      'dashboard',
      'war-map',
      'deckgl',
      'events',
      effectiveRange.start.toISOString(),
      effectiveRange.end.toISOString(),
      queryBbox ?? null,
      queryViewport.zoom,
      translateTarget ?? null,
    ],
    queryFn: async () => {
      const response = await apiClient.get<WarMapEventsResponse>('dashboard/war-map/events', {
        params: {
          start: effectiveRange.start.toISOString(),
          end: effectiveRange.end.toISOString(),
          translate: translateTarget,
          bbox: queryBbox,
          zoom: queryViewport.zoom.toFixed(2),
          cluster: '1',
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
      'deckgl',
      'news-markers',
      effectiveRange.start.toISOString(),
      effectiveRange.end.toISOString(),
      queryBbox ?? null,
      queryViewport.zoom,
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
            zoom: queryViewport.zoom.toFixed(2),
            cluster: '1',
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
      'deckgl',
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
    if (!mapContainerRef.current || !inView || mapRef.current) {
      return;
    }

    const initialViewState = viewStateRef.current;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE_URL,
      center: [initialViewState.lon, initialViewState.lat],
      zoom: initialViewState.zoom,
      bearing: initialViewState.bearing,
      pitch: initialViewState.pitch,
      renderWorldCopies: false,
      attributionControl: false,
    });

    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
    });
    map.addControl(overlay);

    const syncFromMap = () => {
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
        bbox: extractBbox(map),
        zoom: map.getZoom(),
      });
      window.setTimeout(() => {
        syncFromMapRef.current = false;
      }, 0);
    };

    map.on('load', () => {
      const projectionAwareMap = map as unknown as {
        setProjection?: (projection: { type: 'mercator' | 'globe' }) => void;
      };
      projectionAwareMap.setProjection?.({ type: 'mercator' });
      setMapReady(true);
      syncFromMap();
    });

    map.on('moveend', syncFromMap);

    mapRef.current = map;
    deckOverlayRef.current = overlay;

    return () => {
      map.off('moveend', syncFromMap);
      deckOverlayRef.current = null;
      mapRef.current = null;
      map.remove();
      setMapReady(false);
    };
  }, [inView, setViewState]);

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
    if (parsed.renderer === 'echarts') {
      toast.info(
        t('dashboard.charts.warMap.renderer.echartsDeprecated', {
          defaultValue: 'ECharts renderer has been removed. Switched to deck.gl.',
        }),
      );
    }
    if (parsed.viewState) {
      setViewState(parsed.viewState);
    }

    hasHydratedUrlRef.current = true;
  }, [setActivePreset, setLayerVisibility, setTimeRangePreset, setViewState, t]);

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
        renderer: 'deckgl',
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
            monitor.keywords.find((keyword) => keyword.trim().length > 0)?.trim() ??
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

  const deckData = useMemo(() => {
    const layersData = layersQuery.data?.layers ?? {};
    const events = eventsQuery.data?.events ?? [];
    const newsMarkers = newsQuery.data?.markers ?? [];

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
        (typeof minZoom !== 'number' || queryViewport.zoom >= minZoom) &&
        (typeof maxZoom !== 'number' || queryViewport.zoom <= maxZoom);
      if (!isZoomVisible) {
        continue;
      }

      if (dataset.geometryType === 'path') {
        const paths = dataset.features.filter(
          (feature): feature is WarMapLayerFeature & { path: [number, number][] } =>
            Array.isArray(feature.path) && feature.path.length >= 2,
        );
        if (paths.length > 0) {
          staticLayers.push(
            new PathLayer({
              id: `wm-path-${layerId}`,
              data: paths,
              pickable: Boolean(dataset.renderHints?.pickable ?? true),
              getPath: (feature: WarMapLayerFeature & { path: [number, number][] }) => feature.path,
              getColor: color,
              getWidth: 2,
              widthMinPixels: 1.4,
              widthMaxPixels: 5,
            }),
          );
        }
        continue;
      }

      if (dataset.geometryType === 'polygon') {
        const polygons = dataset.features.filter(
          (feature): feature is WarMapLayerFeature & { polygon: [number, number][][] } =>
            Array.isArray(feature.polygon) && feature.polygon.length > 0,
        );
        if (polygons.length > 0) {
          staticLayers.push(
            new PolygonLayer({
              id: `wm-polygon-${layerId}`,
              data: polygons,
              pickable: Boolean(dataset.renderHints?.pickable ?? true),
              getPolygon: (feature: WarMapLayerFeature & { polygon: [number, number][][] }) =>
                feature.polygon[0] ?? [],
              getFillColor: color,
              getLineColor: toRgba(dataset.renderHints?.color, 0.85, [59, 130, 246]),
              lineWidthMinPixels: 1,
              filled: true,
              stroked: true,
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
    const eventClusters: DeckPoint[] = [];
    for (const event of events) {
      if (!isValidLatLng(event.lat, event.lng)) {
        continue;
      }
      const label =
        translateTarget === 'zh-CN' && typeof event.nameZh === 'string'
          ? event.nameZh
          : event.name;
      const score =
        typeof event.derivedScore === 'number' ? event.derivedScore : event.value ?? 0;
      const point: DeckPoint = {
        id: event.id,
        lat: event.lat,
        lng: event.lng,
        label,
        kind: event.isCluster ? 'event-cluster' : 'event',
        color: event.isCluster ? [217, 119, 6, 208] : severityColor(event.severity),
        radius: event.isCluster
          ? Math.max(12, Math.min(42, Math.sqrt(event.clusterCount ?? 1) * 7))
          : Math.max(5, Math.min(24, Math.sqrt(Math.max(1, score)) * 2.5)),
        isCluster: event.isCluster,
        clusterCount: event.clusterCount,
      };
      if (event.isCluster) {
        eventClusters.push(point);
      } else {
        eventPoints.push(point);
      }
    }

    const newsPoints: DeckPoint[] = [];
    const newsClusters: DeckPoint[] = [];
    for (const marker of newsMarkers) {
      if (!isValidLatLng(marker.lat, marker.lng)) {
        continue;
      }
      const label =
        translateTarget === 'zh-CN' && typeof marker.titleZh === 'string'
          ? marker.titleZh
          : marker.title;
      const baseColor = marker.geoSource === 'fallback-country' ? [8, 145, 178] : [5, 150, 105];
      const [baseR = 8, baseG = 145, baseB = 178] = baseColor;
      const point: DeckPoint = {
        id: marker.id,
        lat: marker.lat,
        lng: marker.lng,
        label,
        kind: marker.isCluster ? 'news-cluster' : 'news',
        color: marker.isCluster
          ? [21, 128, 61, 204]
          : [baseR, baseG, baseB, marker.geoSource === 'fallback-country' ? 110 : 200],
        radius: marker.isCluster
          ? Math.max(12, Math.min(42, Math.sqrt(marker.clusterCount ?? 1) * 7))
          : 5,
        isCluster: marker.isCluster,
        clusterCount: marker.clusterCount,
        url: marker.url ?? null,
        publishedAt: marker.publishedAt,
      };
      if (marker.isCluster) {
        newsClusters.push(point);
      } else {
        newsPoints.push(point);
      }
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
            if (!object || !mapRef.current) {
              return;
            }
            mapRef.current.easeTo({
              center: [object.lng, object.lat],
              zoom: Math.min(8, mapRef.current.getZoom() + 2),
              duration: 350,
            });
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
            if (!object || !mapRef.current) {
              return;
            }
            mapRef.current.easeTo({
              center: [object.lng, object.lat],
              zoom: Math.min(9, mapRef.current.getZoom() + 2),
              duration: 350,
            });
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
            const safeUrl = typeof object.url === 'string' ? safeHttpUrl(object.url) : null;
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
        }),
      );
    }

    return {
      deckLayers,
      eventsCount: eventPoints.length,
      eventClustersCount: eventClusters.length,
      newsCount: newsPoints.length,
      newsClustersCount: newsClusters.length,
      staticVisibleCount: staticLayers.length,
    };
  }, [
    eventsQuery.data?.events,
    layerVisibility,
    layersQuery.data?.layers,
    monitorPoints,
    newsQuery.data?.markers,
    queryViewport.zoom,
    t,
    translateTarget,
  ]);

  const tooltipGetter = useMemo(
    () =>
      ({ object }: { object?: DeckPoint }) => {
        if (!object) {
          return null;
        }
        if (object.kind === 'event-cluster' || object.kind === 'news-cluster') {
          const count = object.clusterCount ?? 0;
          return {
            text: t('dashboard.charts.warMap.tooltip.cluster', {
              defaultValue: `Cluster (${count})`,
              count,
            }),
          };
        }

        const published = object.publishedAt
          ? formatDateTime(object.publishedAt, locale, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })
          : null;

        const lines = [object.label];
        if (object.description) {
          lines.push(object.description);
        }
        if (published) {
          lines.push(
            `${t('dashboard.charts.warMap.tooltip.published', {
              defaultValue: 'Published',
            })}: ${published}`,
          );
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
    deckOverlayRef.current.setProps({
      layers: deckData.deckLayers,
      getTooltip: tooltipGetter,
    });
  }, [deckData.deckLayers, tooltipGetter]);

  const anyLoading = eventsQuery.isLoading || newsQuery.isLoading || layersQuery.isLoading;
  const errors = [eventsQuery.error, newsQuery.error, layersQuery.error].filter(Boolean);
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
            onRetry={() => {
              void eventsQuery.refetch();
              void newsQuery.refetch();
              void layersQuery.refetch();
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
            {t('dashboard.charts.warMap.stats.signals', { defaultValue: 'Signals' })}: {deckData.eventsCount}
          </Tag>
          <Tag color="gold" className="text-xs">
            {t('dashboard.charts.warMap.stats.signalClusters', {
              defaultValue: 'Signal clusters',
            })}
            : {deckData.eventClustersCount}
          </Tag>
          <Tag color="green" className="text-xs">
            {t('dashboard.charts.warMap.stats.news', { defaultValue: 'News' })}: {deckData.newsCount}
          </Tag>
          <Tag color="lime" className="text-xs">
            {t('dashboard.charts.warMap.stats.newsClusters', {
              defaultValue: 'News clusters',
            })}
            : {deckData.newsClustersCount}
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
        <Tooltip
          title={t('dashboard.charts.warMap.renderer.deckglMapLibre', {
            defaultValue: 'Renderer: deck.gl + MapLibre',
          })}
        >
          <Tag color="processing" className="text-xs">
            deckgl
          </Tag>
        </Tooltip>
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
            actionLabel={t('common.retry', { defaultValue: 'Retry' })}
            onAction={() => {
              void eventsQuery.refetch();
              void newsQuery.refetch();
              void layersQuery.refetch();
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

      {!mapReady ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Skeleton active paragraph={{ rows: 4 }} />
        </div>
      ) : null}
    </div>
  );
}
