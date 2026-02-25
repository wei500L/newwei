export type NewsFreshnessLevel = 'fresh' | 'aging' | 'stale' | 'unknown';

export interface NewsFreshnessState {
  level: NewsFreshnessLevel;
  ageMs: number;
  delayMs: number;
  nextRefreshInMs: number;
}

const AGING_FACTOR = 1.25;
const STALE_FACTOR = 2.25;

function toTimestamp(value?: number | string): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function resolveNewsFreshnessState(input: {
  updatedTime?: number | string;
  intervalMs?: number;
  nowMs?: number;
}): NewsFreshnessState {
  const updatedMs = toTimestamp(input.updatedTime);
  const intervalMs =
    typeof input.intervalMs === 'number' && Number.isFinite(input.intervalMs) && input.intervalMs > 0
      ? input.intervalMs
      : 0;

  if (!updatedMs || intervalMs <= 0) {
    return {
      level: 'unknown',
      ageMs: 0,
      delayMs: 0,
      nextRefreshInMs: 0,
    };
  }

  const nowMs =
    typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const ageMs = Math.max(0, nowMs - updatedMs);
  const delayMs = Math.max(0, ageMs - intervalMs);
  const nextRefreshInMs = Math.max(0, intervalMs - ageMs);

  let level: NewsFreshnessLevel = 'fresh';
  if (ageMs > intervalMs * STALE_FACTOR) {
    level = 'stale';
  } else if (ageMs > intervalMs * AGING_FACTOR) {
    level = 'aging';
  }

  return {
    level,
    ageMs,
    delayMs,
    nextRefreshInMs,
  };
}

export function formatShortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0s';
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainMinutes = minutes % 60;
    return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
