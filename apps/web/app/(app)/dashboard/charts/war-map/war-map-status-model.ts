import type {
  WarMapAisMode,
  WarMapLayerVisibility,
} from "@modular/utils";

import type { SupportedLocale } from "@/lib/i18n";

import type {
  WarMapDetailedChainStatus,
  WarMapTranslateFn,
} from "./war-map-overlay-model";
import { readSummaryNumber, readSummaryString } from "./war-map-flights-status";
import {
  formatWarMapRelativeTimestamp,
  getErrorMessage,
} from "./war-map-format";

export { formatWarMapRelativeTimestamp, getErrorMessage } from "./war-map-format";

export {
  buildWarMapAisSummaryPresentation,
  type WarMapAisSummaryPresentation,
} from "./war-map-ais-status";
export {
  buildWarMapFlightsSummaryPresentation,
  type WarMapFlightsSummaryPresentation,
} from "./war-map-flights-status";
import {
  formatWarMapClusterCountLabel,
  type WarMapTransportLegendState,
} from "./war-map-symbols";



interface WarMapUpdatedChainQueryLike {
  isFetching: boolean;
  error: unknown;
  data?: { updatedAt?: string };
  dataUpdatedAt: number;
}

export interface WarMapChainStatusesParams {
  eventsQuery: WarMapUpdatedChainQueryLike;
  newsQuery: WarMapUpdatedChainQueryLike;
  layersQuery: WarMapUpdatedChainQueryLike;
  monitorsQuery: {
    isFetching: boolean;
    error: unknown;
    data: unknown;
    dataUpdatedAt: number;
  };
  t: WarMapTranslateFn;
}

/** 数据链路状态（signals/news/layers/monitors 四条链）。 */
export function buildWarMapChainStatuses(params: WarMapChainStatusesParams) {
  const { eventsQuery, newsQuery, layersQuery, monitorsQuery, t } = params;
return [
  {
    key: "signals",
    label: t("dashboard.charts.warMap.stats.signals"),
    fetching: eventsQuery.isFetching,
    error: Boolean(eventsQuery.error),
    ready: Boolean(eventsQuery.data),
    errorMessage: getErrorMessage(eventsQuery.error),
    dataUpdatedAt: eventsQuery.dataUpdatedAt || undefined,
    sourceUpdatedAt: eventsQuery.data?.updatedAt,
    sourceUpdatedLabel: t("dashboard.charts.warMap.stats.signalsUpdated"),
  },
  {
    key: "news",
    label: t("dashboard.charts.warMap.stats.news"),
    fetching: newsQuery.isFetching,
    error: Boolean(newsQuery.error),
    ready: Boolean(newsQuery.data),
    errorMessage: getErrorMessage(newsQuery.error),
    dataUpdatedAt: newsQuery.dataUpdatedAt || undefined,
    sourceUpdatedAt: newsQuery.data?.updatedAt,
    sourceUpdatedLabel: t("dashboard.charts.warMap.stats.newsUpdated"),
  },
  {
    key: "layers",
    label: t("dashboard.charts.warMap.layers"),
    fetching: layersQuery.isFetching,
    error: Boolean(layersQuery.error),
    ready: Boolean(layersQuery.data),
    errorMessage: getErrorMessage(layersQuery.error),
    dataUpdatedAt: layersQuery.dataUpdatedAt || undefined,
    sourceUpdatedAt: layersQuery.data?.updatedAt,
    sourceUpdatedLabel: t("dashboard.charts.warMap.stats.layersUpdated"),
  },
  {
    key: "monitors",
    label: t("dashboard.charts.warMap.stats.monitors"),
    fetching: monitorsQuery.isFetching,
    error: Boolean(monitorsQuery.error),
    ready: Boolean(monitorsQuery.data),
    errorMessage: getErrorMessage(monitorsQuery.error),
    dataUpdatedAt: monitorsQuery.dataUpdatedAt || undefined,
    sourceUpdatedAt: monitorsQuery.dataUpdatedAt || undefined,
    sourceUpdatedLabel: t("dashboard.charts.warMap.stats.monitorsUpdated"),
  },
];
}

