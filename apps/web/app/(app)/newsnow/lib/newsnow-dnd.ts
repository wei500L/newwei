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

export interface CrossSourceDedupCache extends CrossSourceDedupResult {
  sourceOrderKey: string;
  sourceHashes: Record<string, string>;
  sourceEntriesBySource: Record<string, Record<string, string[]>>;
  itemCountBySource: Record<string, number>;
  hiddenItemsBySource: Record<string, number>;
  titleBuckets: Map<string, GroupBucket>;
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

function buildSourceTitleEntries(
  items: readonly NewsnowSnapshotItem[],
): Record<string, string[]> {
  const entries: Record<string, string[]> = {};

  for (const item of items) {
    const itemId = String(item.id);
    const normalizedTitle = normalizeNewsTitle(item.title);
    if (!normalizedTitle || normalizedTitle.length < NEWS_TITLE_MIN_LENGTH) {
      continue;
    }
    const itemIds = entries[normalizedTitle] ?? [];
    itemIds.push(itemId);
    entries[normalizedTitle] = itemIds;
  }

  return entries;
}

function cloneGroupBucket(bucket: GroupBucket): GroupBucket {
  return {
    normalizedTitle: bucket.normalizedTitle,
    orderedSourceIds: [...bucket.orderedSourceIds],
    sourceSet: new Set(bucket.sourceSet),
    itemIdsBySource: Object.fromEntries(
      Object.entries(bucket.itemIdsBySource).map(([sourceId, itemIds]) => [
        sourceId,
        [...itemIds],
      ]),
    ),
  };
}

function buildFreshCrossSourceDedupResult(input: {
  sourceOrder: string[];
  snapshots: Record<string, NewsnowSourceSnapshot | undefined>;
  snapshotHashes?: Record<string, string | undefined>;
}): CrossSourceDedupCache {
  const { sourceOrder, snapshots, snapshotHashes } = input;
  const bySource: Record<string, Record<string, CrossSourceItemMeta>> = {};
  const duplicateItemsBySource: Record<string, number> = {};
  const hiddenItemsBySource: Record<string, number> = {};
  const visibleItemsBySource: Record<string, number> = {};
  const sourceHashes: Record<string, string> = {};
  const sourceEntriesBySource: Record<string, Record<string, string[]>> = {};
  const itemCountBySource: Record<string, number> = {};
  const titleBuckets = new Map<string, GroupBucket>();
  let duplicateGroups = 0;

  sourceOrder.forEach((sourceId) => {
    const snapshot = snapshots[sourceId];
    const items = snapshot?.items ?? [];
    const entries = buildSourceTitleEntries(items);

    bySource[sourceId] = {};
    duplicateItemsBySource[sourceId] = 0;
    hiddenItemsBySource[sourceId] = 0;
    visibleItemsBySource[sourceId] = items.length;
    sourceEntriesBySource[sourceId] = entries;
    itemCountBySource[sourceId] = items.length;
    sourceHashes[sourceId] =
      snapshotHashes?.[sourceId] ?? buildNewsnowSnapshotHash(items);

    for (const [normalizedTitle, itemIds] of Object.entries(entries)) {
      const bucket = titleBuckets.get(normalizedTitle) ?? {
        normalizedTitle,
        orderedSourceIds: [],
        sourceSet: new Set<string>(),
        itemIdsBySource: {},
      };

      bucket.sourceSet.add(sourceId);
      bucket.itemIdsBySource[sourceId] = [...itemIds];
      titleBuckets.set(normalizedTitle, bucket);
    }
  });

  for (const bucket of titleBuckets.values()) {
    bucket.orderedSourceIds = sourceOrder.filter((sourceId) =>
      bucket.sourceSet.has(sourceId),
    );

    if (bucket.sourceSet.size <= 1) {
      continue;
    }

    duplicateGroups += 1;
    const allSourceIds = bucket.orderedSourceIds;
    const primarySourceId = allSourceIds[0] ?? "";
    if (!primarySourceId) {
      continue;
    }

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
      }

      duplicateItemsBySource[sourceId] =
        (duplicateItemsBySource[sourceId] ?? 0) + itemIds.length;
      if (!isPrimary) {
        hiddenItemsBySource[sourceId] =
          (hiddenItemsBySource[sourceId] ?? 0) + itemIds.length;
      }
    }
  }

  for (const sourceId of sourceOrder) {
    visibleItemsBySource[sourceId] = Math.max(
      0,
      (itemCountBySource[sourceId] ?? 0) - (hiddenItemsBySource[sourceId] ?? 0),
    );
  }

  return {
    bySource,
    duplicateItemsBySource,
    visibleItemsBySource,
    duplicateGroups,
    sourceOrderKey: sourceOrder.join("||"),
    sourceHashes,
    sourceEntriesBySource,
    itemCountBySource,
    hiddenItemsBySource,
    titleBuckets,
  };
}

