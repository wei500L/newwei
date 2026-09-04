import type {
  WarMapAisLayerSummary,
  WarMapAisMode,
  WarMapLayerVisibility,
} from "@modular/utils";

import {
  formatRelativeTime,
  formatUpdatedAt,
  type SupportedLocale,
} from "@/lib/i18n";
import { formatAisRuntimeReason } from "@/lib/realtime-signals-runtime";

import { isAisViewportEmptyStateActive } from "./war-map-ais-mode";
import type { WarMapTranslateFn } from "./war-map-overlay-model";
import {
  formatWarMapClusterCountLabel,
  type WarMapTransportLegendState,
} from "./war-map-symbols";

/** 相对时间戳（短相对格式优先，退化到绝对更新时间）。 */
export function formatWarMapRelativeTimestamp(
  value: string | number | Date | undefined,
  locale: SupportedLocale,
  base: number,
): string | null {
  if (value === undefined) {
    return null;
  }

  return (
    formatRelativeTime(value, locale, {
      base,
      style: "short",
    }) || formatUpdatedAt(value, locale)
  );
}

export function getErrorMessage(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof Error) {
    const withResponse = error as Error & {
      response?: { data?: { message?: string; error?: { message?: string } } };
    };
    const data = withResponse.response?.data;
    return data?.error?.message ?? data?.message ?? withResponse.message;
  }
  return typeof error === "string" ? error : undefined;
}

