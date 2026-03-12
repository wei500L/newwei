"use client";

import { GeoJsonLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { GlobalOutlined, LineChartOutlined, UnorderedListOutlined } from "@ant-design/icons";
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
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDashboardDate } from "@/lib/dashboard-time";
import dayjs from "@/lib/dayjs";
import { resolveEconomicUnit } from "@/lib/economic-units";
import { classifyMapLoadError, type MapLoadErrorPresentation } from "@/lib/map/map-load-error";
import { createDeckMapRuntime, setDeckOverlayProps } from "@/lib/map/map-runtime";
import { MAP_STYLE_URL } from "@/lib/map/map-style";
import { useRenderableContainer } from "@/lib/map/use-renderable-container";
import {
  formatGranularityLabelLocalized,
  pickCoarsestGranularity,
  timeGranularityToUiGranularity,
  UiTimeGranularity,
  uiGranularityToInterval,
} from "@/lib/time-granularity";
import { useDashboardRangeStore } from "@/store/time-range";

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

function resolveGeoFillColor(value: number, max: number): [number, number, number, number] {
  const safeMax = Math.max(1, max);
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const start: [number, number, number] = [224, 255, 255];
  const end: [number, number, number] = [0, 110, 221];
  const r = Math.round(start[0] + (end[0] - start[0]) * ratio);
  const g = Math.round(start[1] + (end[1] - start[1]) * ratio);
  const b = Math.round(start[2] + (end[2] - start[2]) * ratio);
  return [r, g, b, value > 0 ? 210 : 70];
}

export function MetricDrillDown({ visible, metricKey, onClose }: MetricDrillDownProps) {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const rangeLabel = t("dashboard.drilldown.rangeLabel", { defaultValue: "Range" });
  const rangeToLabel = t("dashboard.drilldown.rangeTo", { defaultValue: "to" });
  const unitLabel = t("dashboard.drilldown.unitLabel", { defaultValue: "Unit" });
  const metricValueLabel = t("dashboard.drilldown.valueLabel", { defaultValue: "Value" });
  const aggregationLabel = t("dashboard.drilldown.aggregationLabel", {
    defaultValue: "Aggregation",
  });
  const bucketLabel = t("dashboard.drilldown.bucketLabel", { defaultValue: "Bucket" });
  const eventsLabel = t("dashboard.drilldown.eventsLabel", { defaultValue: "Events" });
  const unknownCountryLabel = t("dashboard.drilldown.unknownCountry", {
    defaultValue: "Unknown",
  });
  const mapLoadingLabel = t("dashboard.drilldown.mapLoading", {
    defaultValue: "Loading map geometry...",
  });
  const mapLoadFailedLabel = t("dashboard.drilldown.mapLoadFailed", {
    defaultValue: "Failed to load map",
  });
  const highLabel = t("dashboard.drilldown.high", { defaultValue: "High" });
  const lowLabel = t("dashboard.drilldown.low", { defaultValue: "Low" });
  const { range, start: rangeStart, end: rangeEnd } = useDashboardRangeStore();

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
    if (!session?.accessToken) {
      return;
    }
    if (geoJsonData) {
      return;
    }

    const apiClient = createApiClient({ accessToken: session.accessToken });
    let cancelled = false;
    setMapError(null);

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
      });

    return () => {
      cancelled = true;
    };
  }, [end, geoJsonData, mapLoadFailedLabel, session?.accessToken, start, visible]);

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
      style: MAP_STYLE_URL,
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
  }, [hasRenderableMapContainer, visible]);

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
          return resolveGeoFillColor(value, maxGeoValue);
        },
      }),
    ];
  }, [geoJsonData, geoValueByCode, maxGeoValue]);

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
        axisLabel: {
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
      yAxis: { type: "value", splitLine: { lineStyle: { type: "dashed" } } },
      series: [
        {
          data: historyData.map((h) => h.value),
          type: "line",
          smooth: true,
          areaStyle: { opacity: 0.2 },
          lineStyle: { width: 3 },
          itemStyle: { color: "#1890ff" },
        },
      ],
    };
  }, [
    activeGranularityLabel,
    activeInterval,
    activeUiGranularity,
    bucketLabel,
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
            text={t("dashboard.drilldown.liveAnalysis", "Live Analysis")}
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
          <Typography.Paragraph type="secondary" className="mb-6">
            {t(
              "dashboard.drilldown.description",
              "Detailed analysis and historical trend for {{metric}}",
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
                title={t("dashboard.drilldown.historicalTrend", "Historical Trend Analysis")}
                variant="borderless"
                className="bg-gray-50"
              >
                <DashboardChart option={trendOption} height={250} />
              </Card>
            </Col>

            <Col xs={24} lg={14}>
              <Card
                title={
                  <>
                    <GlobalOutlined /> {t("dashboard.drilldown.geoImpact", "Geographic Impact")}
                  </>
                }
                variant="borderless"
                className="h-full border border-gray-100"
              >
                {mapError ? (
                  <div className="h-[400px]">
                    <ChartEmptyState
                      variant="error"
                      title={mapError.title}
                      description={mapError.description}
                    />
                  </div>
                ) : (
                  <div className="relative h-[400px] overflow-hidden rounded-md bg-gray-50">
                    <div ref={mapContainerRef} className="h-full w-full" />
                    {!mapReady || !geoJsonData ? (
                      <div className="absolute inset-0 flex items-center justify-center text-gray-400">
                        <Spin tip={mapLoadingLabel} />
                      </div>
                    ) : null}
                  </div>
                )}

                {geoData.length > 0 ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
                    <span>{lowLabel}</span>
                    <div className="h-2 flex-1 rounded bg-gradient-to-r from-cyan-100 to-blue-700" />
                    <span>{highLabel}</span>
                  </div>
                ) : null}

                {geoData.length === 0 && mapReady && geoJsonData ? (
                  <div className="text-center text-gray-400 text-xs mt-2">
                    {t(
                      "dashboard.drilldown.noGeoData",
                      "No geographic data detected in recent alerts.",
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
                    {t("dashboard.drilldown.relatedIntelligence", "Related Intelligence")}
                  </>
                }
                variant="borderless"
                className="h-full border border-gray-100"
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
                          <div className="flex justify-between items-start">
                            <span className="font-medium text-sm">{event.message}</span>
                            <span className="text-xs text-gray-400 ml-2 whitespace-nowrap">
                              {dayjs(event.triggeredAt).format("MMM D, HH:mm")}
                            </span>
                          </div>
                          <Tag className="mt-1 mr-0" color={statusColor[event.status] ?? "default"}>
                            {t(`dashboard.drilldown.status.${event.status}`, {
                              defaultValue: event.status.toUpperCase(),
                            })}
                          </Tag>
                          <span className="text-xs text-gray-500 ml-2">
                            {metricValueLabel}: {event.metricValue}
                            {seriesUnit ? ` ${seriesUnit}` : ""}
                          </span>
                        </div>
                      ),
                    }))}
                  />
                ) : (
                  <div className="text-gray-400 text-center py-8">
                    {t(
                      "dashboard.drilldown.noEvents",
                      "No related intelligence events found in the recent period.",
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
