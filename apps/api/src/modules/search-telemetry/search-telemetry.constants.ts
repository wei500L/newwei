export const SEARCH_TELEMETRY_EVENT_TYPES = [
  "archive_search_submit",
  "archive_query_too_short",
  "archive_load_more_click",
] as const;

export type SearchTelemetryEventType =
  (typeof SEARCH_TELEMETRY_EVENT_TYPES)[number];

export const SEARCH_TELEMETRY_SURFACES = [
  "search_page",
  "events_archive",
] as const;

export type SearchTelemetrySurface = (typeof SEARCH_TELEMETRY_SURFACES)[number];

export const SEARCH_TELEMETRY_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const SEARCH_TELEMETRY_KEY_PREFIX = "search-telemetry";
