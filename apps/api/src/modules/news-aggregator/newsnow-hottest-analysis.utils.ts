import { createHash } from 'node:crypto';

import type {
  NewsnowHotSignal,
  NewsnowHotSignalSeed,
  NewsnowHotSignalCluster,
  NewsnowHotSignalState,
} from './newsnow-hottest-analysis.types';

const CJK_SEGMENT_RE = /[\u3400-\u9fff]{2,}/g;
const LATIN_WORD_RE = /[a-z0-9]{2,}/g;

export const NEWSNOW_HEAT_SCORE_WEIGHTS = {
  rank: 0.3,
  heatValue: 0.28,
  crossSource: 0.27,
  authority: 0.15,
} as const;

export const NEWSNOW_CANDIDATE_SCORE_WEIGHTS = {
  heatScore: 0.34,
  freshnessScore: 0.24,
  supportScore: 0.24,
  authority: 0.1,
  confidence: 0.08,
} as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function extractCjkBigrams(segment: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < segment.length - 1; index += 1) {
    values.push(segment.slice(index, index + 2));
  }
  return values;
}

export function sha1Hex(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('hex');
}

export function normalizeTitle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractComparableTokens(value: string): string[] {
  const normalized = normalizeTitle(value);
  if (!normalized) {
    return [];
  }

  const tokens = new Set<string>();
  for (const token of normalized.match(LATIN_WORD_RE) ?? []) {
    tokens.add(token);
  }
  for (const segment of normalized.match(CJK_SEGMENT_RE) ?? []) {
    for (const token of extractCjkBigrams(segment)) {
      tokens.add(token);
    }
  }
  return Array.from(tokens);
}

export function computeTitleSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeTitle(left);
  const normalizedRight = normalizeTitle(right);
  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }
  if (normalizedLeft === normalizedRight) {
    return 1;
  }
  if (
    normalizedLeft.length >= 8 &&
    normalizedRight.length >= 8 &&
    (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  ) {
    const minLength = Math.min(normalizedLeft.length, normalizedRight.length);
    const maxLength = Math.max(normalizedLeft.length, normalizedRight.length);
    return clamp01(minLength / maxLength);
  }

  const leftTokens = extractComparableTokens(normalizedLeft);
  const rightTokens = extractComparableTokens(normalizedRight);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? clamp01(intersection / union) : 0;
}

export function parseHeatValue(value: string | null | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.replace(/,/g, '').toLowerCase();
  const matches = Array.from(
    normalized.matchAll(/(\d+(?:\.\d+)?)\s*(亿|萬|万|k|m|b)?/g),
  );
  if (matches.length === 0) {
    return null;
  }

  let best: number | null = null;
  for (const match of matches) {
    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric)) {
      continue;
    }
    const unit = match[2] ?? '';
    const multiplier =
      unit === '亿'
        ? 100_000_000
        : unit === '万' || unit === '萬'
          ? 10_000
          : unit === 'k'
            ? 1_000
            : unit === 'm'
              ? 1_000_000
              : unit === 'b'
                ? 1_000_000_000
                : 1;
    const next = numeric * multiplier;
    if (best === null || next > best) {
      best = next;
    }
  }

  return best;
}

export function buildSignalKey(input: {
  sourceId: string;
  title: string;
  url: string;
}): string {
  return sha1Hex(
    `${input.sourceId}|${normalizeTitle(input.title)}|${input.url.trim().toLowerCase()}`,
  );
}

