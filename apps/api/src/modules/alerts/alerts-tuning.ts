export enum AlertTuningAction {
  none = "none",
  increase_threshold = "increase_threshold",
  decrease_threshold = "decrease_threshold",
  adjust_range = "adjust_range"
}

export interface AlertRuleTuningSuggestion {
  ruleId: string;
  windowDays: number;
  totalEvents: number;
  reviewedEvents: number;
  confirmedEvents: number;
  ignoredEvents: number;
  falsePositiveRate: number | null;
  action: AlertTuningAction;
  message?: string | null;
  suggestedThresholdValue?: number | null;
  suggestedThresholdLower?: number | null;
  suggestedThresholdUpper?: number | null;
}

export const quantile = (values: number[], q: number): number | null => {
  if (!values.length) {
    return null;
  }
  const clampedQ = Math.min(Math.max(q, 0), 1);
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * clampedQ;
  const base = Math.floor(position);
  const rest = position - base;
  const next = sorted[base + 1];
  const current = sorted[base];
  if (current === undefined) {
    return null;
  }
  if (next === undefined) {
    return current;
  }
  return current + rest * (next - current);
};

export const safeMean = (values: number[]): number | null => {
  if (!values.length) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
};
