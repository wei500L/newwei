import { describe, expect, it } from "vitest";

import {
  buildAisRuntimeFeedbackAlert,
  formatAisRuntimeReason,
  formatRealtimeSignalErrorCode,
  isOutagesRateLimited,
} from "../lib/realtime-signals-runtime";

const t = (key: string, options?: Record<string, unknown>) => {
  const translations: Record<string, string> = {
    "systemSettings.realtimeSignals.runtime.aisReason.ais_upstream_stalled":
      "AIS relay upstream message flow has stalled.",
    "systemSettings.realtimeSignals.runtime.aisReason.ais_upstream_no_messages_after_connect":
      "AIS relay connected upstream, but no AIS messages arrived after connect.",
    "systemSettings.realtimeSignals.runtime.aisReason.ais_position_reports_mostly_ignored":
      "AIS relay is receiving reports, but most position reports are being ignored during normalization.",
    "systemSettings.realtimeSignals.runtime.aisReason.ais_payload_parse_errors":
      "AIS relay is encountering frequent upstream payload parse errors.",
    "systemSettings.realtimeSignals.runtime.aisReason.ais_snapshot_missing_vessels_contract":
      "AIS relay reports tracked vessels, but this snapshot only exposes aggregated signals instead of individual vessels[].",
  };
  return translations[key] ?? String(options?.defaultValue ?? key);
};

describe("realtime signals runtime helpers", () => {
  it("uses structured error codes for AIS DNS failures", () => {
    const alert = buildAisRuntimeFeedbackAlert(
      t,
      {
        status: "error",
        lastErrorCode: "dns_resolution_failed",
      },
      (value?: string) => value ?? "",
    );

    expect(alert).toMatchObject({
      type: "error",
      message: "The API cannot resolve the AIS relay host.",
    });
  });

  it("treats outages as rate limited only for actual 429/rate-limit status codes", () => {
    expect(
      isOutagesRateLimited({
        status: "error",
        statusReasonCode: "upstream_rate_limited",
        lastErrorStatus: 429,
      }),
    ).toBe(true);

    expect(
      isOutagesRateLimited({
        status: "error",
        statusReasonCode: "upstream_auth_failed",
        lastErrorStatus: 403,
      }),
    ).toBe(false);
  });

  it("formats structured runtime error code labels for non-OpenSky sources", () => {
    expect(formatRealtimeSignalErrorCode(t, "dns_resolution_failed")).toBe(
      "dns_resolution_failed",
    );
  });

  it("maps known AIS reason codes to explicit messages instead of generic degraded text", () => {
    expect(
      buildAisRuntimeFeedbackAlert(
        t,
        {
          status: "error",
          statusReasonCode: "ais_upstream_no_messages_after_connect",
        },
        (value?: string) => value ?? "",
      )?.message,
    ).toBe(
      "AIS relay connected upstream, but no AIS messages arrived after connect.",
    );

    expect(
      buildAisRuntimeFeedbackAlert(
        t,
        {
          status: "error",
          statusReasonCode: "ais_upstream_stalled",
        },
        (value?: string) => value ?? "",
      )?.message,
    ).toBe("AIS relay upstream message flow has stalled.");

    expect(
      buildAisRuntimeFeedbackAlert(
        t,
        {
          status: "error",
          statusReasonCode: "ais_position_reports_mostly_ignored",
          context: {
            positionReportsSeen: 100,
            positionReportsProcessed: 8,
            ignoredPositionReports: 92,
          },
        },
        (value?: string) => value ?? "",
      )?.message,
    ).toBe(
      "AIS relay is receiving reports, but most position reports are being ignored during normalization.",
    );

    expect(
      buildAisRuntimeFeedbackAlert(
        t,
        {
          status: "error",
          statusReasonCode: "ais_payload_parse_errors",
          context: { parseErrors: 20 },
        },
        (value?: string) => value ?? "",
      )?.message,
    ).toBe("AIS relay is encountering frequent upstream payload parse errors.");
  });

  it("localizes AIS reason strings for war map summaries", () => {
    expect(
      formatAisRuntimeReason(
        t,
        "ais_snapshot_missing_vessels_contract",
        undefined,
      ),
    ).toBe(
      "AIS relay reports tracked vessels, but this snapshot only exposes aggregated signals instead of individual vessels[].",
    );
  });
});
