"use client";

import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import { useQuery } from "@tanstack/react-query";
import { Button, Drawer, List, Skeleton, Space, Tag, Typography } from "antd";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ArticlePublishedTime } from "@/components/article-published-time";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { usePendingAction } from "@/hooks/use-pending-action";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { classifyMapLoadError, type MapLoadErrorPresentation } from "@/lib/map/map-load-error";
import { createDeckMapRuntime, setDeckOverlayProps, type DeckMapRuntime } from "@/lib/map/map-runtime";
import { MAP_STYLE_URL } from "@/lib/map/map-style";
import { useRenderableContainer } from "@/lib/map/use-renderable-container";
import { safeHttpUrl } from "@/lib/url";
import { useDashboardRangeStore } from "@/store/time-range";

import {
  canLoadMoreArticles,
  type CursorBucketGranularity,
  inferBucketGranularityFromStarts,
  resolveArticleLimit,
  resolveBucketGranularityKey,
  resolveTooltipBucketEndIso,
  SPACETIME_GEO_ARTICLES_MAX_LIMIT,
  SPACETIME_GEO_ARTICLES_PAGE_SIZE,
} from "./spacetime-geo-heatmap-utils";

type SentimentLabel = "positive" | "neutral" | "negative" | "unknown";

interface SpacetimeGeoHeatPointBucket {
  bucketStart: string;
  total: number;
  sentiment: Record<SentimentLabel, number>;
}

interface SpacetimeGeoHeatPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  heat: number;
  total: number;
  sentiment: Record<SentimentLabel, number>;
  buckets?: SpacetimeGeoHeatPointBucket[];
}

interface SpacetimeGeoHeatmapResponse {
  points: SpacetimeGeoHeatPoint[];
  snapshotId?: string;
  updatedAt?: string;
}

interface SpacetimeGeoHeatmapArticle {
  id: string;
  title: string;
  url?: string | null;
  sourceLabel?: string | null;
  location?: string | null;
  publishedAt?: string;
  ingestedAt?: string;
  processedAt?: string;
  sentiment?: SentimentLabel;
}

interface SpacetimeGeoHeatmapArticlesResponse {
  pointId: string;
  bucketStart?: string;
  hasMore: boolean;
  articles: SpacetimeGeoHeatmapArticle[];
  updatedAt?: string;
}

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
  [key: string]: unknown;
}

interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
  [key: string]: unknown;
}

interface WarMapGeoJsonResponse {
  name: string;
  geoJson: GeoJsonFeatureCollection;
  center?: [number, number];
  zoom?: number;
}

interface SpacetimeDeckPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  viewHeat: number;
  viewTotal: number;
  viewSentiment: Record<SentimentLabel, number>;
  viewBucketStart: string | null;
  dominant: SentimentLabel;
}

