export function normalizeNewsnowSourceIds(sourceIds: string[]): string[] {
  return Array.from(
    new Set(
      sourceIds
        .map((sourceId) => sourceId.trim())
        .filter(Boolean),
    ),
  );
}

export function resolveNewsSourceRefetchInterval(input: {
  enabled: boolean;
  interval?: number | false;
  realtimeConnected: boolean;
}): number | false {
  const interval =
    typeof input.interval === 'number' &&
    Number.isFinite(input.interval) &&
    input.interval > 0
      ? input.interval
      : false;

  if (!input.enabled || input.realtimeConnected || !interval) {
    return false;
  }

  return interval;
}

export function shouldRefetchNewsSourceFromRealtimeEvent(input: {
  sourceId: string;
  visibleSourceIds: string[];
}): boolean {
  const sourceId = input.sourceId.trim();
  if (!sourceId) {
    return false;
  }

  return normalizeNewsnowSourceIds(input.visibleSourceIds).includes(sourceId);
}
