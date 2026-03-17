"use client";

import type {
  WarMapEvent,
  WarMapEventSeverity,
  WarMapNewsMarker,
} from "@modular/utils";

export const OVERLAY_SURFACE_CLASS_NAME =
  "rounded-2xl border border-[var(--border)] bg-white/[0.88] shadow-xl backdrop-blur dark:bg-slate-950/[0.72] dark:shadow-[0_20px_48px_-30px_rgba(2,6,23,0.88)]";
export const OVERLAY_SURFACE_INTERACTIVE_CLASS_NAME =
  `${OVERLAY_SURFACE_CLASS_NAME} transition-all duration-200 hover:bg-white/[0.95] dark:hover:bg-slate-950/[0.82]`;
export const OVERLAY_SECTION_TITLE_CLASS_NAME =
  "text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400";
export const OVERLAY_STATUS_TAG_CLASS_NAME =
  "!m-0 !rounded-full !px-2.5 !py-0.5 !text-[11px] !font-medium !leading-4";
export const OVERLAY_NEUTRAL_TAG_CLASS_NAME =
  `${OVERLAY_STATUS_TAG_CLASS_NAME} !border-[var(--border)] !bg-white/[0.78] !text-slate-700 dark:!border-slate-700/80 dark:!bg-slate-950/[0.68] dark:!text-slate-200`;
export const OVERLAY_BUTTON_GROUP_CLASS_NAME =
  "inline-flex flex-wrap gap-1.5 rounded-[18px] border border-[var(--border)] bg-white/[0.55] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:bg-slate-950/[0.55] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]";
export const OVERLAY_BUTTON_BASE_CLASS_NAME =
  "!h-8 !rounded-full !border !px-3 !text-[11px] !font-medium !leading-none !backdrop-blur-sm !shadow-[0_10px_22px_-20px_rgba(15,23,42,0.45)] transition-[background-color,border-color,color,box-shadow,transform] duration-200";
export const OVERLAY_BUTTON_NEUTRAL_CLASS_NAME =
  `${OVERLAY_BUTTON_BASE_CLASS_NAME} !border-[var(--border)] !bg-white/[0.82] !text-slate-700 hover:!border-slate-300/90 hover:!bg-white hover:!text-slate-950 hover:!shadow-[0_14px_26px_-22px_rgba(15,23,42,0.35)] dark:!border-slate-700/80 dark:!bg-slate-950/[0.68] dark:!text-slate-200 dark:hover:!border-slate-500/[0.85] dark:hover:!bg-slate-900 dark:hover:!text-slate-50 dark:hover:!shadow-[0_16px_30px_-24px_rgba(2,6,23,0.82)]`;
export const OVERLAY_BUTTON_ACTIVE_CLASS_NAME =
  `${OVERLAY_BUTTON_BASE_CLASS_NAME} !border-slate-900 !bg-slate-900 !text-white !shadow-[0_16px_30px_-24px_rgba(15,23,42,0.52)] hover:!border-slate-800 hover:!bg-slate-800 hover:-translate-y-[1px] dark:!border-sky-400/26 dark:!bg-sky-400/16 dark:!text-sky-100 dark:!shadow-[0_18px_32px_-24px_rgba(8,47,73,0.68)] dark:hover:!border-sky-300/38 dark:hover:!bg-sky-400/22`;
export const OVERLAY_BUTTON_GHOST_CLASS_NAME =
  "!h-8 !min-w-8 !rounded-full !border-transparent !bg-transparent !px-0 !text-slate-500 !shadow-none hover:!bg-slate-900/[0.06] hover:!text-slate-900 dark:!text-slate-300 dark:hover:!bg-white/[0.10] dark:hover:!text-slate-50";
export const OVERLAY_BUTTON_LINK_CLASS_NAME =
  "!h-auto !px-0 !text-xs !font-medium !text-slate-600 hover:!text-slate-900 dark:!text-slate-300 dark:hover:!text-slate-100";

type OverlayButtonTone = "neutral" | "active" | "ghost" | "link";

