import type { WarMapTranslateFn } from "./war-map-overlay-model";

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

export { readSummaryNumber, readSummaryString };

export type WarMapFlightsSummaryPresentation = ReturnType<
  typeof buildWarMapFlightsSummaryPresentation
>;

export interface WarMapFlightsSummaryPresentationParams {
  flightsSummary: Record<string, unknown> | undefined;
  t: WarMapTranslateFn;
}

/** 航班摘要展示派生（FE-批4A：从 war-map.tsx 迁移，字段语义不变）。 */
export function buildWarMapFlightsSummaryPresentation(
  params: WarMapFlightsSummaryPresentationParams,
) {
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

