import { describe, expect, it } from "vitest";

import {
  buildAisRuntimeFeedbackAlert,
  formatAisRuntimeReason,
} from "../lib/realtime-signals-runtime";
import { translateTestKey } from "./i18n-test-utils";

const AIS_REASON_TRANSLATIONS: Record<string, string> = {
  "systemSettings.realtimeSignals.runtime.aisReason.ais_snapshot_missing_vessels_contract":
    "AIS relay reports tracked vessels, but this snapshot only exposes aggregated signals instead of individual vessels[].",
};

const t = (key: string, options?: Record<string, unknown>) => {
  const translated = AIS_REASON_TRANSLATIONS[key];
  const base = translated ?? translateTestKey(key, options);
  return base.replace(/\{\{(\w+)\}\}/g, (_match, token: string) =>
    String(options?.[token] ?? `{{${token}}}`),
  );
};

describe("realtime signals runtime helpers", () => {
  it("formats synthesized AIS contract reasons through the shared reason map", () => {
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

  it("builds AIS feedback alerts from aisDiagnostics instead of row context", () => {
    const alert = buildAisRuntimeFeedbackAlert(
      t,
      {
        status: "error",
        statusReasonCode: "ais_position_reports_not_retained",
        aisDiagnostics: {
          configured: true,
          connected: true,
          healthState: "degraded",
          allVesselsAvailable: false,
          candidateCount: 3,
          vesselCount: 0,
          disruptionsCount: 0,
          densityRegions: 0,
          messageCount: 200,
          droppedMessages: 0,
          positionReportsSeen: 200,
          positionReportsProcessed: 0,
          ignoredPositionReports: 180,
          parseErrors: 0,
          statusReasonCode: "ais_position_reports_not_retained",
          statusReason:
            "AIS relay is receiving position reports, but none are being retained as vessel snapshots.",
        },
      },
      (value?: string) => value ?? "n/a",
    );

    expect(alert).toEqual({
      type: "error",
      message:
        "AIS relay is receiving reports, but vessel snapshots are not being retained.",
      description:
        "Seen 200 reports, processed 0, retained candidates 3. Check relay parsing and snapshot retention logic.",
    });
  });
});