const getApiErrorMessage = (error: unknown): string | undefined => {
  if (!error) return undefined;
  if (error instanceof Error) {
    const withResponse = error as Error & {
      response?: {
        data?: {
          message?: string;
          error?: { code?: string; message?: string };
        };
      };
    };
    const data = withResponse.response?.data;
    if (data?.error?.message) {
      return data.error.message;
    }
    if (data?.message) {
      return data.message;
    }
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return undefined;
};

function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

function parseHexColor(color: string): [number, number, number] | null {
  const trimmed = color.trim();
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const r = Number.parseInt(hex.charAt(0) + hex.charAt(0), 16);
    const g = Number.parseInt(hex.charAt(1) + hex.charAt(1), 16);
    const b = Number.parseInt(hex.charAt(2) + hex.charAt(2), 16);
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
  return [r, g, b, Math.max(0, Math.min(255, Math.round(alpha * 255)))];
}

function createSentimentCounts(): Record<SentimentLabel, number> {
  return {
    positive: 0,
    neutral: 0,
    negative: 0,
    unknown: 0,
  };
}

function resolveDominantSentiment(
  sentiment: Record<SentimentLabel, number>,
): SentimentLabel {
  const candidates: SentimentLabel[] = [
    "positive",
    "neutral",
    "negative",
    "unknown",
  ];
  let best: SentimentLabel = "unknown";
  let bestValue = -1;
  for (const key of candidates) {
    const value = sentiment[key] ?? 0;
    if (value > bestValue) {
      bestValue = value;
      best = key;
    }
  }
  return best;
}

function resolveSentimentColor(
  label: SentimentLabel,
  colors: Record<string, string> | undefined,
): [number, number, number, number] {
  switch (label) {
    case "positive":
      return toRgba(colors?.bullish, 0.9, [22, 163, 74]);
    case "negative":
      return toRgba(colors?.bearish, 0.9, [239, 68, 68]);
    case "neutral":
      return toRgba(colors?.accent, 0.86, [245, 158, 11]);
    default:
      return toRgba(colors?.border, 0.75, [148, 163, 184]);
  }
}

function resolveHeatColor(
  weight: number,
  maxWeight: number,
): [number, number, number, number] {
  const safeMax = Math.max(1, maxWeight);
  const ratio = Math.max(0, Math.min(1, weight / safeMax));
  if (ratio >= 0.8) {
    return [235, 47, 150, 120];
  }
  if (ratio >= 0.55) {
    return [250, 173, 20, 108];
  }
  if (ratio >= 0.3) {
    return [31, 59, 123, 96];
  }
  return [31, 59, 123, 65];
}

export interface SpacetimeGeoHeatmapProps {
  eventId?: string | null;
  followCursor?: boolean;
  cursorBucketStartIso?: string | null;
  cursorBucketEndIso?: string | null;
  cursorBucketGranularity?: CursorBucketGranularity | null;
  liveStreamActive?: boolean;
}

export function SpacetimeGeoHeatmap({
  eventId,
  followCursor,
  cursorBucketStartIso,
  cursorBucketEndIso,
  cursorBucketGranularity,
  liveStreamActive = false,
}: SpacetimeGeoHeatmapProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();
  const { range, start, end } = useDashboardRangeStore();
  const { colors } = useChartTheme();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const runtimeRef = useRef<DeckMapRuntime | null>(null);
  const hasAlignedGeoViewRef = useRef(false);

  const [inView, setInView] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapLoadError, setMapLoadError] = useState<MapLoadErrorPresentation | null>(null);
  const [mapMountNonce, setMapMountNonce] = useState(0);
  const hasRenderableMapContainer = useRenderableContainer(mapContainerRef, inView);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [articlePageState, setArticlePageState] = useState<{
    scopeKey: string;
    page: number;
  }>({
    scopeKey: "",
    page: 1,
  });
  const [selectedPoint, setSelectedPoint] = useState<{
    id: string;
    name: string;
    snapshotId: string | null;
  } | null>(null);

  useEffect(() => {
    const dom = containerRef.current;
    if (!dom) {
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
      { rootMargin: "250px" },
    );

    observer.observe(dom);
    return () => observer.disconnect();
  }, []);

  const enabled = Boolean(session?.accessToken && inView && hasRenderableMapContainer);
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const includeBuckets = Boolean(followCursor && cursorBucketStartIso);
  const cursorBucketIso = cursorBucketStartIso?.trim() ?? "";
  const cursorBucketEnd = cursorBucketEndIso?.trim() ?? "";

  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const windowLabel = `${formatDateTime(startIso, locale, {
    dateStyle: "medium",
  })} - ${formatDateTime(endIso, locale, { dateStyle: "medium" })}`;
  const windowLabelShort = `${startIso.slice(0, 10)} - ${endIso.slice(0, 10)}`;

  const heatmapQueryKey = useMemo(() => {
    if (!eventId && !includeBuckets) {
      return ["dashboard", "spacetime", "geo-heatmap", startIso, endIso] as const;
    }
    const key: (string | null | undefined)[] = [
      "dashboard",
      "spacetime",
      "geo-heatmap",
    ];
    if (eventId) {
      key.push("event", eventId);
    } else {
      key.push("global");
    }
    key.push(startIso, endIso);
    if (includeBuckets) {
      key.push("buckets");
    }
    return key;
  }, [endIso, eventId, includeBuckets, startIso]);

  const geoQuery = useQuery({
    queryKey: ["dashboard", "war-map", "geojson"],
    queryFn: async () => {
      const response = await apiClient.get<WarMapGeoJsonResponse>(
        "dashboard/war-map/geojson",
      );
      return response.data;
    },
    staleTime: 60 * 60 * 1000,
    enabled,
  });

  const heatmapQuery = useQuery({
    queryKey: heatmapQueryKey,
    queryFn: async () => {
      const response = await apiClient.get<SpacetimeGeoHeatmapResponse>(
        "dashboard/spacetime/geo-heatmap",
        {
          params: {
            start: startIso,
            end: endIso,
            ...(eventId ? { eventId } : {}),
            ...(includeBuckets ? { includeBuckets: "1" } : {}),
          },
        },
      );
      return response.data;
    },
    staleTime: 30_000,
    refetchInterval:
      liveStreamActive || !(eventId || includeBuckets) ? false : 20_000,
    enabled,
    placeholderData: (previous) => previous,
  });

  const drilldownBucketStart = includeBuckets ? cursorBucketIso : "";
  const articlePageScopeKey = useMemo(() => {
    if (!selectedPoint || !drawerOpen) {
      return "";
    }
    return [
      selectedPoint.id,
      selectedPoint.snapshotId ?? "none",
      eventId ?? "global",
      startIso,
      endIso,
      drilldownBucketStart || "all",
    ].join("|");
  }, [drawerOpen, drilldownBucketStart, endIso, eventId, selectedPoint, startIso]);

  const articlePage =
    articlePageScopeKey && articlePageState.scopeKey === articlePageScopeKey
      ? articlePageState.page
      : 1;
  const currentArticlesLimit = resolveArticleLimit(
    articlePage,
    SPACETIME_GEO_ARTICLES_PAGE_SIZE,
    SPACETIME_GEO_ARTICLES_MAX_LIMIT,
  );

  const articlesQueryKey = useMemo(() => {
    if (!selectedPoint) {
      return ["dashboard", "spacetime", "geo-heatmap", "articles", "none"] as const;
    }

    const key: (string | number | null | undefined)[] = [
      "dashboard",
      "spacetime",
      "geo-heatmap",
      "articles",
      selectedPoint.id,
    ];
    key.push("snapshot", selectedPoint.snapshotId ?? "none");
    if (eventId) {
      key.push("event", eventId);
    } else {
      key.push("global");
    }
    key.push(startIso, endIso);
    if (drilldownBucketStart) {
      key.push("bucket", drilldownBucketStart);
    }
    key.push("limit", currentArticlesLimit);
    return key;
  }, [currentArticlesLimit, drilldownBucketStart, endIso, eventId, selectedPoint, startIso]);

  const articlesQueryEnabled = Boolean(enabled && drawerOpen && selectedPoint?.id);
  const articlesQuery = useQuery({
    queryKey: articlesQueryKey,
    queryFn: async () => {
      if (!selectedPoint) {
        return null;
      }
      const response = await apiClient.get<SpacetimeGeoHeatmapArticlesResponse>(
        "dashboard/spacetime/geo-heatmap/articles",
        {
          params: {
            start: startIso,
            end: endIso,
            pointId: selectedPoint.id,
            ...(selectedPoint.snapshotId ? { snapshotId: selectedPoint.snapshotId } : {}),
            ...(eventId ? { eventId } : {}),
            ...(drilldownBucketStart ? { bucketStart: drilldownBucketStart } : {}),
            limit: currentArticlesLimit,
          },
        },
      );
      return response.data;
    },
    enabled: articlesQueryEnabled,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const destroyMapRuntime = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    runtimeRef.current = null;
    overlayRef.current = null;
    mapRef.current = null;
    hasAlignedGeoViewRef.current = false;
    runtime.destroy();
    setMapReady(false);
  }, []);
  const retryMapLoad = useCallback(() => {
    destroyMapRuntime();
    setMapLoadError(null);
    setMapReady(false);
    setMapMountNonce((value) => value + 1);
  }, [destroyMapRuntime]);

  useEffect(() => {
    if (!mapContainerRef.current || !inView || !hasRenderableMapContainer || runtimeRef.current) {
      return;
    }

    setMapLoadError(null);
    const runtime = createDeckMapRuntime({
      container: mapContainerRef.current,
      initialViewState: {
        lat: 20,
        lon: 0,
        zoom: 1.1,
        bearing: 0,
        pitch: 0,
      },
      style: MAP_STYLE_URL,
      onMapReady: () => {
        setMapLoadError(null);
        setMapReady(true);
      },
      onMapError: (_map, detail) => {
        captureClientError("Spacetime geo heatmap basemap load failed", detail.error ?? detail);
        const presentation = classifyMapLoadError(detail);
        setMapReady(false);
        setMapLoadError(presentation);
        toast.error(`${presentation.title}. ${presentation.rawMessage ?? presentation.description}`);
      },
    });

    runtimeRef.current = runtime;
    mapRef.current = runtime.map;
    overlayRef.current = runtime.overlay;
  }, [hasRenderableMapContainer, inView, mapMountNonce]);

  useEffect(() => {
    if (inView) {
      return;
    }

    destroyMapRuntime();
  }, [destroyMapRuntime, inView]);

  useEffect(() => () => {
    destroyMapRuntime();
  }, [destroyMapRuntime]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !geoQuery.data || hasAlignedGeoViewRef.current) {
      return;
    }

    const center = geoQuery.data.center;
    const zoom = geoQuery.data.zoom;

    if (center || typeof zoom === "number") {
      map.easeTo({
        center: center ?? [0, 20],
        zoom: typeof zoom === "number" ? zoom : map.getZoom(),
        duration: 350,
        essential: true,
      });
    }

    map.resize();
    hasAlignedGeoViewRef.current = true;
  }, [geoQuery.data, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !inView || !hasRenderableMapContainer) {
      return;
    }
    map.resize();
  }, [hasRenderableMapContainer, inView, mapReady]);

  const rawPoints = useMemo(
    () => heatmapQuery.data?.points ?? [],
    [heatmapQuery.data?.points],
  );
  const effectiveBucketGranularity = useMemo<
    Exclude<CursorBucketGranularity, "auto">
  >(() => {
    if (!includeBuckets) {
      return "day";
    }
    if (cursorBucketGranularity && cursorBucketGranularity !== "auto") {
      return cursorBucketGranularity;
    }
    const bucketStarts = rawPoints.flatMap((point) =>
      (point.buckets ?? []).map((bucket) => bucket.bucketStart),
    );
    return inferBucketGranularityFromStarts(bucketStarts);
  }, [cursorBucketGranularity, includeBuckets, rawPoints]);

  const viewPoints = useMemo<SpacetimeDeckPoint[]>(() => {
    if (!includeBuckets || !cursorBucketIso) {
      return rawPoints.map((point) => ({
        id: point.id,
        name: point.name,
        lat: point.lat,
        lng: point.lng,
        viewHeat: point.heat,
        viewTotal: point.total,
        viewSentiment: point.sentiment,
        viewBucketStart: null,
        dominant: resolveDominantSentiment(point.sentiment),
      }));
    }

    return rawPoints.map((point) => {
      const bucket =
        point.buckets?.find((entry) => entry.bucketStart === cursorBucketIso) ?? null;
      const viewTotal = bucket?.total ?? 0;
      const viewSentiment = bucket?.sentiment ?? createSentimentCounts();
      return {
        id: point.id,
        name: point.name,
        lat: point.lat,
        lng: point.lng,
        viewHeat: viewTotal,
        viewTotal,
        viewSentiment,
        viewBucketStart: cursorBucketIso,
        dominant: resolveDominantSentiment(viewSentiment),
      };
    });
  }, [cursorBucketIso, includeBuckets, rawPoints]);

  const visiblePoints = useMemo(
    () =>
      viewPoints.filter(
        (point) =>
          point.viewTotal > 0 &&
          Number.isFinite(point.viewHeat) &&
          isValidLatLng(point.lat, point.lng),
      ),
    [viewPoints],
  );

  const maxHeat = useMemo(
    () =>
      visiblePoints.reduce(
        (acc, point) => Math.max(acc, Number(point.viewHeat ?? 0)),
        0,
      ),
    [visiblePoints],
  );

  const boundaryLayers = useMemo<any[]>(
    () =>
      geoQuery.data?.geoJson
        ? [
            new GeoJsonLayer({
              id: "spacetime-geo-boundaries",
              data: geoQuery.data.geoJson as any,
              pickable: false,
              stroked: true,
              filled: true,
              lineWidthMinPixels: 1,
              getLineColor: [148, 163, 184, 170],
              getFillColor: [148, 163, 184, 45],
            }),
          ]
        : [],
    [geoQuery.data?.geoJson],
  );
  const pointLayers = useMemo<any[]>(() => {
    if (visiblePoints.length === 0) {
      return [];
    }

    return [
      new ScatterplotLayer<SpacetimeDeckPoint>({
        id: "spacetime-geo-heat",
        data: visiblePoints,
        pickable: false,
        radiusUnits: "meters",
        getPosition: (point) => [point.lng, point.lat],
        getRadius: (point) =>
          Math.max(
            30_000,
            Math.min(220_000, 30_000 + Math.sqrt(Math.max(1, point.viewHeat)) * 18_000),
          ),
        getFillColor: (point) => resolveHeatColor(point.viewHeat, maxHeat),
        stroked: false,
      }),
      new ScatterplotLayer<SpacetimeDeckPoint>({
        id: "spacetime-geo-points",
        data: visiblePoints,
        pickable: true,
        autoHighlight: true,
        getPosition: (point) => [point.lng, point.lat],
        getFillColor: (point) => resolveSentimentColor(point.dominant, colors),
        getRadius: (point) =>
          Math.max(6, Math.min(26, 6 + Math.sqrt(Math.max(1, point.viewTotal)) * 4)),
        radiusMinPixels: 6,
        radiusMaxPixels: 26,
        stroked: true,
        lineWidthMinPixels: 1,
        getLineColor: [255, 255, 255, 180],
        onClick: (info) => {
          const point = info.object as SpacetimeDeckPoint | undefined;
          if (!point) {
            return;
          }
          setSelectedPoint({
            id: point.id,
            name: point.name,
            snapshotId: heatmapQuery.data?.snapshotId ?? null,
          });
          setArticlePageState({ scopeKey: "", page: 1 });
          setDrawerOpen(true);
        },
      }),
    ];
  }, [colors, heatmapQuery.data?.snapshotId, maxHeat, visiblePoints]);
  const deckLayers = useMemo<any[]>(
    () => [...boundaryLayers, ...pointLayers],
    [boundaryLayers, pointLayers],
  );

  const tooltipGetter = useMemo(
    () =>
      ({ object }: { object?: unknown }) => {
        const point = object as SpacetimeDeckPoint | undefined;
        if (!point) {
          return null;
        }

        const bucketStart = point.viewBucketStart;
        const bucketStartLabel = bucketStart
          ? formatDateTime(bucketStart, locale, { dateStyle: "medium" })
          : null;
        const bucketEndIso = bucketStart
          ? resolveTooltipBucketEndIso({
              bucketStart,
              cursorBucketStartIso: cursorBucketIso,
              cursorBucketEndIso: cursorBucketEnd,
              granularity: effectiveBucketGranularity,
            })
          : null;
        const bucketEndLabel = bucketEndIso
          ? formatDateTime(bucketEndIso, locale, { dateStyle: "medium" })
          : null;
        const bucketLabel =
          bucketStartLabel && bucketEndLabel
            ? `${bucketStartLabel} - ${bucketEndLabel}`
            : bucketStartLabel;

        const bucketGranularityLabel = t(
          `dashboard.charts.spacetimeGeoHeatmap.granularity.${resolveBucketGranularityKey(effectiveBucketGranularity)}`,
          { defaultValue: resolveBucketGranularityKey(effectiveBucketGranularity) },
        );

        const sentiment = point.viewSentiment;
        const pos = Number(sentiment.positive ?? 0);
        const neu = Number(sentiment.neutral ?? 0);
        const neg = Number(sentiment.negative ?? 0);
        const unk = Number(sentiment.unknown ?? 0);

        const totalSentiment = pos + neu + neg + unk;
        const normalizedBase = pos + neu + neg;
        const normalizedSentiment =
          normalizedBase > 0 ? (pos - neg) / normalizedBase : 0;
        const normalizedSentimentText = `${
          normalizedSentiment >= 0 ? "+" : ""
        }${normalizedSentiment.toFixed(3)}`;

        const ratio = (value: number) =>
          totalSentiment > 0 ? Math.round((value / totalSentiment) * 100) : 0;

        const lines = [
          point.name,
          `${t("dashboard.charts.spacetimeGeoHeatmap.tooltip.window")}: ${windowLabel}`,
        ];

        if (bucketLabel) {
          lines.push(
            `${t("dashboard.charts.spacetimeGeoHeatmap.tooltip.bucket")}: ${bucketLabel} (${bucketGranularityLabel})`,
          );
        }

        lines.push(
          `${t("dashboard.charts.spacetimeGeoHeatmap.tooltip.articles")}: ${point.viewTotal}`,
        );
        lines.push(
          `${t("dashboard.charts.spacetimeGeoHeatmap.tooltip.sentimentIndex")}: ${normalizedSentimentText}`,
        );
        lines.push(
          `${t("items.sentiment.positive")}: ${pos} (${ratio(
            pos,
          )}%)`,
        );
        lines.push(
          `${t("items.sentiment.neutral")}: ${neu} (${ratio(
            neu,
          )}%)`,
        );
        lines.push(
          `${t("items.sentiment.negative")}: ${neg} (${ratio(
            neg,
          )}%)`,
        );
        lines.push(
          `${t("common.unknown")}: ${unk} (${ratio(unk)}%)`,
        );

        return { text: lines.join("\n") };
      },
    [
      cursorBucketEnd,
      cursorBucketIso,
      effectiveBucketGranularity,
      locale,
      t,
      windowLabel,
    ],
  );

  useEffect(() => {
    if (!overlayRef.current) {
      return;
    }
    setDeckOverlayProps(overlayRef.current, {
      layers: hasRenderableMapContainer ? deckLayers : [],
      getTooltip: tooltipGetter,
    });
  }, [deckLayers, hasRenderableMapContainer, tooltipGetter]);

  const updatedAtLabel = useMemo(() => {
    const iso = heatmapQuery.data?.updatedAt;
    if (!iso) return null;
    return formatDateTime(iso, locale, { dateStyle: "medium", timeStyle: "short" });
  }, [heatmapQuery.data?.updatedAt, locale]);

  const drilldownUpdatedAtLabel = useMemo(() => {
    const iso = articlesQuery.data?.updatedAt;
    if (!iso) return null;
    return formatDateTime(iso, locale, { dateStyle: "medium", timeStyle: "short" });
  }, [articlesQuery.data?.updatedAt, locale]);
  const { pending: refreshingGeo, run: refreshGeo } = usePendingAction(
    () => geoQuery.refetch(),
  );
  const { pending: refreshingHeatmap, run: refreshHeatmap } = usePendingAction(
    () => heatmapQuery.refetch(),
  );
  const { pending: refreshingArticles, run: refreshArticles } = usePendingAction(
    () => articlesQuery.refetch(),
  );

  const geoErrorMessage = getApiErrorMessage(geoQuery.error);
  const hasHeatmapData = Boolean(heatmapQuery.data);
  const showHeatmapErrorBanner = Boolean(heatmapQuery.error);
  const showGeoErrorBanner = Boolean(geoQuery.error && geoQuery.data);

  if (geoQuery.isLoading && !geoQuery.data) {
    return (
      <div ref={containerRef} className="h-full flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (geoQuery.isError && !geoQuery.data) {
    return (
      <div ref={containerRef} className="h-full">
        <ChartEmptyState
          variant="error"
          title={t("dashboard.charts.spacetimeGeoHeatmap.geoFailedTitle")}
          description={
            geoErrorMessage ?? t("dashboard.dataAbnormal")
          }
          actionLabel={t("dashboard.actions.retryFetch")}
          actionLoading={refreshingGeo}
          onAction={() => {
            void refreshGeo();
          }}
        />
      </div>
    );
  }

  const hasVisiblePoints = includeBuckets
    ? visiblePoints.length > 0
    : rawPoints.length > 0;

  const drilldownTitle =
    selectedPoint?.name ??
    t("dashboard.charts.spacetimeGeoHeatmap.details");

  return (
    <>
      <div ref={containerRef} className="h-full flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Space size="small" wrap>
            <Tag color={enabled ? "green" : "default"}>
              {enabled
                ? t("dashboard.charts.spacetimeGeoHeatmap.active")
                : t("dashboard.charts.spacetimeGeoHeatmap.inactive")}
            </Tag>
            <Tag color="default" className="text-xs">
              Range: {range}
            </Tag>
            <Tag color="default" className="text-xs">
              Window: {windowLabelShort}
            </Tag>
            <Tag color="geekblue" className="text-xs">
              Aggregation: window (recency-weighted)
            </Tag>
            {includeBuckets && cursorBucketIso ? (
              <Tag color="purple">
                {t("dashboard.charts.spacetimeGeoHeatmap.bucket")}
                : {formatDateTime(cursorBucketIso, locale, { dateStyle: "medium" })}
              </Tag>
            ) : null}
            {updatedAtLabel ? (
              <Tag>
                {t("dashboard.updatedAt")}: {updatedAtLabel}
              </Tag>
            ) : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("dashboard.charts.spacetimeGeoHeatmap.caption")}
          </Typography.Text>
        </div>

        {showGeoErrorBanner && geoQuery.error ? (
          <RequestErrorBanner
            error={geoQuery.error}
            onRetry={() => {
              void refreshGeo();
            }}
            actionLoading={refreshingGeo}
            showCachedDataHint
          />
        ) : null}

        {showHeatmapErrorBanner && heatmapQuery.error ? (
          <RequestErrorBanner
            error={heatmapQuery.error}
            onRetry={() => {
              void refreshHeatmap();
            }}
            actionLoading={refreshingHeatmap}
            showCachedDataHint={hasHeatmapData}
          />
        ) : null}

        <div className="relative flex-1 min-h-0">
          <div ref={mapContainerRef} className="h-full w-full overflow-hidden rounded-lg" />

          {heatmapQuery.isLoading && !heatmapQuery.data ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Skeleton active paragraph={{ rows: 6 }} />
            </div>
          ) : null}

          {!heatmapQuery.isLoading && heatmapQuery.error && !hasHeatmapData ? (
            <div className="absolute inset-0">
              <ChartEmptyState
                variant="error"
                title={t("dashboard.dataAbnormal")}
                description={
                  getApiErrorMessage(heatmapQuery.error) ??
                  t("common.serviceUnavailable")
                }
                actionLabel={t("dashboard.actions.retryFetch")}
                actionLoading={refreshingHeatmap}
                onAction={() => {
                  void refreshHeatmap();
                }}
              />
            </div>
          ) : null}

          {!heatmapQuery.isLoading && !heatmapQuery.error && !hasVisiblePoints ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <ChartEmptyState
                title={t("dashboard.dataEmpty")}
                description={
                  includeBuckets
                    ? t("dashboard.charts.spacetimeGeoHeatmap.emptyBucket")
                    : t("dashboard.charts.spacetimeGeoHeatmap.empty")
                }
              />
            </div>
          ) : null}

          {mapLoadError ? (
            <div className="absolute inset-0">
              <ChartEmptyState
                variant="error"
                title={mapLoadError.title}
                description={mapLoadError.description}
                actionLabel={t("common.retry")}
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
      </div>

      <Drawer
        title={drilldownTitle}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setArticlePageState({ scopeKey: "", page: 1 });
        }}
        width={520}
      >
        <Space size="small" wrap style={{ marginBottom: 12 }}>
          {selectedPoint?.id ? <Tag>id: {selectedPoint.id}</Tag> : null}
          {drilldownBucketStart ? (
            <Tag color="purple">
              {t("dashboard.charts.spacetimeGeoHeatmap.bucket")}
              : {formatDateTime(drilldownBucketStart, locale, { dateStyle: "medium" })}
            </Tag>
          ) : null}
          {drilldownUpdatedAtLabel ? (
            <Tag>
              {t("dashboard.updatedAt")}: {drilldownUpdatedAtLabel}
            </Tag>
          ) : null}
        </Space>

        {articlesQuery.isLoading && !articlesQuery.data ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (() => {
            const payload = articlesQuery.data;
            const rawArticles = payload?.articles ?? [];
            const articles = Array.from(
              new Map(rawArticles.map((article) => [article.id, article])).values(),
            );
            const hasArticles = articles.length > 0;

            if (articlesQuery.error && !hasArticles) {
              return (
                <RequestErrorBanner
                  error={articlesQuery.error}
                  onRetry={() => {
                    void refreshArticles();
                  }}
                  actionLoading={refreshingArticles}
                  presentation="center"
                />
              );
            }

            if (!hasArticles) {
              return (
                <ChartEmptyState
                  title={t("dashboard.dataEmpty")}
                  description={t("dashboard.charts.spacetimeGeoHeatmap.noArticles")}
                />
              );
            }

            return (
              <>
                {articlesQuery.error ? (
                  <div className="mb-3">
                    <RequestErrorBanner
                      error={articlesQuery.error}
                      onRetry={() => {
                        void refreshArticles();
                      }}
                      actionLoading={refreshingArticles}
                      showCachedDataHint
                    />
                  </div>
                ) : null}

                <List
                  dataSource={articles}
                  renderItem={(article) => {
                    const url = safeHttpUrl(article.url);
                    const title = article.title?.trim() ?? "";
                    return (
                      <List.Item key={article.id}>
                        <List.Item.Meta
                          title={
                            url ? (
                              <a href={url} target="_blank" rel="noreferrer">
                                {title || url}
                              </a>
                            ) : (
                              <span>
                                {title ||
                                  t("common.emptyValue")}
                              </span>
                            )
                          }
                          description={
                            <Space direction="vertical" size={2}>
                              <Space size="small" wrap>
                                {article.sourceLabel ? (
                                  <Tag color="blue">{article.sourceLabel}</Tag>
                                ) : null}
                                {article.sentiment ? <Tag>{article.sentiment}</Tag> : null}
                              </Space>
                              <ArticlePublishedTime
                                publishedAt={article.publishedAt ?? null}
                                locale={locale}
                                formatOptions={{ dateStyle: "medium", timeStyle: "short" }}
                                primaryStrong
                                secondaryStyle={{ fontSize: 12 }}
                              />
                            </Space>
                          }
                        />
                      </List.Item>
                    );
                  }}
                />

                {canLoadMoreArticles(Boolean(payload?.hasMore), currentArticlesLimit) ? (
                  <Space direction="vertical" size={6} style={{ width: "100%" }}>
                    <Button
                      block
                      onClick={() => {
                        if (currentArticlesLimit >= SPACETIME_GEO_ARTICLES_MAX_LIMIT) {
                          return;
                        }
                        if (!articlePageScopeKey) {
                          return;
                        }
                        setArticlePageState({
                          scopeKey: articlePageScopeKey,
                          page: articlePage + 1,
                        });
                      }}
                      loading={articlesQuery.isFetching}
                    >
                      {t("dashboard.charts.spacetimeGeoHeatmap.loadMore")}
                    </Button>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t("dashboard.charts.spacetimeGeoHeatmap.moreHint")}
                    </Typography.Text>
                  </Space>
                ) : payload?.hasMore ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("dashboard.charts.spacetimeGeoHeatmap.moreLimitHint")}
                  </Typography.Text>
                ) : null}
              </>
            );
          })()}
      </Drawer>
    </>
  );
}
