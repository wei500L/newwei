import { describe, expect, it } from 'vitest';

import {
  buildResolvePrefetchAttemptState,
  shouldSkipResolvePrefetch,
} from '../app/(app)/newsnow/lib/newsnow-resolve-prefetch';

describe('newsnow resolve prefetch policy', () => {
  it('skips unchanged fully-resolved candidate sets', () => {
    const previous = buildResolvePrefetchAttemptState({
      prefetchKey: 'a::https://example.com/a',
      candidateCount: 1,
      matchedCount: 1,
      attemptedAtMs: 1_000,
    });

    expect(
      shouldSkipResolvePrefetch({
        prefetchKey: 'a::https://example.com/a',
        previous,
        nowMs: 2_000,
        retryIntervalMs: 60_000,
      }),
    ).toBe(true);
  });

  it('retries unchanged unresolved candidate sets only after retry interval', () => {
    const previous = buildResolvePrefetchAttemptState({
      prefetchKey: 'a::https://example.com/a|b::https://example.com/b',
      candidateCount: 2,
      matchedCount: 0,
      attemptedAtMs: 1_000,
    });

    expect(
      shouldSkipResolvePrefetch({
        prefetchKey: 'a::https://example.com/a|b::https://example.com/b',
        previous,
        nowMs: 30_000,
        retryIntervalMs: 60_000,
      }),
    ).toBe(true);

    expect(
      shouldSkipResolvePrefetch({
        prefetchKey: 'a::https://example.com/a|b::https://example.com/b',
        previous,
        nowMs: 61_000,
        retryIntervalMs: 60_000,
      }),
    ).toBe(false);
  });

  it('does not skip when candidate key changes', () => {
    const previous = buildResolvePrefetchAttemptState({
      prefetchKey: 'a::https://example.com/a',
      candidateCount: 1,
      matchedCount: 1,
      attemptedAtMs: 1_000,
    });

    expect(
      shouldSkipResolvePrefetch({
        prefetchKey: 'b::https://example.com/b',
        previous,
        nowMs: 2_000,
        retryIntervalMs: 60_000,
      }),
    ).toBe(false);
  });
});
