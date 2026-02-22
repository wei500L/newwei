export type TimelinePresetKey = "conservative" | "balanced" | "aggressive";

export type TimelinePresetSelection = TimelinePresetKey | "custom";

export interface TimelinePresetValues {
  timelineLowConfidenceThreshold: number;
  timelineHighConfidenceThreshold: number;
  timelineDriftKlThreshold: number;
  timelineMinBucketItemsForDrift: number;
  timelineCrossCategoryWarningShare: number;
  timelineMaxCategoryDistributionItems: number;
  timelineMaxPhaseSummaries: number;
}

export const DEFAULT_TIMELINE_PRESET_KEY: TimelinePresetKey = "balanced";
export const DEFAULT_TIMELINE_PRESET_CUSTOM_DISTANCE_THRESHOLD = 0.22;

export const TIMELINE_PRESET_VALUES: Record<TimelinePresetKey, TimelinePresetValues> =
  {
    conservative: {
      timelineLowConfidenceThreshold: 0.6,
      timelineHighConfidenceThreshold: 0.9,
      timelineDriftKlThreshold: 0.5,
      timelineMinBucketItemsForDrift: 5,
      timelineCrossCategoryWarningShare: 0.45,
      timelineMaxCategoryDistributionItems: 12,
      timelineMaxPhaseSummaries: 6,
    },
    balanced: {
      timelineLowConfidenceThreshold: 0.5,
      timelineHighConfidenceThreshold: 0.8,
      timelineDriftKlThreshold: 0.35,
      timelineMinBucketItemsForDrift: 3,
      timelineCrossCategoryWarningShare: 0.3,
      timelineMaxCategoryDistributionItems: 16,
      timelineMaxPhaseSummaries: 8,
    },
    aggressive: {
      timelineLowConfidenceThreshold: 0.4,
      timelineHighConfidenceThreshold: 0.7,
      timelineDriftKlThreshold: 0.2,
      timelineMinBucketItemsForDrift: 2,
      timelineCrossCategoryWarningShare: 0.2,
      timelineMaxCategoryDistributionItems: 24,
      timelineMaxPhaseSummaries: 12,
    },
  };

const TIMELINE_PRESET_FIELDS: Array<keyof TimelinePresetValues> = [
  "timelineLowConfidenceThreshold",
  "timelineHighConfidenceThreshold",
  "timelineDriftKlThreshold",
  "timelineMinBucketItemsForDrift",
  "timelineCrossCategoryWarningShare",
  "timelineMaxCategoryDistributionItems",
  "timelineMaxPhaseSummaries",
];

const TIMELINE_PRESET_RANGES: Record<
  keyof TimelinePresetValues,
  { min: number; max: number }
> = {
  timelineLowConfidenceThreshold: { min: 0, max: 1 },
  timelineHighConfidenceThreshold: { min: 0, max: 1 },
  timelineDriftKlThreshold: { min: 0, max: 5 },
  timelineMinBucketItemsForDrift: { min: 1, max: 50 },
  timelineCrossCategoryWarningShare: { min: 0, max: 1 },
  timelineMaxCategoryDistributionItems: { min: 4, max: 64 },
  timelineMaxPhaseSummaries: { min: 1, max: 20 },
};

export interface ClosestTimelinePresetResult {
  selection: TimelinePresetSelection;
  closestPreset: TimelinePresetKey;
  distance: number;
  isCustom: boolean;
}

export function resolveTimelinePresetValues(
  input?: Partial<TimelinePresetValues>,
): TimelinePresetValues {
  const fallback = TIMELINE_PRESET_VALUES[DEFAULT_TIMELINE_PRESET_KEY];
  return {
    timelineLowConfidenceThreshold: coerceFiniteNumber(
      input?.timelineLowConfidenceThreshold,
      fallback.timelineLowConfidenceThreshold,
    ),
    timelineHighConfidenceThreshold: coerceFiniteNumber(
      input?.timelineHighConfidenceThreshold,
      fallback.timelineHighConfidenceThreshold,
    ),
    timelineDriftKlThreshold: coerceFiniteNumber(
      input?.timelineDriftKlThreshold,
      fallback.timelineDriftKlThreshold,
    ),
    timelineMinBucketItemsForDrift: coerceFiniteNumber(
      input?.timelineMinBucketItemsForDrift,
      fallback.timelineMinBucketItemsForDrift,
    ),
    timelineCrossCategoryWarningShare: coerceFiniteNumber(
      input?.timelineCrossCategoryWarningShare,
      fallback.timelineCrossCategoryWarningShare,
    ),
    timelineMaxCategoryDistributionItems: coerceFiniteNumber(
      input?.timelineMaxCategoryDistributionItems,
      fallback.timelineMaxCategoryDistributionItems,
    ),
    timelineMaxPhaseSummaries: coerceFiniteNumber(
      input?.timelineMaxPhaseSummaries,
      fallback.timelineMaxPhaseSummaries,
    ),
  };
}

export function detectClosestTimelinePreset(
  input?: Partial<TimelinePresetValues>,
  options?: { customDistanceThreshold?: number },
): ClosestTimelinePresetResult {
  const values = resolveTimelinePresetValues(input);
  const threshold = coerceFiniteNumber(
    options?.customDistanceThreshold,
    DEFAULT_TIMELINE_PRESET_CUSTOM_DISTANCE_THRESHOLD,
  );

  let closestPreset: TimelinePresetKey = DEFAULT_TIMELINE_PRESET_KEY;
  let closestDistance = Number.POSITIVE_INFINITY;
  const presets = Object.entries(TIMELINE_PRESET_VALUES) as Array<
    [TimelinePresetKey, TimelinePresetValues]
  >;

  for (const [presetKey, presetValues] of presets) {
    let distance = 0;
    for (const field of TIMELINE_PRESET_FIELDS) {
      const range = TIMELINE_PRESET_RANGES[field];
      const denominator = Math.max(1e-9, range.max - range.min);
      distance += Math.abs(values[field] - presetValues[field]) / denominator;
    }
    if (distance < closestDistance) {
      closestDistance = distance;
      closestPreset = presetKey;
    }
  }

  const isCustom = closestDistance > threshold;
  return {
    selection: isCustom ? "custom" : closestPreset,
    closestPreset,
    distance: closestDistance,
    isCustom,
  };
}

function coerceFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}
