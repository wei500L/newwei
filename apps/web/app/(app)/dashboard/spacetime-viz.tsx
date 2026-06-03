"use client";

import { gql, useApolloClient, useQuery } from "@apollo/client";
import {
  Button,
  Card,
  Drawer,
  Empty,
  InputNumber,
  List,
  Segmented,
  Select,
  Skeleton,
  Slider,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import dynamic from "next/dynamic";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { usePendingAction } from "@/hooks/use-pending-action";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import {
  formatGranularityLabel,
  inferGranularityFromTimestampsMs,
} from "@/lib/time-granularity";
import { safeHttpUrl } from "@/lib/url";

import type { DashboardStreamState } from "./use-dashboard-stream";

type NewsEventSourceType =
  | "all"
  | "authoritative"
  | "mixed"
  | "blog"
  | "unknown";
type NewsEventSortBy = "latest" | "heat" | "credibility";
type TimelineGranularityFilter = "auto" | "day" | "week" | "month";
type NewsEventSourceFilterType = "all" | "authoritative" | "mixed" | "blog";

interface SourceEvidence {
  uniqueSourceCount: number;
  authoritativeSourceCount: number;
  blogSourceCount: number;
  corroborated: boolean;
}

interface NewsEventListItem {
  id: string;
  title?: string | null;
  primaryTopic?: string | null;
  primaryEntity?: string | null;
  lastAt: string;
  itemCount: number;
  heatScore: number;
  credibilityScore: number;
  sourceType: NewsEventSourceType;
  sourceEvidence: SourceEvidence;
  breaking: boolean;
}

interface TimelineEntry {
  id: string;
  bucketStart: string;
  title?: string | null;
  summary?: string | null;
  keyPoints?: unknown;
  referencedArticleIds?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface TimelineNode extends TimelineEntry {
  aggregatedCount: number;
  sourceEntryIds: string[];
}

interface EventItem {
  id: string;
  eventId: string;
  processedArticleId: string;
  processedItemId?: string | null;
  createdAt: string;
  processedArticle: {
    id: string;
    articleId: string;
    title?: string | null;
    publishedAt?: string | null;
    processedAt: string;
    article: {
      id: string;
      url: string;
      sourceLabel?: string | null;
      crawlAt: string;
    };
  };
}

interface NewsEventDetails {
  id: string;
  title?: string | null;
  primaryTopic?: string | null;
  primaryEntity?: string | null;
  startAt: string;
  lastAt: string;
  itemCount: number;
  heatScore: number;
  credibilityScore: number;
  sourceType: NewsEventSourceType;
  sourceEvidence: SourceEvidence;
  timeline?: TimelineEntry[];
  items?: EventItem[];
}

interface ReferencedArticleView {
  id: string;
  title?: string | null;
  url?: string | null;
  sourceLabel?: string | null;
  publishedAt?: string | null;
  crawlAt?: string | null;
  processedAt: string;
}

interface SpacetimeTimelineUiSettings {
  authoritativeLock: boolean;
  requireCorroborated: boolean;
  sourceType: NewsEventSourceFilterType;
  sortBy: NewsEventSortBy;
  minHeatScore: number;
  minCredibilityScore: number;
  timelineGranularity: TimelineGranularityFilter;
  speed: number;
  syncStatusAutoRefresh: boolean;
}

interface SpacetimeTimelineUiSettingsResponse {
  version: number;
  updatedAt: {
    settings?: string;
  };
  settings: SpacetimeTimelineUiSettings | null;
}

interface NewsEventSourcePolicySyncStatus {
  degraded: boolean;
  policyCacheStale: boolean;
  presetCacheStale: boolean;
  forceAuthoritativeMode: boolean;
  forceMinAuthoritativeSources: number;
  warningCodes: string[];
}

const SpacetimeGeoHeatmap = dynamic(
  () =>
    import("./charts/spacetime-geo-heatmap").then(
      (mod) => mod.SpacetimeGeoHeatmap,
    ),
  {
    ssr: false,
    loading: () => <Skeleton active paragraph={{ rows: 8 }} />,
  },
);

const SpacetimePropagation = dynamic(
  () =>
    import("./charts/spacetime-propagation").then(
      (mod) => mod.SpacetimePropagation,
    ),
  {
    loading: () => <Skeleton active paragraph={{ rows: 6 }} />,
  },
);

const KnowledgeGraph3D = dynamic(
  () =>
    import("./charts/knowledge-graph-3d").then((mod) => mod.KnowledgeGraph3D),
  {
    ssr: false,
    loading: () => <Skeleton active paragraph={{ rows: 6 }} />,
  },
);

const NEWS_EVENTS_QUERY = gql`
  query SpacetimeNewsEvents(
    $limit: Int
    $windowDays: Int
    $status: NewsEventStatus
    $sourceType: NewsEventSourceType
    $minHeatScore: Float
    $minCredibilityScore: Float
    $minAuthoritativeSources: Int
    $sortBy: NewsEventSortBy
    $dedupeSimilar: Boolean
  ) {
    newsEvents(
      limit: $limit
      windowDays: $windowDays
      status: $status
      sourceType: $sourceType
      minHeatScore: $minHeatScore
      minCredibilityScore: $minCredibilityScore
      minAuthoritativeSources: $minAuthoritativeSources
      sortBy: $sortBy
      dedupeSimilar: $dedupeSimilar
    ) {
      id
      title
      primaryTopic
      primaryEntity
      lastAt
      itemCount
      breaking
      heatScore
      credibilityScore
      sourceType
      sourceEvidence {
        uniqueSourceCount
        authoritativeSourceCount
        blogSourceCount
        corroborated
      }
    }
  }
`;

const NEWS_EVENT_QUERY = gql`
  query SpacetimeNewsEvent(
    $id: String!
    $timelineLimit: Int
    $itemsLimit: Int
  ) {
    newsEvent(id: $id, timelineLimit: $timelineLimit, itemsLimit: $itemsLimit) {
      id
      title
      primaryTopic
      primaryEntity
      startAt
      lastAt
      itemCount
      heatScore
      credibilityScore
      sourceType
      sourceEvidence {
        uniqueSourceCount
        authoritativeSourceCount
        blogSourceCount
        corroborated
      }
      timeline {
        id
        eventId
        bucketStart
        title
        summary
        keyPoints
        referencedArticleIds
        createdAt
        updatedAt
      }
      items {
        id
        eventId
        processedArticleId
        processedItemId
        createdAt
        processedArticle {
          id
          articleId
          title
          publishedAt
          processedAt
          article {
            id
            url
            sourceLabel
            crawlAt
          }
        }
      }
    }
  }
`;

interface DeferredChartMountProps {
  className?: string;
  minHeight?: number | string;
  children: React.ReactNode;
}

function DeferredChartMount({
  className,
  minHeight,
  children,
}: DeferredChartMountProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className={className} style={{ minHeight }}>
      {visible ? children : <Skeleton active paragraph={{ rows: 6 }} />}
    </div>
  );
}

const NEWS_EVENT_REFERENCED_ARTICLES_QUERY = gql`
  query SpacetimeNewsEventReferencedArticles(
    $eventId: String!
    $articleIds: [String!]!
    $limit: Int
  ) {
    newsEventReferencedArticles(
      eventId: $eventId
      articleIds: $articleIds
      limit: $limit
    ) {
      id
      url
      sourceLabel
      title
      crawlAt
      publishedAt
      processedAt
      processedArticleId
    }
  }
`;

const SOURCE_POLICY_SYNC_STATUS_QUERY = gql`
  query SpacetimeSourcePolicySyncStatus {
    newsEventSourcePolicySyncStatus {
      degraded
      policyCacheStale
      presetCacheStale
      forceAuthoritativeMode
      forceMinAuthoritativeSources
      warningCodes
    }
  }
`;

const EVENT_LIST_WINDOW_DAYS = 30;
const REFERENCED_ARTICLES_QUERY_CHUNK_SIZE = 180;
const TIMELINE_SPEED_MIN = 0.25;
const TIMELINE_SPEED_MAX = 16;
const TIMELINE_SETTINGS_SAVE_DEBOUNCE_MS = 650;
const SYNC_STATUS_POLL_INTERVAL_MS = 60_000;

const resolveEventTitle = (event: {
  id: string;
  title?: string | null;
  primaryTopic?: string | null;
  primaryEntity?: string | null;
}) => {
  const title = event.title?.trim() ?? "";
  if (title) return title;
  const entity = event.primaryEntity?.trim() ?? "";
  if (entity) return entity;
  const topic = event.primaryTopic?.trim() ?? "";
  if (topic) return topic;
  return event.id;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const chunkStringArray = (value: string[], size: number): string[][] => {
  if (size <= 0 || value.length === 0) {
    return [];
  }
  const chunks: string[][] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
};

const normalizeWarningCodes = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const deduped = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }
  return Array.from(deduped).slice(0, 32);
};

