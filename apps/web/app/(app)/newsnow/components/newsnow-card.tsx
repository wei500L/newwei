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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import { buildAdminSettingsHref } from "@/app/(app)/admin/settings/settings-navigation";
import {
  extractApiError,
  NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE,
} from "@/lib/api-error";
import {
  getPrimaryRuntimeSecretKey,
} from '@/lib/news-source-runtime-secrets';
import { shouldShowRuntimeSecretCta } from '@/lib/news-source-runtime-secrets-ui';
import { trackUserNewsBehavior } from "@/lib/user-news-behavior";

import {
  useNewsSource,
  useResolveNewsUrl,
  type NewsItem,
  type NewsnowAnalyzedItem,
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
import { resolveNewsSourceRefetchInterval } from "../lib/newsnow-fetching";
import { getNewsItemStableKey } from "../lib/newsnow-items";
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
  activeDragId?: string | null;
  hideCrossSourceDuplicates?: boolean;
  crossSourceMetaByItemId?: Record<string, CrossSourceItemMeta>;
  duplicateItemsCount?: number;
  visibleItemsCount?: number;
  realtimeUnreadCount?: number;
  personalizedScoreDetail?: PersonalizedSourceScoreDetail;
  analysisByItemId?: Record<string, NewsnowAnalyzedItem>;
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

const accentRgbMap: Record<string, string> = {
  slate: "148 163 184",
  blue: "96 165 250",
  red: "248 113 113",
  green: "52 211 153",
  orange: "251 146 60",
  gray: "161 161 170",
  indigo: "129 140 248",
  emerald: "52 211 153",
  teal: "45 212 191",
  yellow: "251 191 36",
};

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function NewsnowCard({
  id,
  source,
  dragDisabled = false,
  activeDragId = null,
  hideCrossSourceDuplicates = false,
  crossSourceMetaByItemId,
  duplicateItemsCount = 0,
  visibleItemsCount = 0,
  realtimeUnreadCount = 0,
  personalizedScoreDetail,
  analysisByItemId,
}: NewsnowCardProps) {
  const { t } = useTranslation();
  const router = useRouter();
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
    realtimeConnected,
    setSourceVisibility,
  } = useNewsnowStore();
  const isSourceVisible = useNewsnowStore((state) =>
    state.visibleSourceIds.includes(id),
  );
  const sourceRefetchInterval = useMemo(
    () =>
      resolveNewsSourceRefetchInterval({
        enabled: isSourceVisible,
        interval: source.interval,
        realtimeConnected,
      }),
    [isSourceVisible, realtimeConnected, source.interval],
  );
  const { data, error, isLoading, isError, isFetching, refresh } = useNewsSource(
    id,
    {
      enabled: isSourceVisible,
      interval: sourceRefetchInterval,
    },
  );
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
  const mouseMoveRafRef = useRef<number | null>(null);
  const pendingMousePosRef = useRef({ x: 0, y: 0 });

  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const handleMouseMove = (e: React.MouseEvent<HTMLElement>) => {
    if (isDragging || activeDragId) {
      return;
    }
    if (!articleRef.current) return;
    const rect = articleRef.current.getBoundingClientRect();
    pendingMousePosRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
    if (mouseMoveRafRef.current !== null) {
      return;
    }
    mouseMoveRafRef.current = window.requestAnimationFrame(() => {
      mouseMoveRafRef.current = null;
      setMousePos(pendingMousePosRef.current);
    });
  };

  useEffect(
    () => () => {
      if (mouseMoveRafRef.current !== null) {
        window.cancelAnimationFrame(mouseMoveRafRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const node = articleRef.current;
    if (!node) {
      return;
    }

    if (
      typeof window === "undefined" ||
      typeof IntersectionObserver === "undefined"
    ) {
      setSourceVisibility(id, true);
      return () => {
        setSourceVisibility(id, false);
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setSourceVisibility(id, Boolean(entry?.isIntersecting));
      },
      { threshold: [0, 0.01, VIEW_EXPOSURE_THRESHOLD] },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
      setSourceVisibility(id, false);
    };
  }, [id, setSourceVisibility]);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isSorting,
  } = useSortable({
    id,
    disabled: dragDisabled,
    transition: {
      duration: 260,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  });
  const setArticleNodeRef = useCallback(
    (node: HTMLElement | null) => {
      articleRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef],
  );

  const isAnyCardDragging = Boolean(activeDragId);
  const isAnotherCardDragging = Boolean(activeDragId && activeDragId !== id);
  const dragTiltDeg =
    isDragging && transform ? clamp(transform.x / 28, -3.2, 3.2) : 0;
  const baseTransform = CSS.Transform.toString(transform);
  const composedTransform = isDragging
    ? `${baseTransform ?? ""} rotate(${dragTiltDeg.toFixed(2)}deg) scale(1.01)`
    : baseTransform;

  const style: CSSProperties = {
    transform: composedTransform,
    transition:
      transition ??
      "transform 220ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease-out",
    zIndex: isDragging ? 80 : isSorting ? 20 : undefined,
    opacity: isDragging ? 0.98 : isAnotherCardDragging ? 0.9 : 1,
    boxShadow: isDragging
      ? "0 18px 36px -24px rgb(var(--newsnow-card-accent-rgb) / 0.58)"
      : undefined,
    pointerEvents: isDragging ? "none" : undefined,
  };

  const colorClass = colorMap[source.color] || "bg-[var(--primary)]";
  const accentRgb = accentRgbMap[source.color] || "111 155 255";
  const cardStyle: CSSProperties = {
    ...style,
    height: "clamp(380px, 56vh, 620px)",
    ["--newsnow-card-accent-rgb" as string]: accentRgb,
    ["contentVisibility" as string]: "auto",
    ["containIntrinsicSize" as string]: "440px",
    backfaceVisibility: "hidden",
  };
  
  // Aura color values based on source color, used for the hover glow
  const auraGlowColorMap: Record<string, string> = {
    slate: "rgba(148,163,184,0.15)",
    blue: "rgba(59,130,246,0.15)",
    red: "rgba(244,63,94,0.15)",
    green: "rgba(16,185,129,0.15)",
    orange: "rgba(249,115,22,0.15)",
    gray: "rgba(161,161,170,0.15)",
    indigo: "rgba(99,102,241,0.15)",
    emerald: "rgba(16,185,129,0.15)",
    teal: "rgba(20,184,166,0.15)",
    yellow: "rgba(245,158,11,0.15)",
  };
  const glowColor = auraGlowColorMap[source.color] || "rgba(59,130,246,0.15)";
  
  const sourceBehaviorKey = useMemo(() => id.trim() || source.name, [id, source.name]);
  const runtimeSecretsSettingsHref = useMemo(
    () =>
      buildAdminSettingsHref({
        page: "ingestion",
        panel: "news-source-runtime-secrets",
        query: { sourceId: id },
      }),
    [id],
  );
  const runtimeSecretPrimaryKey = useMemo(
    () => getPrimaryRuntimeSecretKey(source.runtimeSecrets),
    [source.runtimeSecrets],
  );
  const iconUrl = useMemo(() => resolveSourceIconUrl(source.home), [source.home]);
  const sourceError = useMemo(
    () => (isError ? extractApiError(error) : null),
    [error, isError],
  );
  const needsRuntimeSecret = useMemo(
    () => shouldShowRuntimeSecretCta(source, sourceError?.code),
    [source, sourceError?.code],
  );
  const isRuntimeSecretRequiredError =
    sourceError?.code === NEWS_SOURCE_RUNTIME_SECRET_REQUIRED_CODE;
  const sourceErrorMessage = useMemo(() => {
    if (!sourceError) {
      return null;
    }
    return sourceError.detail
      ? `${sourceError.message} (${sourceError.detail})`
      : sourceError.message;
  }, [sourceError]);
  const sourceErrorTitle = useMemo(
    () =>
      isRuntimeSecretRequiredError
        ? t('pages.newsnow.runtimeSecrets.requiredTitle', {
            defaultValue: 'Missing runtime secret',
          })
        : t('pages.newsnow.source.fetchFailed', {
            defaultValue: 'Failed to fetch source',
          }),
    [isRuntimeSecretRequiredError, t],
  );
  const runtimeSecretRequiredKeysLabel = useMemo(() => {
    if (!isRuntimeSecretRequiredError || !sourceError?.requiredKeys?.length) {
      return null;
    }
    return t('pages.newsnow.runtimeSecrets.requiredKeys', {
      defaultValue: 'Required keys: {{keys}}',
      keys: sourceError.requiredKeys.join(', '),
    });
  }, [isRuntimeSecretRequiredError, sourceError?.requiredKeys, t]);
  const runtimeSecretsLinkLabel = useMemo(() => {
    if (runtimeSecretPrimaryKey) {
      return t('pages.newsnow.runtimeSecrets.openSettingsWithKey', {
        defaultValue: 'Go to System Settings > News source secrets (Suggested: {{key}})',
        key: runtimeSecretPrimaryKey,
      });
    }
    return t('pages.newsnow.runtimeSecrets.openSettings', {
      defaultValue: 'Go to System Settings > News source secrets',
    });
  }, [runtimeSecretPrimaryKey, t]);
  const runtimeSecretsEmptyLabel = useMemo(() => {
    if (runtimeSecretPrimaryKey) {
      return t('pages.newsnow.runtimeSecrets.maybeRequiredWithKey', {
        defaultValue: 'This source may require a runtime secret first (Suggested: {{key}})',
        key: runtimeSecretPrimaryKey,
      });
    }
    return t('pages.newsnow.runtimeSecrets.maybeRequired', {
      defaultValue: 'This source may require a runtime secret first',
    });
  }, [runtimeSecretPrimaryKey, t]);

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
      const meta = dedupMetaMap[getNewsItemStableKey(item)];
      return !meta || meta.isPrimary;
    });
  }, [data?.items, dedupMetaMap, hideCrossSourceDuplicates]);

  const hiddenDuplicatesCount = Math.max(
    0,
    (data?.items?.length ?? 0) - displayItems.length,
  );
  const exposurePrimaryItem = displayItems[0];
  const exposurePrimaryKey = exposurePrimaryItem
    ? `${getNewsItemStableKey(exposurePrimaryItem)}::${exposurePrimaryItem.url}`
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
        itemId: getNewsItemStableKey(firstItem),
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
    const currentIds = (data?.items ?? []).map((item, index) =>
      getNewsItemStableKey(item, index),
    );
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
      .map((item) => `${getNewsItemStableKey(item)}::${item.url}`)
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
        const itemKey = getNewsItemStableKey(item);
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
    const itemId = getNewsItemStableKey(item);
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
  const isDormant =
    !isSourceVisible && !data && !isError && !isLoading && !isFetching;

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
      const cached = resolvedTargetsByItemId[getNewsItemStableKey(item)];
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
      const cached = resolvedTargetsByItemId[getNewsItemStableKey(item)];
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

  const handleRefresh = useCallback(async () => {
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
  }, [clearLiveUnread, id, refresh, trackSourceInteraction]);

  const updatedText = data?.updatedTime
    ? `${getRelativeTime(data.updatedTime)}更新`
    : isError
      ? "获取失败"
      : isDormant
        ? "进入视口时加载"
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
    sourceRefetchInterval &&
    typeof sourceRefetchInterval === "number" &&
    sourceRefetchInterval > 0
      ? formatShortDuration(freshness.nextRefreshInMs)
      : null;
  const actionAvailabilityByItemId = useMemo(() => {
    const map: Record<string, { hasEvent: boolean; hasItem: boolean }> = {};
    displayItems.forEach((item) => {
      const key = getNewsItemStableKey(item);
      const resolved = resolvedTargetsByItemId[key];
      map[key] = {
        hasEvent: Boolean(resolved?.eventId),
        hasItem: Boolean(resolved?.itemId),
      };
    });
    return map;
  }, [displayItems, resolvedTargetsByItemId]);
  const cardListContent = useMemo(() => {
    if (isDragging) {
      return (
        <div className="flex h-full items-center justify-center p-4 text-center">
          <span className="rounded-full border border-[var(--border)] bg-[var(--secondary)]/70 px-3 py-1 text-[11px] font-medium text-[var(--secondary-foreground)]">
            拖动中
          </span>
        </div>
      );
    }

    if (isLoading) {
      return (
        <div className="space-y-3 p-3 opacity-60">
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      );
    }

    if (isDormant) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-sm font-medium text-[var(--foreground)]">
            可见时自动加载
          </p>
          <p className="max-w-[18rem] text-xs text-[var(--secondary-foreground)]">
            只会预取首屏和当前进入视口的新闻源，减少后台与首屏请求放大。
          </p>
        </div>
      );
    }

    if (isError) {
      return (
        <div className="flex h-full flex-col items-center justify-center space-y-2 p-4 text-center">
          <p className="text-sm font-medium text-[var(--foreground)]">{sourceErrorTitle}</p>
          {sourceErrorMessage ? (
            <p className="max-w-[28rem] break-all text-[11px] text-[var(--secondary-foreground)]">
              {sourceErrorMessage}
            </p>
          ) : null}
          {runtimeSecretRequiredKeysLabel ? (
            <p className="max-w-[28rem] break-all text-[11px] text-[var(--secondary-foreground)]">
              {runtimeSecretRequiredKeysLabel}
            </p>
          ) : null}
          {needsRuntimeSecret ? (
            <a
              href={runtimeSecretsSettingsHref}
              className="text-xs text-[var(--primary)] underline-offset-2 hover:underline"
            >
              {runtimeSecretsLinkLabel}
            </a>
          ) : null}
          <Button
            size="small"
            className="mt-2"
            onClick={() => {
              void handleRefresh();
            }}
          >
            重试
          </Button>
        </div>
      );
    }

    if (displayItems.length > 0) {
      return source.type === "hottest" ? (
        <NewsListHot
          items={displayItems}
          onOpenEvent={handleOpenEvent}
          onOpenItem={handleOpenItem}
          onOpenOriginal={trackOriginalOpen}
          freshItemIds={animatedItemIds}
          crossSourceMetaByItemId={dedupMetaMap}
          actionAvailabilityByItemId={actionAvailabilityByItemId}
          analysisByItemId={analysisByItemId}
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
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-xs font-medium text-[var(--secondary-foreground)]">暂无数据</p>
        {needsRuntimeSecret ? (
          <a
            href={runtimeSecretsSettingsHref}
            className="text-xs text-[var(--primary)] underline-offset-2 hover:underline"
          >
            {runtimeSecretsEmptyLabel}
          </a>
        ) : null}
      </div>
    );
  }, [
    actionAvailabilityByItemId,
    analysisByItemId,
    animatedItemIds,
    dedupMetaMap,
    densityMode,
    displayItems,
    handleOpenEvent,
    handleOpenItem,
    handleRefresh,
    isDragging,
    isDormant,
    isError,
    isLoading,
    needsRuntimeSecret,
    runtimeSecretsEmptyLabel,
    runtimeSecretsLinkLabel,
    runtimeSecretsSettingsHref,
    runtimeSecretRequiredKeysLabel,
    source.type,
    sourceErrorMessage,
    sourceErrorTitle,
    trackOriginalOpen,
  ]);

  return (
    <article
      ref={setArticleNodeRef}
      onMouseMove={isAnyCardDragging ? undefined : handleMouseMove}
      style={cardStyle}
      className={`relative isolate group flex min-h-[380px] flex-col overflow-hidden rounded-[var(--radius-lg)] glass-panel will-change-transform transition-[transform,box-shadow,opacity] duration-300 motion-reduce:transition-none active:scale-[0.99] ${
        dragDisabled || isAnyCardDragging ? "" : "hover:-translate-y-1"
      } ${isDragging ? "cursor-grabbing" : ""}`}
    >
      {/* Hover Glow Effect */}
      <div
        className={`pointer-events-none absolute inset-0 transition-opacity duration-500 ${
          isAnyCardDragging ? "opacity-0" : "opacity-0 group-hover:opacity-100"
        }`}
        style={{
          background: `radial-gradient(600px circle at ${mousePos.x}px ${mousePos.y}px, ${glowColor}, transparent 40%)`,
          zIndex: 0,
        }}
      />
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 h-1.5 ${colorClass} ${
          isDragging ? "opacity-100" : "opacity-80"
        }`}
        style={{
          clipPath: "inset(0 round var(--radius-lg) var(--radius-lg) 0 0)",
          zIndex: 2,
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-[inherit] border border-transparent"
        style={{
          borderTopColor: "rgb(var(--newsnow-card-accent-rgb) / 0.55)",
          zIndex: 2,
        }}
      />
      
      <div className="relative z-10 flex items-start justify-between px-5 pb-3 pt-4">
        <div className="flex min-w-0 items-center gap-3">
          <a
            href={source.home}
            title={source.desc}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[14px] bg-secondary border border-[var(--border)] text-xs font-semibold text-[var(--foreground)] shadow-sm transition-transform hover:scale-105"
          >
            {iconLoadError || !iconUrl ? (
              <span className="font-serif text-lg">{source.name.slice(0, 1)}</span>
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
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-bold tracking-wide text-[var(--foreground)] font-serif">
                {source.name}
              </h3>
              {source.title ? (
                <span className="truncate rounded-md bg-[var(--secondary)] px-2 py-0.5 text-[10px] font-medium text-[var(--secondary-foreground)] border border-[var(--border)]">
                  {source.title}
                </span>
              ) : null}
            </div>
            <p className="truncate text-[11px] text-[var(--secondary-foreground)]/80 mt-0.5 font-medium">
              {updatedText}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {duplicateItemsCount > 0 ? (
                <span className="rounded-full bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                  同题 {duplicateItemsCount}
                </span>
              ) : null}
              {hideCrossSourceDuplicates && hiddenDuplicatesCount > 0 ? (
                <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                  已折叠 {hiddenDuplicatesCount}
                </span>
              ) : null}
              {unreadCount > 0 ? (
                <span className="animate-pulse rounded-full bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
                  新 {unreadCount}
                </span>
              ) : null}
              {realtimeUnreadCount > 0 ? (
                <span className="rounded-full bg-[var(--primary)]/10 border border-[var(--primary)]/20 px-2 py-0.5 text-[10px] font-semibold text-[var(--primary)]">
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
                  <span className="cursor-help rounded-full bg-violet-500/10 border border-violet-500/20 px-2 py-0.5 text-[10px] font-semibold text-violet-600 dark:text-violet-400">
                    综合 {Math.round(personalizedCombinedScore)}
                  </span>
                </Tooltip>
              ) : null}
              {(sortMode === "personalized" || sortMode === "smart") &&
              affinityScore > 0 ? (
                <span className="rounded-full bg-fuchsia-500/10 border border-fuchsia-500/20 px-2 py-0.5 text-[10px] font-semibold text-fuchsia-600 dark:text-fuchsia-400">
                  偏好 {Math.round(affinityScore)}
                </span>
              ) : null}
              {hideCrossSourceDuplicates && visibleItemsCount > 0 ? (
                <span className="rounded-full bg-[var(--secondary)] border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold text-[var(--secondary-foreground)]">
                  可见 {visibleItemsCount}
                </span>
              ) : null}
              {nextRefreshLabel ? (
                <span className="rounded-full bg-[var(--secondary)] border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold text-[var(--secondary-foreground)]">
                  下次刷新 {nextRefreshLabel}
                </span>
              ) : null}
              {data?.updatedTime && freshness.level === "fresh" ? (
                <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                  {t("common.freshnessFresh", { defaultValue: "Fresh" })}
                </span>
              ) : null}
              {data?.updatedTime && freshness.level === "aging" ? (
                <span className="rounded-full bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                  {t("common.freshnessWarm", { defaultValue: "Warm" })} {freshnessDelayLabel}
                </span>
              ) : null}
              {data?.updatedTime && freshness.level === "stale" ? (
                <span className="rounded-full bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                  {t("common.freshnessStale", { defaultValue: "Stale" })} {freshnessDelayLabel}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div
          className="ml-3 inline-flex shrink-0 items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--secondary)]/50 backdrop-blur-md px-1 py-1 shadow-sm"
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
              className="h-7 w-7 text-[var(--secondary-foreground)] hover:bg-[var(--background)] hover:text-[var(--foreground)]"
            />
          </Tooltip>
          <Tooltip title={isFocused ? "取消关注" : "关注"}>
            <Button
              type="text"
              size="small"
              icon={
                isFocused ? (
                  <StarFilled className="text-amber-500" />
                ) : (
                  <StarOutlined />
                )
              }
              onClick={() => toggleFocus(id)}
              className="h-7 w-7 text-[var(--secondary-foreground)] hover:bg-[var(--background)] hover:text-amber-500"
            />
          </Tooltip>
          <Tooltip title="查看关联事件">
            <Button
              type="text"
              size="small"
              onClick={handleOpenEventsHub}
              className="h-7 px-2 text-[var(--secondary-foreground)] font-medium hover:bg-[var(--background)] hover:text-[var(--foreground)]"
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
              aria-pressed={isDragging}
              disabled={dragDisabled}
              className={`relative inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--background)] hover:text-[var(--foreground)] ${
                dragDisabled
                  ? "cursor-not-allowed opacity-45"
                  : isDragging
                    ? "cursor-grabbing bg-[var(--background)] text-[var(--foreground)] shadow-sm"
                    : isAnyCardDragging
                      ? "cursor-grab text-[var(--foreground)]/85"
                  : "cursor-grab active:cursor-grabbing"
              }`}
            >
              <span
                className={`pointer-events-none absolute inset-0 rounded-lg transition-opacity duration-150 ${
                  isDragging ? "opacity-100" : "opacity-0"
                }`}
                style={{
                  backgroundColor: "rgb(var(--newsnow-card-accent-rgb) / 0.16)",
                }}
              />
              <span className="relative z-10">
                <DragOutlined />
              </span>
            </button>
          </Tooltip>
        </div>
      </div>

      <div
        className={`relative z-10 mx-3 mb-3 flex-1 overflow-y-auto rounded-[calc(var(--radius-lg)-2px)] border border-[var(--border)] px-2.5 py-2.5 shadow-inner [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden ${
          isDragging
            ? "bg-white/25 dark:bg-black/20 backdrop-blur-0"
            : "bg-white/40 dark:bg-black/20 backdrop-blur-sm"
        }`}
      >
        {cardListContent}
      </div>
    </article>
  );
}
