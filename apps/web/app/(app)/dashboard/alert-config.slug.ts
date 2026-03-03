import { CUSTOM_MANUAL_SYSTEM_METRIC_SLUG } from "./alert-config.constants";

export function normalizeMetricSlug(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

export function isCustomManualMetricSlug(value: unknown): boolean {
  return normalizeMetricSlug(value) === CUSTOM_MANUAL_SYSTEM_METRIC_SLUG;
}
