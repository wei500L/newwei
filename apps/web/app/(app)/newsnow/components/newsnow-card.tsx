"use client";

import {
  DragOutlined,
  ReloadOutlined,
  StarFilled,
  StarOutlined,
} from "@ant-design/icons";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Skeleton, Tooltip, message } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "@/lib/api-error";
import { trackUserNewsBehavior } from "@/lib/user-news-behavior";

import {
  useNewsSource,
  useResolveNewsUrl,
  type NewsItem,
  type NewsResolveResponse,
  type Source,
} from "../hooks/use-news-sources";
import type { PersonalizedSourceScoreDetail } from "../hooks/use-newsnow-personalized-order";
import { useRelativeTime } from "../hooks/use-relative-time";
import type { CrossSourceItemMeta } from "../lib/newsnow-dnd";
import {
  formatShortDuration,
  resolveNewsFreshnessState,
} from "../lib/newsnow-freshness";
import {
  RESOLVE_PREFETCH_RETRY_INTERVAL_MS,
  buildResolvePrefetchAttemptState,
  shouldSkipResolvePrefetch,
  type ResolvePrefetchAttemptState,
} from "../lib/newsnow-resolve-prefetch";
import { useNewsnowStore } from "../store/newsnow-store";

import { NewsListHot } from "./news-list-hot";
import { NewsListTimeline } from "./news-list-timeline";

interface NewsnowCardProps {
  id: string;
  source: Source;
  dragDisabled?: boolean;
  mobileMode?: boolean;
  hideCrossSourceDuplicates?: boolean;
  crossSourceMetaByItemId?: Record<string, CrossSourceItemMeta>;
  duplicateItemsCount?: number;
  visibleItemsCount?: number;
  realtimeUnreadCount?: number;
  personalizedScoreDetail?: PersonalizedSourceScoreDetail;
}

const colorMap: Record<string, string> = {
  slate: "bg-slate-400",
  blue: "bg-blue-400",
  red: "bg-red-400",
  green: "bg-green-400",
  orange: "bg-orange-400",
  gray: "bg-zinc-400",
  indigo: "bg-indigo-400",
  emerald: "bg-emerald-400",
  teal: "bg-teal-400",
  yellow: "bg-amber-400",
};

const cardShellMap: Record<string, string> = {
  slate: "border-slate-300/30 bg-[#0f1520]",
  blue: "border-blue-300/28 bg-[#0b1424]",
  red: "border-red-300/28 bg-[#1a1018]",
  green: "border-green-300/28 bg-[#0d1a19]",
  orange: "border-orange-300/28 bg-[#1b1510]",
  gray: "border-zinc-300/28 bg-[#111824]",
  indigo: "border-indigo-300/28 bg-[#10152b]",
  emerald: "border-emerald-300/28 bg-[#0c1d19]",
  teal: "border-teal-300/28 bg-[#0b1c22]",
  yellow: "border-amber-300/28 bg-[#191810]",
};

const cardGlowMap: Record<string, string> = {
  slate: "shadow-[0_20px_44px_-34px_rgba(148,163,184,0.54)]",
  blue: "shadow-[0_20px_44px_-34px_rgba(59,130,246,0.56)]",
  red: "shadow-[0_20px_44px_-34px_rgba(244,63,94,0.54)]",
  green: "shadow-[0_20px_44px_-34px_rgba(16,185,129,0.54)]",
  orange: "shadow-[0_20px_44px_-34px_rgba(249,115,22,0.54)]",
  gray: "shadow-[0_20px_44px_-34px_rgba(161,161,170,0.5)]",
  indigo: "shadow-[0_20px_44px_-34px_rgba(99,102,241,0.56)]",
  emerald: "shadow-[0_20px_44px_-34px_rgba(16,185,129,0.56)]",
  teal: "shadow-[0_20px_44px_-34px_rgba(20,184,166,0.56)]",
  yellow: "shadow-[0_20px_44px_-34px_rgba(245,158,11,0.5)]",
};

const accentMap: Record<string, string> = {
  slate: "text-slate-300",
  blue: "text-blue-300",
  red: "text-red-300",
  green: "text-green-300",
  orange: "text-orange-300",
  gray: "text-gray-300",
  indigo: "text-indigo-300",
  emerald: "text-emerald-300",
  teal: "text-teal-300",
  yellow: "text-yellow-300",
};

