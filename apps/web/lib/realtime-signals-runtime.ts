import {
  AIS_PRODUCT_REASON_CODES,
  AIS_RELAY_REASON_CODES,
  type AisSurfaceReasonCode,
  type RealtimeAisRuntimeDiagnostics,
} from "@modular/utils";

export type RealtimeSignalRuntimeStatus =
  | "ok"
  | "error"
  | "stale"
  | "not_configured"
  | "idle";

export type RealtimeSignalErrorCode =
  | "dns_resolution_failed"
  | "request_timeout"
  | "network_error"
  | "upstream_auth_failed"
  | "upstream_rate_limited"
  | "upstream_server_error"
  | "fetch_error";

type RealtimeSignalsTranslate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

interface RuntimeFeedbackAlert {
  type: "error" | "warning";
  message: string;
  description: string;
}

interface AisRuntimeRowLike {
  status: RealtimeSignalRuntimeStatus;
  statusReason?: string;
  statusReasonCode?: string;
  lastErrorCode?: RealtimeSignalErrorCode;
  aisDiagnostics?: RealtimeAisRuntimeDiagnostics;
}

interface OutagesRuntimeRowLike {
  status: RealtimeSignalRuntimeStatus;
  statusReasonCode?: string;
  lastErrorStatus?: number;
}

const AIS_REASON_CODES = new Set<string>([
  ...AIS_RELAY_REASON_CODES,
  ...AIS_PRODUCT_REASON_CODES,
]);

interface AisAlertContext {
  diagnostics?: RealtimeAisRuntimeDiagnostics;
  formatTimestamp: (value?: string) => string;
  t: RealtimeSignalsTranslate;
}

function isAisSurfaceReasonCode(
  code: string | undefined,
): code is AisSurfaceReasonCode {
  return typeof code === "string" && AIS_REASON_CODES.has(code);
}

export function formatRealtimeSignalErrorCode(
  t: RealtimeSignalsTranslate,
  code: RealtimeSignalErrorCode | undefined,
) {
  if (!code) {
    return undefined;
  }
  return t(`systemSettings.realtimeSignals.runtime.errorCode.${code}`, {
    defaultValue: code,
  });
}

export function formatAisRuntimeReason(
  t: RealtimeSignalsTranslate,
  code: string | undefined,
  fallback: string | undefined,
) {
  if (!code) {
    return fallback;
  }
  return t(`systemSettings.realtimeSignals.runtime.aisReason.${code}`, {
    defaultValue: fallback ?? code,
  });
}

export function isOutagesRateLimited(row: OutagesRuntimeRowLike) {
  return (
    row.status === "error" &&
    (row.statusReasonCode === "upstream_rate_limited" ||
      row.lastErrorStatus === 429)
  );
}

export function buildAisRuntimeFeedbackAlert(
  t: RealtimeSignalsTranslate,
  row: AisRuntimeRowLike,
  formatTimestamp: (value?: string) => string,
): RuntimeFeedbackAlert | null {
  const statusReasonCode =
    typeof row.statusReasonCode === "string" && row.statusReasonCode.trim()
      ? row.statusReasonCode.trim()
      : undefined;
  const diagnostics = row.aisDiagnostics;
  const aisReasonCode = isAisSurfaceReasonCode(diagnostics?.statusReasonCode)
    ? diagnostics.statusReasonCode
    : isAisSurfaceReasonCode(statusReasonCode)
      ? statusReasonCode
      : undefined;
  const alertContext: AisAlertContext = {
    diagnostics,
    formatTimestamp,
    t,
  };

  if (
    row.status === "not_configured" ||
    statusReasonCode === "ais_not_configured" ||
    diagnostics?.configured === false
  ) {
    return {
      type: "warning",
      message: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisRelayMissingConfig.title",
      ),
      description: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisRelayMissingConfig.body",
      ),
    };
  }

  if (
    row.lastErrorCode === "dns_resolution_failed" ||
    statusReasonCode === "dns_resolution_failed"
  ) {
    return {
      type: "error",
      message: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisRelayDnsFailure.title",
      ),
      description: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisRelayDnsFailure.body",
      ),
    };
  }

  if (aisReasonCode) {
    const buildAlert = AIS_REASON_ALERT_BUILDERS[aisReasonCode];
    if (buildAlert) {
      return buildAlert(alertContext, diagnostics?.statusReason ?? row.statusReason);
    }
  }

  if (
    diagnostics?.healthState === "degraded" ||
    (row.status === "error" && statusReasonCode)
  ) {
    return {
      type: "warning",
      message: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisRelayDegraded.title",
      ),
      description:
        formatAisRuntimeReason(
          t,
          statusReasonCode,
          row.statusReason ??
            t(
              "systemSettings.realtimeSignals.runtime.feedback.aisRelayDegraded.body",
            ),
        ) ??
        t("systemSettings.realtimeSignals.runtime.feedback.aisRelayDegraded.body"),
    };
  }

  return null;
}

