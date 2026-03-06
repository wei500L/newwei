'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useEffect, useMemo, useState } from 'react';

import { createApiClient } from '@/lib/api-client';
import { subscribeNewsnowPersonalizationUpdated } from '@/lib/newsnow-personalization-events';

import type { NewsnowPreferenceSettings } from '../store/newsnow-store';

const PERSONALIZATION_QUERY_DEBOUNCE_MS = 700;

export interface PersonalizedSourceScoreDetail {
  combinedScore: number;
  affinityScore: number;
  behaviorScore: number;
  affinityWeight: number;
  behaviorWeight: number;
  affinityContribution: number;
  behaviorContribution: number;
  focusBonus: number;
}

interface PersonalizedOrderResponse {
  columnKey: string;
  sortMode: 'manual' | 'personalized';
  sourceIds: string[];
  sourceScores: Record<string, number>;
  sourceScoreDetails: Record<string, PersonalizedSourceScoreDetail>;
  scoreWeights: {
    affinity: number;
    behavior: number;
    focusBonus: number;
  };
  computedAt: string;
}

interface UseNewsnowPersonalizedOrderInput {
  columnKey: string;
  sourceIds: string[];
  settingsOverride?: Partial<NewsnowPreferenceSettings>;
  enabled?: boolean;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function normalizeSourceIds(base: string[], incoming: unknown): string[] {
  const baseSet = new Set(base);
  const ordered: string[] = [];
  const seen = new Set<string>();

  if (Array.isArray(incoming)) {
    for (const entry of incoming) {
      if (typeof entry !== 'string') {
        continue;
      }
      const sourceId = entry.trim();
      if (!sourceId || seen.has(sourceId) || !baseSet.has(sourceId)) {
        continue;
      }
      seen.add(sourceId);
      ordered.push(sourceId);
    }
  }

  for (const sourceId of base) {
    if (seen.has(sourceId)) {
      continue;
    }
    ordered.push(sourceId);
  }

  return ordered;
}

function normalizeScores(sourceIds: string[], raw: unknown): Record<string, number> {
  const baseSet = new Set(sourceIds);
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const [sourceId, rawScore] of Object.entries(record)) {
    if (!baseSet.has(sourceId)) {
      continue;
    }
    const score =
      typeof rawScore === 'number' && Number.isFinite(rawScore)
        ? Math.max(0, Math.min(100, rawScore))
        : 0;
    out[sourceId] = score;
  }
  return out;
}

function normalizeScoreWeights(raw: unknown) {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const affinity =
    typeof record.affinity === 'number' && Number.isFinite(record.affinity)
      ? Math.max(0, record.affinity)
      : 0.5;
  const behavior =
    typeof record.behavior === 'number' && Number.isFinite(record.behavior)
      ? Math.max(0, record.behavior)
      : 0.5;
  const focusBonus =
    typeof record.focusBonus === 'number' && Number.isFinite(record.focusBonus)
      ? Math.max(0, record.focusBonus)
      : 0;
  const total = affinity + behavior;
  if (total <= 0) {
    return { affinity: 0.5, behavior: 0.5, focusBonus };
  }
  return {
    affinity: Number((affinity / total).toFixed(4)),
    behavior: Number((behavior / total).toFixed(4)),
    focusBonus: Number(focusBonus.toFixed(4)),
  };
}