export function resolveOverlayButtonClassName({
  tone = "neutral",
  iconOnly = false,
  extraClassName,
}: {
  tone?: OverlayButtonTone;
  iconOnly?: boolean;
  extraClassName?: string;
} = {}): string {
  const toneClassName =
    tone === "active"
      ? OVERLAY_BUTTON_ACTIVE_CLASS_NAME
      : tone === "ghost"
        ? OVERLAY_BUTTON_GHOST_CLASS_NAME
        : tone === "link"
          ? OVERLAY_BUTTON_LINK_CLASS_NAME
          : OVERLAY_BUTTON_NEUTRAL_CLASS_NAME;

  return [toneClassName, iconOnly ? "!min-w-8 !px-0" : null, extraClassName]
    .filter(Boolean)
    .join(" ");
}

const DESKTOP_CONTROLS_PANEL_WIDTH = 320;
const DESKTOP_INSPECTOR_PANEL_WIDTH = 360;

export interface RenderableWarMapEvent extends WarMapEvent {
  label: string;
}

export interface RenderableWarMapNewsMarker extends WarMapNewsMarker {
  label: string;
  locationLabel: string;
  latestAt?: string;
}

export type SelectedCluster =
  | {
      key: string;
      kind: "event-cluster";
      lat: number;
      lng: number;
      count: number;
      zoomTarget: number;
      members: RenderableWarMapEvent[];
    }
  | {
      key: string;
      kind: "news-cluster";
      lat: number;
      lng: number;
      count: number;
      zoomTarget: number;
      members: RenderableWarMapNewsMarker[];
    };

export type SelectedInspector =
  | SelectedCluster
  | {
      key: string;
      kind: "event";
      lat: number;
      lng: number;
      zoomTarget: number;
      item: RenderableWarMapEvent;
    }
  | {
      key: string;
      kind: "news";
      lat: number;
      lng: number;
      zoomTarget: number;
      item: RenderableWarMapNewsMarker;
    };

export type OverlayDensity = "expanded" | "compact" | "minimal";
export type OverlayPanelKey = "controls";
export type OverlayControlsSection =
  | "overview"
  | "view"
  | "transport"
  | "feeds"
  | "legend";

export type WarMapTranslateFn = (
  key: string,
  options?: { defaultValue?: string; [key: string]: unknown },
) => string;

export interface WarMapOverlayLayout {
  overlayTopClassName: string;
  overlayRailWidth: number;
  overlayPanelMaxHeight: number;
  controlsPanelWidth: number;
  inspectorPanelHeight: number;
  inspectorPanelWidth: number;
  showActionLabels: boolean;
}

export interface WarMapControlsSectionMeta {
  label: string;
  description: string;
}

export interface WarMapOverlayTab {
  key: OverlayControlsSection;
  label: string;
}

export interface WarMapOverviewMetricCard {
  key: "signals" | "news" | "monitors" | "layers";
  label: string;
  value: number;
  note: string;
  className: string;
}

export interface WarMapSummaryStatusCard {
  key: "stream" | "data";
  label: string;
  value: string;
  detail: string;
  dotClassName: string;
  tagColor: string;
  tooltip?: string;
}

export interface WarMapFeedSummaryCard {
  key: "healthy" | "refreshing" | "issues";
  label: string;
  value: number;
  toneClassName: string;
}

export interface WarMapDetailedChainStatus {
  key: string;
  color: string;
  text: string;
  tooltip: string;
}

export interface WarMapOverlayViewModel {
  controlsSectionMeta: Record<
    OverlayControlsSection,
    WarMapControlsSectionMeta
  >;
  controlsTabs: WarMapOverlayTab[];
  overviewMetricCards: WarMapOverviewMetricCard[];
  summaryStatusCards: WarMapSummaryStatusCard[];
  summaryDataLabel: string;
  overviewDataTagLabel: string;
  feedSummaryCards: WarMapFeedSummaryCard[];
  detailedChainStatuses: WarMapDetailedChainStatus[];
}

export interface WarMapSelectableOption<T extends string> {
  key: T;
  label: string;
  active: boolean;
}

interface BuildWarMapOverlayLayoutParams {
  wrapperWidth: number;
  wrapperHeight: number;
  overlayDensity: OverlayDensity;
  hasNonFatalErrors: boolean;
}

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveOverlayDensity(
  width: number,
  height: number,
): OverlayDensity {
  if (width >= 1100 && height >= 560) {
    return "expanded";
  }
  if (width >= 760 && height >= 480) {
    return "compact";
  }
  return "minimal";
}

