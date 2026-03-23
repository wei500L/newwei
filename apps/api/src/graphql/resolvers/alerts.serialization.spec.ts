import { AlertChannelType, AlertDeliveryStatus, AlertEventStatus, AlertMetricProvider, AlertOperator, AlertSeverity } from "@prisma/client";

import {
  serializeAlertEvent,
  serializeAlertEventPayload,
  serializeOptionalFiniteNumber,
  serializeRequiredFiniteNumber,
} from "./alerts.serialization";

describe("alerts serialization", () => {
  it("normalizes non-finite alert event numbers into GraphQL-safe values", () => {
    const serialized = serializeAlertEvent({
      id: "evt-1",
      triggeredAt: "2026-03-23T08:00:00.000Z",
      metricValue: Number.NaN,
      changePercent: Number.POSITIVE_INFINITY,
      severity: AlertSeverity.high,
      status: AlertEventStatus.delivered,
      message: "Triggered",
      ruleId: "rule-1",
      context: ["not-an-object"],
      rule: {
        name: "CPU spike",
        metricProvider: AlertMetricProvider.system_metric,
        metricSlug: " system.load ",
        operator: AlertOperator.gte,
        thresholdValue: Number.NaN,
        thresholdLower: 0,
        thresholdUpper: Number.NEGATIVE_INFINITY,
        changeWindowMin: 15,
      },
      deliveries: [
        {
          id: "delivery-1",
          status: AlertDeliveryStatus.pending,
          channelType: AlertChannelType.in_app,
          channel: null,
          targetSnapshot: { userId: "user-1", name: "Primary inbox" },
        },
      ],
    });

    expect(serialized.triggeredAt).toEqual(
      new Date("2026-03-23T08:00:00.000Z"),
    );
    expect(serialized.metricValue).toBe(0);
    expect(serialized.changePercent).toBeNull();
    expect(serialized.ruleName).toBe("CPU spike");
    expect(serialized.metricProvider).toBe(AlertMetricProvider.system_metric);
    expect(serialized.metricSlug).toBe("system.load");
    expect(serialized.operator).toBe(AlertOperator.gte);
    expect(serialized.thresholdValue).toBeNull();
    expect(serialized.thresholdLower).toBe(0);
    expect(serialized.thresholdUpper).toBeNull();
    expect(serialized.changeWindowMin).toBe(15);
    expect(serialized.context).toBeNull();
    expect(serialized.deliveries).toEqual([
      {
        id: "delivery-1",
        status: AlertDeliveryStatus.pending,
        error: undefined,
        sentAt: undefined,
        channelType: AlertChannelType.in_app,
        channelName: "Primary inbox",
        target: "user-1",
      },
    ]);
  });

  it("serializes subscription payloads with the same safeguards", () => {
    const serialized = serializeAlertEventPayload({
      orgId: "org-1",
      event: {
        id: "evt-2",
        ruleId: "rule-2",
        ruleName: "OpenSky",
        metricProvider: AlertMetricProvider.realtime_signal,
        metricSlug: " realtime.opensky.military_flights ",
        triggeredAt: new Date("2026-03-23T08:05:00.000Z"),
        message: "Watch",
        severity: AlertSeverity.medium,
        metricValue: Number.POSITIVE_INFINITY,
        changePercent: Number.NaN,
        status: AlertEventStatus.pending,
        context: { source: "stream" },
      },
    });

    expect(serialized.metricValue).toBe(0);
    expect(serialized.changePercent).toBeNull();
    expect(serialized.metricSlug).toBe("realtime.opensky.military_flights");
    expect(serialized.context).toEqual({ source: "stream" });
    expect(serialized.deliveries).toEqual([]);
  });

  it("exposes numeric helpers for optional and required values", () => {
    expect(serializeOptionalFiniteNumber(0)).toBe(0);
    expect(serializeOptionalFiniteNumber("12.5")).toBe(12.5);
    expect(serializeOptionalFiniteNumber(Number.NaN)).toBeNull();
    expect(serializeRequiredFiniteNumber(Number.NaN)).toBe(0);
  });
});
