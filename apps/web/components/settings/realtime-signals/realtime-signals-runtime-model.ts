import {
  buildAisRuntimeFeedbackAlert,
  isOutagesRateLimited,
  type RealtimeSignalRuntimeStatus,
} from "@/lib/realtime-signals-runtime";

import type {
  RealtimeOpenskyBudgetDegradationLevel,
  RealtimeOpenskyBudgetSummary,
  RealtimeOpenskyErrorKind,
  RealtimeOpenskySnapshotFreshness,
  RealtimeSignalRuntimeDiagnosticsSource,
  RealtimeSignalSourceKey,
  RealtimeSignalsTranslate,
} from "./realtime-signals-types";

export interface RuntimeFeedbackAlert {
  type: "error" | "warning";
  message: string;
  description: string;
}

export function summarizeRuntimeContext(
  t: RealtimeSignalsTranslate,
  source: RealtimeSignalSourceKey,
  context?: Record<string, unknown>,
  aisDiagnostics?: RealtimeSignalRuntimeDiagnosticsSource["aisDiagnostics"],
  openskySnapshot?: RealtimeSignalRuntimeDiagnosticsSource["openskySnapshot"],
) {
  if (!context && !aisDiagnostics && source !== "opensky") {
    return null;
  }
  const resolvedContext = context ?? {};

  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const str = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

  switch (source) {
    case "opensky":
      return t(
        "systemSettings.realtimeSignals.runtime.contextSummary.opensky",
        {
          scope: str(resolvedContext.scope) ?? "military",
          military: num(resolvedContext.militaryCount) ?? 0,
          raw:
            openskySnapshot?.rawAircraftCount ??
            num(resolvedContext.totalAircraft) ??
            0,
          current:
            openskySnapshot?.currentValidPositionCount ??
            num(resolvedContext.validPositionCount) ??
            0,
          map:
            openskySnapshot?.snapshotValidPositionCount ??
            num(resolvedContext.snapshotValidPositionCount) ??
            num(resolvedContext.validPositionCount) ??
            0,
        },
      );
    case "ais":
      return aisDiagnostics?.configured === false
        ? t(
            "systemSettings.realtimeSignals.runtime.contextSummary.aisNotConfigured",
          )
        : t("systemSettings.realtimeSignals.runtime.contextSummary.ais", {
            disruptions: aisDiagnostics?.disruptionsCount ?? 0,
            density: aisDiagnostics?.densityRegions ?? 0,
            vessels: aisDiagnostics?.vesselCount ?? 0,
            seen: aisDiagnostics?.positionReportsSeen ?? 0,
            processed: aisDiagnostics?.positionReportsProcessed ?? 0,
            ignored: aisDiagnostics?.ignoredPositionReports ?? 0,
            parse: aisDiagnostics?.parseErrors ?? 0,
          });
    case "unrest":
      if (resolvedContext.acledApiEnabled === false) {
        return t(
          "systemSettings.realtimeSignals.runtime.contextSummary.unrestGdeltOnly",
          {
            gdelt: num(resolvedContext.gdeltCount) ?? 0,
            total: num(resolvedContext.unrestCount) ?? 0,
          },
        );
      }
      return t("systemSettings.realtimeSignals.runtime.contextSummary.unrest", {
        acled: num(resolvedContext.acledCount) ?? 0,
        gdelt: num(resolvedContext.gdeltCount) ?? 0,
        total: num(resolvedContext.unrestCount) ?? 0,
      });
    case "outages":
      return resolvedContext.configured === false
        ? t(
            "systemSettings.realtimeSignals.runtime.contextSummary.outagesNotConfigured",
          )
        : t("systemSettings.realtimeSignals.runtime.contextSummary.outages", {
            outages: num(resolvedContext.outages) ?? 0,
          });
    case "keyword_spike":
      return t(
        "systemSettings.realtimeSignals.runtime.contextSummary.keywordSpike",
        {
          recent: num(resolvedContext.recentArticleCount) ?? 0,
          baseline: num(resolvedContext.baselineArticleCount) ?? 0,
          spikes: Array.isArray(resolvedContext.spikes)
            ? resolvedContext.spikes.length
            : 0,
        },
      );
    case "pizzint":
      return t(
        "systemSettings.realtimeSignals.runtime.contextSummary.pizzint",
        {
          defcon: num(resolvedContext.defcon) ?? 0,
          open: num(resolvedContext.openLocations) ?? 0,
          spikes: num(resolvedContext.activeSpikes) ?? 0,
        },
      );
    case "gdelt_tension":
      return t(
        "systemSettings.realtimeSignals.runtime.contextSummary.gdeltTension",
        {
          pairs: Array.isArray(resolvedContext.tensions)
            ? resolvedContext.tensions.length
            : 0,
          start: str(resolvedContext.dateStart) ?? "-",
          end: str(resolvedContext.dateEnd) ?? "-",
        },
      );
    case "polymarket_leads":
      return t(
        "systemSettings.realtimeSignals.runtime.contextSummary.polymarketLeads",
        {
          leads: Array.isArray(resolvedContext.leads)
            ? resolvedContext.leads.length
            : 0,
        },
      );
    default:
      return null;
  }
}