const secretRequiredSourceIds = new Set(["weibo", "producthunt"]);
const VIEW_EXPOSURE_THRESHOLD = 0.35;
const VIEW_EXPOSURE_DWELL_MS = 1200;
const RESOLVE_PREFETCH_CONCURRENCY = 6;
const EMPTY_CROSS_SOURCE_META_BY_ITEM_ID: Record<string, CrossSourceItemMeta> = {};

function resolveSourceIconUrl(home?: string): string | null {
  if (!home) {
    return null;
  }
  try {
    const hostname = new URL(home).hostname;
    if (!hostname) {
      return null;
    }
    return `https://icons.duckduckgo.com/ip3/${hostname}.ico`;
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) {
    return [];
  }
  const safeConcurrency = Math.max(1, Math.min(concurrency, values.length));
  const results = new Array<R>(values.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: safeConcurrency }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) {
          return;
        }
        const value = values[index];
        if (value === undefined) {
          continue;
        }
        results[index] = await worker(value, index);
      }
    }),
  );
  return results;
}

function toItemKey(item: NewsItem): string {
  return String(item.id);
}

function areStringArraysEqual(current: string[], next: string[]): boolean {
  if (current.length !== next.length) {
    return false;
  }
  for (let idx = 0; idx < current.length; idx += 1) {
    if (current[idx] !== next[idx]) {
      return false;
    }
  }
  return true;
}

function areResolvedTargetsEqual(
  current: Record<string, { eventId?: string; itemId?: string }>,
  next: Record<string, { eventId?: string; itemId?: string }>,
): boolean {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (currentKeys.length !== nextKeys.length) {
    return false;
  }
  for (const key of currentKeys) {
    const currentTarget = current[key];
    const nextTarget = next[key];
    if (!currentTarget || !nextTarget) {
      return false;
    }
    if (
      (currentTarget.eventId ?? null) !== (nextTarget.eventId ?? null) ||
      (currentTarget.itemId ?? null) !== (nextTarget.itemId ?? null)
    ) {
      return false;
    }
  }
  return true;
}