const AIS_REASON_ALERT_BUILDERS: Record<
  AisSurfaceReasonCode,
  (context: AisAlertContext, fallback: string | undefined) => RuntimeFeedbackAlert
> = {
  ais_upstream_disconnected: ({ diagnostics, formatTimestamp, t }, fallback) => ({
    type: "error",
    message:
      formatAisRuntimeReason(t, "ais_upstream_disconnected", fallback) ??
      "AIS relay is reachable, but its upstream AIS stream is disconnected.",
    description: `${t(
      "systemSettings.realtimeSignals.runtime.feedback.aisUpstreamDisconnected.body",
    )}${
      diagnostics?.lastHealthyAt
        ? ` ${t(
            "systemSettings.realtimeSignals.runtime.feedback.lastHealthyAt",
            {
              time: formatTimestamp(diagnostics.lastHealthyAt),
            },
          )}`
        : ""
    }`,
  }),
  ais_upstream_no_messages_after_connect: ({ t }, fallback) => ({
    type: "error",
    message:
      formatAisRuntimeReason(
        t,
        "ais_upstream_no_messages_after_connect",
        fallback,
      ) ?? "AIS relay connected upstream, but no AIS messages arrived after connect.",
    description: t(
      "systemSettings.realtimeSignals.runtime.feedback.aisUpstreamNoMessagesAfterConnect.body",
    ),
  }),
  ais_upstream_stalled: ({ t }, fallback) => ({
    type: "error",
    message:
      formatAisRuntimeReason(t, "ais_upstream_stalled", fallback) ??
      "AIS relay upstream message flow has stalled.",
    description: t(
      "systemSettings.realtimeSignals.runtime.feedback.aisUpstreamStalled.body",
    ),
  }),
  ais_position_reports_not_retained: ({ diagnostics, t }, fallback) => ({
    type: "error",
    message:
      formatAisRuntimeReason(t, "ais_position_reports_not_retained", fallback) ??
      "AIS relay is receiving reports, but vessel snapshots are not being retained.",
    description: t(
      "systemSettings.realtimeSignals.runtime.feedback.aisReportsNotRetained.body",
      {
        seen: diagnostics?.positionReportsSeen ?? 0,
        processed: diagnostics?.positionReportsProcessed ?? 0,
        candidates: diagnostics?.candidateCount ?? 0,
      },
    ),
  }),
  ais_position_reports_mostly_ignored: ({ diagnostics, t }, fallback) => ({
    type: "warning",
    message:
      formatAisRuntimeReason(
        t,
        "ais_position_reports_mostly_ignored",
        fallback,
      ) ??
      "AIS relay is receiving reports, but most position reports are being ignored during normalization.",
    description: t(
      "systemSettings.realtimeSignals.runtime.feedback.aisReportsMostlyIgnored.body",
      {
        seen: diagnostics?.positionReportsSeen ?? 0,
        processed: diagnostics?.positionReportsProcessed ?? 0,
        ignored: diagnostics?.ignoredPositionReports ?? 0,
      },
    ),
  }),
  ais_payload_parse_errors: ({ diagnostics, t }, fallback) => ({
    type: "warning",
    message:
      formatAisRuntimeReason(t, "ais_payload_parse_errors", fallback) ??
      "AIS relay is encountering frequent upstream payload parse errors.",
    description: t(
      "systemSettings.realtimeSignals.runtime.feedback.aisPayloadParseErrors.body",
      {
        count: diagnostics?.parseErrors ?? 0,
      },
    ),
  }),
  ais_snapshot_missing_vessels_contract: ({ t }, fallback) => ({
    type: "warning",
    message:
      formatAisRuntimeReason(
        t,
        "ais_snapshot_missing_vessels_contract",
        fallback,
      ) ??
      "AIS relay reports tracked vessels, but this snapshot only exposes aggregated signals instead of individual vessels[].",
    description: t(
      "systemSettings.realtimeSignals.runtime.feedback.aisSnapshotMissingVesselsContract.body",
    ),
  }),
};