function readSummaryNumber(
  summary: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readSummaryString(
  summary: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = summary?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFlightBudgetSummary(summary: Record<string, unknown> | undefined) {
  const degradationLevel = readSummaryString(summary, "degradationLevel");
  return {
    remainingCredits: readSummaryNumber(summary, "remainingCredits"),
    dailyBudget: readSummaryNumber(summary, "dailyBudget"),
    dateHkt: readSummaryString(summary, "dateHkt"),
    statusReasonCode: readSummaryString(summary, "statusReasonCode"),
    statusReason: readSummaryString(summary, "statusReason"),
    degradationLevel:
      degradationLevel === "normal" ||
      degradationLevel === "warning" ||
      degradationLevel === "critical" ||
      degradationLevel === "exhausted"
        ? degradationLevel
        : undefined,
  };
}

export interface WarMapFlightsSummaryPresentation {
  flightsReturnedCount;
  flightsSnapshotCount;
  flightsRawCount;
  flightsMaxReturned;
  flightsTruncated;
  flightsFreshness;
  flightsSource;
  flightsScope;
  flightsSourceEndpoint;
  flightsBudget;
  flightsSourceLabel;
  flightsScopeLabel;
  flightsSourceBadgeLabel;
  flightsCoverageLabel;
  flightsRawLabel;
  flightsBudgetReason;
  flightsTooltipText;
}

export interface WarMapFlightsSummaryPresentationParams {
  flightsSummary: Record<string, unknown> | undefined;
  t: WarMapTranslateFn;
}

/** 航班摘要展示派生（FE-批4A：从 war-map.tsx 迁移，字段语义不变）。 */
export function buildWarMapFlightsSummaryPresentation(
  params: WarMapFlightsSummaryPresentationParams,
): WarMapFlightsSummaryPresentation {
  const { flightsSummary, t } = params;
const flightsReturnedCount = readSummaryNumber(
  flightsSummary,
  "returnedCount",
);
const flightsSnapshotCount = readSummaryNumber(
  flightsSummary,
  "snapshotValidPositionCount",
);
const flightsRawCount = readSummaryNumber(flightsSummary, "rawAircraftCount");
const flightsMaxReturned = readSummaryNumber(flightsSummary, "maxReturned");
const flightsTruncated = flightsSummary?.truncated === true;
const flightsFreshness =
  typeof flightsSummary?.freshness === "string"
    ? flightsSummary.freshness
    : undefined;
const flightsSource = readSummaryString(flightsSummary, "source");
const flightsScope = readSummaryString(flightsSummary, "scope");
const flightsSourceEndpoint = readSummaryString(
  flightsSummary,
  "sourceEndpoint",
);
const flightsBudget = readFlightBudgetSummary(flightsSummary);
const flightsSourceLabel =
  flightsSource === "opensky"
    ? t("dashboard.charts.warMap.stats.flightSourceOpensky")
    : flightsSource
      ? flightsSource.toUpperCase()
      : undefined;
const flightsScopeLabel =
  flightsScope === "military"
    ? t("dashboard.charts.warMap.stats.flightScopeMilitary")
    : flightsScope === "all"
      ? t("dashboard.charts.warMap.stats.flightScopeAll")
      : flightsScope;
const flightsSourceBadgeLabel =
  flightsSourceLabel && flightsScopeLabel
    ? `${flightsSourceLabel} / ${flightsScopeLabel}`
    : (flightsSourceLabel ?? flightsScopeLabel ?? null);
const flightsCoverageLabel =
  typeof flightsSnapshotCount === "number" &&
  typeof flightsRawCount === "number"
    ? t("dashboard.charts.warMap.stats.flightCoverage", {
        positioned: flightsSnapshotCount,
        raw: flightsRawCount,
      })
    : null;
const flightsRawLabel =
  typeof flightsRawCount === "number"
    ? t("dashboard.charts.warMap.stats.flightsRaw", {
        count: flightsRawCount,
      })
    : null;
const flightsBudgetReason =
  flightsFreshness === "budget_limited"
    ? flightsBudget.statusReasonCode === "opensky_budget_critical"
      ? t("dashboard.charts.warMap.stats.flightBudgetLimitedCritical")
      : flightsBudget.statusReasonCode === "opensky_budget_exhausted"
        ? t("dashboard.charts.warMap.stats.flightBudgetLimitedExhausted")
        : flightsBudget.statusReasonCode ===
            "opensky_budget_insufficient_credits"
          ? t(
              "dashboard.charts.warMap.stats.flightBudgetLimitedInsufficient",
            )
          : t("dashboard.charts.warMap.stats.flightBudgetLimited")
    : null;
const flightsTooltipText = [
  flightsSourceLabel
    ? `${t("dashboard.charts.warMap.stats.flightSource")}: ${flightsSourceLabel}`
    : null,
  flightsScopeLabel
    ? `${t("dashboard.charts.warMap.stats.flightScope")}: ${flightsScopeLabel}`
    : null,
  flightsCoverageLabel
    ? `${t("dashboard.charts.warMap.stats.flightCoverageLabel")}: ${flightsCoverageLabel}`
    : null,
  typeof flightsReturnedCount === "number"
    ? `${t("dashboard.charts.warMap.stats.flightRendered")}: ${flightsReturnedCount}${typeof flightsMaxReturned === "number" ? ` / ${flightsMaxReturned}` : ""}`
    : null,
  flightsSourceEndpoint
    ? `${t("dashboard.charts.warMap.stats.flightEndpoint")}: ${flightsSourceEndpoint}`
    : null,
  flightsFreshness === "zoom_required"
    ? t("dashboard.charts.warMap.stats.flightZoomRequired")
    : null,
  flightsFreshness === "not_configured"
    ? t("dashboard.charts.warMap.stats.flightNotConfigured")
    : flightsFreshness === "budget_limited"
      ? flightsBudgetReason
      : null,
  flightsFreshness === "budget_limited" &&
  typeof flightsBudget.remainingCredits === "number" &&
  typeof flightsBudget.dailyBudget === "number"
    ? t("dashboard.charts.warMap.stats.flightBudgetRemaining", {
        remaining: flightsBudget.remainingCredits,
        budget: flightsBudget.dailyBudget,
      })
    : null,
  flightsFreshness === "budget_limited" && flightsBudget.dateHkt
    ? t("dashboard.charts.warMap.stats.flightBudgetReset", {
        date: flightsBudget.dateHkt,
      })
    : null,
  flightsFreshness === "budget_limited" && flightsBudget.degradationLevel
    ? t("dashboard.charts.warMap.stats.flightBudgetDegradation", {
        value: flightsBudget.degradationLevel,
      })
    : null,
  flightsFreshness === "budget_limited" && flightsBudget.statusReason
    ? flightsBudget.statusReason
    : null,
]
  .filter((value): value is string => Boolean(value))
  .join("\n");
  return {
    flightsReturnedCount,
    flightsSnapshotCount,
    flightsRawCount,
    flightsMaxReturned,
    flightsTruncated,
    flightsFreshness,
    flightsSource,
    flightsScope,
    flightsSourceEndpoint,
    flightsBudget,
    flightsSourceLabel,
    flightsScopeLabel,
    flightsSourceBadgeLabel,
    flightsCoverageLabel,
    flightsRawLabel,
    flightsBudgetReason,
    flightsTooltipText,
  };
}

export interface WarMapAisSummaryPresentation {
  aisConnected;
  aisConfigured;
  aisFreshness;
  aisSnapshotUpdatedAt;
  aisSourceEndpoint;
  aisRelayVesselCount;
  aisDisruptionsCount;
  aisDensityCount;
  aisCandidateCount;
  aisRenderedVesselCount;
  aisAllVesselsAvailable;
  aisMessageCount;
  aisClientCount;
  aisDroppedMessages;
  aisPositionReportsSeen;
  aisPositionReportsProcessed;
  aisIgnoredPositionReports;
  aisParseErrors;
  aisStatusReasonCode;
  aisStatusReason;
  aisViewportVesselCount;
  aisMaxReturned;
  aisTruncated;
  aisBlockedReasonCode;
  aisBlockedReason;
  aisResolvedStatusReason;
  aisResolvedBlockedReason;
  aisViewportEmptyStateActive;
  aisViewportEmptyStateLabel;
  aisViewportEmptyStateHint;
  aisSnapshotRelative;
  aisSnapshotExact;
  aisHasIssue;
  aisSourceStatusColor;
  aisSourceStatusLabel;
  aisPreferredModeLabel;
  aisEffectiveModeLabel;
  aisHighlightedCandidateCount;
  aisTooltipText;
  aisAllModeDegraded;
  aisAllModeDegradedLabel;
  aisPrimaryCountLabel;
  aisPrimaryCountValue;
  aisHighlightCountLabel;
}

export interface WarMapAisSummaryPresentationParams {
  aisSummary: WarMapAisLayerSummary | undefined;
  layerVisibility: WarMapLayerVisibility;
  aisMode: WarMapAisMode;
  effectiveAisMode: WarMapAisMode;
  aisHighlightCandidates: boolean;
  aisHighlightedCandidateCount: number | undefined;
  locale: SupportedLocale;
  nowMs: number;
  t: WarMapTranslateFn;
}

/** AIS 摘要展示派生（FE-批4A：从 war-map.tsx 迁移，字段语义不变）。 */
export function buildWarMapAisSummaryPresentation(
  params: WarMapAisSummaryPresentationParams,
): WarMapAisSummaryPresentation {
  const {
    aisSummary,
    layerVisibility,
    aisMode,
    effectiveAisMode,
    aisHighlightCandidates,
    aisHighlightedCandidateCount,
    locale,
    nowMs,
    t,
  } = params;
const aisConnected = aisSummary?.connected ?? false;
const aisConfigured = aisSummary?.configured ?? true;
const aisFreshness = aisSummary?.freshness;
const aisSnapshotUpdatedAt = aisSummary?.snapshotUpdatedAt;
const aisSourceEndpoint = aisSummary?.sourceEndpoint;
const aisRelayVesselCount = aisSummary?.relayVesselCount;
const aisDisruptionsCount = aisSummary?.disruptionsCount;
const aisDensityCount = aisSummary?.densityCount;
const aisCandidateCount = aisSummary?.candidateCount;
const aisRenderedVesselCount = aisSummary?.renderedVesselCount;
const aisAllVesselsAvailable = aisSummary?.allVesselsAvailable;
const aisMessageCount = aisSummary?.messageCount;
const aisClientCount = aisSummary?.clientCount;
const aisDroppedMessages = aisSummary?.droppedMessages;
const aisPositionReportsSeen = aisSummary?.positionReportsSeen;
const aisPositionReportsProcessed = aisSummary?.positionReportsProcessed;
const aisIgnoredPositionReports = aisSummary?.ignoredPositionReports;
const aisParseErrors = aisSummary?.parseErrors;
const aisStatusReasonCode = aisSummary?.statusReasonCode;
const aisStatusReason = aisSummary?.statusReason;
const aisViewportVesselCount = aisSummary?.viewportVesselCount;
const aisMaxReturned = aisSummary?.maxReturned;
const aisTruncated = aisSummary?.truncated ?? false;
const aisBlockedReasonCode = aisSummary?.blockedReasonCode;
const aisBlockedReason = aisSummary?.blockedReason;
const aisResolvedStatusReason = formatAisRuntimeReason(
  t,
  aisStatusReasonCode,
  aisStatusReason,
);
const aisResolvedBlockedReason =
  aisBlockedReasonCode === "missing_vessels_snapshot"
    ? t("dashboard.charts.warMap.stats.aisAllUnavailableHint")
    : aisBlockedReasonCode === "snapshot_unavailable"
      ? t("dashboard.charts.warMap.stats.aisSnapshotUnavailable")
      : aisBlockedReason;
const aisViewportEmptyStateActive =
  layerVisibility.ais &&
  isAisViewportEmptyStateActive({
    effectiveMode: effectiveAisMode,
    allVesselsAvailable: aisAllVesselsAvailable,
    viewportVesselCount: aisViewportVesselCount,
    renderedVesselCount: aisRenderedVesselCount,
  });
const aisViewportEmptyStateLabel = aisViewportEmptyStateActive
  ? t("dashboard.charts.warMap.stats.aisViewportEmpty")
  : null;
const aisViewportEmptyStateHint = aisViewportEmptyStateActive
  ? t("dashboard.charts.warMap.stats.aisViewportEmptyHint")
  : null;
const aisSnapshotRelative = aisSnapshotUpdatedAt
  ? formatWarMapRelativeTimestamp(aisSnapshotUpdatedAt, locale, nowMs)
  : null;
const aisSnapshotExact = aisSnapshotUpdatedAt
  ? formatUpdatedAt(aisSnapshotUpdatedAt, locale)
  : null;
const aisHasIssue = Boolean(aisResolvedStatusReason);
const aisSourceStatusColor = !aisConfigured
  ? "red"
  : aisHasIssue
      ? "volcano"
      : !aisConnected
        ? "gold"
      : aisFreshness === "stale"
        ? "gold"
        : "cyan";
const aisSourceStatusLabel = !aisConfigured
  ? t("dashboard.charts.warMap.stats.aisNotConfigured")
  : aisHasIssue
      ? t("dashboard.charts.warMap.stats.aisDegraded")
      : !aisConnected
        ? t("dashboard.charts.warMap.stats.aisDisconnected")
      : aisFreshness === "stale"
        ? t("dashboard.charts.warMap.status.stale")
        : t("dashboard.stream.status.live");
const aisPreferredModeLabel =
  aisMode === "all"
    ? t("dashboard.charts.warMap.stats.aisModeAll")
    : aisMode === "density"
      ? t("dashboard.charts.warMap.stats.aisModeDensity")
      : t("dashboard.charts.warMap.stats.aisModeMilitary");
const aisEffectiveModeLabel = aisPreferredModeLabel;
const aisTooltipText = [
  `${t("dashboard.charts.warMap.layerNames.ais")}: ${aisSourceStatusLabel}`,
  aisResolvedStatusReason,
  `${t("dashboard.charts.warMap.stats.mode")}: ${aisEffectiveModeLabel}`,
  effectiveAisMode === "all"
    ? t("dashboard.charts.warMap.overlay.aisAllVesselsHint")
    : effectiveAisMode === "military"
      ? t("dashboard.charts.warMap.overlay.aisCandidatesOnlyHint")
      : null,
  effectiveAisMode === "all"
    ? aisHighlightCandidates
      ? t("dashboard.charts.warMap.overlay.aisHighlightCandidatesHint")
      : t("dashboard.charts.warMap.overlay.aisHighlightCandidatesOffHint")
    : null,
  aisViewportEmptyStateHint,
  typeof aisRelayVesselCount === "number"
    ? `${t("dashboard.charts.warMap.stats.aisTrackedVessels")}: ${aisRelayVesselCount}`
    : null,
  typeof aisViewportVesselCount === "number"
    ? `${t("dashboard.charts.warMap.stats.aisViewportVessels")}: ${aisViewportVesselCount}`
    : null,
  typeof aisRenderedVesselCount === "number"
    ? `${t("dashboard.charts.warMap.stats.aisRenderedVessels")}: ${aisRenderedVesselCount}`
    : null,
  typeof aisHighlightedCandidateCount === "number"
    ? `${t("dashboard.charts.warMap.stats.aisHighlightedCandidates")}: ${aisHighlightedCandidateCount}`
    : null,
  typeof aisMaxReturned === "number"
    ? `${t("dashboard.charts.warMap.stats.aisViewportCap")}: ${aisMaxReturned}`
    : null,
  aisTruncated
    ? t("dashboard.charts.warMap.stats.aisViewportTruncated")
    : null,
  typeof aisCandidateCount === "number"
    ? `${t("dashboard.charts.warMap.stats.aisCandidates")}: ${aisCandidateCount}`
    : null,
  typeof aisDensityCount === "number"
    ? `${t("dashboard.charts.warMap.stats.aisDensityZones")}: ${aisDensityCount}`
    : null,
  typeof aisDisruptionsCount === "number"
    ? `${t("dashboard.charts.warMap.stats.aisDisruptions")}: ${aisDisruptionsCount}`
    : null,
  typeof aisMessageCount === "number"
    ? `${t("dashboard.charts.warMap.stats.aisMessages")}: ${aisMessageCount}`
    : null,
  typeof aisPositionReportsSeen === "number"
    ? `${t("dashboard.charts.warMap.stats.aisPositionReportsSeen")}: ${aisPositionReportsSeen}`
    : null,
  typeof aisPositionReportsProcessed === "number"
    ? `${t("dashboard.charts.warMap.stats.aisPositionReportsProcessed")}: ${aisPositionReportsProcessed}`
    : null,
  typeof aisIgnoredPositionReports === "number"
    ? `${t("dashboard.charts.warMap.stats.aisIgnoredPositionReports")}: ${aisIgnoredPositionReports}`
    : null,
  typeof aisParseErrors === "number"
    ? `${t("dashboard.charts.warMap.stats.aisParseErrors")}: ${aisParseErrors}`
    : null,
  typeof aisDroppedMessages === "number"
    ? `${t("dashboard.charts.warMap.stats.aisDroppedMessages")}: ${aisDroppedMessages}`
    : null,
  typeof aisClientCount === "number"
    ? `${t("dashboard.charts.warMap.stats.aisClients")}: ${aisClientCount}`
    : null,
  aisSourceEndpoint
    ? `${t("dashboard.charts.warMap.stats.aisSourceEndpoint")}: ${aisSourceEndpoint}`
    : null,
  aisSnapshotExact
    ? `${t("dashboard.charts.warMap.stats.aisSnapshotUpdated")}: ${aisSnapshotExact}`
    : null,
  aisResolvedBlockedReason ?? null,
]
  .filter((value): value is string => Boolean(value))
  .join("\n");
const aisAllModeDegraded =
  effectiveAisMode === "all" && aisAllVesselsAvailable === false;
const aisAllModeDegradedLabel = aisAllModeDegraded
  ? (aisResolvedBlockedReason ??
    t("dashboard.charts.warMap.stats.aisAllUnavailable"))
  : null;
const aisPrimaryCountLabel =
  effectiveAisMode === "density"
    ? t("dashboard.charts.warMap.stats.aisDensityZones")
    : effectiveAisMode === "military"
      ? t("dashboard.charts.warMap.stats.aisCandidates")
      : t("dashboard.charts.warMap.stats.aisViewportVessels");
const aisPrimaryCountValue =
  effectiveAisMode === "density"
    ? aisDensityCount
    : effectiveAisMode === "military"
      ? (aisRenderedVesselCount ?? aisCandidateCount)
      : (aisViewportVesselCount ?? aisRenderedVesselCount);
const aisHighlightCountLabel =
  effectiveAisMode === "all" && aisHighlightCandidates
    ? t("dashboard.charts.warMap.stats.aisHighlightedCandidates")
    : undefined;
  return {
    aisConnected,
    aisConfigured,
    aisFreshness,
    aisSnapshotUpdatedAt,
    aisSourceEndpoint,
    aisRelayVesselCount,
    aisDisruptionsCount,
    aisDensityCount,
    aisCandidateCount,
    aisRenderedVesselCount,
    aisAllVesselsAvailable,
    aisMessageCount,
    aisClientCount,
    aisDroppedMessages,
    aisPositionReportsSeen,
    aisPositionReportsProcessed,
    aisIgnoredPositionReports,
    aisParseErrors,
    aisStatusReasonCode,
    aisStatusReason,
    aisViewportVesselCount,
    aisMaxReturned,
    aisTruncated,
    aisBlockedReasonCode,
    aisBlockedReason,
    aisResolvedStatusReason,
    aisResolvedBlockedReason,
    aisViewportEmptyStateActive,
    aisViewportEmptyStateLabel,
    aisViewportEmptyStateHint,
    aisSnapshotRelative,
    aisSnapshotExact,
    aisHasIssue,
    aisSourceStatusColor,
    aisSourceStatusLabel,
    aisPreferredModeLabel,
    aisEffectiveModeLabel,
    aisHighlightedCandidateCount,
    aisTooltipText,
    aisAllModeDegraded,
    aisAllModeDegradedLabel,
    aisPrimaryCountLabel,
    aisPrimaryCountValue,
    aisHighlightCountLabel,
  };
}

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
    errorMessage?: string;
    dataUpdatedAt?: number;
    sourceUpdatedAt?: string;
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
  detailedChainStatuses: WarMapDetailedChainStatus[];
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
});

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

