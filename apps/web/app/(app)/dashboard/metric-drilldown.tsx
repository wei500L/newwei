"use client";

import { GlobalOutlined, LineChartOutlined, UnorderedListOutlined } from "@ant-design/icons";
import { GeoJsonLayer } from "@deck.gl/layers";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import {
  extractCountryCodeFromText,
  getCountryName,
  normalizeCountryCode,
} from "@modular/utils";
import { Badge, Card, Col, Modal, Row, Spin, Tag, Timeline, Typography } from "antd";
import type { EChartsOption } from "echarts";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useMetricDrillDownDetailsQuery } from "@/graphql/generated";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { useTheme } from "@/hooks/use-theme";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDashboardDate } from "@/lib/dashboard-time";
import dayjs from "@/lib/dayjs";
import { resolveEconomicUnit } from "@/lib/economic-units";
import { classifyMapLoadError, type MapLoadErrorPresentation } from "@/lib/map/map-load-error";
import { createDeckMapRuntime, setDeckOverlayProps } from "@/lib/map/map-runtime";
import { resolveMapStyleUrl } from "@/lib/map/map-style";
import { useRenderableContainer } from "@/lib/map/use-renderable-container";
import {
  formatGranularityLabelLocalized,
  pickCoarsestGranularity,
  timeGranularityToUiGranularity,
  UiTimeGranularity,
  uiGranularityToInterval,
} from "@/lib/time-granularity";
import { useDashboardRangeStore } from "@/store/time-range";

import {
  buildMetricAlertFacts,
  buildMetricAlertHeadline,
  isGenericMetricAlertMessage,
  resolveMetricDrilldownSurface,
} from "./metric-drilldown-utils";

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

interface MetricDrillDownProps {
  visible: boolean;
  metricKey: string | null;
  onClose: () => void;
}

interface GeoImpactEntry {
  code: string;
  name: string;
  value: number;
}

function resolveGeoFillColor(
  value: number,
  max: number,
  isDark: boolean,
): [number, number, number, number] {
  const safeMax = Math.max(1, max);
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const start: [number, number, number] = isDark
    ? [30, 41, 59]
    : [224, 255, 255];
  const end: [number, number, number] = isDark
    ? [56, 189, 248]
    : [0, 110, 221];
  const r = Math.round(start[0] + (end[0] - start[0]) * ratio);
  const g = Math.round(start[1] + (end[1] - start[1]) * ratio);
  const b = Math.round(start[2] + (end[2] - start[2]) * ratio);
  return [r, g, b, value > 0 ? (isDark ? 196 : 210) : (isDark ? 96 : 70)];
}