export interface WarMapTransportLegendStateParams {
  layerVisibility: WarMapLayerVisibility;
  flightsReturnedCount: number | undefined;
  flightsFreshness: string | undefined;
  aisAllModeDegraded: boolean;
  aisAllModeDegradedLabel: string | null;
  aisViewportEmptyStateActive: boolean;
  aisViewportEmptyStateHint: string | null;
  aisDisruptionsCount: number | undefined;
  aisPrimaryCountValue: number | undefined;
  effectiveAisMode: WarMapAisMode;
  t: WarMapTranslateFn;
}

/** 运输（航班/AIS）legend 状态派生（FE-批4A：从 war-map.tsx 迁移）。 */
export function buildWarMapTransportLegendState(
  params: WarMapTransportLegendStateParams,
): WarMapTransportLegendState {
  const {
    layerVisibility,
    flightsReturnedCount,
    flightsFreshness,
    aisAllModeDegraded,
    aisAllModeDegradedLabel,
    aisViewportEmptyStateActive,
    aisViewportEmptyStateHint,
    aisDisruptionsCount,
    aisPrimaryCountValue,
    effectiveAisMode,
    t,
  } = params;
const flightsUnavailableReason =
    layerVisibility.flights && flightsReturnedCount === 0
      ? flightsFreshness === "zoom_required"
        ? t("dashboard.charts.warMap.legend.flightZoomRequired")
        : flightsFreshness === "not_configured"
          ? t("dashboard.charts.warMap.legend.flightNotConfigured")
          : flightsFreshness === "budget_limited"
            ? t("dashboard.charts.warMap.legend.flightBudgetLimited")
            : flightsFreshness === "stale"
              ? t("dashboard.charts.warMap.legend.flightStale")
              : t("dashboard.charts.warMap.legend.flightMissing")
      : null;
  const aisAllModeReason =
    layerVisibility.ais && aisAllModeDegraded
      ? (aisAllModeDegradedLabel ??
        t("dashboard.charts.warMap.legend.aisAggregatedOnly"))
      : null;
  const aisViewportReason =
    layerVisibility.ais && aisViewportEmptyStateActive
      ? (aisViewportEmptyStateHint ??
        t("dashboard.charts.warMap.legend.aisViewportEmpty"))
      : null;

  const statusHintLines = [
    flightsUnavailableReason
      ? `${t("dashboard.charts.warMap.overlay.flights")}: ${flightsUnavailableReason}`
      : null,
    aisAllModeReason
      ? `${t("dashboard.charts.warMap.layerNames.ais")}: ${aisAllModeReason}`
      : null,
    !aisAllModeReason && aisViewportReason
      ? `${t("dashboard.charts.warMap.layerNames.ais")}: ${aisViewportReason}`
      : null,
  ].filter((value): value is string => Boolean(value));

  const sectionStatusLabel =
    flightsUnavailableReason && aisAllModeReason
      ? t("dashboard.charts.warMap.legend.transportLimited")
      : aisAllModeReason
        ? t("dashboard.charts.warMap.legend.transportAggregatedOnly")
        : flightsUnavailableReason
          ? t("dashboard.charts.warMap.legend.transportFlightsLimited")
          : aisViewportReason
            ? t("dashboard.charts.warMap.legend.transportViewportEmpty")
            : undefined;

  const flightCountLabel =
    typeof flightsReturnedCount === "number"
      ? formatWarMapClusterCountLabel(flightsReturnedCount)
      : undefined;
  const aisPrimaryCountLabelValue =
    typeof aisPrimaryCountValue === "number"
      ? formatWarMapClusterCountLabel(aisPrimaryCountValue)
      : undefined;
  const aisDisruptionCountLabel =
    typeof aisDisruptionsCount === "number"
      ? formatWarMapClusterCountLabel(aisDisruptionsCount)
      : undefined;

  return {
    sectionStatusLabel,
    sectionStatusTone: sectionStatusLabel ? "warning" : undefined,
    sectionStatusHint:
      statusHintLines.length > 0 ? statusHintLines.join("\n") : undefined,
    flights: layerVisibility.flights
      ? {
          note: flightsUnavailableReason ?? undefined,
          countLabel: flightCountLabel,
          tone: flightsUnavailableReason ? "degraded" : "default",
        }
      : undefined,
    aisPrimary: layerVisibility.ais
      ? {
          note:
            aisAllModeReason ??
            aisViewportReason ??
            (effectiveAisMode === "all"
              ? t("dashboard.charts.warMap.legend.quickColorByCategory")
              : undefined),
          countLabel: aisPrimaryCountLabelValue,
          tone:
            aisAllModeReason || aisViewportReason ? "degraded" : "default",
        }
      : undefined,
    aisDisruption: layerVisibility.ais
      ? {
          countLabel: aisDisruptionCountLabel,
          tone: aisAllModeReason ? "degraded" : "default",
        }
      : undefined,
  };
}

