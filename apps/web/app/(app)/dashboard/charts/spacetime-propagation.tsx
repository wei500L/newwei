"use client";

import { useQuery } from "@tanstack/react-query";
import { WarningOutlined } from "@ant-design/icons";
import { Drawer, List, Skeleton, Space, Tag, Tooltip, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ArticlePublishedTime } from "@/components/article-published-time";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { usePendingAction } from "@/hooks/use-pending-action";
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
  linkedSources?: string[] | null;
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

const EMPTY_DEGRADATION_STATS = {
  filteredEdges: 0,
  totalEdges: 0,
  selfLoops: 0,
  hiddenEdges: 0
} as const;
const MAX_PROPAGATION_WINDOW_HOURS = 24 * 31;
const DEFAULT_PROPAGATION_WINDOW_HOURS = 24;

export function SpacetimePropagation({
  eventId,
  cursorStartIso,
  cursorEndIso,
  linkedSources,
  loading
}: SpacetimePropagationProps) {
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
  const linkedSourceSet = useMemo(
    () =>
      new Set(
        (linkedSources ?? [])
          .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
          .filter((entry) => entry.length > 0)
      ),
    [linkedSources]
  );
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const windowLabelShort = `${startIso.slice(0, 10)} - ${endIso.slice(0, 10)}`;
  const propagationWindowHours = useMemo(() => {
    const durationMs = Math.max(0, end.getTime() - start.getTime());
    const durationHours = Math.ceil(durationMs / (60 * 60 * 1000));
    return Math.max(
      1,
      Math.min(MAX_PROPAGATION_WINDOW_HOURS, durationHours || DEFAULT_PROPAGATION_WINDOW_HOURS)
    );
  }, [end, start]);

  const enabled = Boolean(session?.accessToken && eventId);

  const propagationQuery = useQuery({
    queryKey: [
      "dashboard",
      "spacetime",
      "propagation",
      eventId ?? "none",
      startIso,
      endIso,
      propagationWindowHours
    ],
    queryFn: async () => {
      if (!eventId) {
        return null;
      }
      const response = await apiClient.get<SpacetimePropagationResponse>("dashboard/spacetime/propagation", {
        params: {
          start: startIso,
          end: endIso,
          eventId,
          windowHours: propagationWindowHours
        }
      });
      return response.data;
    },
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
    placeholderData: (previous) => previous ?? null
  });

  const normalizedPropagation = useMemo(() => {
    const payload = propagationQuery.data;
    if (!payload) {
      return null;
    }
    const nodeIds = new Set(payload.nodes.map((n) => n.id));
    const safeEdges: SpacetimePropagationEdgeDto[] = [];
    let filtered = 0;
    let selfLoops = 0;
    let hiddenEdges = 0;
    for (const edge of payload.edges) {
      const isInvalid = !nodeIds.has(edge.source) || !nodeIds.has(edge.target);
      const isSelfLoop = edge.source === edge.target;
      if (isInvalid) filtered++;
      if (isSelfLoop) selfLoops++;
      if (isInvalid || isSelfLoop) {
        hiddenEdges++;
        continue;
      }
      safeEdges.push(edge);
    }
    return {
      payload,
      safeEdges,
      degradationStats: {
        filteredEdges: filtered,
        totalEdges: payload.edges.length,
        selfLoops,
        hiddenEdges
      }
    };
  }, [propagationQuery.data]);

  const degradationStats = normalizedPropagation?.degradationStats ?? EMPTY_DEGRADATION_STATS;
  const edgeKindStats = useMemo(() => {
    if (!normalizedPropagation) {
      return { duplicate: 0, time: 0 };
    }
    let duplicate = 0;
    let time = 0;
    for (const edge of normalizedPropagation.safeEdges) {
      if (edge.kind === "duplicate") {
        duplicate += 1;
      } else {
        time += 1;
      }
    }
    return { duplicate, time };
  }, [normalizedPropagation]);

  const option = useMemo<EChartsOption>(() => {
    if (!normalizedPropagation) {
      return {};
    }
    const { payload, safeEdges } = normalizedPropagation;

    const nodes = payload.nodes.map((node) => {
      const firstMs = safeParseTimeMs(node.firstAt) ?? 0;
      const lastMs = safeParseTimeMs(node.lastAt) ?? 0;
      const nodeKey = node.id.trim().toLowerCase();
      const isLinked = linkedSourceSet.has(nodeKey);
      const isSeen = cursorEndMs ? firstMs < cursorEndMs : true;
      const isWindow =
        cursorStartMs && cursorEndMs
          ? lastMs >= cursorStartMs && firstMs < cursorEndMs
          : true;
      const isNew =
        cursorStartMs && cursorEndMs
          ? firstMs >= cursorStartMs && firstMs < cursorEndMs
          : false;

      const opacity = isLinked ? 1 : isWindow ? 1 : isSeen ? 0.3 : 0.14;
      const borderColor = isLinked
        ? (colors?.primary ?? "#1f3b7b")
        : isNew
          ? (colors?.primary ?? "#1f3b7b")
          : isWindow
            ? (colors?.accent ?? "#f59e0b")
            : (colors?.border ?? "#e2e8f0");
      const borderWidth = isLinked ? 5 : isNew ? 4 : isWindow ? 3 : 2;
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
          show: isLinked || symbolSize >= 26,
          color: colors?.foreground ?? "#0f172a",
          fontFamily
        },
        originalData: {
          count: node.count,
          firstAt: node.firstAt,
          lastAt: node.lastAt,
          isLinked,
          isSeen,
          isWindow,
          isNew
        }
      };
    });

    const nodeIndexById = new Map<string, number>();
    nodes.forEach((node, index) => {
      if (typeof node.id === "string") {
        nodeIndexById.set(node.id, index);
      }
    });

    const links = safeEdges.flatMap((edge) => {
      const sourceIndex = nodeIndexById.get(edge.source);
      const targetIndex = nodeIndexById.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined) {
        return [];
      }

      const firstMs = safeParseTimeMs(edge.firstAt) ?? 0;
      const lastMs = safeParseTimeMs(edge.lastAt) ?? 0;
      const isLinkedEdge =
        linkedSourceSet.has(edge.source.trim().toLowerCase()) ||
        linkedSourceSet.has(edge.target.trim().toLowerCase());
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
      const linkedColor = colors?.primary ?? "#1f3b7b";
      const color = isLinkedEdge ? linkedColor : isNew ? (colors?.primary ?? baseColor) : isWindow ? windowColor : baseColor;
      const opacity = isLinkedEdge ? 0.92 : isWindow ? 0.78 : isSeen ? 0.3 : 0.12;
      const width = isLinkedEdge ? Math.max(2, Math.min(8, edge.weight + 1)) : Math.max(1, Math.min(7, edge.weight));

      return {
        source: sourceIndex,
        target: targetIndex,
        value: edge.weight,
        lineStyle: {
          width,
          color,
          opacity,
          curveness: 0.18,
          type: edge.kind === "duplicate" ? "solid" : "dashed"
        },
        originalData: {
          sourceId: edge.source,
          targetId: edge.target,
          kind: edge.kind,
          weight: edge.weight,
          avgLagMs: edge.avgLagMs,
          avgDuplicateSimilarity: edge.avgDuplicateSimilarity,
          firstAt: edge.firstAt,
          lastAt: edge.lastAt,
          isLinkedEdge,
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
            const sourceLabel =
              typeof meta.sourceId === "string"
                ? meta.sourceId
                : typeof data.source === "string"
                  ? data.source
                  : String(data.source ?? "");
            const targetLabel =
              typeof meta.targetId === "string"
                ? meta.targetId
                : typeof data.target === "string"
                  ? data.target
                  : String(data.target ?? "");

            return [
              `<div style="font-weight:600;margin-bottom:6px;">${sourceLabel} -> ${targetLabel}</div>`,
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
    linkedSourceSet,
    locale,
    normalizedPropagation,
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
  const { pending: refreshingPropagation, run: refreshPropagation } =
    usePendingAction(() => propagationQuery.refetch());
  const { pending: refreshingArticles, run: refreshArticles } = usePendingAction(
    () => articlesQuery.refetch(),
  );

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

  const propagation = propagationQuery.data;
  const hasPropagation = Boolean(propagation && propagation.nodes.length > 0);
  const showStalePropagationErrorBanner = Boolean(propagationQuery.error && hasPropagation);

  if (propagationQuery.error && !hasPropagation) {
    return (
      <div className="h-[360px]">
        <RequestErrorBanner
          error={propagationQuery.error}
          onRetry={() => {
            void refreshPropagation();
          }}
          actionLoading={refreshingPropagation}
          presentation="center"
        />
      </div>
    );
  }

  if (!hasPropagation) {
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
        <Tag color="blue" className="text-xs">
          Link window: {propagation?.windowHours ?? propagationWindowHours}h
        </Tag>
        <Tag color="geekblue" className="text-xs">
          Aggregation: window graph
        </Tag>
        <Tag color="green" className="text-xs">
          Duplicate links: {edgeKindStats.duplicate}
        </Tag>
        <Tag color="gold" className="text-xs">
          Time links: {edgeKindStats.time}
        </Tag>
        {linkedSourceSet.size > 0 ? (
          <Tag color="cyan" className="text-xs">
            {t("dashboard.charts.spacetimePropagation.linkedSources", {
              defaultValue: "Linked sources: {{count}}",
              count: linkedSourceSet.size
            })}
          </Tag>
        ) : null}
        {cursorStartIso && cursorEndIso ? (
          <Tag color="purple" className="text-xs">
            Cursor: {formatDateTime(cursorStartIso, locale, { dateStyle: "medium" })} -{" "}
            {formatDateTime(cursorEndIso, locale, { dateStyle: "medium" })}
          </Tag>
        ) : null}
        {degradationStats.hiddenEdges > 0 ? (
          <Tooltip
            title={t("dashboard.charts.spacetimePropagation.filteredTooltip", {
              hidden: degradationStats.hiddenEdges,
              filtered: degradationStats.filteredEdges,
              selfLoops: degradationStats.selfLoops,
              total: degradationStats.totalEdges,
              defaultValue: `${degradationStats.hiddenEdges} 条传播链已被隐藏（无效引用 ${degradationStats.filteredEdges} / 自环 ${degradationStats.selfLoops}，两者可能重叠），以确保传播图正常显示。`
            })}
          >
            <Tag
              color="orange"
              icon={<WarningOutlined />}
              className="text-xs cursor-help"
            >
              {t("dashboard.charts.spacetimePropagation.filtered", {
                hidden: degradationStats.hiddenEdges,
                filtered: degradationStats.filteredEdges,
                selfLoops: degradationStats.selfLoops,
                defaultValue: `已隐藏 ${degradationStats.hiddenEdges} 条链（无效 ${degradationStats.filteredEdges} / 自环 ${degradationStats.selfLoops}）`
              })}
            </Tag>
          </Tooltip>
        ) : null}
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t("dashboard.charts.spacetimePropagation.caption", {
          defaultValue:
            "Directed source diffusion: duplicate links are evidence-backed; time links are recency-inferred."
        })}
      </Typography.Text>
      {showStalePropagationErrorBanner ? (
        <div className="mb-2">
          <RequestErrorBanner
            error={propagationQuery.error}
            onRetry={() => {
              void refreshPropagation();
            }}
            actionLoading={refreshingPropagation}
            showCachedDataHint
          />
        </div>
      ) : null}
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
        ) : (() => {
            const payload = articlesQuery.data;
            const articles = payload?.articles ?? [];
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
                  title={t("dashboard.dataEmpty", { defaultValue: "No data" })}
                  description={t("dashboard.charts.spacetimePropagation.noArticles", {
                    defaultValue: "No articles found for this source in the selected window."
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
                              <span>{title || t("common.emptyValue", { defaultValue: "N/A" })}</span>
                            )
                          }
                          description={
                            <Space direction="vertical" size={2}>
                              <Space size="small" wrap>
                                {article.sourceLabel ? <Tag color="geekblue">{article.sourceLabel}</Tag> : null}
                                {renderSentimentTag(article.sentiment)}
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
                    {t("dashboard.charts.spacetimePropagation.moreHint", {
                      defaultValue: "More articles available. Narrow the time range to inspect further."
                    })}
                  </Typography.Text>
                ) : null}
              </>
            );
          })()}
      </Drawer>
    </div>
  );
}