export function MetricDrillDown({ visible, metricKey, onClose }: MetricDrillDownProps) {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const { isDark } = useTheme();
  const chartTheme = useChartTheme();
  const rangeLabel = t("dashboard.drilldown.rangeLabel");
  const rangeToLabel = t("dashboard.drilldown.rangeTo");
  const unitLabel = t("dashboard.drilldown.unitLabel");
  const aggregationLabel = t("dashboard.drilldown.aggregationLabel");
  const bucketLabel = t("dashboard.drilldown.bucketLabel");
  const eventsLabel = t("dashboard.drilldown.eventsLabel");
  const unknownCountryLabel = t("dashboard.drilldown.unknownCountry");
  const mapLoadingLabel = t("dashboard.drilldown.mapLoading");
  const mapInitializingLabel = t("dashboard.drilldown.mapInitializing");
  const mapLoadFailedLabel = t("dashboard.drilldown.mapLoadFailed");
  const highLabel = t("dashboard.drilldown.high");
  const lowLabel = t("dashboard.drilldown.low");
  const currentValueLabel = t("dashboard.drilldown.currentValue");
  const thresholdLabel = t("dashboard.drilldown.threshold");
  const recentChangeLabel = t("dashboard.drilldown.recentChange");
  const noHistoryTitle = t("dashboard.drilldown.noHistoryTitle");
  const noHistoryDescription = t("dashboard.drilldown.noHistoryDescription");
  const surface = resolveMetricDrilldownSurface(isDark);
  const { range, start: rangeStart, end: rangeEnd } = useDashboardRangeStore();
  const mapStyleUrl = useMemo(() => resolveMapStyleUrl(isDark), [isDark]);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const hasAlignedMapViewRef = useRef(false);

  const [mapReady, setMapReady] = useState(false);
  const hasRenderableMapContainer = useRenderableContainer(mapContainerRef, visible);
  const [mapError, setMapError] = useState<MapLoadErrorPresentation | null>(null);
  const [geoJsonData, setGeoJsonData] = useState<GeoJsonFeatureCollection | null>(null);
  const [geoMapCenter, setGeoMapCenter] = useState<[number, number] | null>(null);
  const [geoMapZoom, setGeoMapZoom] = useState<number | null>(null);
  const [isGeoJsonLoading, setIsGeoJsonLoading] = useState(false);

  const start = rangeStart.toISOString();
  const end = rangeEnd.toISOString();

  const { data, loading } = useMetricDrillDownDetailsQuery({
    variables: {
      category: metricKey ?? "",
      start,
      end,
      granularity: null,
    },
    skip: !visible || !metricKey,
  });

  const statusColor: Record<string, string> = {
    pending: "processing",
    delivered: "success",
    failed: "error",
    confirmed: "success",
    ignored: "default",
  };

  useEffect(() => {
    if (!visible) {
      return;
    }
    // The map data is window-scoped: when the drilldown range changes, the
    // previously cached geoJson must be refetched (otherwise the map layer
    // silently keeps the old range while the alerts/history beside it show
    // the new one).
    setGeoJsonData(null);
    setGeoMapCenter(null);
    setGeoMapZoom(null);
    hasAlignedMapViewRef.current = false;
    if (!session?.accessToken) {
      setGeoJsonData({ type: "FeatureCollection", features: [] });
      setIsGeoJsonLoading(false);
      return;
    }

    const apiClient = createApiClient({ accessToken: session.accessToken });
    let cancelled = false;
    setMapError(null);
    setIsGeoJsonLoading(true);

    apiClient
      .get<WarMapGeoJsonResponse>("dashboard/war-map/geojson", {
        params: { start, end },
      })
      .then((response) => {
        if (cancelled) {
          return;
        }
        setGeoJsonData(response.data.geoJson);
        setGeoMapCenter(response.data.center ?? null);
        setGeoMapZoom(
          typeof response.data.zoom === "number" ? response.data.zoom : null,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : mapLoadFailedLabel;
        setMapError({
          kind: "unknown",
          title: mapLoadFailedLabel,
          description: message,
          rawMessage: message,
        });
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        setIsGeoJsonLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [end, mapLoadFailedLabel, session?.accessToken, start, visible]);

  useEffect(() => {
    if (!visible || !mapContainerRef.current || !hasRenderableMapContainer || mapRef.current) {
      return;
    }

    const runtime = createDeckMapRuntime({
      container: mapContainerRef.current,
      initialViewState: {
        lat: 20,
        lon: 0,
        zoom: 1.1,
        bearing: 0,
        pitch: 0,
      },
      style: mapStyleUrl,
      onMapReady: (map) => {
        setMapError(null);
        setMapReady(true);
        map.resize();
      },
      onMapError: (_map, detail) => {
        captureClientError("Metric drilldown basemap load failed", detail.error ?? detail);
        const presentation = classifyMapLoadError(detail);
        setMapReady(false);
        setMapError(presentation);
      },
    });

    mapRef.current = runtime.map;
    overlayRef.current = runtime.overlay;

    return () => {
      overlayRef.current = null;
      mapRef.current = null;
      hasAlignedMapViewRef.current = false;
      runtime.destroy();
      setMapReady(false);
    };
  }, [hasRenderableMapContainer, mapStyleUrl, visible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!visible || !map || !mapReady || !hasRenderableMapContainer) {
      return;
    }
    map.resize();
  }, [hasRenderableMapContainer, mapReady, visible]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || hasAlignedMapViewRef.current) {
      return;
    }

    if (!geoMapCenter && typeof geoMapZoom !== "number") {
      return;
    }

    map.easeTo({
      center: geoMapCenter ?? [0, 20],
      zoom: typeof geoMapZoom === "number" ? geoMapZoom : map.getZoom(),
      duration: 300,
      essential: true,
    });
    hasAlignedMapViewRef.current = true;
  }, [geoMapCenter, geoMapZoom, mapReady]);

  const geoData = useMemo<GeoImpactEntry[]>(() => {
    if (!data?.relatedAlerts) return [];

    const counts = new Map<string, GeoImpactEntry>();
    const addCode = (code: string) => {
      const normalized = normalizeCountryCode(code);
      if (!normalized) {
        return;
      }
      const existing = counts.get(normalized);
      if (existing) {
        existing.value += 1;
        return;
      }
      counts.set(normalized, {
        code: normalized,
        name: getCountryName(normalized) ?? normalized,
        value: 1,
      });
    };

    data.relatedAlerts.forEach((alert) => {
      let found = false;
      const ctx = alert.context as Record<string, unknown>;

      if (ctx?.country || ctx?.countryCode) {
        const code = normalizeCountryCode(
          typeof ctx.countryCode === "string"
            ? ctx.countryCode
            : typeof ctx.country === "string"
              ? ctx.country
              : null,
        );
        if (code) {
          addCode(code);
          found = true;
        }
      }

      if (!found && alert.message) {
        const code = extractCountryCodeFromText(alert.message);
        if (code) {
          addCode(code);
        }
      }
    });

    return Array.from(counts.values());
  }, [data?.relatedAlerts]);

  const geoValueByCode = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of geoData) {
      map.set(item.code, item.value);
    }
    return map;
  }, [geoData]);

  const maxGeoValue = useMemo(
    () => Math.max(5, ...geoData.map((item) => item.value)),
    [geoData],
  );

  const mapLayers = useMemo<any[]>(() => {
    if (!geoJsonData) {
      return [];
    }

    return [
      new GeoJsonLayer({
        id: "metric-drilldown-geo-impact",
        data: geoJsonData as any,
        pickable: true,
        autoHighlight: true,
        filled: true,
        stroked: true,
        lineWidthMinPixels: 1,
        getLineColor: [148, 163, 184, 200],
        getFillColor: (feature) => {
          const properties = (feature as { properties?: Record<string, unknown> }).properties;
          const rawName =
            typeof properties?.name === "string" ? properties.name.trim() : "";
          const rawId = typeof (feature as { id?: unknown }).id === "string"
            ? (feature as { id?: string }).id?.trim() ?? ""
            : "";
          const resolvedCode =
            normalizeCountryCode(rawId) ?? normalizeCountryCode(rawName);
          const value = resolvedCode ? (geoValueByCode.get(resolvedCode) ?? 0) : 0;
          return resolveGeoFillColor(value, maxGeoValue, isDark);
        },
      }),
    ];
  }, [geoJsonData, geoValueByCode, isDark, maxGeoValue]);

  const mapTooltipGetter = useMemo(
    () =>
      ({ object }: { object?: unknown }) => {
        if (!object) {
          return null;
        }

        const properties = (object as { properties?: Record<string, unknown> }).properties;
        const rawName =
          typeof properties?.name === "string" ? properties.name.trim() : "";
        const label = rawName || unknownCountryLabel;
        const rawId = typeof (object as { id?: unknown }).id === "string"
          ? (object as { id?: string }).id?.trim() ?? ""
          : "";
        const resolvedCode =
          normalizeCountryCode(rawId) ?? normalizeCountryCode(rawName);
        const value = resolvedCode ? (geoValueByCode.get(resolvedCode) ?? 0) : 0;

        return {
          text: `${label}: ${value} ${eventsLabel}`,
        };
      },
    [eventsLabel, geoValueByCode, unknownCountryLabel],
  );

  useEffect(() => {
    if (!overlayRef.current) {
      return;
    }
    setDeckOverlayProps(overlayRef.current, {
      layers: hasRenderableMapContainer ? mapLayers : [],
      getTooltip: mapTooltipGetter,
    });
  }, [hasRenderableMapContainer, mapLayers, mapTooltipGetter]);

  const seriesUnit = useMemo(() => {
    const series = data?.history ?? [];
    for (let i = series.length - 1; i >= 0; i -= 1) {
      const point = series[i];
      if (!point) continue;
      const unit = resolveEconomicUnit({
        unit: point.unit ?? null,
        defaultUnit: point.item?.defaultUnit ?? null,
        dataType: point.dataType ?? null,
      });
      if (unit) return unit;
    }
    return null;
  }, [data?.history]);

  const historyData = useMemo(
    () =>
      data?.history?.map((point) => ({
        timestamp: point.timestamp,
        date: dayjs(point.timestamp).format("YYYY-MM-DD"),
        value: point.value,
      })) ?? [],
    [data],
  );

  const activeUiGranularity = useMemo<UiTimeGranularity>(() => {
    const backendGranularity = pickCoarsestGranularity(
      (data?.history ?? []).map((point) =>
        timeGranularityToUiGranularity(point.effectiveGranularity),
      ),
    );
    return backendGranularity;
  }, [data?.history]);

  const activeInterval = useMemo(
    () => uiGranularityToInterval(activeUiGranularity),
    [activeUiGranularity],
  );
  const activeGranularityLabel = formatGranularityLabelLocalized(
    activeUiGranularity,
    t,
  );
  const granularityTagText = `${aggregationLabel}: ${activeGranularityLabel}`;

  const trendOption = useMemo<EChartsOption>(() => {
    if (historyData.length === 0) return {};
    return {
      grid: { top: 20, right: 20, bottom: 20, left: 40, containLabel: true },
      tooltip: {
        backgroundColor: chartTheme.colors.tooltipBg,
        borderColor: chartTheme.colors.border,
        textStyle: { color: chartTheme.colors.tooltipText },
        trigger: "axis",
        formatter: (params: unknown) => {
          const payload = Array.isArray(params) ? params[0] : params;
          const axisValue =
            typeof (payload as { axisValue?: unknown })?.axisValue === "string"
              ? ((payload as { axisValue: string }).axisValue ?? "")
              : "";
          const value =
            typeof (payload as { value?: unknown })?.value === "number"
              ? ((payload as { value: number }).value ?? undefined)
              : undefined;

          const bucketStartIso = axisValue;
          const bucketEndIso =
            bucketStartIso && activeInterval
              ? dayjs(bucketStartIso)
                  .add(activeInterval.count, activeInterval.unit)
                  .toISOString()
              : "";

          const startLabel = bucketStartIso
            ? dayjs(bucketStartIso).format("YYYY-MM-DD")
            : "";
          const endLabel = bucketEndIso ? dayjs(bucketEndIso).format("YYYY-MM-DD") : "";
          const label = endLabel ? `${startLabel} - ${endLabel}` : startLabel;
          const valueLabel =
            typeof value === "number"
              ? value
              : (payload as { data?: unknown })?.data;

          return [
            `<div style="font-weight:600;margin-bottom:6px;">${label}</div>`,
            `<div>${valueLabel ?? ""}${seriesUnit ? ` ${seriesUnit}` : ""}</div>`,
            `<div style="color:#64748b;margin-top:6px;">${bucketLabel}: ${activeGranularityLabel}</div>`,
          ].join("");
        },
      },
      xAxis: {
        type: "category",
        data: historyData.map((h) => h.timestamp),
        boundaryGap: false,
        axisLine: {
          lineStyle: { color: chartTheme.colors.border },
        },
        axisLabel: {
          color: chartTheme.colors.foreground,
          formatter: (value: unknown) => {
            if (typeof value !== "string") return "";
            if (activeUiGranularity === UiTimeGranularity.Year) {
              return dayjs(value).format("YYYY");
            }
            if (
              activeUiGranularity === UiTimeGranularity.Quarter ||
              activeUiGranularity === UiTimeGranularity.Month
            ) {
              return dayjs(value).format("YYYY-MM");
            }
            return dayjs(value).format("MM-DD");
          },
        },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: chartTheme.colors.foreground },
        splitLine: { lineStyle: { type: "dashed", color: chartTheme.colors.grid } },
      },
      series: [
        {
          data: historyData.map((h) => h.value),
          type: "line",
          smooth: true,
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: `${chartTheme.colors.primary}66` },
                { offset: 1, color: `${chartTheme.colors.primary}08` },
              ],
            },
          },
          lineStyle: { width: 3, color: chartTheme.colors.primary },
          itemStyle: { color: chartTheme.colors.primary },
        },
      ],
    };
  }, [
    activeGranularityLabel,
    activeInterval,
    activeUiGranularity,
    bucketLabel,
    chartTheme.colors.border,
    chartTheme.colors.foreground,
    chartTheme.colors.grid,
    chartTheme.colors.primary,
    chartTheme.colors.tooltipBg,
    chartTheme.colors.tooltipText,
    historyData,
    seriesUnit,
  ]);

  const title = data?.history?.[0]?.item.displayName ?? metricKey;

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <LineChartOutlined className="text-blue-600" />
          <span>{title}</span>
          <Badge
            status="processing"
            text={t("dashboard.drilldown.liveAnalysis")}
            className="ml-2"
          />
        </div>
      }
      open={visible}
      onCancel={onClose}
      width={1200}
      footer={null}
      destroyOnHidden
      centered
      className="top-4"
    >
      {loading ? (
        <div className="flex justify-center py-12">
          <Spin size="large" />
        </div>
      ) : (
        <>
          <Typography.Paragraph type="secondary" className="mb-6 text-slate-600 dark:text-slate-300">
            {t(
              "dashboard.drilldown.description",
              { metric: title },
            )}
          </Typography.Paragraph>

          <div className="mb-4 flex flex-wrap gap-2">
            <Tag color="default" className="text-xs">
              {rangeLabel}: {range} ({formatDashboardDate(rangeStart)} {rangeToLabel}{" "}
              {formatDashboardDate(rangeEnd)})
            </Tag>
            {seriesUnit ? (
              <Tag color="default" className="text-xs">
                {unitLabel}: {seriesUnit}
              </Tag>
            ) : null}
            <Tag color="geekblue" className="text-xs">
              {granularityTagText}
            </Tag>
          </div>

          <Row gutter={[24, 24]}>
            <Col span={24}>
              <Card
                size="small"
                title={t("dashboard.drilldown.historicalTrend")}
                variant="borderless"
                className={surface.sectionCardClassName}
              >
                {historyData.length > 0 ? (
                  <DashboardChart
                    option={trendOption}
                    height={250}
                    lazy={false}
                    theme={chartTheme.echartsTheme}
                  />
                ) : (
                  <div className={surface.panelClassName}>
                    <ChartEmptyState
                      title={noHistoryTitle}
                      description={noHistoryDescription}
                    />
                  </div>
                )}
              </Card>
            </Col>

            <Col xs={24} lg={14}>
              <Card
                title={
                  <>
                    <GlobalOutlined /> {t("dashboard.drilldown.geoImpact")}
                  </>
                }
                variant="borderless"
                className={surface.sectionCardClassName}
              >
                {mapError ? (
                  <div className="h-viz-xl">
                    <ChartEmptyState
                      variant="error"
                      title={mapError.title}
                      description={mapError.description}
                    />
                  </div>
                ) : (
                  <div className={surface.mapShellClassName}>
                    <div ref={mapContainerRef} className="h-full w-full" />
                    {!mapReady ? (
                      <div className="absolute inset-0 flex items-center justify-center bg-white/55 text-slate-500 backdrop-blur-sm dark:bg-slate-950/55 dark:text-slate-300">
                        {isGeoJsonLoading ? (
                          <Spin tip={mapLoadingLabel} />
                        ) : (
                          <div className="rounded-full border border-[var(--border)] bg-white/85 px-3 py-1.5 text-xs shadow-sm dark:bg-slate-950/85">
                            {mapInitializingLabel}
                          </div>
                        )}
                      </div>
                    ) : null}
                    {mapReady && isGeoJsonLoading ? (
                      <div className="absolute right-3 top-3 rounded-full border border-[var(--border)] bg-white/88 px-3 py-1 text-xs text-slate-600 shadow-sm dark:bg-slate-950/82 dark:text-slate-300">
                        <Spin tip={mapLoadingLabel} />
                      </div>
                    ) : null}
                  </div>
                )}

                {geoData.length > 0 ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span>{lowLabel}</span>
                    <div className="h-2 flex-1 rounded bg-gradient-to-r from-cyan-100 via-sky-300 to-blue-700 dark:from-slate-700 dark:via-cyan-400 dark:to-sky-500" />
                    <span>{highLabel}</span>
                  </div>
                ) : null}

                {geoData.length === 0 && mapReady && geoJsonData ? (
                  <div className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
                    {t(
                      "dashboard.drilldown.noGeoData",
                    )}
                  </div>
                ) : null}
              </Card>
            </Col>

            <Col xs={24} lg={10}>
              <Card
                title={
                  <>
                    <UnorderedListOutlined />{" "}
                    {t("dashboard.drilldown.relatedSignals")}
                  </>
                }
                variant="borderless"
                className={surface.sectionCardClassName}
                styles={{ body: { maxHeight: 400, overflowY: "auto" } }}
              >
                {data?.relatedAlerts && data.relatedAlerts.length > 0 ? (
                  <Timeline
                    items={data.relatedAlerts.map((event) => ({
                      color:
                        event.severity === "high"
                          ? "red"
                          : event.severity === "medium"
                            ? "orange"
                            : "green",
                      children: (
                        <div className="pb-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                                {buildMetricAlertHeadline(event, title ?? metricKey ?? "")}
                              </div>
                              {event.message &&
                              !isGenericMetricAlertMessage(event.message) &&
                              event.message.trim() !==
                                buildMetricAlertHeadline(event, title ?? metricKey ?? "") ? (
                                <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
                                  {event.message}
                                </p>
                              ) : null}
                              <div className="mt-2 flex flex-wrap gap-2">
                                {buildMetricAlertFacts(event, seriesUnit).map((fact) => {
                                  const label =
                                    fact.key === "current"
                                      ? currentValueLabel
                                      : fact.key === "threshold"
                                        ? thresholdLabel
                                        : recentChangeLabel;
                                  const toneClassName =
                                    fact.tone === "bullish"
                                      ? "border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-400/35 dark:bg-emerald-400/12 dark:text-emerald-200"
                                      : fact.tone === "bearish"
                                        ? "border-amber-200/80 bg-amber-50 text-amber-700 dark:border-amber-400/35 dark:bg-amber-400/12 dark:text-amber-200"
                                        : "border-[var(--border)] bg-white/85 text-slate-600 dark:bg-slate-950/70 dark:text-slate-200";

                                  return (
                                    <span
                                      key={`${event.id}-${fact.key}-${fact.value}`}
                                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium ${toneClassName}`}
                                    >
                                      <span className="uppercase tracking-[0.12em] opacity-70">
                                        {label}
                                      </span>
                                      <span>{fact.value}</span>
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                            <span className="ml-2 whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                              {dayjs(event.triggeredAt).format("MMM D, HH:mm")}
                            </span>
                          </div>
                          <Tag className="mt-2 mr-0" color={statusColor[event.status] ?? "default"}>
                            {t(`dashboard.drilldown.status.${event.status}`, {
                              defaultValue: event.status.toUpperCase(),
                            })}
                          </Tag>
                        </div>
                      ),
                    }))}
                  />
                ) : (
                  <div className="py-8 text-center text-slate-500 dark:text-slate-400">
                    {t(
                      "dashboard.drilldown.noSignals",
                    )}
                  </div>
                )}
              </Card>
            </Col>
          </Row>
        </>
      )}
    </Modal>
  );
}