export function buildGlobalInputSignature(input: {
  entries: Array<{
    sourceId: string;
    failed: boolean;
    items: Array<{
      id: string;
      title: string;
      url: string;
      heatText: string | null;
      rank: number;
    }>;
  }>;
}): string {
  const payload = input.entries
    .map((entry) => ({
      sourceId: entry.sourceId.trim().toLowerCase(),
      failed: entry.failed,
      items: entry.items
        .map((item) => ({
          id: item.id.trim(),
          title: normalizeTitle(item.title),
          url: item.url.trim().toLowerCase(),
          heatText: item.heatText?.trim() ?? null,
          rank: item.rank,
        }))
        .sort((left, right) => {
          if (left.rank !== right.rank) {
            return left.rank - right.rank;
          }
          if (left.id !== right.id) {
            return left.id.localeCompare(right.id);
          }
          return left.url.localeCompare(right.url);
        }),
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));

  return sha1Hex(JSON.stringify(payload));
}

export function computeFreshness(input: {
  nowMs: number;
  state: NewsnowHotSignalState | null;
  rank: number;
}): { freshnessScore: number; isNew: boolean; isRising: boolean } {
  const state = input.state;
  if (!state) {
    return { freshnessScore: 1, isNew: true, isRising: false };
  }

  const firstSeenMs = Date.parse(state.firstSeenAt);
  const ageMs = Number.isFinite(firstSeenMs) ? Math.max(0, input.nowMs - firstSeenMs) : 12 * 60 * 60 * 1000;
  const ageHours = ageMs / (60 * 60 * 1000);
  const newness =
    ageHours <= 0.5
      ? 1
      : ageHours <= 2
        ? 0.82
        : ageHours <= 6
          ? 0.55
          : ageHours <= 12
            ? 0.35
            : 0.18;
  const previousRank =
    typeof state.lastRank === 'number' && Number.isFinite(state.lastRank)
      ? state.lastRank
      : null;
  const rankGain = previousRank && previousRank > input.rank ? previousRank - input.rank : 0;
  const riseScore = rankGain > 0 ? clamp01(rankGain / 12) : 0;

  return {
    freshnessScore: clamp01(newness * 0.7 + riseScore * 0.3),
    isNew: false,
    isRising: rankGain > 0,
  };
}

export function buildHeuristicClusters(
  signals: Array<
    Pick<
      NewsnowHotSignal | NewsnowHotSignalSeed,
      'signalKey' | 'sourceId' | 'title' | 'heatValue' | 'rank'
    >
  >,
): NewsnowHotSignalCluster[] {
  if (signals.length === 0) {
    return [];
  }

  type ClusterableSignal = (typeof signals)[number];

  const parents = signals.map((_, index) => index);
  const find = (index: number): number => {
    if (parents[index] === index) {
      return index;
    }
    parents[index] = find(parents[index]!);
    return parents[index]!;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parents[rightRoot] = leftRoot;
    }
  };

  for (let leftIndex = 0; leftIndex < signals.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < signals.length; rightIndex += 1) {
      const left = signals[leftIndex]!;
      const right = signals[rightIndex]!;
      const similarity = computeTitleSimilarity(left.title, right.title);
      if (similarity >= 0.72) {
        union(leftIndex, rightIndex);
        continue;
      }
      if (left.sourceId === right.sourceId) {
        continue;
      }
      if (similarity >= 0.48) {
        union(leftIndex, rightIndex);
      }
    }
  }

  const groups = new Map<number, ClusterableSignal[]>();
  signals.forEach((signal, index) => {
    const root = find(index);
    const current = groups.get(root) ?? [];
    current.push(signal);
    groups.set(root, current);
  });

  return Array.from(groups.values())
    .map((items) => {
      const representative = [...items].sort((left, right) => left.rank - right.rank)[0]!;
      const totalHeatValue = items.reduce((sum, item) => sum + (item.heatValue ?? 0), 0);
      const maxHeatValue = items.reduce((best, item) => Math.max(best, item.heatValue ?? 0), 0);
      const avgRank = items.reduce((sum, item) => sum + item.rank, 0) / items.length;
      return {
        clusterId: sha1Hex(items.map((item) => item.signalKey).sort().join('|')),
        itemKeys: items.map((item) => item.signalKey),
        sourceIds: Array.from(new Set(items.map((item) => item.sourceId))),
        representativeTitle: representative.title,
        totalHeatValue,
        maxHeatValue,
        avgRank: Number(avgRank.toFixed(3)),
      } satisfies NewsnowHotSignalCluster;
    })
    .sort((left, right) => {
      if (right.sourceIds.length !== left.sourceIds.length) {
        return right.sourceIds.length - left.sourceIds.length;
      }
      if (right.maxHeatValue !== left.maxHeatValue) {
        return right.maxHeatValue - left.maxHeatValue;
      }
      return left.avgRank - right.avgRank;
    });
}

export function computeHeatScore(input: {
  rank: number;
  rankCap: number;
  heatValue: number | null;
  maxHeatValue: number;
  sourceCount: number;
  authority: number;
}): number {
  const rankBase = input.rankCap > 1 ? 1 - (input.rank - 1) / (input.rankCap - 1) : 1;
  const heatBase =
    input.heatValue && input.maxHeatValue > 0
      ? Math.sqrt(Math.min(input.heatValue, input.maxHeatValue) / input.maxHeatValue)
      : 0;
  const crossSourceBase = clamp01((input.sourceCount - 1) / 4);
  return clamp01(
    rankBase * NEWSNOW_HEAT_SCORE_WEIGHTS.rank +
      heatBase * NEWSNOW_HEAT_SCORE_WEIGHTS.heatValue +
      crossSourceBase * NEWSNOW_HEAT_SCORE_WEIGHTS.crossSource +
      clamp01(input.authority) * NEWSNOW_HEAT_SCORE_WEIGHTS.authority,
  );
}

export function computeCandidateScore(input: {
  heatScore: number;
  freshnessScore: number;
  sourceCount: number;
  authority: number;
  confidence?: number | null;
}): number {
  const supportScore = clamp01((input.sourceCount - 1) / 5);
  const confidence =
    typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? clamp01(input.confidence)
      : 0.5;
  return clamp01(
    input.heatScore * NEWSNOW_CANDIDATE_SCORE_WEIGHTS.heatScore +
      input.freshnessScore * NEWSNOW_CANDIDATE_SCORE_WEIGHTS.freshnessScore +
      supportScore * NEWSNOW_CANDIDATE_SCORE_WEIGHTS.supportScore +
      clamp01(input.authority) * NEWSNOW_CANDIDATE_SCORE_WEIGHTS.authority +
      confidence * NEWSNOW_CANDIDATE_SCORE_WEIGHTS.confidence,
  );
}

export function buildStateKey(orgId: string, signalKey: string): string {
  return `newsnow:hottest:state:v1:${orgId}:${signalKey}`;
}

export function buildAnalysisCacheKey(orgId: string): string {
  return `newsnow:hottest:analysis:v1:${orgId}:fresh`;
}

export function buildAnalysisStaleCacheKey(orgId: string): string {
  return `newsnow:hottest:analysis:v1:${orgId}:stale`;
}

export function buildGlobalSignatureCacheKey(): string {
  return 'newsnow:hottest:global:v1:signature';
}

export function buildGlobalSnapshotCacheKey(): string {
  return 'newsnow:hottest:global:v1:fresh';
}

export function buildGlobalSnapshotStaleCacheKey(): string {
  return 'newsnow:hottest:global:v1:stale';
}

export function buildBridgeExternalId(sourceId: string, url: string): string {
  return `newsnow:${sourceId}:${sha1Hex(url.trim().toLowerCase())}`;
}
