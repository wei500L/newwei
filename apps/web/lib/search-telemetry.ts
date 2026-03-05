import { createApiClient } from "./api-client";

export type SearchTelemetryEventType =
  | "archive_search_submit"
  | "archive_query_too_short"
  | "archive_load_more_click";

export type SearchTelemetrySurface = "search_page" | "events_archive";

export type SearchTelemetryVertical =
  | "EAST_SEA"
  | "SOUTH_SEA"
  | "WEST_FRONT"
  | "FOREIGN_AFFAIRS"
  | "DOMESTIC_AFFAIRS";

export interface SearchTelemetryPayload {
  eventType: SearchTelemetryEventType;
  surface?: SearchTelemetrySurface;
  vertical?: SearchTelemetryVertical;
  queryLength?: number;
}

const api = createApiClient();
const DEDUPE_WINDOW_MS = 1200;
const recentEvents = new Map<string, number>();

function shouldSkipEvent(key: string, now: number) {
  const lastTs = recentEvents.get(key) ?? 0;
  if (now - lastTs < DEDUPE_WINDOW_MS) {
    return true;
  }
  recentEvents.set(key, now);
  if (recentEvents.size > 400) {
    for (const [eventKey, eventTs] of recentEvents.entries()) {
      if (now - eventTs > DEDUPE_WINDOW_MS * 6) {
        recentEvents.delete(eventKey);
      }
    }
  }
  return false;
}

export async function trackSearchTelemetry(payload: SearchTelemetryPayload) {
  if (typeof window === "undefined") {
    return;
  }
  const queryLength =
    typeof payload.queryLength === "number" &&
    Number.isFinite(payload.queryLength)
      ? Math.max(0, Math.min(500, Math.floor(payload.queryLength)))
      : undefined;
  const dedupeKey = [
    payload.eventType,
    payload.surface ?? "",
    payload.vertical ?? "",
    String(queryLength ?? ""),
  ].join("::");
  const now = Date.now();
  if (shouldSkipEvent(dedupeKey, now)) {
    return;
  }

  try {
    await api.post("/search-telemetry", {
      eventType: payload.eventType,
      ...(payload.surface ? { surface: payload.surface } : {}),
      ...(payload.vertical ? { vertical: payload.vertical } : {}),
      ...(typeof queryLength === "number" ? { queryLength } : {}),
    });
  } catch {
    // Keep telemetry non-blocking.
  }
}
