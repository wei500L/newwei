"use client";

import { SettingOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Button, Checkbox, Popover, Skeleton, Space, Tag, Tooltip } from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { createApiClient } from "@/lib/api-client";
import { buildExportBaseName, formatDateForFilename } from "@/lib/data-export";
import dayjs from "@/lib/dayjs";
import { formatDateTime, formatUpdatedAt, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";
import { useSituationMonitorMonitorsStore } from "@/store/situation-monitor-monitors";
import { useDashboardRangeStore } from "@/store/time-range";
import { type WarMapLayerId, useWarMapSettingsStore } from "@/store/war-map-settings";

enum WarEventSeverity {
  Low = "low",
  Medium = "medium",
  High = "high"
}

interface WarMapEvent {
  id: string;
  name: string;
  lat: number;
  lng: number;
  severity: WarEventSeverity;
  derivedScore?: number;
  value?: number;
  alertScore?: number;
  alertCount?: number;
  newsCount?: number;
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

interface WarMapEventsResponse {
  events: WarMapEvent[];
  updatedAt?: string;
}

type WarMapNewsGeoSource = "geocoded" | "fallback-country";

interface WarMapNewsMarker {
  id: string;
  title: string;
  url?: string | null;
  location: string;
  lat: number;
  lng: number;
  publishedAt?: string;
  ingestedAt?: string;
  displayName?: string;
  geoSource: WarMapNewsGeoSource;
}

interface WarMapNewsMarkersResponse {
  markers: WarMapNewsMarker[];
  updatedAt?: string;
}

type WarMapPointKind = "signal" | "news" | "layer" | "monitor";

type WarMapThreatLevel = "critical" | "high" | "elevated" | "low";

interface WarMapHotspot {
  id: string;
  name: string;
  lat: number;
  lng: number;
  level: WarMapThreatLevel;
  description: string;
}

interface WarMapStrategicPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  description: string;
}

interface WarMapConflictZone {
  id: string;
  name: string;
  coords: [number, number][];
  color: string;
}

interface WarMapLayersResponse {
  updatedAt: string;
  threatColors: Record<WarMapThreatLevel, string>;
  hotspots: WarMapHotspot[];
  conflictZones: WarMapConflictZone[];
  chokepoints: WarMapStrategicPoint[];
  cableLandings: WarMapStrategicPoint[];
  nuclearSites: WarMapStrategicPoint[];
  militaryBases: WarMapStrategicPoint[];
}

interface WarMapScatterPoint {
  kind: WarMapPointKind;
  name: string;
  value: [number, number, number];
  severity?: WarEventSeverity;
  alertScore?: number;
  alertCount?: number;
  newsCount?: number;
  title?: string;
  location?: string;
  url?: string | null;
  publishedAt?: string;
  ingestedAt?: string;
  geoSource?: WarMapNewsGeoSource;
  displayName?: string;
  monitorId?: string;
  keywords?: string[];
  description?: string;
  layer?: string;
  itemStyle?: {
    color: string;
    opacity?: number;
  };
}

const severityLabel = (severity: WarEventSeverity) => {
  switch (severity) {
    case WarEventSeverity.High:
      return "High";
    case WarEventSeverity.Medium:
      return "Medium";
    case WarEventSeverity.Low:
      return "Low";
    default:
      return "Unknown";
  }
};

const isFiniteNumber = (value: number) => Number.isFinite(value);

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

export interface WarMapProps {
  className?: string;
}

export function WarMap({ className }: WarMapProps = {}) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();
  const { start, end } = useDashboardRangeStore();
  const { echartsTheme, colors, fontFamily } = useChartTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  const registeredMapsRef = useRef(new Set<string>());
  const [mapReady, setMapReady] = useState(false);
  const layerVisibility = useWarMapSettingsStore((state) => state.layerVisibility);
  const setLayerVisible = useWarMapSettingsStore((state) => state.setLayerVisible);
  const resetLayers = useWarMapSettingsStore((state) => state.resetLayers);
  const monitors = useSituationMonitorMonitorsStore((state) => state.monitors);
  const emptyMessage = t("pages.map.empty", {
    defaultValue: "No alerts or geo-tagged news signals in the selected range."
  });

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
        const entry = entries[0];
        setInView(Boolean(entry?.isIntersecting));
      },
      { rootMargin: "200px" }
    );

    observer.observe(dom);

    return () => observer.disconnect();
  }, []);

  const enabled = Boolean(session?.accessToken && inView);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const geoQuery = useQuery({
    queryKey: ["dashboard", "war-map", "geojson"],
    queryFn: async () => {
      const response = await apiClient.get<WarMapGeoJsonResponse>(
        "dashboard/war-map/geojson"
      );
      return response.data;
    },
    staleTime: 60 * 60 * 1000,
    enabled
  });

  const eventsQuery = useQuery({
    queryKey: [
      "dashboard",
      "war-map",
      "events",
      start.toISOString(),
      end.toISOString()
    ],
    queryFn: async () => {
      const response = await apiClient.get<WarMapEventsResponse>(
        "dashboard/war-map/events",
        {
          params: {
            start: start.toISOString(),
            end: end.toISOString()
          }
        }
      );
      return response.data;
    },
    staleTime: 30_000,
    enabled,
    placeholderData: (previous) => previous
  });

  const newsMarkersQuery = useQuery({
    queryKey: [
      "dashboard",
      "war-map",
      "news-markers",
      start.toISOString(),
      end.toISOString()
    ],
    queryFn: async () => {
      const response = await apiClient.get<WarMapNewsMarkersResponse>(
        "dashboard/war-map/news-markers",
        {
          params: {
            start: start.toISOString(),
            end: end.toISOString()
          }
        }
      );
      return response.data;
    },
    staleTime: 30_000,
    enabled,
    placeholderData: (previous) => previous
  });

  const layersQuery = useQuery({
    queryKey: ["dashboard", "war-map", "layers"],
    queryFn: async () => {
      const response = await apiClient.get<WarMapLayersResponse>("dashboard/war-map/layers");
      return response.data;
    },
    staleTime: 24 * 60 * 60 * 1000,
    enabled
  });

  useEffect(() => {
    if (!enabled || !geoQuery.data) {
      return;
    }
    const mapName = geoQuery.data.name;
    if (!mapName) {
      setMapReady(false);
      return;
    }
    if (registeredMapsRef.current.has(mapName)) {
      setMapReady(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      const echartsModule = await import("echarts/core");
      const [installGeo, installMap] = await Promise.all([
        import("echarts/lib/component/geo/install.js").then((m) => m.install),
        import("echarts/lib/chart/map/install.js").then((m) => m.install),
      ]);

      echartsModule.use([installGeo, installMap]);
      if (cancelled) return;
      echartsModule.registerMap(mapName, geoQuery.data.geoJson as any);
      registeredMapsRef.current.add(mapName);
      setMapReady(true);
    })().catch(() => {
      if (!cancelled) {
        setMapReady(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, geoQuery.data]);

  const option = useMemo<EChartsOption>(() => {
    if (!enabled || !geoQuery.data || !mapReady) return {};
    const events = eventsQuery.data?.events ?? [];
    const newsMarkers = newsMarkersQuery.data?.markers ?? [];
    const layers = layersQuery.data;
    const monitorsWithLocation = monitors
      .filter((monitor) => monitor.enabled && monitor.location)
      .map((monitor) => ({
        id: monitor.id,
        name: monitor.name,
        color: monitor.color,
        keywords: monitor.keywords,
        location: monitor.location!
      }))
      .filter((monitor) => {
        const lat = monitor.location.lat;
        const lng = monitor.location.lng;
        return (
          Number.isFinite(lat) &&
          Number.isFinite(lng) &&
          Math.abs(lat) <= 90 &&
          Math.abs(lng) <= 180
        );
      });
    const resolveSeverityColor = (severity: WarEventSeverity) => {
      switch (severity) {
        case WarEventSeverity.High:
          return colors?.bearish ?? "#d95f02";
        case WarEventSeverity.Medium:
          return colors?.accent ?? "#d97706";
        case WarEventSeverity.Low:
        default:
          return colors?.primary ?? "#1f3b7b";
      }
    };
    const scatterData: WarMapScatterPoint[] = events
      .filter((event) => {
        const lat = event.lat;
        const lng = event.lng;
        return (
          isFiniteNumber(lat) &&
          isFiniteNumber(lng) &&
          Math.abs(lat) <= 90 &&
          Math.abs(lng) <= 180
        );
      })
      .map((event) => {
        const score = typeof event.derivedScore === "number" ? event.derivedScore : (event.value ?? 0);
        const alertCount = typeof event.alertCount === "number" ? event.alertCount : undefined;
        const alertScore = typeof event.alertScore === "number" ? event.alertScore : undefined;
        const newsCount = typeof event.newsCount === "number" ? event.newsCount : undefined;
        return {
          kind: "signal",
          name: event.name,
          value: [event.lng, event.lat, score],
          severity: event.severity,
          alertCount,
          alertScore,
          newsCount,
          itemStyle: {
            color: resolveSeverityColor(event.severity)
          }
        };
      });

    const newsScatterData: WarMapScatterPoint[] = newsMarkers
      .filter((marker) => {
        const lat = marker.lat;
        const lng = marker.lng;
        return (
          isFiniteNumber(lat) &&
          isFiniteNumber(lng) &&
          Math.abs(lat) <= 90 &&
          Math.abs(lng) <= 180
        );
      })
      .map((marker) => {
        const opacity = marker.geoSource === "fallback-country" ? 0.35 : 0.85;
        return {
          kind: "news",
          name: marker.location,
          title: marker.title,
          location: marker.location,
          url: marker.url ?? null,
          publishedAt: marker.publishedAt,
          ingestedAt: marker.ingestedAt,
          geoSource: marker.geoSource,
          displayName: marker.displayName,
          value: [marker.lng, marker.lat, 1],
          itemStyle: {
            color: colors?.bullish ?? "#1b9e77",
            opacity
          }
        };
      });

    const useLargeMode = scatterData.length >= 500;
    const useLargeNewsMode = newsScatterData.length >= 800;

    const areaColor = "rgba(148, 163, 184, 0.25)";
    const borderColor = colors?.border ?? "#e2e8f0";

    const series: any[] = [];

    if (layers && layerVisibility.conflictZones && layers.conflictZones.length > 0) {
      series.push({
        name: t("dashboard.charts.warMap.conflictZones", { defaultValue: "Conflict zones" }),
        type: "custom",
        coordinateSystem: "geo",
        silent: true,
        z: 1,
        data: layers.conflictZones.map((zone) => ({
          name: zone.name,
          coords: zone.coords,
          color: zone.color
        })),
        renderItem: (params: any, api: any) => {
          const data = params.data as { coords?: [number, number][]; color?: string } | undefined;
          const coords = Array.isArray(data?.coords) ? data.coords : [];
          if (coords.length < 3) return null;
          const points = coords.map((coord) => api.coord(coord));
          const color = typeof data?.color === "string" ? data.color : "rgba(239, 68, 68, 0.6)";
          return {
            type: "polygon",
            shape: { points },
            style: {
              fill: color,
              opacity: 0.12,
              stroke: color,
              lineWidth: 1
            }
          };
        }
      });
    }

    if (layers && layerVisibility.hotspots && layers.hotspots.length > 0) {
      series.push({
        name: t("dashboard.charts.warMap.hotspots", { defaultValue: "Hotspots" }),
        type: "effectScatter",
        coordinateSystem: "geo",
        z: 3,
        data: layers.hotspots.map((hotspot) => {
          const color = layers.threatColors?.[hotspot.level] ?? colors?.accent ?? "#faad14";
          return {
            kind: "layer",
            layer: "hotspot",
            name: hotspot.name,
            description: hotspot.description,
            level: hotspot.level,
            value: [hotspot.lng, hotspot.lat, 1],
            itemStyle: {
              color,
              opacity: 0.85
            }
          };
        }),
        symbolSize: (value: unknown, params: any) => {
          const level = params?.data?.level as WarMapThreatLevel | undefined;
          switch (level) {
            case "critical":
              return 16;
            case "high":
              return 14;
            case "elevated":
              return 12;
            case "low":
            default:
              return 10;
          }
        },
        rippleEffect: {
          brushType: "stroke",
          scale: 3
        },
        label: {
          show: true,
          position: "right",
          formatter: (params: any) => params?.data?.name ?? "",
          color: colors?.foreground ?? "#475569",
          fontFamily,
          fontSize: 10
        }
      });
    }

    if (layerVisibility.monitors && monitorsWithLocation.length > 0) {
      series.push({
        name: t("dashboard.charts.warMap.monitors", { defaultValue: "Monitors" }),
        type: "scatter",
        coordinateSystem: "geo",
        cursor: "pointer",
        z: 12,
        data: monitorsWithLocation.map((monitor) => ({
          kind: "monitor",
          monitorId: monitor.id,
          name: monitor.name,
          description: monitor.location.name,
          keywords: monitor.keywords,
          value: [monitor.location.lng, monitor.location.lat, 1],
          itemStyle: {
            color: monitor.color ?? colors?.primary ?? "#1f3b7b",
            opacity: 0.9
          }
        })),
        symbol: "circle",
        symbolSize: 10,
        emphasis: { scale: true },
        label: {
          show: false
        }
      });
    }

    const buildStrategicSeries = (
      id: WarMapLayerId,
      name: string,
      points: WarMapStrategicPoint[] | undefined,
      style: { color: string; symbol: string; size: number; opacity?: number }
    ) => {
      if (!layers || !layerVisibility[id] || !points || points.length === 0) return;
      series.push({
        name,
        type: "scatter",
        coordinateSystem: "geo",
        z: 2,
        symbol: style.symbol,
        symbolSize: style.size,
        itemStyle: {
          color: style.color,
          opacity: style.opacity ?? 0.8
        },
        data: points.map((point) => ({
          kind: "layer",
          layer: id,
          name: point.name,
          description: point.description,
          value: [point.lng, point.lat, 1],
          itemStyle: {
            color: style.color,
            opacity: style.opacity ?? 0.8
          }
        }))
      });
    };

    if (layers) {
      buildStrategicSeries(
        "chokepoints",
        t("dashboard.charts.warMap.chokepoints", { defaultValue: "Chokepoints" }),
        layers.chokepoints,
        { color: colors?.primary ?? "#1f3b7b", symbol: "diamond", size: 9 }
      );
      buildStrategicSeries(
        "cableLandings",
        t("dashboard.charts.warMap.cableLandings", { defaultValue: "Cable landings" }),
        layers.cableLandings,
        { color: "#a855f7", symbol: "circle", size: 6, opacity: 0.65 }
      );
      buildStrategicSeries(
        "nuclearSites",
        t("dashboard.charts.warMap.nuclearSites", { defaultValue: "Nuclear sites" }),
        layers.nuclearSites,
        { color: "#eab308", symbol: "triangle", size: 7, opacity: 0.75 }
      );
      buildStrategicSeries(
        "militaryBases",
        t("dashboard.charts.warMap.militaryBases", { defaultValue: "Military bases" }),
        layers.militaryBases,
        { color: "#ec4899", symbol: "pin", size: 9, opacity: 0.75 }
      );
    }

    series.push({
      name: t("dashboard.charts.warMap.series", { defaultValue: "Signals" }),
      type: "scatter",
      coordinateSystem: "geo",
      data: scatterData,
      large: useLargeMode,
      largeThreshold: 500,
      progressive: useLargeMode ? 2000 : undefined,
      progressiveThreshold: useLargeMode ? 800 : undefined,
      animation: !useLargeMode,
      animationDurationUpdate: useLargeMode ? 0 : 300,
      emphasis: useLargeMode ? { disabled: true } : { scale: true },
      symbolSize: (value: unknown) => {
        if (!Array.isArray(value)) return 8;
        const intensity = typeof value[2] === "number" ? value[2] : 0;
        return Math.max(6, Math.min(26, Math.sqrt(intensity) * 2));
      },
      itemStyle: {
        shadowBlur: 6,
        shadowColor: "rgba(15, 23, 42, 0.2)"
      },
      z: 10
    });

    series.push({
      name: t("dashboard.charts.warMap.newsSeries", { defaultValue: "News" }),
      type: "scatter",
      coordinateSystem: "geo",
      cursor: "pointer",
      data: newsScatterData,
      large: useLargeNewsMode,
      largeThreshold: 800,
      progressive: useLargeNewsMode ? 3000 : undefined,
      progressiveThreshold: useLargeNewsMode ? 1200 : undefined,
      animation: !useLargeNewsMode,
      animationDurationUpdate: useLargeNewsMode ? 0 : 300,
      emphasis: useLargeNewsMode ? { disabled: true } : { scale: true },
      symbolSize: () => 6,
      itemStyle: {
        shadowBlur: 3,
        shadowColor: "rgba(15, 23, 42, 0.12)"
      },
      z: 11
    });

    return {
      // Title handled externally by container
      tooltip: {
        trigger: "item",
        backgroundColor: colors?.tooltipBg ?? "#0f172a",
        borderColor: colors?.primary ?? "#1f3b7b",
        textStyle: {
          color: colors?.tooltipText ?? "#f8fafc",
          fontFamily
        },
        formatter: (params: any) => {
          const payload = Array.isArray(params) ? params[0] : params;
          if (!payload) return "";
          const data = payload.data;
          if (!data) return payload.name ?? "";
          const kind: WarMapPointKind | undefined = typeof data.kind === "string" ? data.kind : undefined;

          if (kind === "news") {
            const publishedAt =
              typeof data.publishedAt === "string"
                ? formatDateTime(data.publishedAt, locale, { dateStyle: "medium", timeStyle: "short" })
                : "N/A";
            const ingestedAt =
              typeof data.ingestedAt === "string"
                ? formatDateTime(data.ingestedAt, locale, { dateStyle: "medium", timeStyle: "short" })
                : "N/A";
            const title = typeof data.title === "string" ? data.title : payload.name ?? "News";
            const location = typeof data.location === "string" ? data.location : payload.name ?? "N/A";
            const geoLabel = typeof data.geoSource === "string" ? data.geoSource : undefined;

            return `
              <div style="min-width: 220px;">
                <div style="font-weight: 600; margin-bottom: 6px; font-size: 14px; color: ${colors?.bullish ?? '#1b9e77'};">${title}</div>
                <div style="margin-bottom: 4px;">
                  <span style="color: #94a3b8;">Location:</span>
                  <span style="margin-left: 6px;">${location}</span>
                </div>
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                  <span style="color: #94a3b8;">Published:</span>
                  <span>${publishedAt}</span>
                </div>
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                  <span style="color: #94a3b8;">Ingested:</span>
                  <span>${ingestedAt}</span>
                </div>
                ${geoLabel ? `
                <div style="margin-top: 6px; font-size: 0.85em; color: #64748b;">
                  Geo: ${geoLabel}
                </div>` : ""}
                <div style="margin-top: 8px; font-size: 0.85em; color: #64748b; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 4px;">
                  Click to open original link
                </div>
              </div>
            `;
          }

          if (kind === "layer") {
            const color = data.itemStyle?.color ?? colors?.accent ?? "#faad14";
            const description = typeof data.description === "string" ? data.description : data.name;
            return `
              <div style="min-width: 200px;">
                <div style="font-weight: 600; margin-bottom: 6px; font-size: 14px; color: ${color};">${description}</div>
              </div>
            `;
          }

          if (kind === "monitor") {
            const color = data.itemStyle?.color ?? colors?.primary ?? "#1f3b7b";
            const keywords = Array.isArray(data.keywords) ? data.keywords.slice(0, 6).join(", ") : "";
            const location = typeof data.description === "string" ? data.description : "";
            return `
              <div style="min-width: 220px;">
                <div style="font-weight: 600; margin-bottom: 6px; font-size: 14px; color: ${color};">${data.name}</div>
                ${location ? `<div style="color: #94a3b8; margin-bottom: 4px;">${location}</div>` : ""}
                ${keywords ? `<div style="color: #94a3b8;">${keywords}</div>` : ""}
                <div style="margin-top: 8px; font-size: 0.85em; color: #64748b; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 4px;">
                  Click to open search results
                </div>
              </div>
            `;
          }

          const derivedScore = data.value?.[2] ?? 0;
          const severityColor = data.itemStyle?.color ?? "#fff";
          const alertCount = typeof data.alertCount === "number" ? data.alertCount : undefined;
          const alertScore = typeof data.alertScore === "number" ? data.alertScore : undefined;
          const newsCount = typeof data.newsCount === "number" ? data.newsCount : undefined;
          const hasBreakdown = Boolean(
            typeof alertCount === "number" ||
              typeof alertScore === "number" ||
              typeof newsCount === "number"
          );
          const updatedStr = eventsQuery.data?.updatedAt
            ? formatUpdatedAt(eventsQuery.data.updatedAt, locale)
            : "N/A";
          const windowStr = `${formatDateTime(start, locale, { dateStyle: "medium" })} - ${formatDateTime(end, locale, {
            dateStyle: "medium"
          })}`;

          return `
            <div style="min-width: 200px;">
              <div style="font-weight: 600; margin-bottom: 6px; font-size: 14px; color: ${colors?.primary ?? '#1f3b7b'};">${data.name}</div>
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: #94a3b8;">Severity:</span>
                <span style="color: ${severityColor}; font-weight: 600;">${severityLabel(data.severity)}</span>
              </div>
              ${hasBreakdown ? `
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: #94a3b8;">Alerts:</span>
                <span>${alertCount ?? 0}${typeof alertScore === "number" ? ` (score ${alertScore})` : ""}</span>
              </div>
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: #94a3b8;">News:</span>
                <span>${newsCount ?? 0}</span>
              </div>
              ` : ""}
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: #94a3b8;">Derived score:</span>
                <span>${derivedScore}</span>
              </div>
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: #94a3b8;">Window:</span>
                <span>${windowStr}</span>
              </div>
              <div style="margin-top: 8px; font-size: 0.85em; color: #64748b; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 4px;">
                Dataset updated: ${updatedStr}
              </div>
            </div>
          `;
        }
      },
      geo: {
        map: geoQuery.data.name,
        roam: true,
        zoom: geoQuery.data.zoom ?? 1.2,
        center: geoQuery.data.center,
        itemStyle: {
          areaColor,
          borderColor,
          borderWidth: 1,
          shadowColor: "rgba(15, 23, 42, 0.1)",
          shadowBlur: 6
        },
        emphasis: {
          itemStyle: {
            areaColor: "rgba(31, 59, 123, 0.18)",
            borderColor: colors?.primary ?? "#1f3b7b"
          },
          label: {
            show: true,
            color: colors?.primary ?? "#1f3b7b"
          }
        },
        label: {
          show: false
        }
      },
      backgroundColor: 'transparent',
      series
    };
  }, [
    colors,
    enabled,
    eventsQuery.data,
    fontFamily,
    geoQuery.data,
    layerVisibility,
    layersQuery.data,
    locale,
    mapReady,
    monitors,
    newsMarkersQuery.data,
    start,
    end,
    t
  ]);

  const chartEvents = useMemo(() => {
    const popupBlockedMessage = t("common.popupBlocked", {
      defaultValue: "Popup blocked. Please allow popups for this site."
    });

    const openInNewTab = (url: string, labels: { loading: string; success: string }) => {
      const toastId = toast.loading(labels.loading);
      const handle = window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => {
        if (handle) {
          toast.success(labels.success, { id: toastId });
        } else {
          toast.error(popupBlockedMessage, { id: toastId });
        }
      }, 200);
    };

    return [
      {
        type: "click",
        handler: (params: unknown) => {
          const payload = params as { data?: unknown } | null;
          const data = payload?.data;
          if (!data || typeof data !== "object") {
            return;
          }
          const record = data as Record<string, unknown>;
          if (record.kind === "news") {
            const url = typeof record.url === "string" ? safeHttpUrl(record.url) : null;
            if (!url) {
              toast.warning(
                t("dashboard.charts.warMap.missingNewsUrl", {
                  defaultValue: "No link available for this news marker."
                })
              );
              return;
            }
            openInNewTab(url, {
              loading: t("dashboard.charts.warMap.openingNews", { defaultValue: "Opening news link..." }),
              success: t("dashboard.charts.warMap.openedNews", { defaultValue: "News opened in a new tab" })
            });
            return;
          }

          if (record.kind === "monitor") {
            const keywords = Array.isArray(record.keywords)
              ? record.keywords.filter((kw): kw is string => typeof kw === "string" && kw.trim().length > 0)
              : [];
            const fallback = typeof record.name === "string" ? record.name : "";
            const query = (keywords[0] ?? fallback).trim();
            if (!query) {
              toast.warning(
                t("dashboard.charts.warMap.missingMonitorQuery", {
                  defaultValue: "No keywords available for this monitor."
                })
              );
              return;
            }
            openInNewTab(`/search?q=${encodeURIComponent(query)}`, {
              loading: t("dashboard.charts.warMap.openingSearch", {
                query,
                defaultValue: `Opening search for "${query}"...`
              }),
              success: t("dashboard.charts.warMap.openedSearch", {
                query,
                defaultValue: `Search opened for "${query}" in a new tab`
              })
            });
          }
        }
      }
    ];
  }, [t]);

  const geoErrorMessage = getApiErrorMessage(geoQuery.error);
  const eventsErrorMessage = getApiErrorMessage(eventsQuery.error);
  const newsMarkersErrorMessage = getApiErrorMessage(newsMarkersQuery.error);
  const events = eventsQuery.data?.events ?? [];
  const newsMarkers = newsMarkersQuery.data?.markers ?? [];
  const layers = layersQuery.data;
  const layersLoaded = Boolean(layers);

  const signalStats = useMemo(() => {
    let renderable = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    for (const event of events) {
      if (
        !isFiniteNumber(event.lat) ||
        !isFiniteNumber(event.lng) ||
        Math.abs(event.lat) > 90 ||
        Math.abs(event.lng) > 180
      ) {
        continue;
      }
      renderable += 1;
      switch (event.severity) {
        case WarEventSeverity.High:
          high += 1;
          break;
        case WarEventSeverity.Medium:
          medium += 1;
          break;
        case WarEventSeverity.Low:
        default:
          low += 1;
          break;
      }
    }

    return {
      total: events.length,
      renderable,
      bySeverity: { high, medium, low }
    };
  }, [events]);

  const newsStats = useMemo(() => {
    let renderable = 0;
    let geocoded = 0;
    let fallback = 0;
    for (const marker of newsMarkers) {
      if (
        !isFiniteNumber(marker.lat) ||
        !isFiniteNumber(marker.lng) ||
        Math.abs(marker.lat) > 90 ||
        Math.abs(marker.lng) > 180
      ) {
        continue;
      }
      renderable += 1;
      if (marker.geoSource === "fallback-country") {
        fallback += 1;
      } else {
        geocoded += 1;
      }
    }
    return {
      total: newsMarkers.length,
      renderable,
      byGeoSource: { geocoded, fallback }
    };
  }, [newsMarkers]);

  const monitorStats = useMemo(() => {
    const withLocation = monitors.filter((monitor) => monitor.enabled && Boolean(monitor.location));
    const totalAvailable = withLocation.length;
    const totalVisible = layerVisibility.monitors ? totalAvailable : 0;
    return { totalAvailable, totalVisible };
  }, [layerVisibility.monitors, monitors]);
  const hasMonitorLocations = monitorStats.totalAvailable > 0;

  const layerStats = useMemo(() => {
    const counts = {
      hotspots: layers?.hotspots.length ?? 0,
      conflictZones: layers?.conflictZones.length ?? 0,
      chokepoints: layers?.chokepoints.length ?? 0,
      cableLandings: layers?.cableLandings.length ?? 0,
      nuclearSites: layers?.nuclearSites.length ?? 0,
      militaryBases: layers?.militaryBases.length ?? 0
    };

    const totalAvailable =
      counts.hotspots +
      counts.conflictZones +
      counts.chokepoints +
      counts.cableLandings +
      counts.nuclearSites +
      counts.militaryBases;

    const totalVisible =
      (layerVisibility.hotspots ? counts.hotspots : 0) +
      (layerVisibility.conflictZones ? counts.conflictZones : 0) +
      (layerVisibility.chokepoints ? counts.chokepoints : 0) +
      (layerVisibility.cableLandings ? counts.cableLandings : 0) +
      (layerVisibility.nuclearSites ? counts.nuclearSites : 0) +
      (layerVisibility.militaryBases ? counts.militaryBases : 0);

    return { counts, totalAvailable, totalVisible };
  }, [layerVisibility, layers]);

  const totalAvailablePoints =
    signalStats.renderable +
    newsStats.renderable +
    layerStats.totalAvailable +
    monitorStats.totalAvailable;
  const totalVisiblePoints =
    signalStats.renderable +
    newsStats.renderable +
    layerStats.totalVisible +
    monitorStats.totalVisible;

  const hasRenderableData = totalVisiblePoints > 0;
  const staleDataError =
    (eventsQuery.isError ? eventsQuery.error : null) ??
    (newsMarkersQuery.isError ? newsMarkersQuery.error : null) ??
    (layersQuery.isError ? layersQuery.error : null) ??
    (geoQuery.isError ? geoQuery.error : null);
  const showStaleErrorBanner = Boolean(hasRenderableData && staleDataError);

  const hasHiddenOverlays =
    layerStats.totalAvailable > layerStats.totalVisible ||
    monitorStats.totalAvailable > monitorStats.totalVisible;

  const hasInvalidSignalGeo =
    (signalStats.total > 0 && signalStats.renderable === 0) ||
    (newsStats.total > 0 && newsStats.renderable === 0);

  const emptyStateDescription = useMemo(() => {
    if (hasInvalidSignalGeo) {
      return t("dashboard.charts.warMap.empty.invalidGeo", {
        defaultValue:
          "Data was returned, but none of the records had valid coordinates. This looks like a data source issue."
      });
    }

    if (totalAvailablePoints > 0 && totalVisiblePoints === 0) {
      return (
        <div className="flex flex-col items-center gap-1">
          <span>{emptyMessage}</span>
          <span>
            {t("dashboard.charts.warMap.empty.hiddenLayers", {
              defaultValue: "Some overlay layers are available but hidden by filters. Enable them from Layers."
            })}
          </span>
        </div>
      );
    }

    if (
      !hasHiddenOverlays && layersLoaded && layerStats.totalAvailable === 0 && monitorStats.totalAvailable === 0
    ) {
      return (
        <div className="flex flex-col items-center gap-1">
          <span>{emptyMessage}</span>
          <span>
            {t("dashboard.charts.warMap.empty.noOverlays", {
              defaultValue: "No static layers or monitor locations are configured."
            })}
          </span>
        </div>
      );
    }

    return emptyMessage;
  }, [
    emptyMessage,
    hasHiddenOverlays,
    hasInvalidSignalGeo,
    layerStats.totalAvailable,
    layersLoaded,
    monitorStats.totalAvailable,
    t,
    totalAvailablePoints,
    totalVisiblePoints
  ]);

  if (!inView) {
    return (
      <div ref={containerRef} className="h-[400px] flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (geoQuery.isLoading && !geoQuery.data) {
    return (
      <div ref={containerRef} className="h-[400px] flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (geoQuery.isError && !geoQuery.data) {
    return (
      <div ref={containerRef} className="h-[400px]">
        <ChartEmptyState
          variant="error"
          title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={
            geoErrorMessage ??
            t("common.serviceUnavailable", {
              defaultValue: "Service is unavailable. Please try again."
            })
          }
          actionLabel={t("common.retry")}
          onAction={() => geoQuery.refetch()}
        />
      </div>
    );
  }

  if (!geoQuery.data) {
    return (
      <div ref={containerRef} className="h-[400px]">
        <ChartEmptyState description={emptyMessage} />
      </div>
    );
  }

  if (!mapReady) {
    return (
      <div ref={containerRef} className="h-[400px] flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  const layerSelector = (
    <div style={{ minWidth: 220 }}>
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        <Checkbox
          checked={layerVisibility.hotspots}
          onChange={(event) =>
            setLayerVisible("hotspots", event.target.checked)
          }
          disabled={!layersQuery.data}
        >
          {t("dashboard.charts.warMap.hotspots", { defaultValue: "Hotspots" })}
        </Checkbox>
        <Checkbox
          checked={layerVisibility.conflictZones}
          onChange={(event) =>
            setLayerVisible("conflictZones", event.target.checked)
          }
          disabled={!layersQuery.data}
        >
          {t("dashboard.charts.warMap.conflictZones", { defaultValue: "Conflict zones" })}
        </Checkbox>
        <Checkbox
          checked={layerVisibility.chokepoints}
          onChange={(event) =>
            setLayerVisible("chokepoints", event.target.checked)
          }
          disabled={!layersQuery.data}
        >
          {t("dashboard.charts.warMap.chokepoints", { defaultValue: "Chokepoints" })}
        </Checkbox>
        <Checkbox
          checked={layerVisibility.cableLandings}
          onChange={(event) =>
            setLayerVisible("cableLandings", event.target.checked)
          }
          disabled={!layersQuery.data}
        >
          {t("dashboard.charts.warMap.cableLandings", { defaultValue: "Cable landings" })}
        </Checkbox>
        <Checkbox
          checked={layerVisibility.nuclearSites}
          onChange={(event) =>
            setLayerVisible("nuclearSites", event.target.checked)
          }
          disabled={!layersQuery.data}
        >
          {t("dashboard.charts.warMap.nuclearSites", { defaultValue: "Nuclear sites" })}
        </Checkbox>
        <Checkbox
          checked={layerVisibility.militaryBases}
          onChange={(event) =>
            setLayerVisible("militaryBases", event.target.checked)
          }
          disabled={!layersQuery.data}
        >
          {t("dashboard.charts.warMap.militaryBases", { defaultValue: "Military bases" })}
        </Checkbox>
        <Checkbox
          checked={layerVisibility.monitors}
          onChange={(event) => setLayerVisible("monitors", event.target.checked)}
          disabled={!hasMonitorLocations}
        >
          {t("dashboard.charts.warMap.monitors", { defaultValue: "Monitors" })}
        </Checkbox>
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

  const containerClassName = ["relative", className ?? "h-[400px]"].filter(Boolean).join(" ");
  const windowLabel = `${formatDateTime(start, locale, { dateStyle: "medium" })} - ${formatDateTime(end, locale, {
    dateStyle: "medium"
  })}`;
  const signalsUpdatedLabel = eventsQuery.data?.updatedAt
    ? formatUpdatedAt(eventsQuery.data.updatedAt, locale)
    : null;
  const newsUpdatedLabel = newsMarkersQuery.data?.updatedAt
    ? formatUpdatedAt(newsMarkersQuery.data.updatedAt, locale)
    : null;
  const formatCount = (value: number) => value.toLocaleString(locale);

  const signalsTooltip = (
    <div className="text-xs">
      <div>
        {t("dashboard.charts.warMap.stats.signalsHint", {
          defaultValue: "Aggregated over window"
        })}
      </div>
      <div>
        {t("dashboard.charts.warMap.stats.total", { defaultValue: "Total" })}: {formatCount(signalStats.total)}
      </div>
      <div>
        {t("dashboard.charts.warMap.stats.renderable", { defaultValue: "Renderable" })}:{" "}
        {formatCount(signalStats.renderable)}
      </div>
      <div>
        {t("dashboard.charts.warMap.stats.high", { defaultValue: "High" })}:{" "}
        {formatCount(signalStats.bySeverity.high)} •{" "}
        {t("dashboard.charts.warMap.stats.medium", { defaultValue: "Medium" })}:{" "}
        {formatCount(signalStats.bySeverity.medium)} •{" "}
        {t("dashboard.charts.warMap.stats.low", { defaultValue: "Low" })}: {formatCount(signalStats.bySeverity.low)}
      </div>
    </div>
  );

  const newsTooltip = (
    <div className="text-xs">
      <div>
        {t("dashboard.charts.warMap.stats.newsHint", {
          defaultValue: "Point-in-time (published/ingested)"
        })}
      </div>
      <div>
        {t("dashboard.charts.warMap.stats.total", { defaultValue: "Total" })}: {formatCount(newsStats.total)}
      </div>
      <div>
        {t("dashboard.charts.warMap.stats.renderable", { defaultValue: "Renderable" })}: {formatCount(newsStats.renderable)}
      </div>
      <div>
        {t("dashboard.charts.warMap.stats.geocoded", { defaultValue: "Geocoded" })}:{" "}
        {formatCount(newsStats.byGeoSource.geocoded)} •{" "}
        {t("dashboard.charts.warMap.stats.fallbackCountry", { defaultValue: "Fallback country" })}:{" "}
        {formatCount(newsStats.byGeoSource.fallback)}
      </div>
    </div>
  );

  const layersTooltip = (
    <div className="text-xs">
      <div>
        {t("dashboard.charts.warMap.stats.layersHint", {
          defaultValue: "Static layers (not time-filtered)"
        })}
      </div>
      <div>
        {t("dashboard.charts.warMap.hotspots", { defaultValue: "Hotspots" })}: {formatCount(layerStats.counts.hotspots)}
        {layerVisibility.hotspots ? "" : ` (${t("dashboard.charts.warMap.stats.hidden", { defaultValue: "hidden" })})`}
      </div>
      <div>
        {t("dashboard.charts.warMap.conflictZones", { defaultValue: "Conflict zones" })}:{" "}
        {formatCount(layerStats.counts.conflictZones)}
        {layerVisibility.conflictZones ? "" : ` (${t("dashboard.charts.warMap.stats.hidden", { defaultValue: "hidden" })})`}
      </div>
      <div>
        {t("dashboard.charts.warMap.chokepoints", { defaultValue: "Chokepoints" })}:{" "}
        {formatCount(layerStats.counts.chokepoints)}
        {layerVisibility.chokepoints ? "" : ` (${t("dashboard.charts.warMap.stats.hidden", { defaultValue: "hidden" })})`}
      </div>
      <div>
        {t("dashboard.charts.warMap.cableLandings", { defaultValue: "Cable landings" })}:{" "}
        {formatCount(layerStats.counts.cableLandings)}
        {layerVisibility.cableLandings ? "" : ` (${t("dashboard.charts.warMap.stats.hidden", { defaultValue: "hidden" })})`}
      </div>
      <div>
        {t("dashboard.charts.warMap.nuclearSites", { defaultValue: "Nuclear sites" })}:{" "}
        {formatCount(layerStats.counts.nuclearSites)}
        {layerVisibility.nuclearSites ? "" : ` (${t("dashboard.charts.warMap.stats.hidden", { defaultValue: "hidden" })})`}
      </div>
      <div>
        {t("dashboard.charts.warMap.militaryBases", { defaultValue: "Military bases" })}:{" "}
        {formatCount(layerStats.counts.militaryBases)}
        {layerVisibility.militaryBases ? "" : ` (${t("dashboard.charts.warMap.stats.hidden", { defaultValue: "hidden" })})`}
      </div>
      <div>
        {t("dashboard.charts.warMap.stats.total", { defaultValue: "Total" })}: {formatCount(layerStats.totalVisible)} /{" "}
        {formatCount(layerStats.totalAvailable)}
      </div>
    </div>
  );

  const monitorsTooltip = (
    <div className="text-xs">
      <div>
        {t("dashboard.charts.warMap.stats.monitorsHint", {
          defaultValue: "Custom monitors with saved locations"
        })}
      </div>
      <div>
        {t("dashboard.charts.warMap.stats.total", { defaultValue: "Total" })}: {formatCount(monitorStats.totalAvailable)}
      </div>
      <div>
        {t("dashboard.charts.warMap.stats.showing", { defaultValue: "Showing" })}:{" "}
        {formatCount(monitorStats.totalVisible)}
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className={containerClassName}>
      {showStaleErrorBanner ? (
        <div className="absolute left-4 right-4 top-4 z-20">
          <RequestErrorBanner
            error={staleDataError}
            showCachedDataHint
            onRetry={() => {
              void geoQuery.refetch();
              void eventsQuery.refetch();
              void newsMarkersQuery.refetch();
              void layersQuery.refetch();
            }}
          />
        </div>
      ) : null}
      <div className="absolute left-4 top-12 z-10 flex flex-col gap-1">
        <Space size={6} wrap>
          <Tag color="default" className="text-xs">
            {t("dashboard.charts.warMap.stats.window", { defaultValue: "Window" })}: {windowLabel}
          </Tag>
          <Tooltip title={signalsTooltip}>
            <Tag color="geekblue" className="text-xs">
              {t("dashboard.charts.warMap.stats.signals", { defaultValue: "Signals" })}:{" "}
              {formatCount(signalStats.renderable)}
            </Tag>
          </Tooltip>
          <Tooltip title={newsTooltip}>
            <Tag color="green" className="text-xs">
              {t("dashboard.charts.warMap.stats.news", { defaultValue: "News" })}: {formatCount(newsStats.renderable)}
            </Tag>
          </Tooltip>
          <Tooltip title={layersTooltip}>
            <Tag color="default" className="text-xs">
              {t("dashboard.charts.warMap.stats.layers", { defaultValue: "Layers" })}:{" "}
              {formatCount(layerStats.totalVisible)} / {formatCount(layerStats.totalAvailable)}
            </Tag>
          </Tooltip>
          <Tooltip title={monitorsTooltip}>
            <Tag color="purple" className="text-xs">
              {t("dashboard.charts.warMap.stats.monitors", { defaultValue: "Monitors" })}:{" "}
              {formatCount(monitorStats.totalVisible)} / {formatCount(monitorStats.totalAvailable)}
            </Tag>
          </Tooltip>
          <Tag color="default" className="text-xs">
            {t("dashboard.charts.dataStats.showing", { defaultValue: "Showing" })}:{" "}
            {formatCount(totalVisiblePoints)} / {formatCount(totalAvailablePoints)}
          </Tag>
          {signalsUpdatedLabel ? (
            <Tag color="default" className="text-xs">
              {t("dashboard.charts.warMap.stats.signalsUpdated", { defaultValue: "Signals updated" })}:{" "}
              {signalsUpdatedLabel}
            </Tag>
          ) : null}
          {newsUpdatedLabel ? (
            <Tag color="default" className="text-xs">
              {t("dashboard.charts.warMap.stats.newsUpdated", { defaultValue: "News updated" })}: {newsUpdatedLabel}
            </Tag>
          ) : null}
        </Space>
      </div>
      <DashboardChart
        option={option}
        theme={echartsTheme}
        height="100%"
        exportFilename={buildExportBaseName({
          base: "war-map",
          start: formatDateForFilename(start),
          end: formatDateForFilename(end),
          fallback: "chart"
        })}
        showExportImage
        actions={
          <Popover
            content={layerSelector}
            title={t("dashboard.charts.warMap.layers", { defaultValue: "Layers" })}
            trigger="click"
            placement="bottomRight"
          >
            <Button size="small" type="default" icon={<SettingOutlined />} />
          </Popover>
        }
        onEvents={chartEvents}
      />
      {(eventsQuery.isLoading || newsMarkersQuery.isLoading) && !eventsQuery.data && !newsMarkersQuery.data ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Skeleton active paragraph={{ rows: 4 }} />
        </div>
      ) : null}
      {!eventsQuery.isLoading &&
      !newsMarkersQuery.isLoading &&
      !hasRenderableData &&
      (eventsQuery.isError || newsMarkersQuery.isError) ? (
        <div className="absolute inset-0">
          <ChartEmptyState
            variant="error"
            title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
            description={
              eventsErrorMessage ??
              newsMarkersErrorMessage ??
              t("common.serviceUnavailable", {
                defaultValue: "Service is unavailable. Please try again."
              })
            }
            actionLabel={t("common.retry")}
            onAction={() => {
              void eventsQuery.refetch();
              void newsMarkersQuery.refetch();
            }}
          />
        </div>
      ) : null}
      {!eventsQuery.isLoading &&
      !newsMarkersQuery.isLoading &&
      !eventsQuery.isError &&
      !newsMarkersQuery.isError &&
      (eventsQuery.data || newsMarkersQuery.data) &&
      !hasRenderableData ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <ChartEmptyState description={emptyStateDescription} />
        </div>
      ) : null}
    </div>
  );
}
