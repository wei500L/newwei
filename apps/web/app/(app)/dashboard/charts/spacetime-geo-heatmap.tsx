"use client";

import { useQuery } from "@tanstack/react-query";
import { Drawer, List, Skeleton, Space, Tag, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ArticlePublishedTime } from "@/components/article-published-time";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { createApiClient } from "@/lib/api-client";
import { ensureEchartsMapRegistered } from "@/lib/echarts-map";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";
import { useDashboardRangeStore } from "@/store/time-range";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

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

const resolveDominantSentiment = (sentiment: Record<SentimentLabel, number>): SentimentLabel => {
  const candidates: SentimentLabel[] = ["positive", "neutral", "negative", "unknown"];
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
};

const createSentimentCounts = (): Record<SentimentLabel, number> => ({
  positive: 0,
  neutral: 0,
  negative: 0,
  unknown: 0
});

const resolveSentimentColor = (label: SentimentLabel, colors: Record<string, string> | undefined) => {
  switch (label) {
    case "positive":
      return colors?.bullish ?? "#16a34a";
    case "negative":
      return colors?.bearish ?? "#ef4444";
    case "neutral":
      return colors?.accent ?? "#f59e0b";
    default:
      return colors?.border ?? "#94a3b8";
  }
};

export interface SpacetimeGeoHeatmapProps {
  eventId?: string | null;
  followCursor?: boolean;
  cursorBucketStartIso?: string | null;
}

