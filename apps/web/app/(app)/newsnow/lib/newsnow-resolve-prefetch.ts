export interface ResolvePrefetchAttemptState {
  key: string;
  attemptedAtMs: number;
  hasUnresolvedCandidates: boolean;
}

export const RESOLVE_PREFETCH_RETRY_INTERVAL_MS = 60_000;

export interface ResolvePrefetchSkipInput {
  prefetchKey: string;
  previous: ResolvePrefetchAttemptState | null;
  nowMs?: number;
  retryIntervalMs: number;
}

function resolveNowMs(nowMs?: number): number {
  return typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
}

function toSafeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

export function buildResolvePrefetchAttemptState(input: {
  prefetchKey: string;
  candidateCount: number;
  matchedCount: number;
  attemptedAtMs?: number;
}): ResolvePrefetchAttemptState {
  const candidateCount = toSafeCount(input.candidateCount);
  const matchedCount = Math.min(candidateCount, toSafeCount(input.matchedCount));

  return {
    key: input.prefetchKey,
    attemptedAtMs: resolveNowMs(input.attemptedAtMs),
    hasUnresolvedCandidates: candidateCount > 0 && matchedCount < candidateCount,
  };
}

export function shouldSkipResolvePrefetch(input: ResolvePrefetchSkipInput): boolean {
  const previous = input.previous;
  if (!previous) {
    return false;
  }
  if (previous.key !== input.prefetchKey) {
    return false;
  }
  if (!previous.hasUnresolvedCandidates) {
    return true;
  }

  const retryIntervalMs = Math.max(0, input.retryIntervalMs);
  if (retryIntervalMs <= 0) {
    return false;
  }

  const elapsedMs = resolveNowMs(input.nowMs) - previous.attemptedAtMs;
  return elapsedMs < retryIntervalMs;
}