export function severityTagColor(severity: WarMapEventSeverity): string {
  switch (severity) {
    case "high":
      return "red";
    case "medium":
      return "gold";
    case "low":
    default:
      return "blue";
  }
}

export function buildWarMapOverlayLayout({
  wrapperWidth,
  wrapperHeight,
  overlayDensity,
  hasNonFatalErrors,
}: BuildWarMapOverlayLayoutParams): WarMapOverlayLayout {
  return {
    overlayTopClassName: hasNonFatalErrors ? "top-20" : "top-4",
    overlayRailWidth:
      overlayDensity === "expanded"
        ? clamp(wrapperWidth - 32, 260, 360)
        : overlayDensity === "compact"
          ? clamp(wrapperWidth - 32, 240, 300)
          : clamp(wrapperWidth - 32, 240, DESKTOP_CONTROLS_PANEL_WIDTH),
    overlayPanelMaxHeight:
      overlayDensity === "expanded"
        ? clamp(Math.round((wrapperHeight || 430) * 0.44), 220, 320)
        : overlayDensity === "compact"
          ? clamp(Math.round((wrapperHeight || 430) * 0.38), 220, 280)
          : clamp(Math.round((wrapperHeight || 430) * 0.58), 260, 420),
    controlsPanelWidth:
      overlayDensity === "compact"
        ? clamp(wrapperWidth - 32, 260, 300)
        : clamp(wrapperWidth - 32, 280, DESKTOP_CONTROLS_PANEL_WIDTH),
    inspectorPanelHeight:
      overlayDensity === "compact"
        ? clamp(Math.round((wrapperHeight || 430) * 0.42), 220, 300)
        : clamp(Math.round((wrapperHeight || 430) * 0.52), 240, 380),
    inspectorPanelWidth:
      overlayDensity === "compact"
        ? clamp(wrapperWidth - 32, 240, 320)
        : clamp(wrapperWidth - 32, 260, DESKTOP_INSPECTOR_PANEL_WIDTH),
    showActionLabels: overlayDensity === "expanded",
  };
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
      label: t("dashboard.charts.warMap.overlay.overview", {
        defaultValue: "Overview",
      }),
      description: t("dashboard.charts.warMap.overlay.overviewHint", {
        defaultValue:
          "Realtime health, density, and freshness signals for the current map window.",
      }),
    },
    view: {
      label: t("dashboard.charts.warMap.overlay.view", {
        defaultValue: "View",
      }),
      description: t("dashboard.charts.warMap.overlay.viewHint", {
        defaultValue:
          "Adjust framing, time horizon, and layer visibility without crowding the map.",
      }),
    },
    transport: {
      label: t("dashboard.charts.warMap.overlay.transport", {
        defaultValue: "Transport",
      }),
      description: t("dashboard.charts.warMap.overlay.transportHint", {
        defaultValue:
          "Inspect flight and AIS modes, freshness, and source quality in one place.",
      }),
    },
    feeds: {
      label: t("dashboard.charts.warMap.overlay.feeds", {
        defaultValue: "Feeds",
      }),
      description: t("dashboard.charts.warMap.overlay.feedsHint", {
        defaultValue:
          "Monitor ingestion chains and quickly spot stale or degraded data sources.",
      }),
    },
    legend: {
      label: t("dashboard.charts.warMap.legend.title", {
        defaultValue: "Legend",
      }),
      description: t("dashboard.charts.warMap.overlay.legendHint", {
        defaultValue:
          "Decode severity, news geocoding, monitor markers, and AIS layer semantics.",
      }),
    },
  };

  return {
    controlsSectionMeta,
    controlsTabs: [
      { key: "overview", label: controlsSectionMeta.overview.label },
      { key: "view", label: controlsSectionMeta.view.label },
      { key: "transport", label: controlsSectionMeta.transport.label },
      { key: "feeds", label: controlsSectionMeta.feeds.label },
      { key: "legend", label: controlsSectionMeta.legend.label },
    ],
    overviewMetricCards: [
      {
        key: "signals",
        label: t("dashboard.charts.warMap.stats.signals", {
          defaultValue: "Signals",
        }),
        value: rawEventsCount,
        note: t("dashboard.charts.warMap.overlay.signalDensity", {
          defaultValue: "Current alert markers",
        }),
        className:
          "from-sky-50 via-white to-sky-100/60 dark:from-sky-500/[0.16] dark:via-slate-950/[0.92] dark:to-sky-400/[0.08]",
      },
      {
        key: "news",
        label: t("dashboard.charts.warMap.stats.news", {
          defaultValue: "News",
        }),
        value: rawNewsMarkersCount,
        note: t("dashboard.charts.warMap.overlay.newsCoverage", {
          defaultValue: "Geo-tagged headlines",
        }),
        className:
          "from-emerald-50 via-white to-emerald-100/60 dark:from-emerald-500/[0.14] dark:via-slate-950/[0.92] dark:to-emerald-400/[0.08]",
      },
      {
        key: "monitors",
        label: t("dashboard.charts.warMap.stats.monitors", {
          defaultValue: "Monitors",
        }),
        value: monitorsCount,
        note: t("dashboard.charts.warMap.overlay.monitorCoverage", {
          defaultValue: "Tracked watchlists",
        }),
        className:
          "from-cyan-50 via-white to-cyan-100/60 dark:from-cyan-500/[0.14] dark:via-slate-950/[0.92] dark:to-cyan-400/[0.08]",
      },
      {
        key: "layers",
        label: t("dashboard.charts.warMap.stats.visibleLayers", {
          defaultValue: "Visible layers",
        }),
        value: visibleLayerCount,
        note: t("dashboard.charts.warMap.overlay.layerCoverage", {
          defaultValue: "Active map overlays",
        }),
        className:
          "from-violet-50 via-white to-violet-100/60 dark:from-violet-500/[0.14] dark:via-slate-950/[0.92] dark:to-violet-400/[0.08]",
      },
    ],
    summaryStatusCards: [
      {
        key: "stream",
        label: t("dashboard.charts.warMap.overlay.stream", {
          defaultValue: "Stream",
        }),
        value: streamStatusLabel,
        detail:
          streamMessageRelative ??
          t("dashboard.charts.warMap.overlay.noRecentMessage", {
            defaultValue: "No recent message",
          }),
        dotClassName:
          streamStatusColor === "green"
            ? "bg-emerald-500 dark:bg-emerald-400"
            : streamStatusColor === "gold"
              ? "bg-amber-500 dark:bg-amber-400"
              : "bg-rose-500 dark:bg-rose-400",
        tagColor: streamStatusColor,
        tooltip: streamMessageExact
          ? `${t("dashboard.charts.warMap.stats.streamMessage", {
              defaultValue: "Stream message",
            })}: ${streamMessageExact}`
          : (streamError ?? undefined),
      },
      {
        key: "data",
        label: t("dashboard.charts.warMap.overlay.data", {
          defaultValue: "Data",
        }),
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
          ? `${t("dashboard.charts.warMap.stats.dataUpdated", {
              defaultValue: "Data updated",
            })}: ${latestQueryUpdatedExact}`
          : undefined,
      },
    ],
    summaryDataLabel,
    overviewDataTagLabel:
      latestQueryUpdatedRelative ??
      t("common.pending", { defaultValue: "Pending" }),
    feedSummaryCards: [
      {
        key: "healthy",
        label: t("dashboard.charts.warMap.overlay.healthyFeeds", {
          defaultValue: "Healthy",
        }),
        value: healthyChainCount,
        toneClassName: "text-emerald-600 dark:text-emerald-300",
      },
      {
        key: "refreshing",
        label: t("dashboard.charts.warMap.overlay.refreshingFeeds", {
          defaultValue: "Refreshing",
        }),
        value: refreshingChainCount,
        toneClassName: "text-indigo-600 dark:text-indigo-300",
      },
      {
        key: "issues",
        label: t("dashboard.charts.warMap.overlay.issueFeeds", {
          defaultValue: "Issues",
        }),
        value: errorChainCount,
        toneClassName: "text-rose-600 dark:text-rose-300",
      },
    ],
    detailedChainStatuses,
  };
}
