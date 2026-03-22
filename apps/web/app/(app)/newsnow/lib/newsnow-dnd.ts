import { arrayMove } from "@dnd-kit/sortable";

export function reorderNewsnowItems(items: string[], activeId: string, overId?: string | null): string[] {
  if (!overId || activeId === overId) {
    return items;
  }

  const oldIndex = items.indexOf(activeId);
  const newIndex = items.indexOf(overId);

  if (oldIndex < 0 || newIndex < 0) {
    return items;
  }

  return arrayMove(items, oldIndex, newIndex);
}

export interface NewsnowSnapshotItem {
  id: string;
  title: string;
  pubDate?: number | string;
  url?: string;
}

export function buildNewsnowSnapshotHash(items: readonly NewsnowSnapshotItem[]): string {
  if (items.length === 0) {
    return "0";
  }

  return items
    .map((item) =>
      [
        String(item.id),
        item.title.trim(),
        item.pubDate === undefined ? "" : String(item.pubDate),
        item.url?.trim() ?? "",
      ].join("::"),
    )
    .join("||");
}

export interface NewsnowSourceSnapshot {
  updatedAt: number;
  items: NewsnowSnapshotItem[];
}

export interface CrossSourceItemMeta {
  normalizedTitle: string;
  duplicateSourceIds: string[];
  groupSize: number;
  primarySourceId: string;
  isPrimary: boolean;
}

export interface CrossSourceDedupResult {
  bySource: Record<string, Record<string, CrossSourceItemMeta>>;
  duplicateItemsBySource: Record<string, number>;
  visibleItemsBySource: Record<string, number>;
  duplicateGroups: number;
}

export interface SourceAffinitySignal {
  score?: number;
  lastInteractedAt?: number;
}

const NEWS_TITLE_MIN_LENGTH = 8;
const SYMBOL_NOISE_PATTERN =
  /[~`!@#$%^&*()_+\-=[\]{};:'"\\|,.<>/?，。！？、；：“”‘’（）【】《》〈〉·…\s]+/g;
const BRACKET_PREFIX_PATTERN = /^[[(（【].{1,16}[\])）】]\s*/;
const MAX_SOURCE_SCORE_AGE_DAYS = 14;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeNewsTitle(title: string): string {
  const trimmed = title.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(BRACKET_PREFIX_PATTERN, "")
    .replace(SYMBOL_NOISE_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface GroupBucket {
  normalizedTitle: string;
  orderedSourceIds: string[];
  sourceSet: Set<string>;
  itemIdsBySource: Record<string, string[]>;
}

export function buildCrossSourceDedupResult(input: {
  sourceOrder: string[];
  snapshots: Record<string, NewsnowSourceSnapshot | undefined>;
}): CrossSourceDedupResult {
  const { sourceOrder, snapshots } = input;
  const bySource: Record<string, Record<string, CrossSourceItemMeta>> = {};
  const duplicateItemsBySource: Record<string, number> = {};
  const visibleItemsBySource: Record<string, number> = {};
  const groupMap = new Map<string, GroupBucket>();

  sourceOrder.forEach((sourceId) => {
    bySource[sourceId] = {};
    duplicateItemsBySource[sourceId] = 0;
    visibleItemsBySource[sourceId] = 0;
  });

  for (const sourceId of sourceOrder) {
    const snapshot = snapshots[sourceId];
    const items = snapshot?.items ?? [];
    for (const item of items) {
      const itemId = String(item.id);
      const normalizedTitle = normalizeNewsTitle(item.title);
      if (!normalizedTitle || normalizedTitle.length < NEWS_TITLE_MIN_LENGTH) {
        continue;
      }
      const bucket = groupMap.get(normalizedTitle) ?? {
        normalizedTitle,
        orderedSourceIds: [],
        sourceSet: new Set<string>(),
        itemIdsBySource: {},
      };

      if (!bucket.sourceSet.has(sourceId)) {
        bucket.sourceSet.add(sourceId);
        bucket.orderedSourceIds.push(sourceId);
      }
      const current = bucket.itemIdsBySource[sourceId] ?? [];
      current.push(itemId);
      bucket.itemIdsBySource[sourceId] = current;

      groupMap.set(normalizedTitle, bucket);
    }
  }

  let duplicateGroups = 0;

  for (const bucket of groupMap.values()) {
    if (bucket.sourceSet.size <= 1) {
      continue;
    }
    duplicateGroups += 1;
    const primarySourceId = bucket.orderedSourceIds[0] ?? "";
    if (!primarySourceId) {
      continue;
    }

    const allSourceIds = Array.from(bucket.sourceSet);
    for (const sourceId of allSourceIds) {
      const duplicateSourceIds = allSourceIds.filter((id) => id !== sourceId);
      const isPrimary = sourceId === primarySourceId;
      const itemIds = bucket.itemIdsBySource[sourceId] ?? [];
      for (const itemId of itemIds) {
        bySource[sourceId] ??= {};
        bySource[sourceId][itemId] = {
          normalizedTitle: bucket.normalizedTitle,
          duplicateSourceIds,
          groupSize: allSourceIds.length,
          primarySourceId,
          isPrimary,
        };
        duplicateItemsBySource[sourceId] = (duplicateItemsBySource[sourceId] ?? 0) + 1;
      }
    }
  }

  for (const sourceId of sourceOrder) {
    const items = snapshots[sourceId]?.items ?? [];
    let visible = 0;
    for (const item of items) {
      const itemId = String(item.id);
      const meta = bySource[sourceId]?.[itemId];
      if (!meta || meta.isPrimary) {
        visible += 1;
      }
    }
    visibleItemsBySource[sourceId] = visible;
  }

  return {
    bySource,
    duplicateItemsBySource,
    visibleItemsBySource,
    duplicateGroups,
  };
}

export function sortNewsnowSourcesByAffinity(input: {
  sourceIds: string[];
  affinities: Record<string, SourceAffinitySignal | undefined>;
  focusSources?: string[];
}): string[] {
  const focusSet = new Set(input.focusSources ?? []);
  const now = Date.now();

  const weighted = input.sourceIds.map((sourceId, index) => {
    const affinity = input.affinities[sourceId];
    const baseScore =
      affinity && typeof affinity.score === "number" && Number.isFinite(affinity.score)
        ? affinity.score
        : 0;
    const elapsedDays =
      affinity && typeof affinity.lastInteractedAt === "number"
        ? clamp((now - affinity.lastInteractedAt) / (24 * 60 * 60 * 1000), 0, MAX_SOURCE_SCORE_AGE_DAYS)
        : MAX_SOURCE_SCORE_AGE_DAYS;
    const recencyFactor = 1 - elapsedDays / (MAX_SOURCE_SCORE_AGE_DAYS * 1.25);
    const recencyWeighted = baseScore * clamp(recencyFactor, 0.2, 1);
    const focusBonus = focusSet.has(sourceId) ? 0.35 : 0;

    return {
      sourceId,
      index,
      score: recencyWeighted + focusBonus,
    };
  });

  const ranked = [...weighted].sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.0001) {
      return b.score - a.score;
    }
    return a.index - b.index;
  });

  return ranked.map((entry) => entry.sourceId);
}
