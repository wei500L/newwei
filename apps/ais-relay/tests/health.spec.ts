import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRelayHealthPayload,
  buildRelayLivenessPayload,
} from "../src/health";

test("liveness stays healthy even when runtime diagnostics are degraded", () => {
  const payload = buildRelayLivenessPayload(
    new Date("2026-04-12T00:00:00.000Z"),
  );

  assert.deepEqual(payload, {
    status: "ok",
    service: "ais-relay",
    now: "2026-04-12T00:00:00.000Z",
  });
});

test("health payload preserves degraded runtime diagnostics", () => {
  const payload = buildRelayHealthPayload({
    connected: true,
    vessels: 12,
    messages: 345,
    droppedMessages: 2,
    densityZones: 4,
    sharedSecretEnabled: true,
    diagnostics: {
      healthState: "degraded",
      statusReasonCode: "ais_upstream_stalled",
      statusReason:
        "AIS relay has not received an upstream message for 90s while the upstream connection remains open.",
      positionReportsSeen: 100,
      positionReportsProcessed: 98,
      ignoredPositionReports: 2,
      parseErrors: 0,
      lastHealthyAt: "2026-04-12T00:00:00.000Z",
    },
  });

  assert.equal(payload.status, "degraded");
  assert.equal(payload.diagnostics.statusReasonCode, "ais_upstream_stalled");
  assert.equal(payload.connected, true);
});
