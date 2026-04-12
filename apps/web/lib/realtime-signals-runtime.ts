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
  context?: Record<string, unknown>;
}

interface OutagesRuntimeRowLike {
  status: RealtimeSignalRuntimeStatus;
  statusReasonCode?: string;
  lastErrorStatus?: number;
}

function readRuntimeContextString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readRuntimeContextNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  const context =
    row.context && typeof row.context === "object" && !Array.isArray(row.context)
      ? row.context
      : undefined;
  const statusReasonCode =
    typeof row.statusReasonCode === "string" && row.statusReasonCode.trim()
      ? row.statusReasonCode.trim()
      : undefined;
  const lastHealthyAt = readRuntimeContextString(context?.lastHealthyAt);
  const positionReportsSeen = readRuntimeContextNumber(
    context?.positionReportsSeen,
  );
  const positionReportsProcessed = readRuntimeContextNumber(
    context?.positionReportsProcessed,
  );
  const ignoredPositionReports = readRuntimeContextNumber(
    context?.ignoredPositionReports,
  );
  const candidateCount = readRuntimeContextNumber(context?.candidateCount);
  const parseErrors = readRuntimeContextNumber(context?.parseErrors);

  if (
    row.status === "not_configured" ||
    statusReasonCode === "ais_not_configured" ||
    context?.configured === false
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

  if (
    statusReasonCode === "ais_upstream_disconnected" ||
    context?.connected === false
  ) {
    return {
      type: "error",
      message: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisUpstreamDisconnected.title",
        {
          defaultValue:
            "AIS relay is reachable, but its upstream AIS stream is disconnected.",
        },
      ),
      description: `${t(
        "systemSettings.realtimeSignals.runtime.feedback.aisUpstreamDisconnected.body",
        {
          defaultValue:
            "The relay service is up, but it is not maintaining a live upstream stream.",
        },
      )}${
        lastHealthyAt
          ? ` ${t(
              "systemSettings.realtimeSignals.runtime.feedback.lastHealthyAt",
              {
                defaultValue: "Last healthy: {{time}}.",
                time: formatTimestamp(lastHealthyAt),
              },
            )}`
          : ""
      }`,
    };
  }

  if (statusReasonCode === "ais_position_reports_not_retained") {
    return {
      type: "error",
      message: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisReportsNotRetained.title",
        {
          defaultValue:
            "AIS relay is receiving reports, but vessel snapshots are not being retained.",
        },
      ),
      description: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisReportsNotRetained.body",
        {
          defaultValue:
            "Seen {{seen}} reports, processed {{processed}}, retained candidates {{candidates}}. Check relay parsing and snapshot retention logic.",
          seen: positionReportsSeen ?? 0,
          processed: positionReportsProcessed ?? 0,
          candidates: candidateCount ?? 0,
        },
      ),
    };
  }

  if (statusReasonCode === "ais_upstream_no_messages_after_connect") {
    return {
      type: "error",
      message:
        formatAisRuntimeReason(t, statusReasonCode, row.statusReason) ??
        "AIS relay connected upstream, but no AIS messages arrived after connect.",
      description: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisUpstreamNoMessagesAfterConnect.body",
        {
          defaultValue:
            "The websocket connected, but no AIS payload arrived before the relay timeout window. Check upstream subscription health, credentials, and whether the source is sending live traffic.",
        },
      ),
    };
  }

  if (statusReasonCode === "ais_upstream_stalled") {
    return {
      type: "error",
      message:
        formatAisRuntimeReason(t, statusReasonCode, row.statusReason) ??
        "AIS relay upstream message flow has stalled.",
      description: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisUpstreamStalled.body",
        {
          defaultValue:
            "The upstream socket stayed open but message flow stopped. Inspect upstream heartbeat/keepalive behavior and relay-side reconnect activity.",
        },
      ),
    };
  }

  if (statusReasonCode === "ais_position_reports_mostly_ignored") {
    return {
      type: "warning",
      message:
        formatAisRuntimeReason(t, statusReasonCode, row.statusReason) ??
        "AIS relay is receiving reports, but most position reports are being ignored during normalization.",
      description: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisReportsMostlyIgnored.body",
        {
          defaultValue:
            "The relay is receiving positions, but normalization is discarding most of them. Seen {{seen}} reports, processed {{processed}}, ignored {{ignored}}.",
          seen: positionReportsSeen ?? 0,
          processed: positionReportsProcessed ?? 0,
          ignored: ignoredPositionReports ?? 0,
        },
      ),
    };
  }

  if (statusReasonCode === "ais_payload_parse_errors") {
    return {
      type: "warning",
      message:
        formatAisRuntimeReason(t, statusReasonCode, row.statusReason) ??
        "AIS relay is encountering frequent upstream payload parse errors.",
      description: t(
        "systemSettings.realtimeSignals.runtime.feedback.aisPayloadParseErrors.body",
        {
          defaultValue:
            "The relay is discarding a significant share of upstream payloads during parsing. Review upstream payload format drift and parser assumptions. Recent parse errors: {{count}}.",
          count: parseErrors ?? 0,
        },
      ),
    };
  }

  if (
    context?.healthState === "degraded" ||
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