export function NewsnowCard({
  id,
  source,
  dragDisabled = false,
  hideCrossSourceDuplicates = false,
  crossSourceMetaByItemId,
  duplicateItemsCount = 0,
  visibleItemsCount = 0,
  realtimeUnreadCount = 0,
  personalizedScoreDetail,
}: NewsnowCardProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { data, error, isLoading, isError, isFetching, refresh } = useNewsSource(
    id,
    source.interval,
  );
  const resolveNewsUrl = useResolveNewsUrl();
  const {
    focusSources,
    toggleFocus,
    trackSourceInteraction,
    upsertSourceSnapshot,
    removeSourceSnapshot,
    sortMode,
    densityMode,
    sourceAffinity,
    clearLiveUnread,
  } = useNewsnowStore();
  const { getRelativeTime } = useRelativeTime();
  const isFocused = focusSources.includes(id);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [iconLoadError, setIconLoadError] = useState(false);
  const [newItemIds, setNewItemIds] = useState<string[]>([]);
  const [animatedItemIds, setAnimatedItemIds] = useState<string[]>([]);
  const [resolvedTargetsByItemId, setResolvedTargetsByItemId] = useState<
    Record<string, { eventId?: string; itemId?: string }>
  >({});
  const [prefetchedEventIds, setPrefetchedEventIds] = useState<string[]>([]);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const previousIdsRef = useRef<string[]>([]);
  const openStartedAtRef = useRef<number | null>(null);
  const highlightTimersRef = useRef<Record<string, number>>({});
  const articleRef = useRef<HTMLElement | null>(null);
  const exposureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasTrackedExposureRef = useRef(false);
  const exposureKeyRef = useRef("");
  const lastResolvedPrefetchRef = useRef<ResolvePrefetchAttemptState | null>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: dragDisabled });
  const setArticleNodeRef = useCallback(
    (node: HTMLElement | null) => {
      articleRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  const colorClass = colorMap[source.color] || "bg-blue-400";
  const cardShellClass =
    cardShellMap[source.color] || "border-blue-300/28 bg-[#0b1424]";
  const cardGlowClass =
    cardGlowMap[source.color] ||
    "shadow-[0_20px_44px_-34px_rgba(59,130,246,0.54)]";
  const accentClass = accentMap[source.color] || "text-blue-300";
  const sourceBaseId = useMemo(() => id.split("-")[0] ?? id, [id]);
  const sourceBehaviorKey = useMemo(() => id.trim() || source.name, [id, source.name]);
  const iconUrl = useMemo(() => resolveSourceIconUrl(source.home), [source.home]);
  const needsRuntimeSecret = secretRequiredSourceIds.has(sourceBaseId);
  const sourceErrorMessage = useMemo(() => {
    if (!isError) {
      return null;
    }
    const parsed = extractApiError(error);
    return parsed.detail ? `${parsed.message} (${parsed.detail})` : parsed.message;
  }, [error, isError]);

  useEffect(() => {
    setIconLoadError(false);
  }, [iconUrl]);

  const dedupMetaMap =
    crossSourceMetaByItemId ?? EMPTY_CROSS_SOURCE_META_BY_ITEM_ID;
  const affinityScore = sourceAffinity[id]?.score ?? 0;
  const personalizedCombinedScore =
    personalizedScoreDetail && Number.isFinite(personalizedScoreDetail.combinedScore)
      ? personalizedScoreDetail.combinedScore
      : 0;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockMs(Date.now());
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const displayItems = useMemo(() => {
    const sourceItems = data?.items ?? [];
    if (!hideCrossSourceDuplicates) {
      return sourceItems;
    }
    return sourceItems.filter((item) => {
      const meta = dedupMetaMap[toItemKey(item)];
      return !meta || meta.isPrimary;
    });
  }, [data?.items, dedupMetaMap, hideCrossSourceDuplicates]);

  const hiddenDuplicatesCount = Math.max(
    0,
    (data?.items?.length ?? 0) - displayItems.length,
  );
  const exposurePrimaryItem = displayItems[0];
  const exposurePrimaryKey = exposurePrimaryItem
    ? `${toItemKey(exposurePrimaryItem)}::${exposurePrimaryItem.url}`
    : "";

  useEffect(() => {
    if (exposureKeyRef.current !== exposurePrimaryKey) {
      exposureKeyRef.current = exposurePrimaryKey;
      hasTrackedExposureRef.current = false;
    }
  }, [exposurePrimaryKey]);

  useEffect(() => {
    const node = articleRef.current;
    const firstItem = exposurePrimaryItem;
    if (!node || !firstItem) {
      return;
    }

    const emitView = () => {
      if (hasTrackedExposureRef.current) {
        return;
      }
      hasTrackedExposureRef.current = true;
      void trackUserNewsBehavior({
        type: "view",
        itemId: toItemKey(firstItem),
        source: sourceBehaviorKey,
        url: firstItem.url,
      });
    };

    const clearPendingTimer = () => {
      if (exposureTimerRef.current) {
        clearTimeout(exposureTimerRef.current);
        exposureTimerRef.current = null;
      }
    };

    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") {
      emitView();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }
        if (
          entry.isIntersecting &&
          entry.intersectionRatio >= VIEW_EXPOSURE_THRESHOLD
        ) {
          if (!exposureTimerRef.current && !hasTrackedExposureRef.current) {
            exposureTimerRef.current = setTimeout(() => {
              exposureTimerRef.current = null;
              emitView();
            }, VIEW_EXPOSURE_DWELL_MS);
          }
          return;
        }
        clearPendingTimer();
      },
      { threshold: [0, VIEW_EXPOSURE_THRESHOLD, 0.75] },
    );
    observer.observe(node);

    return () => {
      clearPendingTimer();
      observer.disconnect();
    };
  }, [exposurePrimaryItem, sourceBehaviorKey]);

  useEffect(() => {
    if (!data?.items) {
      return;
    }

    const snapshotItems = data.items.map((item) => ({
      id: String(item.id),
      title: item.title,
      pubDate: item.pubDate,
      url: item.url,
    }));

    upsertSourceSnapshot(id, {
      updatedAt: Date.now(),
      items: snapshotItems,
    });
  }, [data?.items, id, upsertSourceSnapshot]);

  useEffect(
    () => () => {
      removeSourceSnapshot(id);
    },
    [id, removeSourceSnapshot],
  );

  useEffect(() => {
    const currentIds = (data?.items ?? []).map(toItemKey);
    if (currentIds.length === 0) {
      previousIdsRef.current = [];
      return;
    }

    if (previousIdsRef.current.length > 0) {
      const previousSet = new Set(previousIdsRef.current);
      const added = currentIds.filter((itemId) => !previousSet.has(itemId));
      if (added.length > 0) {
        setNewItemIds((prev) => {
          const merged = Array.from(new Set([...added, ...prev]));
          return merged.slice(0, 80);
        });
        setAnimatedItemIds((prev) => {
          const merged = Array.from(new Set([...added, ...prev]));
          return merged.slice(0, 80);
        });
        added.forEach((itemId) => {
          const existingTimer = highlightTimersRef.current[itemId];
          if (existingTimer) {
            window.clearTimeout(existingTimer);
          }
          const timer = window.setTimeout(() => {
            setAnimatedItemIds((prev) => prev.filter((id) => id !== itemId));
            delete highlightTimersRef.current[itemId];
          }, 3_000);
          highlightTimersRef.current[itemId] = timer;
        });
      }
    }
    previousIdsRef.current = currentIds;
  }, [data?.items]);

  useEffect(
    () => () => {
      Object.values(highlightTimersRef.current).forEach((timer) => {
        window.clearTimeout(timer);
      });
      highlightTimersRef.current = {};
    },
    [],
  );

  useEffect(() => {
    const handleWindowFocus = () => {
      const startedAt = openStartedAtRef.current;
      if (startedAt === null) {
        return;
      }
      const dwellMs = Date.now() - startedAt;
      openStartedAtRef.current = null;
      trackSourceInteraction(id, "focus", { dwellMs });
    };

    window.addEventListener("focus", handleWindowFocus);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [id, trackSourceInteraction]);

  useEffect(() => {
    let cancelled = false;
    const abortController =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    const candidates = displayItems;
    const prefetchKey = candidates
      .map((item) => `${toItemKey(item)}::${item.url}`)
      .join("|");
    const nowMs = Date.now();
    const previousPrefetch = lastResolvedPrefetchRef.current;
    const shouldForceRefresh =
      previousPrefetch?.key === prefetchKey &&
      previousPrefetch.hasUnresolvedCandidates;
    if (
      shouldSkipResolvePrefetch({
        prefetchKey,
        previous: previousPrefetch,
        nowMs,
        retryIntervalMs: RESOLVE_PREFETCH_RETRY_INTERVAL_MS,
      })
    ) {
      return;
    }
    if (candidates.length === 0) {
      setResolvedTargetsByItemId((prev) =>
        Object.keys(prev).length === 0 ? prev : {},
      );
      setPrefetchedEventIds((prev) => (prev.length === 0 ? prev : []));
      lastResolvedPrefetchRef.current = buildResolvePrefetchAttemptState({
        prefetchKey,
        candidateCount: 0,
        matchedCount: 0,
        attemptedAtMs: nowMs,
      });
      return;
    }

    const prefetch = async () => {
      const settled = await mapWithConcurrency<NewsItem, NewsResolveResponse>(
        candidates,
        RESOLVE_PREFETCH_CONCURRENCY,
        async (item) => {
          try {
            return await resolveNewsUrl(item.url, {
              signal: abortController?.signal,
              ...(shouldForceRefresh ? { forceRefresh: true } : {}),
            });
          } catch {
            return { matched: false as const };
          }
        },
      );

      if (cancelled) {
        return;
      }
      const nextByItemId: Record<string, { eventId?: string; itemId?: string }> = {};
      let matchedCount = 0;
      settled.forEach((entry, idx) => {
        const item = candidates[idx];
        if (!item) {
          return;
        }
        if (!entry?.matched) {
          return;
        }
        matchedCount += 1;
        const itemKey = toItemKey(item);
        nextByItemId[itemKey] = {
          ...(entry.eventId ? { eventId: entry.eventId } : {}),
          ...(entry.itemId ? { itemId: entry.itemId } : {}),
        };
      });
      setResolvedTargetsByItemId((prev) =>
        areResolvedTargetsEqual(prev, nextByItemId) ? prev : nextByItemId,
      );

      const eventIds = Array.from(
        new Set(
          settled
            .map((entry) => entry.eventId)
            .filter((value): value is string => typeof value === "string" && value.length > 0),
        ),
      );
      setPrefetchedEventIds((prev) =>
        areStringArraysEqual(prev, eventIds) ? prev : eventIds,
      );
      lastResolvedPrefetchRef.current = buildResolvePrefetchAttemptState({
        prefetchKey,
        candidateCount: candidates.length,
        matchedCount,
      });
    };

    void prefetch();
    return () => {
      cancelled = true;
      abortController?.abort();
    };
  }, [displayItems, resolveNewsUrl]);

  const markItemSeen = useCallback((item: NewsItem) => {
    const itemId = toItemKey(item);
    setNewItemIds((prev) => {
      if (!prev.includes(itemId)) {
        return prev;
      }
      return prev.filter((id) => id !== itemId);
    });
    setAnimatedItemIds((prev) => {
      if (!prev.includes(itemId)) {
        return prev;
      }
      return prev.filter((id) => id !== itemId);
    });
    const timer = highlightTimersRef.current[itemId];
    if (timer) {
      window.clearTimeout(timer);
      delete highlightTimersRef.current[itemId];
    }
  }, []);

  const unreadCount = newItemIds.length;

  const handleOpenEventsHub = useCallback(() => {
    clearLiveUnread(id);
    if (prefetchedEventIds.length === 1) {
      router.push(`/events/${prefetchedEventIds[0]}`);
      return;
    }
    router.push("/events");
  }, [clearLiveUnread, id, prefetchedEventIds, router]);

  const trackOriginalOpen = useCallback((item: NewsItem) => {
    markItemSeen(item);
    clearLiveUnread(id);
    trackSourceInteraction(id, "open_original");
    void trackUserNewsBehavior({
      type: "click",
      source: sourceBehaviorKey,
      url: item.url,
    });
    openStartedAtRef.current = Date.now();
  }, [clearLiveUnread, id, markItemSeen, sourceBehaviorKey, trackSourceInteraction]);

  const openOriginal = useCallback((item: NewsItem) => {
    if (typeof window === "undefined") {
      return;
    }
    trackOriginalOpen(item);
    const href = item.mobileUrl || item.url;
    window.open(href, "_blank", "noopener,noreferrer");
  }, [trackOriginalOpen]);

  const handleOpenEvent = useCallback(
    async (item: NewsItem) => {
      markItemSeen(item);
      clearLiveUnread(id);
      const cached = resolvedTargetsByItemId[toItemKey(item)];
      if (cached?.eventId) {
        trackSourceInteraction(id, "open_event");
        void trackUserNewsBehavior({
          type: "open_event",
          source: sourceBehaviorKey,
          eventId: cached.eventId,
          url: item.url,
        });
        router.push(`/events/${cached.eventId}`);
        return;
      }
      try {
        const resolved = await resolveNewsUrl(item.url);
        if (resolved.matched && resolved.eventId) {
          trackSourceInteraction(id, "open_event");
          void trackUserNewsBehavior({
            type: "open_event",
            source: sourceBehaviorKey,
            eventId: resolved.eventId,
            itemId: resolved.itemId,
            url: item.url,
          });
          router.push(`/events/${resolved.eventId}`);
          return;
        }
        if (resolved.matched && resolved.itemId) {
          message.info("未匹配到事件，已打开深读");
          trackSourceInteraction(id, "open_item");
          void trackUserNewsBehavior({
            type: "open_item",
            source: sourceBehaviorKey,
            itemId: resolved.itemId,
            eventId: resolved.eventId,
            url: item.url,
          });
          router.push(`/items/${resolved.itemId}`);
          return;
        }
      } catch {
        message.warning("解析失败，已打开原文");
        openOriginal(item);
        return;
      }

      message.info("暂未匹配到事件，已打开原文");
      openOriginal(item);
    },
    [
      clearLiveUnread,
      id,
      markItemSeen,
      openOriginal,
      resolveNewsUrl,
      resolvedTargetsByItemId,
      router,
      sourceBehaviorKey,
      trackSourceInteraction,
    ],
  );

  const handleOpenItem = useCallback(
    async (item: NewsItem) => {
      markItemSeen(item);
      clearLiveUnread(id);
      const cached = resolvedTargetsByItemId[toItemKey(item)];
      if (cached?.itemId) {
        trackSourceInteraction(id, "open_item");
        void trackUserNewsBehavior({
          type: "open_item",
          source: sourceBehaviorKey,
          itemId: cached.itemId,
          eventId: cached.eventId,
          url: item.url,
        });
        router.push(`/items/${cached.itemId}`);
        return;
      }
      try {
        const resolved = await resolveNewsUrl(item.url);
        if (resolved.matched && resolved.itemId) {
          trackSourceInteraction(id, "open_item");
          void trackUserNewsBehavior({
            type: "open_item",
            source: sourceBehaviorKey,
            itemId: resolved.itemId,
            eventId: resolved.eventId,
            url: item.url,
          });
          router.push(`/items/${resolved.itemId}`);
          return;
        }
        if (resolved.matched && resolved.eventId) {
          message.info("未匹配到深读，已打开事件");
          trackSourceInteraction(id, "open_event");
          void trackUserNewsBehavior({
            type: "open_event",
            source: sourceBehaviorKey,
            eventId: resolved.eventId,
            itemId: resolved.itemId,
            url: item.url,
          });
          router.push(`/events/${resolved.eventId}`);
          return;
        }
      } catch {
        message.warning("解析失败，已打开原文");
        openOriginal(item);
        return;
      }

      message.info("暂未匹配到深读，已打开原文");
      openOriginal(item);
    },
    [
      clearLiveUnread,
      id,
      markItemSeen,
      openOriginal,
      resolveNewsUrl,
      resolvedTargetsByItemId,
      router,
      sourceBehaviorKey,
      trackSourceInteraction,
    ],
  );

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      clearLiveUnread(id);
      trackSourceInteraction(id, "refresh");
      await refresh();
    } catch {
      // Error is surfaced by React Query state.
    } finally {
      setIsRefreshing(false);
    }
  };

  const updatedText = data?.updatedTime
    ? `${getRelativeTime(data.updatedTime)}更新`
    : isError
      ? "获取失败"
      : "加载中...";
  const freshness = useMemo(
    () =>
      resolveNewsFreshnessState({
        updatedTime: data?.updatedTime,
        intervalMs: source.interval,
        nowMs: clockMs,
      }),
    [clockMs, data?.updatedTime, source.interval],
  );
  const freshnessDelayLabel =
    freshness.delayMs > 0 ? formatShortDuration(freshness.delayMs) : null;
  const nextRefreshLabel =
    source.interval && source.interval > 0
      ? formatShortDuration(freshness.nextRefreshInMs)
      : null;
  const actionAvailabilityByItemId = useMemo(() => {
    const map: Record<string, { hasEvent: boolean; hasItem: boolean }> = {};
    displayItems.forEach((item) => {
      const key = toItemKey(item);
      const resolved = resolvedTargetsByItemId[key];
      map[key] = {
        hasEvent: Boolean(resolved?.eventId),
        hasItem: Boolean(resolved?.itemId),
      };
    });
    return map;
  }, [displayItems, resolvedTargetsByItemId]);

  return (
    <article
      ref={setArticleNodeRef}
      style={{
        ...style,
        height: "clamp(380px, 56vh, 620px)",
      }}
      className={`flex min-h-[380px] flex-col overflow-hidden rounded-[24px] border ring-1 ring-inset ring-white/6 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-all duration-200 hover:-translate-y-1 hover:ring-white/14 ${cardShellClass} ${cardGlowClass}`}
    >
      <div className={`h-1 w-full ${colorClass}`} />
      <div className="pointer-events-none h-3 w-full bg-gradient-to-b from-white/8 to-transparent" />
      <div className="flex items-start justify-between px-4 pb-3 pt-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <a
            href={source.home}
            title={source.desc}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/20 bg-black/45 text-xs font-semibold text-zinc-200"
          >
            {iconLoadError || !iconUrl ? (
              <span>{source.name.slice(0, 1)}</span>
            ) : (
              <img
                src={iconUrl}
                alt={source.name}
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
                onError={() => setIconLoadError(true)}
              />
            )}
          </a>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate text-[15px] font-semibold tracking-[0.01em] text-zinc-100">
                {source.name}
              </h3>
              {source.title ? (
                <span className="truncate rounded bg-black/35 px-1.5 py-0.5 text-[10px] text-zinc-300/95">
                  {source.title}
                </span>
              ) : null}
            </div>
            <p className="truncate text-[11px] text-zinc-300/80">
              {updatedText}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {duplicateItemsCount > 0 ? (
                <span className="rounded bg-amber-400/18 px-1.5 py-0.5 text-[10px] text-amber-200">
                  同题 {duplicateItemsCount}
                </span>
              ) : null}
              {hideCrossSourceDuplicates && hiddenDuplicatesCount > 0 ? (
                <span className="rounded bg-emerald-400/18 px-1.5 py-0.5 text-[10px] text-emerald-200">
                  已折叠 {hiddenDuplicatesCount}
                </span>
              ) : null}
              {unreadCount > 0 ? (
                <span className="animate-pulse rounded bg-sky-400/18 px-1.5 py-0.5 text-[10px] text-sky-200">
                  新 {unreadCount}
                </span>
              ) : null}
              {realtimeUnreadCount > 0 ? (
                <span className="rounded bg-cyan-400/20 px-1.5 py-0.5 text-[10px] text-cyan-200">
                  推送 {realtimeUnreadCount}
                </span>
              ) : null}
              {(sortMode === "personalized" || sortMode === "smart") &&
              personalizedCombinedScore > 0 ? (
                <Tooltip
                  title={
                    <div className="space-y-0.5 text-[11px] leading-5">
                      <div>综合分 {personalizedScoreDetail?.combinedScore.toFixed(2)}</div>
                      <div>
                        偏好贡献 {personalizedScoreDetail?.affinityContribution.toFixed(2)}
                        {" = "}
                        {personalizedScoreDetail?.affinityScore.toFixed(2)} ×{" "}
                        {((personalizedScoreDetail?.affinityWeight ?? 0) * 100).toFixed(0)}%
                      </div>
                      <div>
                        行为贡献 {personalizedScoreDetail?.behaviorContribution.toFixed(2)}
                        {" = "}
                        {personalizedScoreDetail?.behaviorScore.toFixed(2)} ×{" "}
                        {((personalizedScoreDetail?.behaviorWeight ?? 0) * 100).toFixed(0)}%
                      </div>
                      <div>关注加分 {personalizedScoreDetail?.focusBonus.toFixed(2)}</div>
                    </div>
                  }
                >
                  <span className="cursor-help rounded bg-violet-400/20 px-1.5 py-0.5 text-[10px] text-violet-200">
                    综合 {Math.round(personalizedCombinedScore)}
                  </span>
                </Tooltip>
              ) : null}
              {(sortMode === "personalized" || sortMode === "smart") &&
              affinityScore > 0 ? (
                <span className="rounded bg-fuchsia-400/18 px-1.5 py-0.5 text-[10px] text-fuchsia-200">
                  偏好 {Math.round(affinityScore)}
                </span>
              ) : null}
              {hideCrossSourceDuplicates && visibleItemsCount > 0 ? (
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300">
                  可见 {visibleItemsCount}
                </span>
              ) : null}
              {nextRefreshLabel ? (
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-zinc-300">
                  下次刷新 {nextRefreshLabel}
                </span>
              ) : null}
              {freshness.level === "fresh" ? (
                <span className="rounded bg-emerald-400/18 px-1.5 py-0.5 text-[10px] text-emerald-200">
                  {t("common.freshnessFresh", { defaultValue: "Fresh" })}
                </span>
              ) : null}
              {freshness.level === "aging" ? (
                <span className="rounded bg-amber-400/18 px-1.5 py-0.5 text-[10px] text-amber-200">
                  {t("common.freshnessWarm", { defaultValue: "Warm" })} {freshnessDelayLabel}
                </span>
              ) : null}
              {freshness.level === "stale" ? (
                <span className="rounded bg-rose-400/20 px-1.5 py-0.5 text-[10px] text-rose-200">
                  {t("common.freshnessStale", { defaultValue: "Stale" })} {freshnessDelayLabel}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div
          className={`ml-3 inline-flex shrink-0 items-center gap-1 rounded-xl border border-white/12 bg-black/20 px-1 py-1 ${accentClass}`}
        >
          <Tooltip title="刷新">
            <Button
              type="text"
              size="small"
              loading={isFetching || isRefreshing}
              icon={<ReloadOutlined />}
              onClick={() => {
                void handleRefresh();
              }}
              className="h-7 w-7 text-zinc-300 hover:bg-white/10 hover:text-current"
            />
          </Tooltip>
          <Tooltip title={isFocused ? "取消关注" : "关注"}>
            <Button
              type="text"
              size="small"
              icon={
                isFocused ? (
                  <StarFilled className="text-yellow-500" />
                ) : (
                  <StarOutlined />
                )
              }
              onClick={() => toggleFocus(id)}
              className="h-7 w-7 text-zinc-300 hover:bg-white/10 hover:text-yellow-500"
            />
          </Tooltip>
          <Tooltip title="查看关联事件">
            <Button
              type="text"
              size="small"
              onClick={handleOpenEventsHub}
              className="h-7 px-2 text-zinc-300 hover:bg-white/10 hover:text-current"
            >
              事件
              {prefetchedEventIds.length > 0 ? ` ${prefetchedEventIds.length}` : ""}
            </Button>
          </Tooltip>
          <Tooltip title={dragDisabled ? "智能排序中已禁用拖动" : "拖动排序"}>
            <button
              type="button"
              {...(!dragDisabled ? attributes : {})}
              {...(!dragDisabled ? listeners : {})}
              aria-label="拖动重新排序"
              disabled={dragDisabled}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-300 transition-colors hover:bg-white/10 hover:text-zinc-100 ${
                dragDisabled
                  ? "cursor-not-allowed opacity-45"
                  : "cursor-grab active:cursor-grabbing"
              }`}
            >
              <DragOutlined />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="mx-3 mb-3 flex-1 overflow-y-auto rounded-2xl border border-white/8 bg-[linear-gradient(180deg,#090d14_0%,#070a11_100%)] px-2.5 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_12px_22px_-18px_rgba(0,0,0,0.9)] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {isLoading ? (
          <div className="space-y-3 p-3">
            <Skeleton active paragraph={{ rows: 8 }} />
          </div>
        ) : isError ? (
          <div className="flex h-full flex-col items-center justify-center space-y-2 p-4 text-center">
            <p className="text-sm text-zinc-300">获取失败</p>
            {sourceErrorMessage ? (
              <p className="max-w-[28rem] break-all text-[11px] text-zinc-400">
                {sourceErrorMessage}
              </p>
            ) : null}
            {needsRuntimeSecret ? (
              <a
                href="/settings/system?tab=newsSourceRuntimeSecrets"
                className="text-xs text-blue-300 underline-offset-2 hover:underline"
              >
                去系统设置 &gt; 新闻源密钥
              </a>
            ) : null}
            <Button
              size="small"
              onClick={() => {
                void handleRefresh();
              }}
            >
              重试
            </Button>
          </div>
        ) : displayItems.length > 0 ? (
          source.type === "hottest" ? (
            <NewsListHot
              items={displayItems}
              onOpenEvent={handleOpenEvent}
              onOpenItem={handleOpenItem}
              onOpenOriginal={trackOriginalOpen}
              freshItemIds={animatedItemIds}
              crossSourceMetaByItemId={dedupMetaMap}
              actionAvailabilityByItemId={actionAvailabilityByItemId}
              densityMode={densityMode}
            />
          ) : (
            <NewsListTimeline
              items={displayItems}
              onOpenEvent={handleOpenEvent}
              onOpenItem={handleOpenItem}
              onOpenOriginal={trackOriginalOpen}
              freshItemIds={animatedItemIds}
              crossSourceMetaByItemId={dedupMetaMap}
              actionAvailabilityByItemId={actionAvailabilityByItemId}
              densityMode={densityMode}
            />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-xs text-zinc-300">暂无数据</p>
            {needsRuntimeSecret ? (
              <a
                href="/settings/system?tab=newsSourceRuntimeSecrets"
                className="text-xs text-blue-300 underline-offset-2 hover:underline"
              >
                该源可能需要先配置密钥
              </a>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}