export function runtimeFreshnessColor(
  freshness: RealtimeOpenskySnapshotFreshness,
) {
  switch (freshness) {
    case "fresh":
      return "green";
    case "stale":
      return "orange";
    default:
      return "default";
  }
}

export function openskyBudgetDegradationColor(
  degradation: RealtimeOpenskyBudgetDegradationLevel | undefined,
) {
  switch (degradation) {
    case "warning":
      return "gold";
    case "critical":
      return "orange";
    case "exhausted":
      return "red";
    default:
      return "green";
  }
}

export function runtimeStatusColor(status: RealtimeSignalRuntimeStatus) {
  return status === "ok"
    ? "green"
    : status === "error"
      ? "red"
      : status === "stale"
        ? "orange"
        : status === "not_configured"
          ? "gold"
          : "default";
}

export function runtimeStatusLabel(
  t: RealtimeSignalsTranslate,
  status: RealtimeSignalRuntimeStatus,
) {
  return t(`systemSettings.realtimeSignals.runtime.status.${status}`, {
    defaultValue:
      status === "ok"
        ? "OK"
        : status === "error"
          ? "Error"
          : status === "stale"
            ? "Stale"
            : status === "not_configured"
              ? "Not configured"
              : "Idle",
  });
}

export function formatPercentValue(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(2)}%`
    : "—";
}

export function formatTimestampValue(
  t: RealtimeSignalsTranslate,
  value?: string,
) {
  if (!value) {
    return t("systemSettings.realtimeSignals.status.notConfigured");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString();
}

export function formatOpenskyRuntimeReason(
  t: RealtimeSignalsTranslate,
  code: string | undefined,
  fallback: string | undefined,
) {
  if (!code) {
    return fallback;
  }
  return t(`systemSettings.realtimeSignals.runtime.openskyReason.${code}`, {
    defaultValue: fallback ?? code,
  });
}

export function formatOpenskyErrorKindLabel(
  t: RealtimeSignalsTranslate,
  kind: RealtimeOpenskyErrorKind | undefined,
) {
  if (!kind) {
    return undefined;
  }
  return t(`systemSettings.realtimeSignals.runtime.openskyErrorKind.${kind}`, {
    defaultValue: kind,
  });
}

export function buildRuntimeFeedbackAlert(
  t: RealtimeSignalsTranslate,
  row: RealtimeSignalRuntimeDiagnosticsSource,
  formatTimestamp: (value?: string) => string,
): RuntimeFeedbackAlert | null {
  if (row.source === "ais") {
    return buildAisRuntimeFeedbackAlert(t, row, formatTimestamp);
  }

  if (row.source === "outages" && isOutagesRateLimited(row)) {
    const retryAfterValue =
      typeof row.lastRateLimit?.retryAfterSec === "number"
        ? `${row.lastRateLimit.retryAfterSec}s`
        : undefined;
    const nextEligibleAt = row.nextEligibleAt
      ? formatTimestamp(row.nextEligibleAt)
      : undefined;
    return {
      type: "warning" as const,
      message: t(
        "systemSettings.realtimeSignals.runtime.feedback.outagesRateLimited.title",
      ),
      description: `${t(
        "systemSettings.realtimeSignals.runtime.feedback.outagesRateLimited.body",
        {
          time:
            nextEligibleAt ??
            t("systemSettings.realtimeSignals.status.notConfigured"),
        },
      )}${
        retryAfterValue
          ? ` ${t(
              "systemSettings.realtimeSignals.runtime.feedback.retryAfterWindow",
              {
                value: retryAfterValue,
              },
            )}`
          : ""
      }`,
    };
  }

  return null;
}

/** OpenSky 预算表单的派生视图（标签 / 降级 / 错误分布）。 */
export interface OpenskyBudgetView {
  periodLabel: string;
  degradationLabel: string;
  errorBreakdown: string;
}

export function buildOpenskyBudgetView(
  t: RealtimeSignalsTranslate,
  openskyBudget: RealtimeOpenskyBudgetSummary | undefined,
): OpenskyBudgetView {
  const periodLabel =
    openskyBudget?.currentPeriod === "day"
      ? t("systemSettings.realtimeSignals.runtime.openskyBudget.periods.day")
      : openskyBudget?.currentPeriod === "night"
        ? t(
            "systemSettings.realtimeSignals.runtime.openskyBudget.periods.night",
          )
        : "—";
  const degradationLabel = openskyBudget
    ? t(
        `systemSettings.realtimeSignals.runtime.openskyBudget.degradation.${openskyBudget.degradationLevel}`,
        {
          defaultValue: openskyBudget.degradationLevel,
        },
      )
    : "—";
  const errorBreakdown = openskyBudget
    ? [
        `${t("systemSettings.realtimeSignals.runtime.openskyErrorKind.auth")} ${openskyBudget.authErrorCalls}`,
        `${t("systemSettings.realtimeSignals.runtime.openskyErrorKind.rate_limited")} ${openskyBudget.rateLimitedErrorCalls}`,
        `${t("systemSettings.realtimeSignals.runtime.openskyErrorKind.server")} ${openskyBudget.serverErrorCalls}`,
        `${t("systemSettings.realtimeSignals.runtime.openskyErrorKind.timeout")} ${openskyBudget.timeoutErrorCalls}`,
        `${t("systemSettings.realtimeSignals.runtime.openskyErrorKind.network")} ${openskyBudget.networkErrorCalls}`,
        `${t("systemSettings.realtimeSignals.runtime.openskyErrorKind.unknown")} ${openskyBudget.unknownErrorCalls}`,
      ].join(" / ")
    : "—";
  return { periodLabel, degradationLabel, errorBreakdown };
}

/** AIS 诊断数值的安全抽取（仅保留有限数字）。 */
export function extractAisDiagnosticsView(
  row: RealtimeSignalRuntimeDiagnosticsSource,
) {
  const aisDiagnostics =
    row.source === "ais" ? row.aisDiagnostics : undefined;
  const num = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const str = (value: string | undefined) =>
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  return {
    aisDiagnostics,
    trackedVessels: num(aisDiagnostics?.vesselCount),
    candidates: num(aisDiagnostics?.candidateCount),
    reportsSeen: num(aisDiagnostics?.positionReportsSeen),
    reportsProcessed: num(aisDiagnostics?.positionReportsProcessed),
    reportsIgnored: num(aisDiagnostics?.ignoredPositionReports),
    parseErrors: num(aisDiagnostics?.parseErrors),
    lastUpstreamError: str(aisDiagnostics?.lastUpstreamError),
    lastParseError: str(aisDiagnostics?.lastParseError),
  };
}
