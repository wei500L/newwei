const DEFAULT_HEAT_MAX = 10;
const FUTURE_EVENT_TOLERANCE_MS = 5 * 60 * 1000;
const ENTITY_FILTER_MAX_LENGTH = 120;

export const clampPercent = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
};

export const toHeatPercent = (heatScore: number, heatMax = DEFAULT_HEAT_MAX): number => {
  if (!Number.isFinite(heatScore) || heatScore <= 0) {
    return 0;
  }
  const safeMax = Number.isFinite(heatMax) && heatMax > 0 ? heatMax : DEFAULT_HEAT_MAX;
  return clampPercent((heatScore / safeMax) * 100);
};

export const toCredibilityPercent = (credibilityScore: number): number => {
  return clampPercent(credibilityScore);
};

export const isFutureEventTimestamp = (
  value: string | Date,
  nowMs = Date.now(),
  toleranceMs = FUTURE_EVENT_TOLERANCE_MS
): boolean => {
  const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ts)) {
    return false;
  }
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const safeTolerance = Number.isFinite(toleranceMs) && toleranceMs > 0 ? toleranceMs : 0;
  return ts > safeNow + safeTolerance;
};

export const normalizeEntityFilter = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, ENTITY_FILTER_MAX_LENGTH);
};
