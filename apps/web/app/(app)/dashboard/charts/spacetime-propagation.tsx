"use client";

import { useQuery } from "@tanstack/react-query";
import { Alert, Drawer, List, Skeleton, Space, Tag, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { createApiClient } from "@/lib/api-client";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";
import { useDashboardRangeStore } from "@/store/time-range";

type SpacetimePropagationEdgeKind = "duplicate" | "time";

interface SpacetimePropagationNodeDto {
  id: string;
  name: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

interface SpacetimePropagationEdgeDto {
  source: string;
  target: string;
  kind: SpacetimePropagationEdgeKind;
  weight: number;
  avgLagMs: number;
  firstAt: string;
  lastAt: string;
  avgDuplicateSimilarity?: number;
}

interface SpacetimePropagationResponse {
  eventId: string;
  windowHours: number;
  nodes: SpacetimePropagationNodeDto[];
  edges: SpacetimePropagationEdgeDto[];
  updatedAt?: string;
}

type SentimentLabel = "positive" | "neutral" | "negative" | "unknown";

interface SpacetimePropagationArticleDto {
  id: string;
  title: string;
  url?: string | null;
  sourceLabel?: string | null;
  publishedAt?: string;
  ingestedAt?: string;
  processedAt?: string;
  sentiment?: SentimentLabel;
}

interface SpacetimePropagationArticlesResponse {
  eventId: string;
  source: string;
  cursorStart?: string;
  cursorEnd?: string;
  hasMore: boolean;
  articles: SpacetimePropagationArticleDto[];
  updatedAt?: string;
}

export interface SpacetimePropagationProps {
  eventId?: string | null;
  cursorStartIso?: string | null;
  cursorEndIso?: string | null;
  loading?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeParseTimeMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
};

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

const hashToHue = (value: string) => {
  let hash = 0;
  for (let idx = 0; idx < value.length; idx += 1) {
    hash = (hash * 31 + value.charCodeAt(idx)) >>> 0;
  }
  return hash % 360;
};

const resolveSourceColor = (source: string) => {
  const hue = hashToHue(source);
  return `hsl(${hue} 70% 42%)`;
};

export function SpacetimePropagation({ eventId, cursorStartIso, cursorEndIso, loading }: SpacetimePropagationProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );
  const { range, start, end } = useDashboardRangeStore();
  const { echartsTheme, colors, fontFamily } = useChartTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);

  const cursorStartMs = useMemo(() => safeParseTimeMs(cursorStartIso ?? null), [cursorStartIso]);
  const cursorEndMs = useMemo(() => safeParseTimeMs(cursorEndIso ?? null), [cursorEndIso]);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const windowLabelShort = `${startIso.slice(0, 10)} - ${endIso.slice(0, 10)}`;

  const enabled = Boolean(session?.accessToken && eventId);

  const propagationQuery = useQuery({
    queryKey: ["dashboard", "spacetime", "propagation", eventId ?? "none", startIso, endIso],
    queryFn: async () => {
      if (!eventId) {
        return null;
      }
      const response = await apiClient.get<SpacetimePropagationResponse>("dashboard/spacetime/propagation", {
        params: {
          start: startIso,
          end: endIso,
          eventId
        }
      });
      return response.data;
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
    placeholderData: (previous) => previous ?? null
  });

  const option = useMemo<EChartsOption>(() => {
    const payload = propagationQuery.data;
    if (!payload) {
      return {};
    }

    const nodes = payload.nodes.map((node) => {
      const firstMs = safeParseTimeMs(node.firstAt) ?? 0;
      const lastMs = safeParseTimeMs(node.lastAt) ?? 0;
      const isSeen = cursorEndMs ? firstMs < cursorEndMs : true;
      const isWindow =
        cursorStartMs && cursorEndMs
          ? lastMs >= cursorStartMs && firstMs < cursorEndMs
          : true;
      const isNew =
        cursorStartMs && cursorEndMs
          ? firstMs >= cursorStartMs && firstMs < cursorEndMs
          : false;

      const opacity = isWindow ? 1 : isSeen ? 0.3 : 0.14;
      const borderColor = isNew
        ? (colors?.primary ?? "#1f3b7b")
        : isWindow
          ? (colors?.accent ?? "#f59e0b")
          : (colors?.border ?? "#e2e8f0");
      const borderWidth = isNew ? 4 : isWindow ? 3 : 2;
      const symbolSize = Math.max(14, Math.min(56, 14 + node.count * 3.5));

      return {
        id: node.id,
        name: node.name,
        value: node.count,
        symbolSize,
        itemStyle: {
          color: resolveSourceColor(node.id),
          opacity,
          borderColor,
          borderWidth
        },
        label: {
          show: symbolSize >= 26,
          color: colors?.foreground ?? "#0f172a",
          fontFamily
        },
        originalData: {
          count: node.count,
          firstAt: node.firstAt,
          lastAt: node.lastAt,
          isSeen,
          isWindow,
          isNew
        }
      };
    });

    const links = payload.edges.map((edge) => {
      const firstMs = safeParseTimeMs(edge.firstAt) ?? 0;
      const lastMs = safeParseTimeMs(edge.lastAt) ?? 0;
      const isSeen = cursorEndMs ? firstMs < cursorEndMs : true;
      const isWindow =
        cursorStartMs && cursorEndMs
          ? lastMs >= cursorStartMs && firstMs < cursorEndMs
          : true;
      const isNew =
        cursorStartMs && cursorEndMs
          ? firstMs >= cursorStartMs && firstMs < cursorEndMs
          : false;

      const baseColor =
        edge.kind === "duplicate" ? (colors?.primary ?? "#1f3b7b") : (colors?.border ?? "#94a3b8");
      const windowColor = colors?.accent ?? "#f59e0b";
      const color = isNew ? (colors?.primary ?? baseColor) : isWindow ? windowColor : baseColor;
      const opacity = isWindow ? 0.78 : isSeen ? 0.3 : 0.12;
      const width = Math.max(1, Math.min(7, edge.weight));

      return {
        source: edge.source,
        target: edge.target,
        value: edge.weight,
        lineStyle: {
          width,
          color,
          opacity,
          curveness: 0.18,
          type: edge.kind === "duplicate" ? "solid" : "dashed"
        },
        originalData: {
          kind: edge.kind,
          weight: edge.weight,
          avgLagMs: edge.avgLagMs,
          avgDuplicateSimilarity: edge.avgDuplicateSimilarity,
          firstAt: edge.firstAt,
          lastAt: edge.lastAt,
          isSeen,
          isWindow,
          isNew
        }
      };
    });

    return {
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: colors?.tooltipBg ?? "rgba(15, 23, 42, 0.92)",
        textStyle: { color: colors?.tooltipText ?? "#f8fafc", fontFamily },
        formatter: (params: any) => {
          const data = params?.data ?? {};
          if (params?.dataType === "edge") {
            const meta = data.originalData ?? {};
            const avgLagMs = typeof meta.avgLagMs === "number" ? meta.avgLagMs : 0;
            const avgLagMin = Math.round(avgLagMs / 60000);
            const kind = typeof meta.kind === "string" ? meta.kind : "unknown";
            const sim =
              typeof meta.avgDuplicateSimilarity === "number" && Number.isFinite(meta.avgDuplicateSimilarity)
                ? meta.avgDuplicateSimilarity
                : null;
            const firstLabel =
              typeof meta.firstAt === "string"
                ? formatDateTime(meta.firstAt, locale, { dateStyle: "medium", timeStyle: "short" })
                : null;
            const lastLabel =
              typeof meta.lastAt === "string"
                ? formatDateTime(meta.lastAt, locale, { dateStyle: "medium", timeStyle: "short" })
                : null;
            const cursorLabel =
              cursorStartIso && cursorEndIso
                ? `${formatDateTime(cursorStartIso, locale, { dateStyle: "medium" })} - ${formatDateTime(cursorEndIso, locale, {
                    dateStyle: "medium"
                  })}`
                : null;
            return [
              `<div style="font-weight:600;margin-bottom:6px;">${data.source} -> ${data.target}</div>`,
              `<div>kind: ${kind}</div>`,
              `<div>weight: ${meta.weight ?? data.value ?? 0}</div>`,
              `<div>avg lag: ${avgLagMin} min</div>`,
              sim !== null ? `<div>avg similarity: ${sim.toFixed(2)}</div>` : "",
              firstLabel ? `<div>first: ${firstLabel}</div>` : "",
              lastLabel ? `<div>last: ${lastLabel}</div>` : "",
              `<div style="color:#94a3b8;margin-top:6px;">window: ${windowLabelShort}</div>`,
              cursorLabel ? `<div style="color:#94a3b8;">cursor: ${cursorLabel}</div>` : "",
            ].join("");
          }
          const meta = data.originalData ?? {};
          const firstLabel =
            typeof meta.firstAt === "string"
              ? formatDateTime(meta.firstAt, locale, { dateStyle: "medium", timeStyle: "short" })
              : null;
          const lastLabel =
            typeof meta.lastAt === "string"
              ? formatDateTime(meta.lastAt, locale, { dateStyle: "medium", timeStyle: "short" })
              : null;
          const cursorLabel =
            cursorStartIso && cursorEndIso
              ? `${formatDateTime(cursorStartIso, locale, { dateStyle: "medium" })} - ${formatDateTime(cursorEndIso, locale, {
                  dateStyle: "medium"
                })}`
              : null;
          return [
            `<div style="font-weight:600;margin-bottom:6px;">${data.name ?? ""}</div>`,
            `<div>count: ${meta.count ?? 0}</div>`,
            firstLabel ? `<div>first: ${firstLabel}</div>` : "",
            lastLabel ? `<div>last: ${lastLabel}</div>` : "",
            `<div style="color:#94a3b8;margin-top:6px;">window: ${windowLabelShort}</div>`,
            cursorLabel ? `<div style="color:#94a3b8;">cursor: ${cursorLabel}</div>` : "",
          ].join("");
        }
      },
      series: [
        {
          type: "graph",
          layout: "circular",
          roam: true,
          draggable: true,
          data: nodes,
          links,
          edgeSymbol: ["none", "arrow"],
          edgeSymbolSize: 8,
          circular: { rotateLabel: true },
          label: {
            show: true,
            formatter: "{b}"
          },
          emphasis: {
            focus: "adjacency"
          }
        }
      ]
    } as EChartsOption;
  }, [
    colors,
    cursorEndMs,
    cursorEndIso,
    cursorStartIso,
    cursorStartMs,
    fontFamily,
    locale,
    propagationQuery.data,
    windowLabelShort,
  ]);

  const handleChartClick = useCallback((params: unknown) => {
    if (!isRecord(params)) return;
    if (params.seriesType !== "graph") return;
    if (params.dataType !== "node") return;
    const data = params.data;
    if (!isRecord(data)) return;
    const source = typeof data.id === "string" ? data.id.trim() : typeof data.name === "string" ? data.name.trim() : "";
    if (!source) return;
    setSelectedSource(source);
    setDrawerOpen(true);
  }, []);

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

  const articlesQueryEnabled = Boolean(enabled && drawerOpen && selectedSource);
  const articlesQuery = useQuery({
    queryKey: [
      "dashboard",
      "spacetime",
      "propagation",
      "articles",
      eventId ?? "none",
      selectedSource ?? "none",
      startIso,
      endIso,
      cursorStartIso ?? "none",
      cursorEndIso ?? "none"
    ],
    queryFn: async () => {
      if (!eventId || !selectedSource) {
        return null;
      }
      const response = await apiClient.get<SpacetimePropagationArticlesResponse>("dashboard/spacetime/propagation/articles", {
        params: {
          start: startIso,
          end: endIso,
          eventId,
          source: selectedSource,
          ...(cursorStartIso ? { cursorStart: cursorStartIso } : {}),
          ...(cursorEndIso ? { cursorEnd: cursorEndIso } : {}),
          limit: 30
        }
      });
      return response.data;
    },
    enabled: articlesQueryEnabled,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous ?? null
  });

  const drawerUpdatedAtLabel = useMemo(() => {
    const iso = articlesQuery.data?.updatedAt;
    if (!iso) return null;
    return formatDateTime(iso, locale, { dateStyle: "medium", timeStyle: "short" });
  }, [articlesQuery.data?.updatedAt, locale]);

  const resolveArticleTimestamp = (article: SpacetimePropagationArticleDto) =>
    article.publishedAt ?? article.ingestedAt ?? article.processedAt ?? null;

  const renderSentimentTag = (sentiment: SentimentLabel | undefined) => {
    if (!sentiment) return null;
    return <Tag color={resolveSentimentColor(sentiment, colors)}>{sentiment}</Tag>;
  };

  if (loading || (propagationQuery.isLoading && !propagationQuery.data)) {
    return (
      <div className="h-[360px] flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (!eventId) {
    return (
      <div className="h-[360px]">
        <ChartEmptyState
          title={t("dashboard.charts.spacetimePropagation.emptyTitle", { defaultValue: "No event selected" })}
          description={t("dashboard.charts.spacetimePropagation.emptyDescription", { defaultValue: "Select an event to render its propagation flow." })}
        />
      </div>
    );
  }

  if (propagationQuery.error) {
    return (
      <div className="h-[360px]">
        <Alert
          type="error"
          showIcon
          message={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={(propagationQuery.error as Error).message}
        />
      </div>
    );
  }

  const propagation = propagationQuery.data;
  if (!propagation || propagation.nodes.length === 0) {
    return (
      <div className="h-[360px]">
        <ChartEmptyState
          title={t("dashboard.dataEmpty", { defaultValue: "No data" })}
          description={t("dashboard.charts.spacetimePropagation.empty", { defaultValue: "No propagation signals found in the selected range." })}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Space size="small" wrap>
        <Tag color="default" className="text-xs">
          Range: {range}
        </Tag>
        <Tag color="default" className="text-xs">
          Window: {windowLabelShort}
        </Tag>
        <Tag color="geekblue" className="text-xs">
          Aggregation: window graph
        </Tag>
        {cursorStartIso && cursorEndIso ? (
          <Tag color="purple" className="text-xs">
            Cursor: {formatDateTime(cursorStartIso, locale, { dateStyle: "medium" })} -{" "}
            {formatDateTime(cursorEndIso, locale, { dateStyle: "medium" })}
          </Tag>
        ) : null}
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t("dashboard.charts.spacetimePropagation.caption", {
          defaultValue: "Directed source-to-source diffusion (duplicate-aware + time-lag fallback)."
        })}
      </Typography.Text>
      <DashboardChart option={option} theme={echartsTheme} height={360} onEvents={onEvents} />

      <Drawer
        title={selectedSource ?? t("dashboard.charts.spacetimePropagation.details", { defaultValue: "Details" })}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={520}
      >
        <Space size="small" wrap style={{ marginBottom: 12 }}>
          {selectedSource ? <Tag color="blue">{selectedSource}</Tag> : null}
          {cursorStartIso && cursorEndIso ? (
            <Tag>
              {t("dashboard.charts.spacetimePropagation.window", { defaultValue: "Window" })}:{" "}
              {formatDateTime(cursorStartIso, locale, { dateStyle: "medium" })} -{" "}
              {formatDateTime(cursorEndIso, locale, { dateStyle: "medium" })}
            </Tag>
          ) : null}
          {drawerUpdatedAtLabel ? <Tag>{t("dashboard.updatedAt", { defaultValue: "Updated" })}: {drawerUpdatedAtLabel}</Tag> : null}
        </Space>

        {articlesQuery.isLoading && !articlesQuery.data ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : articlesQuery.error ? (
          <Alert
            type="error"
            showIcon
            message={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
            description={(articlesQuery.error as Error).message}
          />
        ) : !articlesQuery.data || articlesQuery.data.articles.length === 0 ? (
          <ChartEmptyState
            title={t("dashboard.dataEmpty", { defaultValue: "No data" })}
            description={t("dashboard.charts.spacetimePropagation.noArticles", {
              defaultValue: "No articles found for this source in the selected window."
            })}
          />
        ) : (
          <>
            <List
              dataSource={articlesQuery.data.articles}
              renderItem={(article) => {
                const url = safeHttpUrl(article.url);
                const title = article.title?.trim() ?? "";
                const ts = resolveArticleTimestamp(article);
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
                        <Space size="small" wrap>
                          {article.sourceLabel ? <Tag color="geekblue">{article.sourceLabel}</Tag> : null}
                          {renderSentimentTag(article.sentiment)}
                          {ts ? (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {formatDateTime(ts, locale, { dateStyle: "medium", timeStyle: "short" })}
                            </Typography.Text>
                          ) : null}
                        </Space>
                      }
                    />
                  </List.Item>
                );
              }}
            />
            {articlesQuery.data.hasMore ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t("dashboard.charts.spacetimePropagation.moreHint", {
                  defaultValue: "More articles available. Narrow the time range to inspect further."
                })}
              </Typography.Text>
            ) : null}
          </>
        )}
      </Drawer>
    </div>
  );
}