export function SpacetimeGeoHeatmap({
  eventId,
  followCursor,
  cursorBucketStartIso
}: SpacetimeGeoHeatmapProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();
  const { range, start, end } = useDashboardRangeStore();
  const { echartsTheme, colors, fontFamily } = useChartTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedPoint, setSelectedPoint] = useState<{
    id: string;
    name: string;
    snapshotId: string | null;
  } | null>(null);

  useEffect(() => {
    const dom = containerRef.current;
    if (!dom) return;

    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setInView(Boolean(entry?.isIntersecting));
      },
      { rootMargin: "250px" }
    );
    observer.observe(dom);
    return () => observer.disconnect();
  }, []);

  const enabled = Boolean(session?.accessToken && inView);
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );
  const includeBuckets = Boolean(followCursor && cursorBucketStartIso);
  const cursorBucketIso = cursorBucketStartIso?.trim() ?? "";
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const windowLabel = `${formatDateTime(startIso, locale, { dateStyle: "medium" })} - ${formatDateTime(endIso, locale, {
    dateStyle: "medium"
  })}`;
  const windowLabelShort = `${startIso.slice(0, 10)} - ${endIso.slice(0, 10)}`;

  const heatmapQueryKey = useMemo(() => {
    if (!eventId && !includeBuckets) {
      return ["dashboard", "spacetime", "geo-heatmap", startIso, endIso] as const;
    }
    const key: (string | null | undefined)[] = ["dashboard", "spacetime", "geo-heatmap"];
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
      const response = await apiClient.get<WarMapGeoJsonResponse>("dashboard/war-map/geojson");
      return response.data;
    },
    staleTime: 60 * 60 * 1000,
    enabled
  });

  const heatmapQuery = useQuery({
    queryKey: heatmapQueryKey,
    queryFn: async () => {
      const response = await apiClient.get<SpacetimeGeoHeatmapResponse>("dashboard/spacetime/geo-heatmap", {
        params: {
          start: startIso,
          end: endIso,
          ...(eventId ? { eventId } : {}),
          ...(includeBuckets ? { includeBuckets: "1" } : {})
        }
      });
      return response.data;
    },
    staleTime: 30_000,
    refetchInterval: eventId || includeBuckets ? 20_000 : false,
    enabled,
    placeholderData: (previous) => previous
  });

  const drilldownBucketStart = includeBuckets ? cursorBucketIso : "";
  const articlesQueryKey = useMemo(() => {
    if (!selectedPoint) {
      return ["dashboard", "spacetime", "geo-heatmap", "articles", "none"] as const;
    }
    const key: (string | null | undefined)[] = ["dashboard", "spacetime", "geo-heatmap", "articles", selectedPoint.id];
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
    return key;
  }, [drilldownBucketStart, endIso, eventId, selectedPoint, startIso]);

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
            limit: 30
          }
        }
      );
      return response.data;
    },
    enabled: articlesQueryEnabled,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous ?? null
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

    let cancelled = false;
    void (async () => {
      await ensureEchartsMapRegistered(mapName, geoQuery.data.geoJson);
      if (cancelled) return;
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

  const rawPoints = heatmapQuery.data?.points ?? [];

  const viewPoints = useMemo(() => {
    if (!includeBuckets || !cursorBucketIso) {
      return rawPoints.map((point) => ({
        ...point,
        viewHeat: point.heat,
        viewTotal: point.total,
        viewSentiment: point.sentiment,
        viewBucketStart: null as string | null
      }));
    }

    return rawPoints.map((point) => {
      const bucket = point.buckets?.find((entry) => entry.bucketStart === cursorBucketIso) ?? null;
      const viewTotal = bucket?.total ?? 0;
      const viewSentiment = bucket?.sentiment ?? createSentimentCounts();
      return {
        ...point,
        viewHeat: viewTotal,
        viewTotal,
        viewSentiment,
        viewBucketStart: cursorBucketIso
      };
    });
  }, [cursorBucketIso, includeBuckets, rawPoints]);

  const visiblePoints = useMemo(() => viewPoints.filter((point) => point.viewTotal > 0), [viewPoints]);

  const option = useMemo<EChartsOption>(() => {
    if (!enabled || !geoQuery.data || !mapReady) return {};

    const maxHeat = viewPoints.reduce((acc, p) => Math.max(acc, Number(p.viewHeat ?? 0)), 0);

    const dominantByPoint = viewPoints.map((p) => ({
      ...p,
      dominant: resolveDominantSentiment(p.viewSentiment)
    }));

    const buckets: Record<SentimentLabel, typeof dominantByPoint> = {
      positive: [],
      neutral: [],
      negative: [],
      unknown: []
    };
    for (const point of dominantByPoint) {
      buckets[point.dominant].push(point);
    }

    const heatmapData = viewPoints
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.viewHeat) && p.viewHeat > 0)
      .map((p) => [p.lng, p.lat, p.viewHeat]);

    const buildScatterSeries = (label: SentimentLabel) => {
      const data = buckets[label]
        .filter((p) => p.viewTotal > 0)
        .map((p) => ({
        id: p.id,
        name: p.name,
        value: [p.lng, p.lat, p.viewHeat],
        meta: {
          total: p.viewTotal,
          sentiment: p.viewSentiment,
          bucketStart: p.viewBucketStart
        }
      }));
      return {
        name: label,
        type: "scatter" as const,
        coordinateSystem: "geo" as const,
        data,
        symbol: "circle",
        symbolSize: (val: unknown) => {
          const arr = Array.isArray(val) ? val : [];
          const heat = Number(arr[2] ?? 0);
          if (!Number.isFinite(heat) || heat <= 0) return 6;
          return Math.max(6, Math.min(26, 6 + Math.sqrt(heat) * 8));
        },
        itemStyle: {
          color: resolveSentimentColor(label, colors),
          opacity: 0.85,
          borderColor: "rgba(255, 255, 255, 0.65)",
          borderWidth: 1
        },
        emphasis: {
          scale: true
        }
      };
    };

    const tooltipFormatter = (params: any) => {
      const data = params?.data ?? null;
      const name = typeof data?.name === "string" ? data.name : "";
      const meta = isRecord(data?.meta) ? (data.meta as Record<string, unknown>) : null;
      const total = typeof meta?.total === "number" ? meta.total : undefined;
      const bucketStart = typeof meta?.bucketStart === "string" ? meta.bucketStart : undefined;
      const bucketStartLabel = bucketStart
        ? formatDateTime(bucketStart, locale, { dateStyle: "medium" })
        : null;
      const bucketEndIso = (() => {
        if (!bucketStart) return null;
        const startMs = new Date(bucketStart).getTime();
        if (!Number.isFinite(startMs)) return null;
        return new Date(startMs + 24 * 60 * 60 * 1000).toISOString();
      })();
      const bucketEndLabel =
        bucketEndIso ? formatDateTime(bucketEndIso, locale, { dateStyle: "medium" }) : null;
      const bucketLabel =
        bucketStartLabel && bucketEndLabel ? `${bucketStartLabel} - ${bucketEndLabel}` : bucketStartLabel;
      const sentiment = isRecord(meta?.sentiment)
        ? (meta.sentiment as Record<string, unknown>)
        : null;
      const pos = Number(sentiment?.positive ?? 0);
      const neu = Number(sentiment?.neutral ?? 0);
      const neg = Number(sentiment?.negative ?? 0);
      const unk = Number(sentiment?.unknown ?? 0);
      const totalSentiment = pos + neu + neg + unk;
      const ratio = (value: number) => (totalSentiment > 0 ? Math.round((value / totalSentiment) * 100) : 0);

      return [
        `<div style="min-width: 220px;">`,
        `<div style="font-weight: 600; margin-bottom: 6px; color: ${colors?.primary ?? "#1f3b7b"};">${name || "Location"}</div>`,
        `<div style="margin-bottom: 6px;">window: <b>${windowLabel}</b></div>`,
        bucketLabel
          ? `<div style="margin-bottom: 6px;">bucket: <b>${bucketLabel}</b> <span style="color:#64748b;">(daily)</span></div>`
          : "",
        total !== undefined ? `<div style="margin-bottom: 6px;">articles: <b>${total}</b></div>` : "",
        `<div style="display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; font-size: 12px;">`,
        `<div>positive</div><div>${pos} (${ratio(pos)}%)</div>`,
        `<div>neutral</div><div>${neu} (${ratio(neu)}%)</div>`,
        `<div>negative</div><div>${neg} (${ratio(neg)}%)</div>`,
        `<div>unknown</div><div>${unk} (${ratio(unk)}%)</div>`,
        `</div>`,
        `</div>`
      ].join("");
    };

    const areaColor = "rgba(148, 163, 184, 0.2)";
    const borderColor = colors?.border ?? "#e2e8f0";

    return {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: colors?.tooltipBg ?? "rgba(15, 23, 42, 0.92)",
        borderColor: colors?.border ?? "rgba(226, 232, 240, 0.35)",
        textStyle: { color: colors?.tooltipText ?? "#f8fafc", fontFamily },
        formatter: tooltipFormatter
      },
      visualMap: {
        type: "continuous",
        min: 0,
        max: maxHeat > 0 ? maxHeat : 1,
        show: false,
        inRange: {
          color: [
            "rgba(31, 59, 123, 0.08)",
            "rgba(31, 59, 123, 0.35)",
            "rgba(250, 173, 20, 0.65)",
            "rgba(235, 47, 150, 0.85)"
          ]
        }
      },
      legend: {
        bottom: 0,
        textStyle: {
          color: colors?.foreground ?? "#0f172a",
          fontFamily,
          fontSize: 12
        },
        data: ["positive", "neutral", "negative", "unknown"]
      },
      geo: {
        map: geoQuery.data.name,
        roam: true,
        zoom: geoQuery.data.zoom ?? 1.1,
        center: geoQuery.data.center,
        itemStyle: {
          areaColor,
          borderColor,
          borderWidth: 1
        },
        emphasis: {
          itemStyle: {
            areaColor: "rgba(31, 59, 123, 0.18)",
            borderColor: colors?.primary ?? "#1f3b7b"
          }
        },
        label: {
          show: false
        }
      },
      series: [
        {
          name: "heat",
          type: "heatmap",
          coordinateSystem: "geo",
          data: heatmapData,
          pointSize: 8,
          blurSize: 12,
          z: 1
        },
        buildScatterSeries("positive"),
        buildScatterSeries("neutral"),
        buildScatterSeries("negative"),
        buildScatterSeries("unknown")
      ]
    };
  }, [colors, enabled, fontFamily, geoQuery.data, locale, mapReady, viewPoints, windowLabel]);

  const handleChartClick = useCallback(
    (params: unknown) => {
      if (!isRecord(params)) return;
      if (params.seriesType !== "scatter") return;
      const data = params.data;
      if (!isRecord(data)) return;
      const pointId = typeof data.id === "string" ? data.id.trim() : "";
      const name = typeof data.name === "string" ? data.name.trim() : "";
      if (!pointId || !name) {
        return;
      }
      setSelectedPoint({ id: pointId, name, snapshotId: heatmapQuery.data?.snapshotId ?? null });
      setDrawerOpen(true);
    },
    [heatmapQuery.data?.snapshotId]
  );

  const onEvents = useMemo(
    () => [
      {
        type: "click",
        handler: (params: unknown) => {
          handleChartClick(params);
        }
      }
    ],
    [handleChartClick]
  );

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
          title={t("dashboard.charts.spacetimeGeoHeatmap.geoFailedTitle", { defaultValue: "Map failed" })}
          description={geoErrorMessage ?? t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
        />
      </div>
    );
  }

  const points = heatmapQuery.data?.points ?? [];
  const hasVisiblePoints = includeBuckets ? visiblePoints.length > 0 : points.length > 0;

  const drilldownTitle = selectedPoint?.name ?? t("dashboard.charts.spacetimeGeoHeatmap.details", { defaultValue: "Details" });

  return (
    <>
      <div ref={containerRef} className="h-full flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Space size="small" wrap>
            <Tag color={enabled ? "green" : "default"}>
              {enabled
                ? t("dashboard.charts.spacetimeGeoHeatmap.active", { defaultValue: "Active" })
                : t("dashboard.charts.spacetimeGeoHeatmap.inactive", { defaultValue: "Inactive" })}
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
                {t("dashboard.charts.spacetimeGeoHeatmap.bucket", { defaultValue: "Bucket" })}:{" "}
                {formatDateTime(cursorBucketIso, locale, { dateStyle: "medium" })}
              </Tag>
            ) : null}
            {updatedAtLabel ? (
              <Tag>
                {t("dashboard.updatedAt", { defaultValue: "Updated" })}: {updatedAtLabel}
              </Tag>
            ) : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("dashboard.charts.spacetimeGeoHeatmap.caption", { defaultValue: "Heat + dominant sentiment overlay (click a dot for details)." })}
          </Typography.Text>
        </div>

        {showGeoErrorBanner && geoQuery.error ? (
          <RequestErrorBanner
            error={geoQuery.error}
            onRetry={() => void geoQuery.refetch()}
            showCachedDataHint
          />
        ) : null}

        {showHeatmapErrorBanner && heatmapQuery.error ? (
          <RequestErrorBanner
            error={heatmapQuery.error}
            onRetry={() => void heatmapQuery.refetch()}
            showCachedDataHint={hasHeatmapData}
          />
        ) : null}

        {heatmapQuery.isLoading && !heatmapQuery.data ? (
          <div className="flex-1 flex items-center">
            <Skeleton active paragraph={{ rows: 6 }} />
          </div>
        ) : !hasVisiblePoints ? (
          <div className="flex-1 min-h-0">
            <ChartEmptyState
              title={t("dashboard.dataEmpty", { defaultValue: "No data" })}
              description={
                includeBuckets
                  ? t("dashboard.charts.spacetimeGeoHeatmap.emptyBucket", { defaultValue: "No geo-tagged news in this bucket." })
                  : t("dashboard.charts.spacetimeGeoHeatmap.empty", { defaultValue: "No geo-tagged news in the selected range." })
              }
            />
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <DashboardChart option={option} theme={echartsTheme} height="100%" onEvents={onEvents} />
          </div>
        )}
      </div>

      <Drawer
        title={drilldownTitle}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={520}
      >
        <Space size="small" wrap style={{ marginBottom: 12 }}>
          {selectedPoint?.id ? <Tag>id: {selectedPoint.id}</Tag> : null}
          {drilldownBucketStart ? (
            <Tag color="purple">
              {t("dashboard.charts.spacetimeGeoHeatmap.bucket", { defaultValue: "Bucket" })}:{" "}
              {formatDateTime(drilldownBucketStart, locale, { dateStyle: "medium" })}
            </Tag>
          ) : null}
          {drilldownUpdatedAtLabel ? (
            <Tag>
              {t("dashboard.updatedAt", { defaultValue: "Updated" })}: {drilldownUpdatedAtLabel}
            </Tag>
          ) : null}
        </Space>

        {articlesQuery.isLoading && !articlesQuery.data ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (() => {
            const payload = articlesQuery.data;
            const articles = payload?.articles ?? [];
            const hasArticles = articles.length > 0;

            if (articlesQuery.error && !hasArticles) {
              return (
                <RequestErrorBanner
                  error={articlesQuery.error}
                  onRetry={() => void articlesQuery.refetch()}
                  presentation="center"
                />
              );
            }

            if (!hasArticles) {
              return (
                <ChartEmptyState
                  title={t("dashboard.dataEmpty", { defaultValue: "No data" })}
                  description={t("dashboard.charts.spacetimeGeoHeatmap.noArticles", {
                    defaultValue: "No articles found for this point."
                  })}
                />
              );
            }

            return (
              <>
                {articlesQuery.error ? (
                  <div className="mb-3">
                    <RequestErrorBanner
                      error={articlesQuery.error}
                      onRetry={() => void articlesQuery.refetch()}
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
                              <span>{title || t("common.emptyValue", { defaultValue: "N/A" })}</span>
                            )
                          }
                          description={
                            <Space direction="vertical" size={2}>
                              <Space size="small" wrap>
                                {article.sourceLabel ? <Tag color="blue">{article.sourceLabel}</Tag> : null}
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
                {payload?.hasMore ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("dashboard.charts.spacetimeGeoHeatmap.moreHint", {
                      defaultValue:
                        "More articles available. Narrow the time range to inspect further."
                    })}
                  </Typography.Text>
                ) : null}
              </>
            );
          })()}
      </Drawer>
    </>
  );
}
