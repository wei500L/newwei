import { CUSTOM_MANUAL_SYSTEM_METRIC_SLUG } from "./alert-config.constants";

const LEGACY_REALTIME_METRIC_SLUG_ALIASES: Readonly<Record<string, string>> = {
  "realtime.opensky.military_flights": "realtime.adsb.military_flights",
};

export function normalizeMetricSlug(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return LEGACY_REALTIME_METRIC_SLUG_ALIASES[trimmed] ?? trimmed;
}

export function isCustomManualMetricSlug(value: unknown): boolean {
  return normalizeMetricSlug(value) === CUSTOM_MANUAL_SYSTEM_METRIC_SLUG;
}