const clampInt = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(value)));
const clampFloat = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const normalizeSourceFilterType = (
  value: unknown,
): NewsEventSourceFilterType => {
  if (
    value === "all" ||
    value === "authoritative" ||
    value === "mixed" ||
    value === "blog"
  ) {
    return value;
  }
  return "authoritative";
};

const normalizeSortBy = (value: unknown): NewsEventSortBy => {
  if (value === "latest" || value === "heat" || value === "credibility") {
    return value;
  }
  return "heat";
};

const normalizeTimelineGranularity = (
  value: unknown,
): TimelineGranularityFilter => {
  if (
    value === "auto" ||
    value === "day" ||
    value === "week" ||
    value === "month"
  ) {
    return value;
  }
  return "auto";
};

const resolveSourceKey = (sourceLabel: unknown, url: unknown): string => {
  const label = typeof sourceLabel === "string" ? sourceLabel.trim() : "";
  if (label) {
    return label.slice(0, 120);
  }
  const rawUrl = typeof url === "string" ? url.trim() : "";
  if (rawUrl) {
    try {
      const host = new URL(rawUrl).hostname.trim();
      if (host) {
        return host.slice(0, 120);
      }
    } catch {
      // Ignore invalid URLs.
    }
  }
  return "unknown";
};

const toGranularityBucketIso = (
  bucketStart: string,
  granularity: TimelineGranularityFilter,
): string => {
  const parsed = dayjs(bucketStart);
  if (!parsed.isValid()) {
    return bucketStart;
  }
  if (granularity === "day") {
    return parsed.startOf("day").toISOString();
  }
  if (granularity === "week") {
    return parsed.startOf("week").toISOString();
  }
  if (granularity === "month") {
    return parsed.startOf("month").toISOString();
  }
  return parsed.toISOString();
};

const buildTimelineNodes = (
  entries: TimelineEntry[],
  granularity: TimelineGranularityFilter,
): TimelineNode[] => {
  const sorted = [...entries].sort(
    (a, b) => dayjs(a.bucketStart).valueOf() - dayjs(b.bucketStart).valueOf(),
  );
  if (granularity === "auto") {
    return sorted.map((entry) => ({
      ...entry,
      aggregatedCount: 1,
      sourceEntryIds: [entry.id],
    }));
  }

  const bucketMap = new Map<string, TimelineEntry[]>();
  for (const entry of sorted) {
    const bucketIso = toGranularityBucketIso(entry.bucketStart, granularity);
    const existing = bucketMap.get(bucketIso);
    if (existing) {
      existing.push(entry);
    } else {
      bucketMap.set(bucketIso, [entry]);
    }
  }

  const aggregated = Array.from(bucketMap.entries()).map(
    ([bucketStart, bucketEntries]) => {
      const descending = bucketEntries
        .slice()
        .sort(
          (a, b) =>
            dayjs(b.bucketStart).valueOf() - dayjs(a.bucketStart).valueOf(),
        );
      const primary = descending[0]!;
      const keyPoints = Array.from(
        new Set(
          bucketEntries.flatMap((entry) =>
            normalizeStringArray(entry.keyPoints),
          ),
        ),
      ).slice(0, 20);
      const referencedArticleIds = Array.from(
        new Set(
          bucketEntries.flatMap((entry) =>
            normalizeStringArray(entry.referencedArticleIds),
          ),
        ),
      ).slice(0, 160);

      return {
        id: `agg:${granularity}:${bucketStart}`,
        bucketStart,
        title: primary.title,
        summary: primary.summary,
        keyPoints,
        referencedArticleIds,
        createdAt: primary.createdAt,
        updatedAt: primary.updatedAt,
        aggregatedCount: bucketEntries.length,
        sourceEntryIds: bucketEntries.map((entry) => entry.id),
      } satisfies TimelineNode;
    },
  );

  return aggregated.sort(
    (a, b) => dayjs(a.bucketStart).valueOf() - dayjs(b.bucketStart).valueOf(),
  );
};

export interface SpacetimeVizProps {
  streamState?: DashboardStreamState;
}

