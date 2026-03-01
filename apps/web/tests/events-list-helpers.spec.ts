import { describe, expect, it } from "vitest";

import {
  clampPercent,
  isFutureEventTimestamp,
  normalizeEntityFilter,
  toCredibilityPercent,
  toHeatPercent
} from "../app/(app)/events/events-list-helpers";

describe("events list helpers", () => {
  it("maps heat and credibility to percent safely", () => {
    expect(toHeatPercent(0)).toBe(0);
    expect(toHeatPercent(5)).toBe(50);
    expect(toHeatPercent(12)).toBe(100);
    expect(toCredibilityPercent(88)).toBe(88);
    expect(toCredibilityPercent(120)).toBe(100);
    expect(clampPercent(-5)).toBe(0);
  });

  it("detects future event timestamps with tolerance window", () => {
    const nowMs = Date.parse("2026-02-15T12:00:00.000Z");
    expect(
      isFutureEventTimestamp("2026-02-15T12:03:00.000Z", nowMs, 5 * 60 * 1000)
    ).toBe(false);
    expect(
      isFutureEventTimestamp("2026-02-15T12:07:00.000Z", nowMs, 5 * 60 * 1000)
    ).toBe(true);
  });

  it("normalizes entity filter input", () => {
    expect(normalizeEntityFilter("  Douglas Engelbart  ")).toBe("Douglas Engelbart");
    expect(normalizeEntityFilter("")).toBeNull();
    expect(normalizeEntityFilter(null)).toBeNull();
  });
});