export interface WarMapStatusSummaryParams {
  chainStatuses: {
    fetching: boolean;
    error: boolean;
    ready: boolean;
    errorMessage: string | undefined;
    dataUpdatedAt: number | undefined;
    sourceUpdatedAt: string | number | undefined;
    label: string;
    sourceUpdatedLabel: string;
  }[];
  streamState: {
    status: string;
    lastMessageAt?: number;
  };
  anyFetching: boolean;
  nowMs: number;
  locale: SupportedLocale;
  t: WarMapTranslateFn;
}

export interface WarMapStatusSummary {
  latestQueryUpdatedAt: number | null;
  latestQueryUpdatedRelative: string | null;
  latestQueryUpdatedExact: string | null;
  streamMessageRelative: string | null;
  streamMessageExact: string | null;
  streamStatusColor: string;
  streamStatusLabel: string;
  refreshingChainCount: number;
  healthyChainCount: number;
  errorChainCount: number;
  hasErroredChain: boolean;
  dataStatusColor: string;
  dataStatusLabel: string;
  detailedChainStatuses: (WarMapDetailedChainStatus & {
    fetching: boolean;
    error: boolean;
    ready: boolean;
    errorMessage: string | undefined;
    dataUpdatedAt: number | undefined;
    sourceUpdatedAt: string | number | undefined;
    label: string;
    sourceUpdatedLabel: string;
  })[];
  summaryDataLabel: string;
}

const STREAM_MESSAGE_STALE_MS = 45_000;
const DATA_REFRESH_STALE_MS = 150_000;

