/**
 * War Map overlay view-model 构建（FE-批4B：自 war-map-overlay-model.ts
 * 拆出）。纯函数模块：由统计/状态输入组装 controls 页签与摘要卡，
 * 无 React、无 "use client"。
 */
import type {
  OverlayControlsSection,
  WarMapControlsSectionMeta,
  WarMapDetailedChainStatus,
  WarMapOverlayViewModel,
  WarMapTranslateFn,
} from "./war-map-overlay-types";

interface BuildWarMapOverlayViewModelParams {
  t: WarMapTranslateFn;
  rawEventsCount: number;
  rawNewsMarkersCount: number;
  monitorsCount: number;
  visibleLayerCount: number;
  streamStatusLabel: string;
  streamStatusColor: string;
  streamMessageRelative: string | null;
  streamMessageExact: string | null;
  streamError?: string | null;
  dataStatusLabel: string;
  dataStatusColor: string;
  latestQueryUpdatedRelative: string | null;
  latestQueryUpdatedExact: string | null;
  summaryDataLabel: string;
  healthyChainCount: number;
  refreshingChainCount: number;
  errorChainCount: number;
  detailedChainStatuses: WarMapDetailedChainStatus[];
}

export function buildWarMapOverlayViewModel({
  t,
  rawEventsCount,
  rawNewsMarkersCount,
  monitorsCount,
  visibleLayerCount,
  streamStatusLabel,
  streamStatusColor,
  streamMessageRelative,
  streamMessageExact,
  streamError,
  dataStatusLabel,
  dataStatusColor,
  latestQueryUpdatedRelative,
  latestQueryUpdatedExact,
  summaryDataLabel,
  healthyChainCount,
  refreshingChainCount,
  errorChainCount,
  detailedChainStatuses,
}: BuildWarMapOverlayViewModelParams): WarMapOverlayViewModel {
  const controlsSectionMeta: Record<
    OverlayControlsSection,
    WarMapControlsSectionMeta
  > = {
    overview: {
      label: t("dashboard.charts.warMap.overlay.overview"),
      description: t("dashboard.charts.warMap.overlay.overviewHint"),
    },
    view: {
      label: t("dashboard.charts.warMap.overlay.view"),
      description: t("dashboard.charts.warMap.overlay.viewHint"),
    },
    transport: {
      label: t("dashboard.charts.warMap.overlay.transport"),
      description: t("dashboard.charts.warMap.overlay.transportHint"),
    },
    feeds: {
      label: t("dashboard.charts.warMap.overlay.feeds"),
      description: t("dashboard.charts.warMap.overlay.feedsHint"),
    },
    legend: {
      label: t("dashboard.charts.warMap.legend.title"),
      description: t("dashboard.charts.warMap.overlay.legendHint"),
    },
  };
  const feedsAttentionLabel =
    errorChainCount > 0
      ? t("dashboard.charts.warMap.overlay.feedsAttention")
      : undefined;
  const feedsAttentionTooltip =
    errorChainCount > 0
      ? t("dashboard.charts.warMap.overlay.feedsAttentionHint", {
          count: errorChainCount,
        })
      : undefined;

  return {
    controlsSectionMeta,
    controlsTabs: [
      { key: "view", label: controlsSectionMeta.view.label },
      { key: "transport", label: controlsSectionMeta.transport.label },
      {
        key: "feeds",
        label: controlsSectionMeta.feeds.label,
        attentionLabel: feedsAttentionLabel,
        attentionTone: feedsAttentionLabel ? "warning" : undefined,
        attentionTooltip: feedsAttentionTooltip,
      },
    ],
    overviewMetricCards: [
      {
        key: "signals",
        label: t("dashboard.charts.warMap.stats.signals"),
        value: rawEventsCount,
        note: t("dashboard.charts.warMap.overlay.signalDensity"),
        className:
          "from-sky-50 via-white to-sky-100/60 dark:from-sky-500/[0.16] dark:via-slate-950/[0.92] dark:to-sky-400/[0.08]",
      },
      {
        key: "news",
        label: t("dashboard.charts.warMap.stats.news"),
        value: rawNewsMarkersCount,
        note: t("dashboard.charts.warMap.overlay.newsCoverage"),
        className:
          "from-emerald-50 via-white to-emerald-100/60 dark:from-emerald-500/[0.14] dark:via-slate-950/[0.92] dark:to-emerald-400/[0.08]",
      },
      {
        key: "monitors",
        label: t("dashboard.charts.warMap.stats.monitors"),
        value: monitorsCount,
        note: t("dashboard.charts.warMap.overlay.monitorCoverage"),
        className:
          "from-cyan-50 via-white to-cyan-100/60 dark:from-cyan-500/[0.14] dark:via-slate-950/[0.92] dark:to-cyan-400/[0.08]",
      },
      {
        key: "layers",
        label: t("dashboard.charts.warMap.stats.visibleLayers"),
        value: visibleLayerCount,
        note: t("dashboard.charts.warMap.overlay.layerCoverage"),
        className:
          "from-violet-50 via-white to-violet-100/60 dark:from-violet-500/[0.14] dark:via-slate-950/[0.92] dark:to-violet-400/[0.08]",
      },
    ],
    summaryStatusCards: [
      {
        key: "stream",
        label: t("dashboard.charts.warMap.overlay.stream"),
        value: streamStatusLabel,
        detail:
          streamMessageRelative ??
          t("dashboard.charts.warMap.overlay.noRecentMessage"),
        dotClassName:
          streamStatusColor === "green"
            ? "bg-emerald-500 dark:bg-emerald-400"
            : streamStatusColor === "gold"
              ? "bg-amber-500 dark:bg-amber-400"
              : "bg-rose-500 dark:bg-rose-400",
        tagColor: streamStatusColor,
        tooltip: streamMessageExact
          ? `${t("dashboard.charts.warMap.overlay.latestStreamUpdate")}: ${streamMessageExact}`
          : (streamError ?? undefined),
      },
      {
        key: "data",
        label: t("dashboard.charts.warMap.overlay.data"),
        value: latestQueryUpdatedRelative ?? dataStatusLabel,
        detail: dataStatusLabel,
        dotClassName:
          dataStatusColor === "blue"
            ? "bg-sky-500 dark:bg-sky-400"
            : dataStatusColor === "processing"
              ? "bg-indigo-500 dark:bg-indigo-400"
              : dataStatusColor === "gold"
                ? "bg-amber-500 dark:bg-amber-400"
                : "bg-slate-400 dark:bg-slate-500",
        tagColor: dataStatusColor,
        tooltip: latestQueryUpdatedExact
          ? `${t("dashboard.charts.warMap.overlay.lastUpdatedLabel")}: ${latestQueryUpdatedExact}`
          : undefined,
      },
    ],
    summaryDataLabel,
    overviewDataTagLabel:
      latestQueryUpdatedRelative ??
      t("dashboard.charts.warMap.overlay.awaitingRefresh"),
    feedSummaryCards: [
      {
        key: "healthy",
        label: t("dashboard.charts.warMap.overlay.healthyFeeds"),
        value: healthyChainCount,
        toneClassName: "text-emerald-600 dark:text-emerald-300",
      },
      {
        key: "refreshing",
        label: t("dashboard.charts.warMap.overlay.refreshingFeeds"),
        value: refreshingChainCount,
        toneClassName: "text-indigo-600 dark:text-indigo-300",
      },
      {
        key: "issues",
        label: t("dashboard.charts.warMap.overlay.issueFeeds"),
        value: errorChainCount,
        toneClassName: "text-rose-600 dark:text-rose-300",
      },
    ],
    detailedChainStatuses,
  };
}
