import { describe, expect, it } from "vitest";

import {
  shouldUpdateAlertEventsMetric,
  shouldVirtualizeAlertEvents,
} from "../app/(app)/alerts/alert-events-virtualization";

describe("alert events virtualization", () => {
  it("enables virtualization only for larger event pages", () => {
    expect(shouldVirtualizeAlertEvents(25)).toBe(false);
    expect(shouldVirtualizeAlertEvents(26)).toBe(true);
  });

  it("ignores sub-pixel metric jitter", () => {
    expect(shouldUpdateAlertEventsMetric(480, 480.5)).toBe(false);
    expect(shouldUpdateAlertEventsMetric(480, 482)).toBe(true);
    expect(shouldUpdateAlertEventsMetric(480, Number.NaN)).toBe(false);
  });
});