export interface WarMapLoadOverlayStateParams {
  mapLoadError: {
    title: string;
    description: string;
  } | null;
  mapReady: boolean;
  anyLoading: boolean;
  errors: unknown[];
  hasData: boolean;
  refreshingMapData: boolean;
  retryMapLoad: () => void;
  refreshMapData: () => void;
  t: WarMapTranslateFn;
}

export interface WarMapLoadOverlayState {
  showBootOverlay: boolean;
  bootOverlayLabel: string;
  hasFatalDataError: boolean;
  fatalOverlay: {
    title: string;
    description: string;
    actionLabel: string;
    actionLoading: boolean;
    onAction: () => void;
  } | null;
  hasFatalOverlay: boolean;
  hasNonFatalDataError: boolean;
}

/** boot/致命错误覆盖层状态派生（FE-批4A：从 war-map.tsx 迁移）。 */
export function buildWarMapLoadOverlayState(
  params: WarMapLoadOverlayStateParams,
): WarMapLoadOverlayState {
  const {
    mapLoadError,
    mapReady,
    anyLoading,
    errors,
    hasData,
    refreshingMapData,
    retryMapLoad,
    refreshMapData,
    t,
  } = params;

  const showBootOverlay =
    !mapLoadError && (!mapReady || (anyLoading && !hasData));
  const bootOverlayLabel = !mapReady
    ? t("dashboard.charts.warMap.status.loadingMap")
    : t("dashboard.charts.warMap.status.loadingData");
  const hasFatalDataError = !anyLoading && errors.length > 0 && !hasData;
  const fatalOverlay = mapLoadError
    ? {
        title: mapLoadError.title,
        description: mapLoadError.description,
        actionLabel: t("common.retry"),
        actionLoading: false,
        onAction: retryMapLoad,
      }
    : hasFatalDataError
      ? {
          title: t("dashboard.dataAbnormal"),
          description:
            getErrorMessage(errors[0]) ?? t("common.serviceUnavailable"),
          actionLabel: t("dashboard.actions.retryFetch"),
          actionLoading: refreshingMapData,
          onAction: () => {
            refreshMapData();
          },
        }
      : null;

  return {
    showBootOverlay,
    bootOverlayLabel,
    hasFatalDataError,
    fatalOverlay,
    hasFatalOverlay: Boolean(fatalOverlay),
    hasNonFatalDataError: errors.length > 0 && hasData,
  };
}
