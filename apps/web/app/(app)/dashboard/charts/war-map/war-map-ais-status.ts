import type { WarMapAisLayerSummary, WarMapAisMode, WarMapLayerVisibility } from "@modular/utils";

import type { SupportedLocale } from "@/lib/i18n";
import { formatAisRuntimeReason } from "@/lib/realtime-signals-runtime";

import { isAisViewportEmptyStateActive } from "./war-map-ais-mode";
import { formatWarMapRelativeTimestamp } from "./war-map-format";
import type { WarMapTranslateFn } from "./war-map-overlay-model";

export type WarMapAisSummaryPresentation = ReturnType<
  typeof buildWarMapAisSummaryPresentation
>;

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
) {
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