/** 顶部状态摘要与链路明细派生（FE-批4A：从 war-map.tsx 迁移）。 */
export function buildWarMapStatusSummary(
  params: WarMapStatusSummaryParams,
): WarMapStatusSummary {
  const { chainStatuses, streamState, anyFetching, nowMs, locale, t } = params;
const latestQueryUpdatedAt = chainStatuses.reduce<number | null>(
  (latest, status) => {
    if (!status.dataUpdatedAt) {
      return latest;
    }
    if (latest === null || status.dataUpdatedAt > latest) {
      return status.dataUpdatedAt;
    }
    return latest;
  },
  null,
);
const latestQueryUpdatedRelative = latestQueryUpdatedAt
  ? formatWarMapRelativeTimestamp(latestQueryUpdatedAt, locale, nowMs)
  : null;
const latestQueryUpdatedExact = latestQueryUpdatedAt
  ? formatUpdatedAt(latestQueryUpdatedAt, locale)
  : null;
const streamMessageRelative = streamState.lastMessageAt
  ? formatWarMapRelativeTimestamp(
      streamState.lastMessageAt,
      locale,
      nowMs,
    )
  : null;
const streamMessageExact = streamState.lastMessageAt
  ? formatUpdatedAt(streamState.lastMessageAt, locale)
  : null;
const streamLagging =
  streamState.status === "live" &&
  (!streamState.lastMessageAt ||
    nowMs - streamState.lastMessageAt > STREAM_MESSAGE_STALE_MS);
const streamStatusColor =
  streamState.status !== "live"
    ? "red"
    : streamLagging
      ? "gold"
      : "green";
const streamStatusLabel =
  streamState.status !== "live"
    ? t("dashboard.stream.status.offline")
    : streamLagging
      ? t("dashboard.charts.warMap.status.lagging")
      : t("dashboard.stream.status.live");
const refreshingChainCount = chainStatuses.filter(
  (status) => status.fetching,
).length;
const healthyChainCount = chainStatuses.filter(
  (status) => status.ready && !status.fetching && !status.error,
).length;
const errorChainCount = chainStatuses.filter((status) => status.error).length;
const hasErroredChain = chainStatuses.some((status) => status.error);
const dataStatusColor = !latestQueryUpdatedAt
  ? "default"
  : anyFetching
    ? "processing"
    : hasErroredChain
      ? "gold"
      : nowMs - latestQueryUpdatedAt > DATA_REFRESH_STALE_MS
        ? "gold"
        : "blue";
const dataStatusLabel = !latestQueryUpdatedAt
  ? t("dashboard.charts.warMap.status.waitingData")
  : anyFetching
    ? t("dashboard.charts.warMap.status.refreshingChains", {
        count: Math.max(refreshingChainCount, 1),
      })
    : t("dashboard.charts.warMap.overlay.updatedSummary", {
        value:
          latestQueryUpdatedRelative ??
          latestQueryUpdatedExact ??
          t("common.justNow"),
      });
const detailedChainStatuses = chainStatuses.map((status) => {
  const isStale =
    Boolean(status.dataUpdatedAt) &&
    !status.fetching &&
    nowMs - (status.dataUpdatedAt ?? 0) > DATA_REFRESH_STALE_MS;
  const stateLabel = status.error
    ? t("dashboard.charts.warMap.status.error")
    : status.fetching
      ? t("dashboard.charts.warMap.status.refreshing")
      : !status.ready
        ? t("dashboard.charts.warMap.status.waiting")
        : isStale
          ? t("dashboard.charts.warMap.status.stale")
          : t("dashboard.charts.warMap.status.updated");
  const relativeUpdated = status.dataUpdatedAt
    ? formatWarMapRelativeTimestamp(status.dataUpdatedAt, locale, nowMs)
    : null;
  const exactUpdated = status.dataUpdatedAt
    ? formatUpdatedAt(status.dataUpdatedAt, locale)
    : null;
  const sourceUpdated = status.sourceUpdatedAt
    ? formatUpdatedAt(status.sourceUpdatedAt, locale)
    : null;
  const color = status.error
    ? "red"
    : status.fetching
      ? "processing"
      : !status.ready
        ? "default"
        : isStale
          ? "gold"
          : "green";
  const text =
    status.ready && relativeUpdated && !status.fetching && !status.error
      ? `${status.label}: ${relativeUpdated}`
      : `${status.label}: ${stateLabel}`;
  const tooltipLines = [
    `${status.label}: ${stateLabel}`,
    exactUpdated
      ? `${t("dashboard.charts.warMap.overlay.lastUpdatedLabel")}: ${exactUpdated}`
      : null,
    sourceUpdated ? `${status.sourceUpdatedLabel}: ${sourceUpdated}` : null,
    status.errorMessage ?? null,
  ].filter(Boolean);
  return {
    ...status,
    color,
    text,
    tooltip: tooltipLines.join("\n"),
  };
}) as WarMapStatusSummary["detailedChainStatuses"];

const summaryDataLabel = !latestQueryUpdatedAt
  ? t("dashboard.charts.warMap.status.waitingData")
  : anyFetching
    ? t("dashboard.charts.warMap.status.refreshingChains", {
        count: Math.max(refreshingChainCount, 1),
      })
    : t("dashboard.charts.warMap.overlay.updatedSummary", {
        value:
          latestQueryUpdatedRelative ??
          latestQueryUpdatedExact ??
          t("common.justNow"),
      });
  return {
    latestQueryUpdatedAt,
    latestQueryUpdatedRelative,
    latestQueryUpdatedExact,
    streamMessageRelative,
    streamMessageExact,
    streamStatusColor,
    streamStatusLabel,
    refreshingChainCount,
    healthyChainCount,
    errorChainCount,
    hasErroredChain,
    dataStatusColor,
    dataStatusLabel,
    detailedChainStatuses,
    summaryDataLabel,
  };
}

export {
  buildWarMapLoadOverlayState,
  type WarMapLoadOverlayState,
  type WarMapLoadOverlayStateParams,
} from "./war-map-load-state";
