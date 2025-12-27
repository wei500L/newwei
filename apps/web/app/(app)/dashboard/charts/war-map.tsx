"use client";

import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Spin } from "antd";
import type { EChartsOption } from "echarts";
import * as echarts from "echarts/core";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { createApiClient } from "@/lib/api-client";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { useDashboardRangeStore } from "@/store/time-range";

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
  value: number;
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

interface WarMapEventsResponse {
  events: WarMapEvent[];
  updatedAt?: string;
}

interface WarMapScatterPoint {
  name: string;
  value: [number, number, number];
  severity: WarEventSeverity;
  updatedAt?: string;
  itemStyle?: {
    color: string;
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

const formatDateForFilename = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

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

export function WarMap() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const { start, end } = useDashboardRangeStore();
  const { echartsTheme, colors } = useChartTheme();
  const registeredMapsRef = useRef(new Set<string>());
  const [mapReady, setMapReady] = useState(false);
  const emptyMessage = t("dashboard.charts.noDataRange", {
    defaultValue: "No Data Found for Selected Range"
  });

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
    enabled: Boolean(session?.accessToken)
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
    enabled: Boolean(session?.accessToken),
    placeholderData: (previous) => previous
  });

  useEffect(() => {
    if (!geoQuery.data) {
      setMapReady(false);
      return;
    }
    const mapName = geoQuery.data.name;
    if (!mapName) {
      setMapReady(false);
      return;
    }
    if (!registeredMapsRef.current.has(mapName)) {
      echarts.registerMap(mapName, geoQuery.data.geoJson as any);
      registeredMapsRef.current.add(mapName);
    }
    setMapReady(true);
  }, [geoQuery.data]);

  const option = useMemo<EChartsOption>(() => {
    if (!geoQuery.data || !mapReady) return {};
    const events = eventsQuery.data?.events ?? [];
    const resolveSeverityColor = (severity: WarEventSeverity) => {
      switch (severity) {
        case WarEventSeverity.High:
          return colors?.destructive ?? "#ef4444";
        case WarEventSeverity.Medium:
          return colors?.accent ?? "#f59e0b";
        case WarEventSeverity.Low:
        default:
          return colors?.primary ?? "#3b82f6";
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
      .map((event) => ({
        name: event.name,
        value: [event.lng, event.lat, event.value],
        severity: event.severity,
        updatedAt: event.updatedAt,
        itemStyle: {
          color: resolveSeverityColor(event.severity)
        }
      }));
    const useLargeMode = scatterData.length >= 500;

    const areaColor = colors?.secondary ?? "#1f2937";
    const borderColor = colors?.border ?? "#334155";

    return {
      title: {
        text: t("dashboard.charts.warMap.title", { defaultValue: "Conflict Zones" }),
        left: "center"
      },
      tooltip: {
        trigger: "item",
        formatter: (params: any) => {
          const payload = Array.isArray(params) ? params[0] : params;
          if (!payload) return "";
          const data = payload.data;
          if (!data) return payload.name ?? "";
          const intensity = data.value?.[2] ?? 0;
          const severityColor = data.itemStyle?.color ?? "#fff";
          const updatedStr = data.updatedAt
            ? new Date(data.updatedAt).toLocaleString()
            : eventsQuery.data?.updatedAt
              ? new Date(eventsQuery.data.updatedAt).toLocaleString()
              : "N/A";

          return `
            <div style="min-width: 200px; font-family: sans-serif;">
              <div style="font-weight: bold; margin-bottom: 6px; font-size: 14px;">${data.name}</div>
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: ${colors?.foreground ?? '#666'};">Severity:</span>
                <span style="color: ${severityColor}; font-weight: bold; text-transform: capitalize;">${severityLabel(data.severity)}</span>
              </div>
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                <span style="color: ${colors?.foreground ?? '#666'};">Intensity:</span>
                <span>${intensity}</span>
              </div>
              <div style="margin-top: 8px; font-size: 0.85em; color: ${colors?.foreground ?? '#666'}; opacity: 0.8; border-top: 1px solid ${colors?.border ?? '#ccc'}; padding-top: 4px;">
                Updated: ${updatedStr}
              </div>
            </div>
          `;
        }
      },
      geo: {
        map: geoQuery.data.name,
        roam: true,
        zoom: geoQuery.data.zoom ?? 1.1,
        center: geoQuery.data.center,
        itemStyle: {
          areaColor,
          borderColor,
          borderWidth: 0.6
        },
        emphasis: {
          itemStyle: {
            areaColor: colors?.accent ?? "#475569"
          }
        },
        label: {
          show: false
        }
      },
      series: [
        {
          name: t("dashboard.charts.warMap.series", { defaultValue: "Conflict" }),
          type: "scatter",
          coordinateSystem: "geo",
          data: scatterData,
          large: useLargeMode,
          largeThreshold: 500,
          progressive: useLargeMode ? 2000 : undefined,
          progressiveThreshold: useLargeMode ? 800 : undefined,
          animation: !useLargeMode,
          animationDurationUpdate: useLargeMode ? 0 : 300,
          hoverAnimation: !useLargeMode,
          emphasis: useLargeMode ? { disabled: true } : undefined,
          symbolSize: (value: unknown) => {
            if (!Array.isArray(value)) return 8;
            const intensity = typeof value[2] === "number" ? value[2] : 0;
            return Math.max(6, Math.min(26, Math.sqrt(intensity) * 2));
          }
        }
      ]
    };
  }, [colors, eventsQuery.data, geoQuery.data, mapReady, t]);

  const geoErrorMessage = getApiErrorMessage(geoQuery.error);
  const eventsErrorMessage = getApiErrorMessage(eventsQuery.error);
  const hasEvents = (eventsQuery.data?.events?.length ?? 0) > 0;

  if (geoQuery.isLoading && !geoQuery.data) {
    return (
      <div className="flex h-[400px] items-center justify-center">
        <Spin />
      </div>
    );
  }

  if (geoQuery.isError && !geoQuery.data) {
    return (
      <div className="flex h-[400px] items-center justify-center">
        <Alert
          type="error"
          showIcon
          message={t("dashboard.widgets.loadFailed", {
            defaultValue: "Failed to load data"
          })}
          description={geoErrorMessage}
          action={
            <Button size="small" onClick={() => geoQuery.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      </div>
    );
  }

  if (!geoQuery.data) {
    return (
      <div className="h-[400px]">
        <ChartEmptyState description={emptyMessage} />
      </div>
    );
  }

  if (!mapReady) {
    return (
      <div className="flex h-[400px] items-center justify-center">
        <Spin />
      </div>
    );
  }

  return (
    <div className="relative h-[400px]">
      <DashboardChart
        option={option}
        theme={echartsTheme}
        height="100%"
        exportFilename={`war-map-${formatDateForFilename(start)}-${formatDateForFilename(
          end
        )}`}
        showExportImage
      />
      {eventsQuery.isLoading ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spin />
        </div>
      ) : null}
      {!eventsQuery.isLoading && eventsQuery.isError ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <Alert
            type="error"
            showIcon
            message={t("dashboard.widgets.loadFailed", {
              defaultValue: "Failed to load data"
            })}
            description={eventsErrorMessage}
            action={
              <Button size="small" onClick={() => eventsQuery.refetch()}>
                {t("common.retry")}
              </Button>
            }
          />
        </div>
      ) : null}
      {!eventsQuery.isLoading && !eventsQuery.isError && eventsQuery.data && !hasEvents ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <ChartEmptyState description={emptyMessage} />
        </div>
      ) : null}
    </div>
  );
}