function normalizeScoreDetails(
  sourceIds: string[],
  raw: unknown,
  sourceScores: Record<string, number>,
  scoreWeights: { affinity: number; behavior: number; focusBonus: number },
): Record<string, PersonalizedSourceScoreDetail> {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, PersonalizedSourceScoreDetail> = {};
  for (const sourceId of sourceIds) {
    const fallbackCombined = sourceScores[sourceId] ?? 0;
    const incoming = record[sourceId];
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
      const detail = incoming as Record<string, unknown>;
      out[sourceId] = {
        combinedScore:
          typeof detail.combinedScore === 'number' && Number.isFinite(detail.combinedScore)
            ? Math.max(0, Math.min(100, detail.combinedScore))
            : fallbackCombined,
        affinityScore:
          typeof detail.affinityScore === 'number' && Number.isFinite(detail.affinityScore)
            ? Math.max(0, Math.min(100, detail.affinityScore))
            : 0,
        behaviorScore:
          typeof detail.behaviorScore === 'number' && Number.isFinite(detail.behaviorScore)
            ? Math.max(0, Math.min(100, detail.behaviorScore))
            : 0,
        affinityWeight:
          typeof detail.affinityWeight === 'number' && Number.isFinite(detail.affinityWeight)
            ? Math.max(0, detail.affinityWeight)
            : scoreWeights.affinity,
        behaviorWeight:
          typeof detail.behaviorWeight === 'number' && Number.isFinite(detail.behaviorWeight)
            ? Math.max(0, detail.behaviorWeight)
            : scoreWeights.behavior,
        affinityContribution:
          typeof detail.affinityContribution === 'number' &&
          Number.isFinite(detail.affinityContribution)
            ? Math.max(0, Math.min(100, detail.affinityContribution))
            : 0,
        behaviorContribution:
          typeof detail.behaviorContribution === 'number' &&
          Number.isFinite(detail.behaviorContribution)
            ? Math.max(0, Math.min(100, detail.behaviorContribution))
            : 0,
        focusBonus:
          typeof detail.focusBonus === 'number' && Number.isFinite(detail.focusBonus)
            ? Math.max(0, detail.focusBonus)
            : 0,
      };
      continue;
    }

    out[sourceId] = {
      combinedScore: fallbackCombined,
      affinityScore: 0,
      behaviorScore: 0,
      affinityWeight: scoreWeights.affinity,
      behaviorWeight: scoreWeights.behavior,
      affinityContribution: 0,
      behaviorContribution: 0,
      focusBonus: 0,
    };
  }
  return out;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [delayMs, value]);

  return debounced;
}

export function useNewsnowPersonalizedOrder({
  columnKey,
  sourceIds,
  settingsOverride,
  enabled = true,
}: UseNewsnowPersonalizedOrderInput) {
  const queryClient = useQueryClient();
  const { data: session, status } = useSession();
  const accessToken = session?.accessToken as string | undefined;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadItems =
    permissions.includes('items.read') || permissions.includes('items.write');
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );

  const settingsFingerprint = useMemo(
    () => stableStringify(settingsOverride ?? null),
    [settingsOverride],
  );
  const debouncedSettingsFingerprint = useDebouncedValue(
    settingsFingerprint,
    PERSONALIZATION_QUERY_DEBOUNCE_MS,
  );
  const debouncedSettingsOverride = useDebouncedValue(
    settingsOverride,
    PERSONALIZATION_QUERY_DEBOUNCE_MS,
  );

  useEffect(() => {
    return subscribeNewsnowPersonalizationUpdated(() => {
      void queryClient.invalidateQueries({
        queryKey: ['newsnow-personalized-order'],
      });
    });
  }, [queryClient]);

  return useQuery<PersonalizedOrderResponse>({
    queryKey: [
      'newsnow-personalized-order',
      columnKey,
      sourceIds.join('|'),
      debouncedSettingsFingerprint,
    ],
    enabled:
      enabled &&
      status === 'authenticated' &&
      !!accessToken &&
      canReadItems &&
      sourceIds.length > 0,
    queryFn: async () => {
      const { data } = await apiClient.post('/news-aggregator/sources/order', {
        column: columnKey,
        sources: sourceIds,
        ...(debouncedSettingsOverride ? { settings: debouncedSettingsOverride } : {}),
      });

      const payload = data as Partial<PersonalizedOrderResponse> & {
        sourceIds?: unknown;
        sourceScores?: unknown;
        sourceScoreDetails?: unknown;
        scoreWeights?: unknown;
        sortMode?: unknown;
      };
      const rawSortMode =
        typeof payload.sortMode === 'string'
          ? payload.sortMode.trim().toLowerCase()
          : '';
      const normalizedSourceIds = normalizeSourceIds(sourceIds, payload.sourceIds);
      const sourceScores = normalizeScores(normalizedSourceIds, payload.sourceScores);
      const scoreWeights = normalizeScoreWeights(payload.scoreWeights);
      const sourceScoreDetails = normalizeScoreDetails(
        normalizedSourceIds,
        payload.sourceScoreDetails,
        sourceScores,
        scoreWeights,
      );

      return {
        columnKey,
        sortMode: rawSortMode === 'smart' || rawSortMode === 'personalized' ? 'personalized' : 'manual',
        sourceIds: normalizedSourceIds,
        sourceScores,
        sourceScoreDetails,
        scoreWeights,
        computedAt:
          typeof payload.computedAt === 'string' && payload.computedAt.trim().length > 0
            ? payload.computedAt
            : new Date().toISOString(),
      };
    },
    staleTime: 1000 * 20,
  });
}