export function SpacetimeViz({ streamState }: SpacetimeVizProps) {
  const apolloClient = useApolloClient();
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session, status: sessionStatus } = useSession();
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const settingsHydratedRef = useRef(false);
  const settingsSnapshotRef = useRef<string | null>(null);

  const sourceTypeLabel = useCallback(
    (sourceType: NewsEventSourceType) => {
      if (sourceType === "authoritative") {
        return t("dashboard.charts.spacetimeTimeline.sourceTypeAuthoritative");
      }
      if (sourceType === "mixed") {
        return t("dashboard.charts.spacetimeTimeline.sourceTypeMixed");
      }
      if (sourceType === "blog") {
        return t("dashboard.charts.spacetimeTimeline.sourceTypeBlog");
      }
      if (sourceType === "all") {
        return t("dashboard.charts.spacetimeTimeline.sourceTypeAll");
      }
      return t("dashboard.charts.spacetimeTimeline.sourceTypeUnknown");
    },
    [t],
  );

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [geoScope, setGeoScope] = useState<"global" | "event">("global");
  const [geoFollowCursor, setGeoFollowCursor] = useState(false);

  const [authoritativeLock, setAuthoritativeLock] = useState(true);
  const [requireCorroborated, setRequireCorroborated] = useState(true);
  const [eventSourceType, setEventSourceType] =
    useState<NewsEventSourceFilterType>("authoritative");
  const [sortBy, setSortBy] = useState<NewsEventSortBy>("heat");
  const [minHeatScore, setMinHeatScore] = useState(0.7);
  const [minCredibilityScore, setMinCredibilityScore] = useState(48);
  const [timelineGranularity, setTimelineGranularity] =
    useState<TimelineGranularityFilter>("auto");
  const [syncStatusAutoRefresh, setSyncStatusAutoRefresh] = useState(true);
  const [syncStatusLastRefreshedAt, setSyncStatusLastRefreshedAt] = useState<
    string | null
  >(null);

  const [timelineDrawerOpen, setTimelineDrawerOpen] = useState(false);
  const [timelineDrawerEntryId, setTimelineDrawerEntryId] = useState<
    string | null
  >(null);
  const {
    data: sourcePolicySyncData,
    loading: sourcePolicySyncLoading,
    refetch: refetchSourcePolicySyncStatus,
  } = useQuery<{
    newsEventSourcePolicySyncStatus: NewsEventSourcePolicySyncStatus;
  }>(SOURCE_POLICY_SYNC_STATUS_QUERY, {
    fetchPolicy: "cache-and-network",
    errorPolicy: "all",
    pollInterval: syncStatusAutoRefresh ? SYNC_STATUS_POLL_INTERVAL_MS : 0,
  });
  const sourcePolicySyncStatus =
    sourcePolicySyncData?.newsEventSourcePolicySyncStatus ?? null;
  const orgForceAuthoritativeMode = Boolean(
    sourcePolicySyncStatus?.forceAuthoritativeMode,
  );
  const orgForceMinAuthoritativeSources = clampInt(
    sourcePolicySyncStatus?.forceMinAuthoritativeSources ?? 1,
    1,
    10,
  );
  const orgRequiresCorroborated =
    orgForceAuthoritativeMode && orgForceMinAuthoritativeSources >= 2;
  const effectiveAuthoritativeLock =
    authoritativeLock || orgForceAuthoritativeMode;
  const effectiveRequireCorroborated =
    requireCorroborated || orgRequiresCorroborated;
  const effectiveEventSourceType: NewsEventSourceFilterType =
    effectiveAuthoritativeLock ? "authoritative" : eventSourceType;
  const minAuthoritativeSources = effectiveAuthoritativeLock
    ? Math.max(
        effectiveRequireCorroborated ? 2 : 1,
        orgForceAuthoritativeMode ? orgForceMinAuthoritativeSources : 1,
      )
    : undefined;

  const timelineSettingsSnapshot = useMemo(
    () =>
      JSON.stringify({
        authoritativeLock,
        requireCorroborated,
        sourceType: eventSourceType,
        sortBy,
        minHeatScore: Number(minHeatScore.toFixed(2)),
        minCredibilityScore: Number(minCredibilityScore.toFixed(2)),
        timelineGranularity,
        speed: Number(speed.toFixed(2)),
        syncStatusAutoRefresh,
      }),
    [
      authoritativeLock,
      requireCorroborated,
      eventSourceType,
      minCredibilityScore,
      minHeatScore,
      sortBy,
      speed,
      syncStatusAutoRefresh,
      timelineGranularity,
    ],
  );

  useEffect(() => {
    if (sessionStatus !== "authenticated" || settingsHydratedRef.current) {
      return;
    }
    settingsHydratedRef.current = true;

    let cancelled = false;
    void apiClient
      .get<SpacetimeTimelineUiSettingsResponse>(
        "user-settings/ui/spacetime-timeline",
      )
      .then(({ data }) => {
        if (cancelled) {
          return;
        }
        const settings = data?.settings;
        if (!settings) {
          settingsSnapshotRef.current = timelineSettingsSnapshot;
          return;
        }

        const nextAuthoritativeLock = Boolean(settings.authoritativeLock);
        const nextRequireCorroborated =
          typeof settings.requireCorroborated === "boolean"
            ? settings.requireCorroborated
            : true;
        const nextSourceType = normalizeSourceFilterType(settings.sourceType);
        const nextSortBy = normalizeSortBy(settings.sortBy);
        const nextHeat = clampFloat(
          typeof settings.minHeatScore === "number"
            ? settings.minHeatScore
            : 0.7,
          0,
          12,
        );
        const nextCredibility = clampFloat(
          typeof settings.minCredibilityScore === "number"
            ? settings.minCredibilityScore
            : 48,
          0,
          100,
        );
        const nextGranularity = normalizeTimelineGranularity(
          settings.timelineGranularity,
        );
        const nextSpeed = clampFloat(
          typeof settings.speed === "number" ? settings.speed : 2,
          TIMELINE_SPEED_MIN,
          TIMELINE_SPEED_MAX,
        );
        const nextSyncStatusAutoRefresh =
          typeof settings.syncStatusAutoRefresh === "boolean"
            ? settings.syncStatusAutoRefresh
            : true;

        setAuthoritativeLock(nextAuthoritativeLock);
        setRequireCorroborated(nextRequireCorroborated);
        setEventSourceType(nextSourceType);
        setSortBy(nextSortBy);
        setMinHeatScore(nextHeat);
        setMinCredibilityScore(nextCredibility);
        setTimelineGranularity(nextGranularity);
        setSpeed(nextSpeed);
        setSyncStatusAutoRefresh(nextSyncStatusAutoRefresh);

        settingsSnapshotRef.current = JSON.stringify({
          authoritativeLock: nextAuthoritativeLock,
          requireCorroborated: nextRequireCorroborated,
          sourceType: nextSourceType,
          sortBy: nextSortBy,
          minHeatScore: Number(nextHeat.toFixed(2)),
          minCredibilityScore: Number(nextCredibility.toFixed(2)),
          timelineGranularity: nextGranularity,
          speed: Number(nextSpeed.toFixed(2)),
          syncStatusAutoRefresh: nextSyncStatusAutoRefresh,
        });
      })
      .catch((error: unknown) => {
        settingsSnapshotRef.current = timelineSettingsSnapshot;
        captureClientError(
          "Failed to load spacetime timeline UI settings",
          error,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [apiClient, sessionStatus, timelineSettingsSnapshot]);

  useEffect(() => {
    if (sessionStatus !== "authenticated" || !settingsHydratedRef.current) {
      return;
    }
    if (settingsSnapshotRef.current === null) {
      return;
    }
    if (settingsSnapshotRef.current === timelineSettingsSnapshot) {
      return;
    }

    const timer = window.setTimeout(() => {
      void apiClient
        .put("user-settings/ui/spacetime-timeline", {
          settings: JSON.parse(
            timelineSettingsSnapshot,
          ) as SpacetimeTimelineUiSettings,
        })
        .then(() => {
          settingsSnapshotRef.current = timelineSettingsSnapshot;
        })
        .catch((error: unknown) => {
          captureClientError(
            "Failed to persist spacetime timeline UI settings",
            error,
          );
        });
    }, TIMELINE_SETTINGS_SAVE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [apiClient, sessionStatus, timelineSettingsSnapshot]);

  const { data: eventsData, loading: eventsLoading } = useQuery<{
    newsEvents: NewsEventListItem[];
  }>(NEWS_EVENTS_QUERY, {
    variables: {
      limit: 24,
      windowDays: EVENT_LIST_WINDOW_DAYS,
      status: "active",
      sourceType: effectiveEventSourceType,
      minHeatScore,
      minCredibilityScore,
      minAuthoritativeSources,
      sortBy,
      dedupeSimilar: true,
    },
    fetchPolicy: "cache-and-network",
  });

  const handleAuthoritativeLockChange = useCallback((checked: boolean) => {
    setAuthoritativeLock(checked);
  }, []);

  const handleRefreshSyncStatus = useCallback(() => {
    void refetchSourcePolicySyncStatus().catch((error: unknown) => {
      captureClientError("Failed to refresh source policy sync status", error);
    });
  }, [refetchSourcePolicySyncStatus]);

  useEffect(() => {
    if (!sourcePolicySyncLoading && sourcePolicySyncStatus) {
      setSyncStatusLastRefreshedAt(new Date().toISOString());
    }
  }, [sourcePolicySyncLoading, sourcePolicySyncStatus]);

  const events = useMemo(() => eventsData?.newsEvents ?? [], [eventsData?.newsEvents]);

  useEffect(() => {
    if (events.length === 0) {
      setSelectedEventId(null);
      return;
    }
    if (
      !selectedEventId ||
      !events.some((event) => event.id === selectedEventId)
    ) {
      setSelectedEventId(events[0]!.id);
    }
  }, [events, selectedEventId]);

  const {
    data: eventData,
    loading: eventLoading,
    error: eventError,
    refetch: refetchEvent,
  } = useQuery<{ newsEvent: NewsEventDetails | null }>(NEWS_EVENT_QUERY, {
    variables: { id: selectedEventId, timelineLimit: 220, itemsLimit: 260 },
    skip: !selectedEventId,
    fetchPolicy: "network-only",
  });
  const { pending: refreshingEvent, run: refreshEvent } = usePendingAction(
    () => refetchEvent(),
  );

  const event = eventData?.newsEvent ?? null;

  const items = useMemo(() => {
    const rows = event?.items ?? [];
    return [...rows].sort(
      (a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf(),
    );
  }, [event?.items]);

  const articleById = useMemo(() => {
    const map = new Map<string, ReferencedArticleView>();
    for (const item of items) {
      const article = item.processedArticle.article;
      const articleId = article?.id;
      if (!articleId || map.has(articleId)) {
        continue;
      }
      map.set(articleId, {
        id: articleId,
        title: item.processedArticle.title,
        url: article.url,
        sourceLabel: article.sourceLabel ?? null,
        publishedAt: item.processedArticle.publishedAt ?? null,
        crawlAt: article.crawlAt ?? null,
        processedAt: item.processedArticle.processedAt,
      });
    }
    return map;
  }, [items]);

  const timeline = useMemo(
    () => buildTimelineNodes(event?.timeline ?? [], timelineGranularity),
    [event?.timeline, timelineGranularity],
  );

  useEffect(() => {
    setCursorIndex(0);
    setPlaying(false);
    setTimelineDrawerOpen(false);
    setTimelineDrawerEntryId(null);
  }, [selectedEventId, timelineGranularity]);

  useEffect(() => {
    if (geoScope === "global") {
      setGeoFollowCursor(false);
    }
  }, [geoScope]);

  useEffect(() => {
    if (!playing) return;
    if (timeline.length <= 1) return;
    const intervalMs = clampInt(
      1400 / Math.max(TIMELINE_SPEED_MIN, speed),
      120,
      5000,
    );
    const timer = setInterval(() => {
      setCursorIndex((prev) => (prev + 1 < timeline.length ? prev + 1 : 0));
    }, intervalMs);
    return () => clearInterval(timer);
  }, [playing, speed, timeline.length]);

  const cursorEntry = timeline[cursorIndex] ?? null;
  const cursorNext = timeline[cursorIndex + 1] ?? null;
  const cursorStartIso = cursorEntry?.bucketStart ?? null;
  const cursorEndIso = cursorNext?.bucketStart ?? event?.lastAt ?? null;

  const cursorGranularity = useMemo(() => {
    const startMs = cursorStartIso
      ? dayjs(cursorStartIso).valueOf()
      : Number.NaN;
    const endMs = cursorEndIso ? dayjs(cursorEndIso).valueOf() : Number.NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return null;
    }
    return inferGranularityFromTimestampsMs([startMs, endMs]);
  }, [cursorEndIso, cursorStartIso]);

  const cursorGranularityLabel = cursorGranularity
    ? formatGranularityLabel(cursorGranularity)
    : null;

  const keyPoints = useMemo(
    () => normalizeStringArray(cursorEntry?.keyPoints),
    [cursorEntry?.keyPoints],
  );

  const cursorLinkedSources = useMemo(() => {
    const set = new Set<string>();
    for (const articleId of normalizeStringArray(
      cursorEntry?.referencedArticleIds,
    )) {
      const article = articleById.get(articleId);
      if (!article) {
        continue;
      }
      const sourceKey = resolveSourceKey(article.sourceLabel, article.url);
      if (sourceKey && sourceKey !== "unknown") {
        set.add(sourceKey);
      }
    }
    return Array.from(set);
  }, [articleById, cursorEntry?.referencedArticleIds]);

  const selectedTimelineEntry = useMemo(() => {
    if (!timelineDrawerEntryId) {
      return null;
    }
    return timeline.find((entry) => entry.id === timelineDrawerEntryId) ?? null;
  }, [timeline, timelineDrawerEntryId]);

  const selectedTimelineArticleIds = useMemo(
    () => normalizeStringArray(selectedTimelineEntry?.referencedArticleIds),
    [selectedTimelineEntry?.referencedArticleIds],
  );

  const unresolvedTimelineArticleIds = useMemo(
    () => {
      const unresolved: string[] = [];
      const seen = new Set<string>();
      for (const articleId of selectedTimelineArticleIds) {
        if (articleById.has(articleId) || seen.has(articleId)) {
          continue;
        }
        seen.add(articleId);
        unresolved.push(articleId);
      }
      return unresolved;
    },
    [articleById, selectedTimelineArticleIds],
  );

  const [referencedArticles, setReferencedArticles] = useState<
    ReferencedArticleView[]
  >([]);
  const [referencedArticlesLoading, setReferencedArticlesLoading] =
    useState(false);

  useEffect(() => {
    if (
      !timelineDrawerOpen ||
      !event?.id ||
      unresolvedTimelineArticleIds.length === 0
    ) {
      setReferencedArticles([]);
      setReferencedArticlesLoading(false);
      return;
    }

    let cancelled = false;
    setReferencedArticles([]);
    setReferencedArticlesLoading(true);

    const articleIdChunks = chunkStringArray(
      unresolvedTimelineArticleIds,
      REFERENCED_ARTICLES_QUERY_CHUNK_SIZE,
    );

    void Promise.allSettled(
      articleIdChunks.map((articleIds) =>
        apolloClient.query<{
          newsEventReferencedArticles: Pick<
            ReferencedArticleView,
            | "id"
            | "url"
            | "sourceLabel"
            | "title"
            | "publishedAt"
            | "crawlAt"
            | "processedAt"
          >[];
        }>({
          query: NEWS_EVENT_REFERENCED_ARTICLES_QUERY,
          variables: {
            eventId: event.id,
            articleIds,
            limit: REFERENCED_ARTICLES_QUERY_CHUNK_SIZE,
          },
          fetchPolicy: "network-only",
        }),
      ),
    )
      .then((results) => {
        if (cancelled) {
          return;
        }
        const merged = new Map<string, ReferencedArticleView>();
        let rejectedCount = 0;
        for (const result of results) {
          if (result.status !== "fulfilled") {
            rejectedCount += 1;
            continue;
          }
          for (const entry of result.value.data?.newsEventReferencedArticles ?? []) {
            if (!entry?.id || merged.has(entry.id)) {
              continue;
            }
            merged.set(entry.id, {
              id: entry.id,
              title: entry.title ?? null,
              url: entry.url ?? null,
              sourceLabel: entry.sourceLabel ?? null,
              publishedAt: entry.publishedAt ?? null,
              crawlAt: entry.crawlAt ?? null,
              processedAt: entry.processedAt,
            });
          }
        }
        setReferencedArticles(Array.from(merged.values()));
        if (rejectedCount > 0) {
          captureClientError(
            "Failed to load some spacetime referenced articles",
            new Error(
              `Referenced article chunks failed: ${rejectedCount}/${results.length}`,
            ),
          );
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setReferencedArticles([]);
        captureClientError("Failed to load spacetime referenced articles", error);
      })
      .finally(() => {
        if (!cancelled) {
          setReferencedArticlesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    apolloClient,
    event?.id,
    timelineDrawerOpen,
    unresolvedTimelineArticleIds,
  ]);

  const timelineEntryReferences = useMemo(() => {
    const articleIds = selectedTimelineArticleIds;
    const fetchedById = new Map(
      referencedArticles.map((entry) => [entry.id, entry] as const),
    );
    const resolved: ReferencedArticleView[] = [];
    const unresolved: string[] = [];

    for (const articleId of articleIds) {
      const article = articleById.get(articleId) ?? fetchedById.get(articleId);
      if (!article) {
        unresolved.push(articleId);
        continue;
      }
      resolved.push(article);
    }

    resolved.sort((a, b) => {
      const aTs = dayjs(a.publishedAt ?? a.crawlAt ?? a.processedAt).valueOf();
      const bTs = dayjs(b.publishedAt ?? b.crawlAt ?? b.processedAt).valueOf();
      return bTs - aTs;
    });

    return {
      resolved,
      unresolved,
    };
  }, [
    articleById,
    referencedArticles,
    selectedTimelineArticleIds,
  ]);

  const eventOptions = useMemo(
    () =>
      events.map((evt) => ({
        value: evt.id,
        label: `${resolveEventTitle(evt)} (${evt.itemCount}) · H${evt.heatScore.toFixed(2)} · C${evt.credibilityScore.toFixed(
          0,
        )} · A${evt.sourceEvidence?.authoritativeSourceCount ?? 0}/U${evt.sourceEvidence?.uniqueSourceCount ?? 0}`,
      })),
    [events],
  );

  const sourceTypeOptions = useMemo(
    () => [
      {
        value: "authoritative" as const,
        label: t("dashboard.charts.spacetimeTimeline.sourceTypeAuthoritative"),
      },
      {
        value: "mixed" as const,
        label: t("dashboard.charts.spacetimeTimeline.sourceTypeMixed"),
      },
      {
        value: "blog" as const,
        label: t("dashboard.charts.spacetimeTimeline.sourceTypeBlog"),
      },
      {
        value: "all" as const,
        label: t("dashboard.charts.spacetimeTimeline.sourceTypeAll"),
      },
    ],
    [t],
  );

  const sortOptions = useMemo(
    () => [
      {
        value: "heat" as const,
        label: t("dashboard.charts.spacetimeTimeline.sortByHeat"),
      },
      {
        value: "credibility" as const,
        label: t("dashboard.charts.spacetimeTimeline.sortByCredibility"),
      },
      {
        value: "latest" as const,
        label: t("dashboard.charts.spacetimeTimeline.sortByLatest"),
      },
    ],
    [t],
  );

  const timelineDegraded = Boolean(sourcePolicySyncStatus?.degraded);
  const degradedWarningCodes = normalizeWarningCodes(
    sourcePolicySyncStatus?.warningCodes,
  );
  const timelineDegradedCritical = degradedWarningCodes.some((code) =>
    code.endsWith("_DB_READ_FAILED"),
  );
  const degradedReasonText = useMemo(() => {
    const reasons = degradedWarningCodes.map((code) => {
      if (code === "POLICY_CACHE_STALE") {
        return t(
          "dashboard.charts.spacetimeTimeline.degradedReasonPolicyCacheStale",
        );
      }
      if (code === "PRESET_CACHE_STALE") {
        return t(
          "dashboard.charts.spacetimeTimeline.degradedReasonPresetCacheStale",
        );
      }
      if (code === "POLICY_CACHE_READ_FAILED") {
        return t(
          "dashboard.charts.spacetimeTimeline.degradedReasonPolicyCacheReadFailed",
        );
      }
      if (code === "PRESET_CACHE_READ_FAILED") {
        return t(
          "dashboard.charts.spacetimeTimeline.degradedReasonPresetCacheReadFailed",
        );
      }
      if (code === "POLICY_DB_READ_FAILED") {
        return t(
          "dashboard.charts.spacetimeTimeline.degradedReasonPolicyDbReadFailed",
        );
      }
      if (code === "PRESET_DB_READ_FAILED") {
        return t(
          "dashboard.charts.spacetimeTimeline.degradedReasonPresetDbReadFailed",
        );
      }
      if (code === "POLICY_CACHE_MISS") {
        return t(
          "dashboard.charts.spacetimeTimeline.degradedReasonPolicyCacheMiss",
        );
      }
      if (code === "PRESET_CACHE_MISS") {
        return t(
          "dashboard.charts.spacetimeTimeline.degradedReasonPresetCacheMiss",
        );
      }
      return t("dashboard.charts.spacetimeTimeline.degradedReasonUnknown", {
        code,
      });
    });
    return reasons.join(" | ");
  }, [degradedWarningCodes, t]);

  const granularityOptions = useMemo(
    () => [
      {
        value: "auto" as const,
        label: t("dashboard.charts.spacetimeTimeline.granularityAuto"),
      },
      {
        value: "day" as const,
        label: t("dashboard.charts.spacetimeTimeline.granularityDay"),
      },
      {
        value: "week" as const,
        label: t("dashboard.charts.spacetimeTimeline.granularityWeek"),
      },
      {
        value: "month" as const,
        label: t("dashboard.charts.spacetimeTimeline.granularityMonth"),
      },
    ],
    [t],
  );

  const speedPresetValues = useMemo(() => [0.5, 1, 2, 4, 8, 12], []);

  const suggestedSeed = useMemo(() => {
    const entity = event?.primaryEntity?.trim() ?? "";
    if (entity) return entity;
    const topic = event?.primaryTopic?.trim() ?? "";
    if (topic) return topic;
    const title = event?.title?.trim() ?? "";
    return title;
  }, [event?.primaryEntity, event?.primaryTopic, event?.title]);

  const jumpCursor = useCallback(
    (delta: number) => {
      if (timeline.length === 0) return;
      setCursorIndex((prev) => clampInt(prev + delta, 0, timeline.length - 1));
    },
    [timeline.length],
  );

  const openTimelineDetails = useCallback(() => {
    if (!cursorEntry) {
      return;
    }
    setPlaying(false);
    setTimelineDrawerEntryId(cursorEntry.id);
    setTimelineDrawerOpen(true);
  }, [cursorEntry]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2">
          <Card
            title={t("dashboard.charts.spacetimeGeoHeatmap.title")}
            className="glass-card sm-panel-card h-[520px]"
            variant="borderless"
          >
            <div className="flex flex-col gap-2 h-full">
              <Space wrap size="small" align="center">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t("dashboard.charts.spacetimeGeoHeatmap.scope")}
                </Typography.Text>
                <Segmented
                  size="small"
                  value={geoScope}
                  options={[
                    {
                      label: t(
                        "dashboard.charts.spacetimeGeoHeatmap.scopeGlobal",
                      ),
                      value: "global",
                    },
                    {
                      label: t(
                        "dashboard.charts.spacetimeGeoHeatmap.scopeEvent",
                      ),
                      value: "event",
                    },
                  ]}
                  onChange={(value) => setGeoScope(value as "global" | "event")}
                />
                <Switch
                  size="small"
                  checked={geoFollowCursor}
                  onChange={setGeoFollowCursor}
                  disabled={
                    geoScope !== "event" ||
                    timeline.length === 0 ||
                    !cursorStartIso
                  }
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t("dashboard.charts.spacetimeGeoHeatmap.followTimeline")}
                </Typography.Text>
              </Space>

              <div className="flex-1 min-h-0">
                <DeferredChartMount className="h-full" minHeight={420}>
                  <SpacetimeGeoHeatmap
                    eventId={geoScope === "event" ? selectedEventId : null}
                    followCursor={geoScope === "event" && geoFollowCursor}
                    cursorBucketStartIso={
                      geoScope === "event" ? cursorStartIso : null
                    }
                    cursorBucketEndIso={
                      geoScope === "event" ? cursorEndIso : null
                    }
                    cursorBucketGranularity={
                      geoScope === "event" ? timelineGranularity : null
                    }
                    liveStreamActive={streamState?.status === "live"}
                  />
                </DeferredChartMount>
              </div>
            </div>
          </Card>
        </div>

        <div className="xl:col-span-1">
          <Card
            title={t("dashboard.charts.spacetimeTimeline.title")}
            extra={
              timelineDegraded ? (
                <Tooltip
                  title={t(
                    "dashboard.charts.spacetimeTimeline.degradedTooltip",
                    {
                      reasons:
                        degradedReasonText ||
                        t(
                          "dashboard.charts.spacetimeTimeline.degradedReasonUnknownShort",
                        ),
                    },
                  )}
                >
                  <Tag
                    color={timelineDegradedCritical ? "error" : "warning"}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {t("dashboard.charts.spacetimeTimeline.degradedBadge")}
                  </Tag>
                </Tooltip>
              ) : null
            }
            className="glass-card sm-panel-card h-[520px]"
            variant="borderless"
          >
            <div className="h-full flex flex-col gap-3">
              <Space direction="vertical" size={6}>
                <Space wrap size="small" align="center">
                  <Typography.Text type="secondary">
                    {t("dashboard.charts.spacetimeTimeline.event")}
                  </Typography.Text>
                  <Select
                    value={selectedEventId ?? undefined}
                    options={eventOptions}
                    loading={eventsLoading}
                    onChange={(value) => setSelectedEventId(value)}
                    style={{ minWidth: 280 }}
                    placeholder={t(
                      "dashboard.charts.spacetimeTimeline.eventPlaceholder",
                    )}
                  />
                </Space>

                <Space wrap size="small" align="center">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("dashboard.charts.spacetimeTimeline.sourceType")}
                  </Typography.Text>
                  <Select
                    size="small"
                    style={{ width: 140 }}
                    value={effectiveEventSourceType}
                    options={sourceTypeOptions}
                    disabled={effectiveAuthoritativeLock}
                    onChange={(value) =>
                      setEventSourceType(value as NewsEventSourceFilterType)
                    }
                  />
                  <Switch
                    size="small"
                    checked={effectiveAuthoritativeLock}
                    onChange={handleAuthoritativeLockChange}
                    disabled={orgForceAuthoritativeMode}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("dashboard.charts.spacetimeTimeline.lockAuthoritative")}
                  </Typography.Text>
                  {orgForceAuthoritativeMode ? (
                    <Tooltip
                      title={t(
                        "dashboard.charts.spacetimeTimeline.orgEnforcedTooltip",
                        {
                          count: orgForceMinAuthoritativeSources,
                        },
                      )}
                    >
                      <Tag color="gold">
                        {t(
                          "dashboard.charts.spacetimeTimeline.orgEnforcedTag",
                        )}
                      </Tag>
                    </Tooltip>
                  ) : null}
                  <Switch
                    size="small"
                    checked={effectiveRequireCorroborated}
                    onChange={setRequireCorroborated}
                    disabled={
                      !effectiveAuthoritativeLock || orgForceAuthoritativeMode
                    }
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t(
                      "dashboard.charts.spacetimeTimeline.requireCorroborated",
                    )}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("dashboard.charts.spacetimeTimeline.sortBy")}
                  </Typography.Text>
                  <Select
                    size="small"
                    style={{ width: 136 }}
                    value={sortBy}
                    options={sortOptions}
                    onChange={(value) => setSortBy(value as NewsEventSortBy)}
                  />
                </Space>

                <Space wrap size="small" align="center">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("dashboard.charts.spacetimeTimeline.minHeat")}
                  </Typography.Text>
                  <InputNumber
                    size="small"
                    min={0}
                    max={12}
                    step={0.1}
                    precision={1}
                    value={minHeatScore}
                    onChange={(value) =>
                      setMinHeatScore(
                        clampFloat(
                          typeof value === "number" ? value : 0,
                          0,
                          12,
                        ),
                      )
                    }
                    style={{ width: 92 }}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("dashboard.charts.spacetimeTimeline.minCredibility")}
                  </Typography.Text>
                  <InputNumber
                    size="small"
                    min={0}
                    max={100}
                    step={1}
                    precision={0}
                    value={minCredibilityScore}
                    onChange={(value) =>
                      setMinCredibilityScore(
                        clampFloat(
                          typeof value === "number" ? value : 0,
                          0,
                          100,
                        ),
                      )
                    }
                    style={{ width: 92 }}
                  />
                </Space>

                <Space wrap size="small" align="center">
                  <Switch
                    size="small"
                    checked={syncStatusAutoRefresh}
                    onChange={setSyncStatusAutoRefresh}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t(
                      "dashboard.charts.spacetimeTimeline.syncStatusAutoRefresh",
                      {
                        seconds: Math.round(
                          SYNC_STATUS_POLL_INTERVAL_MS / 1000,
                        ),
                      },
                    )}
                  </Typography.Text>
                  <Button
                    size="small"
                    onClick={handleRefreshSyncStatus}
                    loading={sourcePolicySyncLoading}
                  >
                    {t("dashboard.charts.spacetimeTimeline.refreshStatus")}
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {syncStatusLastRefreshedAt
                      ? t(
                          "dashboard.charts.spacetimeTimeline.lastRefreshAt",
                          {
                            time:
                              formatDateTime(
                                syncStatusLastRefreshedAt,
                                locale,
                                {
                                  year: "2-digit",
                                  month: "2-digit",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  timeZoneName: "short",
                                },
                              ) || "--",
                          },
                        )
                      : t(
                          "dashboard.charts.spacetimeTimeline.lastRefreshNever",
                        )}
                  </Typography.Text>
                </Space>

                <Space wrap size="small" align="center">
                  <Tag color={playing ? "green" : "default"}>
                    {playing
                      ? t("dashboard.charts.spacetimeTimeline.playing")
                      : t("dashboard.charts.spacetimeTimeline.paused")}
                  </Tag>
                  {event ? (
                    <Tag
                      color={
                        event.sourceType === "authoritative"
                          ? "blue"
                          : "default"
                      }
                    >
                      {sourceTypeLabel(event.sourceType)}
                    </Tag>
                  ) : null}
                  {event ? (
                    <Tag
                      color={
                        event.sourceEvidence?.corroborated ? "cyan" : "default"
                      }
                    >
                      {event.sourceEvidence?.corroborated
                        ? t(
                            "dashboard.charts.spacetimeTimeline.corroboratedTag",
                          )
                        : t(
                            "dashboard.charts.spacetimeTimeline.uncorroboratedTag",
                          )}
                    </Tag>
                  ) : null}
                  {effectiveAuthoritativeLock ? (
                    <Tag color="geekblue">
                      {t(
                        "dashboard.charts.spacetimeTimeline.authorityThreshold",
                        {
                          count: minAuthoritativeSources ?? 1,
                        },
                      )}
                    </Tag>
                  ) : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {event
                      ? resolveEventTitle(event)
                      : t("common.emptyValue")}
                  </Typography.Text>
                  {event ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t(
                        "dashboard.charts.spacetimeTimeline.sourceEvidenceSummary",
                        {
                          authoritative:
                            event.sourceEvidence?.authoritativeSourceCount ?? 0,
                          unique: event.sourceEvidence?.uniqueSourceCount ?? 0,
                          blog: event.sourceEvidence?.blogSourceCount ?? 0,
                        },
                      )}
                    </Typography.Text>
                  ) : null}
                </Space>
              </Space>

              {eventLoading ? (
                <Skeleton active paragraph={{ rows: 7 }} />
              ) : eventError ? (
                <div className="flex flex-col gap-2">
                  <Typography.Text type="danger">
                    {t("dashboard.dataAbnormal")}
                  </Typography.Text>
                  <Button
                    loading={refreshingEvent}
                    disabled={refreshingEvent}
                    onClick={() => {
                      void refreshEvent();
                    }}
                  >
                    {t("dashboard.actions.retryFetch")}
                  </Button>
                </div>
              ) : !event ? (
                <ChartEmptyState
                  title={t("dashboard.charts.spacetimeTimeline.emptyTitle")}
                  description={t(
                    "dashboard.charts.spacetimeTimeline.emptyDescription",
                  )}
                />
              ) : timeline.length === 0 ? (
                <ChartEmptyState
                  title={t(
                    "dashboard.charts.spacetimeTimeline.noTimelineTitle",
                  )}
                  description={t(
                    "dashboard.charts.spacetimeTimeline.noTimelineDescription",
                  )}
                />
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <Space wrap size="small" align="center">
                      <Button
                        size="small"
                        onClick={() => setPlaying((prev) => !prev)}
                      >
                        {playing
                          ? t("common.pause")
                          : t("common.play")}
                      </Button>
                      <Button
                        size="small"
                        onClick={() => jumpCursor(-1)}
                        disabled={cursorIndex <= 0}
                      >
                        {t("common.prev")}
                      </Button>
                      <Button
                        size="small"
                        onClick={() => jumpCursor(1)}
                        disabled={cursorIndex >= timeline.length - 1}
                      >
                        {t("common.next")}
                      </Button>
                      <Button
                        size="small"
                        onClick={() => jumpCursor(10)}
                        disabled={cursorIndex >= timeline.length - 1}
                      >
                        {t("common.fastForward")}
                      </Button>
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                      >
                        {t("dashboard.charts.spacetimeTimeline.granularity")}
                      </Typography.Text>
                      <Select
                        value={timelineGranularity}
                        options={granularityOptions}
                        size="small"
                        style={{ width: 126 }}
                        onChange={(value) =>
                          setTimelineGranularity(
                            value as TimelineGranularityFilter,
                          )
                        }
                      />
                    </Space>

                    <Space wrap size="small" align="center">
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                      >
                        {t("dashboard.charts.spacetimeTimeline.playSpeed")}
                      </Typography.Text>
                      <InputNumber
                        size="small"
                        min={TIMELINE_SPEED_MIN}
                        max={TIMELINE_SPEED_MAX}
                        step={0.25}
                        precision={2}
                        value={speed}
                        onChange={(value) => {
                          const next = typeof value === "number" ? value : 1;
                          setSpeed(
                            Math.max(
                              TIMELINE_SPEED_MIN,
                              Math.min(TIMELINE_SPEED_MAX, next),
                            ),
                          );
                        }}
                        style={{ width: 96 }}
                      />
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                      >
                        x
                      </Typography.Text>
                      {speedPresetValues.map((preset) => (
                        <Button
                          key={preset}
                          size="small"
                          type={
                            Math.abs(speed - preset) < 0.001
                              ? "primary"
                              : "default"
                          }
                          onClick={() => setSpeed(preset)}
                        >
                          {preset}x
                        </Button>
                      ))}
                    </Space>

                    <div>
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                      >
                        {t("dashboard.charts.spacetimeTimeline.step")}
                        : {cursorIndex + 1}/{timeline.length}
                      </Typography.Text>
                      <Slider
                        min={0}
                        max={Math.max(0, timeline.length - 1)}
                        value={cursorIndex}
                        onChange={(value) => setCursorIndex(value)}
                        tooltip={{ formatter: () => null }}
                      />
                    </div>
                  </div>

                  <div className="flex-1 overflow-auto border border-slate-200/60 rounded-md p-3 bg-white/40">
                    <Space
                      direction="vertical"
                      size={6}
                      style={{ width: "100%" }}
                    >
                      <Space wrap size="small" align="center">
                        <Typography.Text strong>
                          {cursorEntry?.title?.trim() ||
                            t("dashboard.charts.spacetimeTimeline.bucket")}
                        </Typography.Text>
                        {cursorStartIso ? (
                          <Tag color="purple" className="text-xs">
                            {formatDateTime(cursorStartIso, locale, {
                              dateStyle: "medium",
                            })}{" "}
                            {cursorEndIso ? (
                              <>
                                -{" "}
                                {formatDateTime(cursorEndIso, locale, {
                                  dateStyle: "medium",
                                })}
                              </>
                            ) : null}
                          </Tag>
                        ) : null}
                        {cursorGranularityLabel ? (
                          <Tag color="geekblue" className="text-xs">
                            {t(
                              "dashboard.charts.spacetimeTimeline.bucketGranularity",
                            )}
                            : {cursorGranularityLabel}
                          </Tag>
                        ) : null}
                        {cursorEntry && cursorEntry.aggregatedCount > 1 ? (
                          <Tag color="blue" className="text-xs">
                            {t(
                              "dashboard.charts.spacetimeTimeline.aggregatedBuckets",
                              {
                                count: cursorEntry.aggregatedCount,
                              },
                            )}
                          </Tag>
                        ) : null}
                        <Button
                          size="small"
                          onClick={openTimelineDetails}
                          disabled={!cursorEntry}
                        >
                          {t(
                            "dashboard.charts.spacetimeTimeline.viewReferences",
                          )}
                        </Button>
                      </Space>
                      {cursorEntry?.summary ? (
                        <Typography.Paragraph
                          type="secondary"
                          style={{ margin: 0, whiteSpace: "pre-wrap" }}
                        >
                          {cursorEntry.summary}
                        </Typography.Paragraph>
                      ) : null}
                      {keyPoints.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {keyPoints.slice(0, 12).map((kp) => (
                            <Tag key={kp}>{kp}</Tag>
                          ))}
                        </div>
                      ) : null}
                      {cursorLinkedSources.length > 0 ? (
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12 }}
                        >
                          {t(
                            "dashboard.charts.spacetimeTimeline.linkedSources",
                            {
                              count: cursorLinkedSources.length,
                            },
                          )}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  </div>
                </>
              )}
            </div>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2">
          <Card
            title={t("dashboard.charts.spacetimePropagation.title")}
            className="glass-card"
            variant="borderless"
          >
            <DeferredChartMount minHeight={320}>
              <SpacetimePropagation
                eventId={selectedEventId}
                cursorStartIso={cursorStartIso}
                cursorEndIso={cursorEndIso}
                linkedSources={cursorLinkedSources}
                loading={eventLoading}
              />
            </DeferredChartMount>
          </Card>
        </div>

        <div className="xl:col-span-1">
          <Card
            title={t("dashboard.charts.knowledgeGraph3d.title")}
            className="glass-card"
            variant="borderless"
          >
            <DeferredChartMount minHeight={380}>
              <KnowledgeGraph3D defaultSeed={suggestedSeed} />
            </DeferredChartMount>
          </Card>
        </div>
      </div>

      <Drawer
        title={
          selectedTimelineEntry?.title?.trim() ||
          t("dashboard.charts.spacetimeTimeline.detailsTitle")
        }
        open={timelineDrawerOpen}
        onClose={() => setTimelineDrawerOpen(false)}
        width={560}
      >
        {!selectedTimelineEntry ? (
          <Empty
            description={t("dashboard.dataEmpty")}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <Space wrap size="small">
              <Tag color="purple">
                {formatDateTime(selectedTimelineEntry.bucketStart, locale, {
                  dateStyle: "medium",
                })}
              </Tag>
              {selectedTimelineEntry.aggregatedCount > 1 ? (
                <Tag color="blue">
                  {t("dashboard.charts.spacetimeTimeline.aggregatedBuckets", {
                    count: selectedTimelineEntry.aggregatedCount,
                  })}
                </Tag>
              ) : null}
              <Tag color="default">
                {t("dashboard.charts.spacetimeTimeline.references", {
                  count:
                    timelineEntryReferences.resolved.length +
                    timelineEntryReferences.unresolved.length,
                })}
              </Tag>
            </Space>

            {selectedTimelineEntry.summary ? (
              <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                {selectedTimelineEntry.summary}
              </Typography.Paragraph>
            ) : null}

            {referencedArticlesLoading ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t("dashboard.charts.spacetimeTimeline.loadingReferences")}
              </Typography.Text>
            ) : null}

            {timelineEntryReferences.resolved.length === 0 ? (
              <ChartEmptyState
                title={t(
                  "dashboard.charts.spacetimeTimeline.noReferencesTitle",
                )}
                description={t(
                  "dashboard.charts.spacetimeTimeline.noReferencesDescription",
                )}
              />
            ) : (
              <List
                dataSource={timelineEntryReferences.resolved}
                renderItem={(article) => {
                  const url = safeHttpUrl(article.url);
                  const title = article.title?.trim() || url || article.id;
                  const publishedAt =
                    article.publishedAt ??
                    article.crawlAt ??
                    article.processedAt;

                  return (
                    <List.Item key={article.id}>
                      <List.Item.Meta
                        title={
                          url ? (
                            <a href={url} target="_blank" rel="noreferrer">
                              {title}
                            </a>
                          ) : (
                            <span>{title}</span>
                          )
                        }
                        description={
                          <Space direction="vertical" size={2}>
                            <Space size="small" wrap>
                              <Tag color="geekblue">
                                {article.sourceLabel ||
                                  t("common.notAvailable")}
                              </Tag>
                            </Space>
                            <Typography.Text
                              type="secondary"
                              style={{ fontSize: 12 }}
                            >
                              {t(
                                "dashboard.charts.spacetimeTimeline.publishedAt",
                              )}
                              :{" "}
                              {publishedAt
                                ? formatDateTime(publishedAt, locale, {
                                    dateStyle: "medium",
                                    timeStyle: "short",
                                  })
                                : t("common.notAvailable")}
                            </Typography.Text>
                          </Space>
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            )}

            {timelineEntryReferences.unresolved.length > 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t("dashboard.charts.spacetimeTimeline.unresolvedReferences", {
                  count: timelineEntryReferences.unresolved.length,
                })}
              </Typography.Text>
            ) : null}
          </div>
        )}
      </Drawer>
    </div>
  );
}
