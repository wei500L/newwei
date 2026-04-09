import type { QueryClient } from "@tanstack/react-query";

import type { createApiClient } from "@/lib/api-client";

import type { StoredSituationMonitor } from "./types/situation-monitor-monitors";

export const SITUATION_MONITOR_QUERY_KEYS = {
  monitors: ["situation-monitor", "monitors"] as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeStoredSituationMonitors(
  payload: unknown,
): StoredSituationMonitor[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.filter(
    (item): item is StoredSituationMonitor =>
      isRecord(item) && typeof item.id === "string",
  );
}

export async function fetchSituationMonitorMonitors(
  apiClient: ReturnType<typeof createApiClient>,
) {
  const response = await apiClient.get("situation-monitor/monitors");
  return normalizeStoredSituationMonitors(response.data);
}

export async function invalidateSituationMonitorMonitors(
  queryClient: QueryClient,
) {
  await queryClient.invalidateQueries({
    queryKey: SITUATION_MONITOR_QUERY_KEYS.monitors,
    exact: true,
    refetchType: "active",
  });
}