export function buildCrossSourceDedupResult(input: {
  sourceOrder: string[];
  snapshots: Record<string, NewsnowSourceSnapshot | undefined>;
  snapshotHashes?: Record<string, string | undefined>;
  previousCache?: CrossSourceDedupCache | null;
}): CrossSourceDedupCache {
  const sourceOrderKey = input.sourceOrder.join("||");
  const previousCache =
    input.previousCache && input.previousCache.sourceOrderKey === sourceOrderKey
      ? input.previousCache
      : null;

  if (!previousCache) {
    return buildFreshCrossSourceDedupResult(input);
  }

  const nextSourceHashes: Record<string, string> = {};
  const changedSourceIds: string[] = [];

  for (const sourceId of input.sourceOrder) {
    const nextHash =
      input.snapshotHashes?.[sourceId] ??
      buildNewsnowSnapshotHash(input.snapshots[sourceId]?.items ?? []);
    nextSourceHashes[sourceId] = nextHash;
    if (previousCache.sourceHashes[sourceId] !== nextHash) {
      changedSourceIds.push(sourceId);
    }
  }

  if (changedSourceIds.length === 0) {
    return previousCache;
  }

  const nextBySource: Record<string, Record<string, CrossSourceItemMeta>> = {
    ...previousCache.bySource,
  };
  const nextDuplicateItemsBySource = {
    ...previousCache.duplicateItemsBySource,
  };
  const nextVisibleItemsBySource = { ...previousCache.visibleItemsBySource };
  const nextHiddenItemsBySource = { ...previousCache.hiddenItemsBySource };
  const nextSourceEntriesBySource = { ...previousCache.sourceEntriesBySource };
  const nextItemCountBySource = { ...previousCache.itemCountBySource };
  const nextTitleBuckets = new Map(previousCache.titleBuckets);
  const mutatedSourceIds = new Set<string>();
  const mutatedTitles = new Set<string>();
  const affectedSourceIds = new Set<string>();
  let nextDuplicateGroups = previousCache.duplicateGroups;

  const ensureSourceMetaMutable = (
    sourceId: string,
  ): Record<string, CrossSourceItemMeta> => {
    if (!mutatedSourceIds.has(sourceId)) {
      nextBySource[sourceId] = { ...(previousCache.bySource[sourceId] ?? {}) };
      mutatedSourceIds.add(sourceId);
    }
    return (nextBySource[sourceId] ??= {});
  };

  const ensureBucketMutable = (normalizedTitle: string): GroupBucket | null => {
    const current = nextTitleBuckets.get(normalizedTitle);
    if (!current) {
      return null;
    }
    if (!mutatedTitles.has(normalizedTitle)) {
      const clonedBucket = cloneGroupBucket(current);
      nextTitleBuckets.set(normalizedTitle, clonedBucket);
      mutatedTitles.add(normalizedTitle);
      return clonedBucket;
    }
    return current;
  };

  const removeBucketContribution = (bucket: GroupBucket) => {
    if (bucket.sourceSet.size <= 1) {
      return;
    }

    nextDuplicateGroups -= 1;
    const sourceIds = bucket.orderedSourceIds.filter((sourceId) =>
      bucket.sourceSet.has(sourceId),
    );
    const primarySourceId = sourceIds[0] ?? "";

    for (const sourceId of sourceIds) {
      const itemIds = bucket.itemIdsBySource[sourceId] ?? [];
      if (itemIds.length === 0) {
        continue;
      }
      const sourceMeta = ensureSourceMetaMutable(sourceId);
      for (const itemId of itemIds) {
        delete sourceMeta[itemId];
      }
      nextDuplicateItemsBySource[sourceId] = Math.max(
        0,
        (nextDuplicateItemsBySource[sourceId] ?? 0) - itemIds.length,
      );
      if (sourceId !== primarySourceId) {
        nextHiddenItemsBySource[sourceId] = Math.max(
          0,
          (nextHiddenItemsBySource[sourceId] ?? 0) - itemIds.length,
        );
      }
    }
  };

  const addBucketContribution = (bucket: GroupBucket) => {
    if (bucket.sourceSet.size <= 1) {
      return;
    }

    const sourceIds = bucket.orderedSourceIds.filter((sourceId) =>
      bucket.sourceSet.has(sourceId),
    );
    const primarySourceId = sourceIds[0] ?? "";
    if (!primarySourceId) {
      return;
    }

    nextDuplicateGroups += 1;
    for (const sourceId of sourceIds) {
      const duplicateSourceIds = sourceIds.filter((id) => id !== sourceId);
      const isPrimary = sourceId === primarySourceId;
      const itemIds = bucket.itemIdsBySource[sourceId] ?? [];
      if (itemIds.length === 0) {
        continue;
      }
      const sourceMeta = ensureSourceMetaMutable(sourceId);
      for (const itemId of itemIds) {
        sourceMeta[itemId] = {
          normalizedTitle: bucket.normalizedTitle,
          duplicateSourceIds,
          groupSize: sourceIds.length,
          primarySourceId,
          isPrimary,
        };
      }
      nextDuplicateItemsBySource[sourceId] =
        (nextDuplicateItemsBySource[sourceId] ?? 0) + itemIds.length;
      if (!isPrimary) {
        nextHiddenItemsBySource[sourceId] =
          (nextHiddenItemsBySource[sourceId] ?? 0) + itemIds.length;
      }
    }
  };

  for (const sourceId of changedSourceIds) {
    const previousEntries = previousCache.sourceEntriesBySource[sourceId] ?? {};
    const nextEntries = buildSourceTitleEntries(
      input.snapshots[sourceId]?.items ?? [],
    );

    nextSourceEntriesBySource[sourceId] = nextEntries;
    nextItemCountBySource[sourceId] = input.snapshots[sourceId]?.items.length ?? 0;
    affectedSourceIds.add(sourceId);

    const affectedTitles = new Set([
      ...Object.keys(previousEntries),
      ...Object.keys(nextEntries),
    ]);

    for (const normalizedTitle of affectedTitles) {
      const currentBucket = nextTitleBuckets.get(normalizedTitle);
      if (currentBucket) {
        for (const bucketSourceId of currentBucket.sourceSet) {
          affectedSourceIds.add(bucketSourceId);
        }
        const mutableBucket = ensureBucketMutable(normalizedTitle);
        if (mutableBucket) {
          removeBucketContribution(mutableBucket);
          delete mutableBucket.itemIdsBySource[sourceId];
          mutableBucket.sourceSet.delete(sourceId);
          mutableBucket.orderedSourceIds = input.sourceOrder.filter((candidate) =>
            mutableBucket.sourceSet.has(candidate),
          );

          if (mutableBucket.sourceSet.size === 0) {
            nextTitleBuckets.delete(normalizedTitle);
            mutatedTitles.delete(normalizedTitle);
          }
        }
      }

      const nextItemIds = nextEntries[normalizedTitle];
      if (nextItemIds && nextItemIds.length > 0) {
        let mutableBucket = ensureBucketMutable(normalizedTitle);
        if (!mutableBucket) {
          mutableBucket = {
            normalizedTitle,
            orderedSourceIds: [],
            sourceSet: new Set<string>(),
            itemIdsBySource: {},
          };
          nextTitleBuckets.set(normalizedTitle, mutableBucket);
          mutatedTitles.add(normalizedTitle);
        }

        mutableBucket.itemIdsBySource[sourceId] = [...nextItemIds];
        mutableBucket.sourceSet.add(sourceId);
        mutableBucket.orderedSourceIds = input.sourceOrder.filter((candidate) =>
          mutableBucket!.sourceSet.has(candidate),
        );
      }

      const nextBucket = nextTitleBuckets.get(normalizedTitle);
      if (nextBucket) {
        for (const bucketSourceId of nextBucket.sourceSet) {
          affectedSourceIds.add(bucketSourceId);
        }
        addBucketContribution(nextBucket);
      }
    }
  }

  for (const sourceId of affectedSourceIds) {
    nextVisibleItemsBySource[sourceId] = Math.max(
      0,
      (nextItemCountBySource[sourceId] ?? 0) -
        (nextHiddenItemsBySource[sourceId] ?? 0),
    );
    nextBySource[sourceId] ??= previousCache.bySource[sourceId] ?? {};
  }

  return {
    bySource: nextBySource,
    duplicateItemsBySource: nextDuplicateItemsBySource,
    visibleItemsBySource: nextVisibleItemsBySource,
    duplicateGroups: nextDuplicateGroups,
    sourceOrderKey,
    sourceHashes: nextSourceHashes,
    sourceEntriesBySource: nextSourceEntriesBySource,
    itemCountBySource: nextItemCountBySource,
    hiddenItemsBySource: nextHiddenItemsBySource,
    titleBuckets: nextTitleBuckets,
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
