'use client';

import { useEffect } from 'react';

import {
  trackUserNewsBehavior,
  type UserNewsBehaviorPayload,
} from './user-news-behavior';

const READ_MILESTONE_STORAGE_PREFIX = 'user-news-behavior:read-milestones:v1';
const EVALUATION_INTERVAL_MS = 1500;
const WORDS_PER_MINUTE = 200;
const CJK_CHARACTERS_PER_MINUTE = 500;
const CJK_CHARACTER_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const NON_CJK_WORD_PATTERN =
  /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildMilestoneStorageKey(itemId: string) {
  return `${READ_MILESTONE_STORAGE_PREFIX}:${itemId}`;
}

function readTrackedMilestones(itemId: string): Set<string> {
  if (typeof window === 'undefined') {
    return new Set();
  }
  try {
    const raw = window.sessionStorage.getItem(buildMilestoneStorageKey(itemId));
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed.filter((entry): entry is string => typeof entry === 'string'),
    );
  } catch {
    return new Set();
  }
}

function writeTrackedMilestones(itemId: string, values: Set<string>) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage.setItem(
      buildMilestoneStorageKey(itemId),
      JSON.stringify(Array.from(values)),
    );
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Dwell/scroll progress keyed by item, kept OUTSIDE the effect: parent
 * re-renders (translation state, AI insights, reading-time estimation)
 * recreate the effect body and reset local variables. Without this buffer
 * every re-render zeroes the accumulated reading time and the engaged/deep/
 * completed milestones can never be reached.
 */
const milestoneProgressByItem = new Map<
  string,
  { activeElapsedMs: number; maxScrollDepth: number }
>();

export function estimateReadingTimeMinutes(text?: string | null): number {
  if (typeof text !== 'string' || !text.trim()) {
    return 1;
  }
  const normalizedText = text.trim();
  const cjkCharacterCount =
    normalizedText.match(CJK_CHARACTER_PATTERN)?.length ?? 0;
  const textWithoutCjk = normalizedText.replace(CJK_CHARACTER_PATTERN, ' ');
  const nonCjkWordCount =
    textWithoutCjk.match(NON_CJK_WORD_PATTERN)?.length ?? 0;
  const estimatedMinutes =
    nonCjkWordCount / WORDS_PER_MINUTE +
    cjkCharacterCount / CJK_CHARACTERS_PER_MINUTE;

  return Math.max(1, Math.ceil(estimatedMinutes));
}

export function useUserNewsReadMilestones(input: {
  itemId?: string;
  eventId?: string;
  source?: string;
  topics?: string[];
  entities?: string[];
  url?: string;
  estimatedReadingTimeMinutes?: number;
  enabled?: boolean;
}) {
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const itemId = input.itemId?.trim();
    if (!itemId || input.enabled === false) {
      return;
    }

    const estimatedMinutes = clamp(
      input.estimatedReadingTimeMinutes ?? 1,
      1,
      12,
    );
    const estimatedReadingTimeMs = estimatedMinutes * 60 * 1000;
    const milestones = [
      {
        key: 'engaged_read',
        dwellMs: clamp(estimatedReadingTimeMs * 0.25, 15_000, 45_000),
        scrollDepth: 0.35,
      },
      {
        key: 'deep_read',
        dwellMs: clamp(estimatedReadingTimeMs * 0.6, 40_000, 120_000),
        scrollDepth: 0.7,
      },
      {
        key: 'completed_read',
        dwellMs: clamp(estimatedReadingTimeMs * 0.85, 75_000, 240_000),
        scrollDepth: 0.9,
      },
    ] as const;

    const tracked = readTrackedMilestones(itemId);
    let activeStartedAt = document.hidden ? 0 : Date.now();
    const progress =
      milestoneProgressByItem.get(itemId) ??
      { activeElapsedMs: 0, maxScrollDepth: 0 };
    let activeElapsedMs = progress.activeElapsedMs;
    let maxScrollDepth = progress.maxScrollDepth;

    const persistMilestone = async (milestoneKey: typeof milestones[number]['key']) => {
      if (tracked.has(milestoneKey)) {
        return;
      }
      tracked.add(milestoneKey);
      writeTrackedMilestones(itemId, tracked);
      await trackUserNewsBehavior({
        type: milestoneKey,
        itemId,
        ...(input.eventId ? { eventId: input.eventId } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.topics ? { topics: input.topics } : {}),
        ...(input.entities ? { entities: input.entities } : {}),
        ...(input.url ? { url: input.url } : {}),
      } satisfies UserNewsBehaviorPayload);
    };

    const updateActiveElapsed = () => {
      if (document.hidden || activeStartedAt <= 0) {
        return;
      }
      activeElapsedMs += Date.now() - activeStartedAt;
      activeStartedAt = Date.now();
    };

    const computeScrollDepth = () => {
      const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
      const denominator = Math.max(1, scrollHeight - viewportHeight);
      const depth = clamp((scrollTop + viewportHeight) / denominator, 0, 1);
      maxScrollDepth = Math.max(maxScrollDepth, depth);
    };

    const evaluate = () => {
      updateActiveElapsed();
      computeScrollDepth();
      for (const milestone of milestones) {
        if (tracked.has(milestone.key)) {
          continue;
        }
        if (
          activeElapsedMs >= milestone.dwellMs &&
          maxScrollDepth >= milestone.scrollDepth
        ) {
          void persistMilestone(milestone.key);
        }
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        updateActiveElapsed();
        activeStartedAt = 0;
      } else {
        activeStartedAt = Date.now();
      }
      evaluate();
    };

    const onScroll = () => {
      computeScrollDepth();
      evaluate();
    };

    computeScrollDepth();
    const timer = window.setInterval(evaluate, EVALUATION_INTERVAL_MS);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      updateActiveElapsed();
      // Persist progress so a sibling re-render (stable input change) does
      // not lose accumulated reading time.
      milestoneProgressByItem.set(itemId, {
        activeElapsedMs,
        maxScrollDepth,
      });
      window.clearInterval(timer);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    input.enabled,
    input.entities,
    input.eventId,
    input.estimatedReadingTimeMinutes,
    input.itemId,
    input.source,
    input.topics,
    input.url,
  ]);
}
