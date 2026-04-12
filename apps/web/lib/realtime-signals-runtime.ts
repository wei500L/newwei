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
        {
          defaultValue: "AIS relay root URL is not configured.",
        },
      ),
      description: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisRelayMissingConfig.body",
        {
          defaultValue:
            "The API cannot request `/ais/snapshot` until `AIS relay root URL` points to the relay service.",
        },
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
        {
          defaultValue: "The API cannot resolve the AIS relay host.",
        },
      ),
      description: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisRelayDnsFailure.body",
        {
          defaultValue:
            "Verify that `AIS relay root URL` uses the correct host name, that the `api` container is on the same Docker network, and that the `ais-relay` service name still matches the configured address.",
        },
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
        {
          defaultValue: "AIS relay reported degraded runtime health.",
        },
      ),
      description:
        formatAisRuntimeReason(
          t,
          statusReasonCode,
          row.statusReason ??
            t(
              "systemSettings.realtimeSignals.runtime.feedback.aisRelayDegraded.body",
              {
                defaultValue:
                  "The relay is responding, but diagnostics indicate upstream or parsing problems that will affect AIS map quality.",
              },
            ),
        ) ??
        t("systemSettings.realtimeSignals.runtime.feedback.aisRelayDegraded.body", {
          defaultValue:
            "The relay is responding, but diagnostics indicate upstream or parsing problems that will affect AIS map quality.",
        }),
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
      {
        defaultValue:
          "The relay service is up, but it is not maintaining a live upstream stream.",
      },
    )}${
      diagnostics?.lastHealthyAt
        ? ` ${t(
            "systemSettings.realtimeSignals.runtime.feedback.lastHealthyAt",
            {
              defaultValue: "Last healthy: {{time}}.",
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
      {
        defaultValue:
          "The websocket connected, but no AIS payload arrived before the relay timeout window. Check upstream subscription health, credentials, and whether the source is sending live traffic.",
      },
    ),
  }),
  ais_upstream_stalled: ({ t }, fallback) => ({
    type: "error",
    message:
      formatAisRuntimeReason(t, "ais_upstream_stalled", fallback) ??
      "AIS relay upstream message flow has stalled.",
    description: t(
      "systemSettings.realtimeSignals.runtime.feedback.aisUpstreamStalled.body",
      {
        defaultValue:
          "The upstream socket stayed open but message flow stopped. Inspect upstream heartbeat/keepalive behavior and relay-side reconnect activity.",
      },
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
        defaultValue:
          "Seen {{seen}} reports, processed {{processed}}, retained candidates {{candidates}}. Check relay parsing and snapshot retention logic.",
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
        defaultValue:
          "The relay is receiving positions, but normalization is discarding most of them. Seen {{seen}} reports, processed {{processed}}, ignored {{ignored}}.",
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
        defaultValue:
          "The relay is discarding a significant share of upstream payloads during parsing. Review upstream payload format drift and parser assumptions. Recent parse errors: {{count}}.",
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
      {
        defaultValue:
          "The relay is publishing density/disruption aggregates, but not the per-vessel `vessels[]` snapshot required by AIS all-mode. Fix the relay snapshot contract instead of diagnosing this as an upstream disconnect.",
      },
    ),
  }),
};
