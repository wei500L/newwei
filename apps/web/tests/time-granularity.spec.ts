import { describe, expect, it } from "vitest";

import {
  inferGranularityFromTimestampsMs,
  intervalToGranularity,
  parseInterval,
  pickCoarsestGranularity,
  pickFinestGranularity,
  resolveActiveGranularityFromTimestampsMs,
  resolveDefaultGranularityForRangePreset,
  timeGranularityToUiGranularity,
  UiTimeGranularity,
} from "../lib/time-granularity";

describe("time-granularity helpers", () => {
  it("maps dashboard presets to default aggregations that match backend thresholds", () => {
    const start = new Date("2024-01-01T00:00:00.000Z");
    const end = new Date("2024-02-01T00:00:00.000Z");

    expect(resolveDefaultGranularityForRangePreset("1D", start, end)).toBe(UiTimeGranularity.Day);
    expect(resolveDefaultGranularityForRangePreset("3M", start, end)).toBe(UiTimeGranularity.Week);
    expect(resolveDefaultGranularityForRangePreset("6M", start, end)).toBe(UiTimeGranularity.Month);
    expect(resolveDefaultGranularityForRangePreset("3Y", start, end)).toBe(UiTimeGranularity.Quarter);
  });

  it("infers default aggregation for custom ranges using day thresholds", () => {
    const base = new Date("2024-01-01T00:00:00.000Z");

    expect(
      resolveDefaultGranularityForRangePreset(
        "custom",
        base,
        new Date(base.getTime() + 10 * 24 * 60 * 60 * 1000),
      ),
    ).toBe(UiTimeGranularity.Day);

    expect(
      resolveDefaultGranularityForRangePreset(
        "custom",
        base,
        new Date(base.getTime() + 60 * 24 * 60 * 60 * 1000),
      ),
    ).toBe(UiTimeGranularity.Week);

    expect(
      resolveDefaultGranularityForRangePreset(
        "custom",
        base,
        new Date(base.getTime() + 200 * 24 * 60 * 60 * 1000),
      ),
    ).toBe(UiTimeGranularity.Month);

    expect(
      resolveDefaultGranularityForRangePreset(
        "custom",
        base,
        new Date(base.getTime() + 400 * 24 * 60 * 60 * 1000),
      ),
    ).toBe(UiTimeGranularity.Quarter);

    expect(
      resolveDefaultGranularityForRangePreset(
        "custom",
        base,
        new Date(base.getTime() + 1200 * 24 * 60 * 60 * 1000),
      ),
    ).toBe(UiTimeGranularity.Year);
  });

  it("parses intervals and maps to UI granularity", () => {
    expect(intervalToGranularity(parseInterval("daily"))).toBe(UiTimeGranularity.Day);
    expect(intervalToGranularity(parseInterval("1h"))).toBe(UiTimeGranularity.Hour);
    expect(intervalToGranularity(parseInterval("3mo"))).toBe(UiTimeGranularity.Quarter);
    expect(intervalToGranularity(parseInterval("12mo"))).toBe(UiTimeGranularity.Year);
  });

  it("infers granularity from timestamp cadence", () => {
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    expect(inferGranularityFromTimestampsMs([0, hour, 2 * hour, 3 * hour])).toBe(UiTimeGranularity.Hour);
    expect(inferGranularityFromTimestampsMs([0, day, 2 * day, 3 * day])).toBe(UiTimeGranularity.Day);
    expect(inferGranularityFromTimestampsMs([0, 7 * day, 14 * day])).toBe(UiTimeGranularity.Week);
    expect(inferGranularityFromTimestampsMs([0, 30 * day, 60 * day])).toBe(UiTimeGranularity.Month);
  });

  it("falls back to requested granularity when data cadence cannot be inferred", () => {
    expect(resolveActiveGranularityFromTimestampsMs(UiTimeGranularity.Month, [])).toBe(UiTimeGranularity.Month);
    expect(resolveActiveGranularityFromTimestampsMs(UiTimeGranularity.Month, [0])).toBe(UiTimeGranularity.Month);
  });

  it("picks coarsest/finest granularity from mixed inputs", () => {
    expect(
      pickCoarsestGranularity([UiTimeGranularity.Day, UiTimeGranularity.Week]),
    ).toBe(UiTimeGranularity.Week);
    expect(
      pickFinestGranularity([UiTimeGranularity.Day, UiTimeGranularity.Week]),
    ).toBe(UiTimeGranularity.Day);
    expect(pickCoarsestGranularity([UiTimeGranularity.Unknown, null])).toBe(UiTimeGranularity.Unknown);
    expect(pickFinestGranularity([UiTimeGranularity.Unknown, undefined])).toBe(UiTimeGranularity.Unknown);
  });

  it("maps backend time granularity enum values to UI granularity labels", () => {
    expect(timeGranularityToUiGranularity("realtime")).toBe(UiTimeGranularity.Realtime);
    expect(timeGranularityToUiGranularity("minute")).toBe(UiTimeGranularity.Minute);
    expect(timeGranularityToUiGranularity("hour")).toBe(UiTimeGranularity.Hour);
    expect(timeGranularityToUiGranularity("day")).toBe(UiTimeGranularity.Day);
  });
});
