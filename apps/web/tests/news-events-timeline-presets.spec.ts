import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIMELINE_PRESET_KEY,
  TIMELINE_PRESET_VALUES,
  detectClosestTimelinePreset,
  resolveTimelinePresetValues,
} from "../lib/news-events-timeline-presets";

describe("news-events timeline presets", () => {
  it("falls back to balanced values when input is missing", () => {
    const values = resolveTimelinePresetValues(undefined);
    expect(values).toEqual(TIMELINE_PRESET_VALUES.balanced);
  });

  it("detects exact preset match without custom classification", () => {
    const result = detectClosestTimelinePreset(TIMELINE_PRESET_VALUES.conservative);
    expect(result.closestPreset).toBe("conservative");
    expect(result.selection).toBe("conservative");
    expect(result.isCustom).toBe(false);
  });

  it("detects aggressive as closest for near-aggressive values", () => {
    const result = detectClosestTimelinePreset({
      timelineLowConfidenceThreshold: 0.39,
      timelineHighConfidenceThreshold: 0.71,
      timelineDriftKlThreshold: 0.22,
      timelineMinBucketItemsForDrift: 2,
      timelineCrossCategoryWarningShare: 0.19,
      timelineMaxCategoryDistributionItems: 25,
      timelineMaxPhaseSummaries: 12,
    });
    expect(result.closestPreset).toBe("aggressive");
    expect(result.selection).toBe("aggressive");
  });

  it("marks configuration as custom when distance exceeds threshold", () => {
    const result = detectClosestTimelinePreset(
      {
        timelineLowConfidenceThreshold: 0.1,
        timelineHighConfidenceThreshold: 0.99,
        timelineDriftKlThreshold: 1.6,
        timelineMinBucketItemsForDrift: 18,
        timelineCrossCategoryWarningShare: 0.88,
        timelineMaxCategoryDistributionItems: 42,
        timelineMaxPhaseSummaries: 2,
      },
      { customDistanceThreshold: 0.15 },
    );
    expect(result.selection).toBe("custom");
    expect(result.isCustom).toBe(true);
  });

  it("uses balanced as default closest preset for missing values", () => {
    const result = detectClosestTimelinePreset({});
    expect(result.closestPreset).toBe(DEFAULT_TIMELINE_PRESET_KEY);
  });
});
