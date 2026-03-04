import { describe, expect, it } from "vitest";

import {
  isCustomManualMetricSlug,
  normalizeMetricSlug,
} from "@/app/(app)/dashboard/alert-config.slug";

describe("alert-config metric slug normalization", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeMetricSlug("  custom.manual  ")).toBe("custom.manual");
  });

  it("maps legacy opensky realtime slug to adsb", () => {
    expect(normalizeMetricSlug("  realtime.opensky.military_flights  ")).toBe(
      "realtime.adsb.military_flights",
    );
  });

  it("returns empty string for non-string inputs", () => {
    expect(normalizeMetricSlug(undefined)).toBe("");
    expect(normalizeMetricSlug(null)).toBe("");
    expect(normalizeMetricSlug(123)).toBe("");
  });

  it("recognizes custom.manual even with surrounding whitespace", () => {
    expect(isCustomManualMetricSlug(" custom.manual ")).toBe(true);
    expect(isCustomManualMetricSlug("custom.manual")).toBe(true);
    expect(isCustomManualMetricSlug("custom.manual.extra")).toBe(false);
  });
});
