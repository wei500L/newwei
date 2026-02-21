"use client";

import { gql, useQuery } from "@apollo/client";
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
  Typography
} from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { formatGranularityLabel, inferGranularityFromTimestampsMs } from "@/lib/time-granularity";
import { safeHttpUrl } from "@/lib/url";

import { KnowledgeGraph3D } from "./charts/knowledge-graph-3d";
import { SpacetimeGeoHeatmap } from "./charts/spacetime-geo-heatmap";
import { SpacetimePropagation } from "./charts/spacetime-propagation";

type NewsEventSourceType = "all" | "authoritative" | "mixed" | "blog" | "unknown";
type NewsEventSortBy = "latest" | "heat" | "credibility";
type TimelineGranularityFilter = "auto" | "day" | "week" | "month";

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

const NEWS_EVENTS_QUERY = gql`
  query SpacetimeNewsEvents(
    $limit: Int
    $windowDays: Int
    $status: NewsEventStatus
    $sourceType: NewsEventSourceType
    $minHeatScore: Float
    $minCredibilityScore: Float
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
    }
  }
`;

const NEWS_EVENT_QUERY = gql`
  query SpacetimeNewsEvent($id: String!, $timelineLimit: Int, $itemsLimit: Int) {
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

const EVENT_LIST_WINDOW_DAYS = 30;
const TIMELINE_SPEED_MIN = 0.25;
const TIMELINE_SPEED_MAX = 16;

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

const clampInt = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)));

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

const toGranularityBucketIso = (bucketStart: string, granularity: TimelineGranularityFilter): string => {
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

const buildTimelineNodes = (entries: TimelineEntry[], granularity: TimelineGranularityFilter): TimelineNode[] => {
  const sorted = [...entries].sort((a, b) => dayjs(a.bucketStart).valueOf() - dayjs(b.bucketStart).valueOf());
  if (granularity === "auto") {
    return sorted.map((entry) => ({
      ...entry,
      aggregatedCount: 1,
      sourceEntryIds: [entry.id]
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

  const aggregated = Array.from(bucketMap.entries()).map(([bucketStart, bucketEntries]) => {
    const descending = bucketEntries
      .slice()
      .sort((a, b) => dayjs(b.bucketStart).valueOf() - dayjs(a.bucketStart).valueOf());
    const primary = descending[0]!;
    const keyPoints = Array.from(new Set(bucketEntries.flatMap((entry) => normalizeStringArray(entry.keyPoints)))).slice(0, 20);
    const referencedArticleIds = Array.from(
      new Set(bucketEntries.flatMap((entry) => normalizeStringArray(entry.referencedArticleIds)))
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
      sourceEntryIds: bucketEntries.map((entry) => entry.id)
    } satisfies TimelineNode;
  });

  return aggregated.sort((a, b) => dayjs(a.bucketStart).valueOf() - dayjs(b.bucketStart).valueOf());
};

export function SpacetimeViz() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);

  const sourceTypeLabel = useCallback(
    (sourceType: NewsEventSourceType) => {
      if (sourceType === "authoritative") {
        return t("dashboard.charts.spacetimeTimeline.sourceTypeAuthoritative", { defaultValue: "Authoritative" });
      }
      if (sourceType === "mixed") {
        return t("dashboard.charts.spacetimeTimeline.sourceTypeMixed", { defaultValue: "Mixed" });
      }
      if (sourceType === "blog") {
        return t("dashboard.charts.spacetimeTimeline.sourceTypeBlog", { defaultValue: "Blog" });
      }
      if (sourceType === "all") {
        return t("dashboard.charts.spacetimeTimeline.sourceTypeAll", { defaultValue: "All" });
      }
      return t("dashboard.charts.spacetimeTimeline.sourceTypeUnknown", { defaultValue: "Unknown" });
    },
    [t]
  );

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [geoScope, setGeoScope] = useState<"global" | "event">("global");
  const [geoFollowCursor, setGeoFollowCursor] = useState(false);

  const [authoritativeLock, setAuthoritativeLock] = useState(true);
  const [eventSourceType, setEventSourceType] = useState<NewsEventSourceType>("authoritative");
  const [sortBy, setSortBy] = useState<NewsEventSortBy>("heat");
  const [minHeatScore, setMinHeatScore] = useState(0.7);
  const [minCredibilityScore, setMinCredibilityScore] = useState(48);
  const [timelineGranularity, setTimelineGranularity] = useState<TimelineGranularityFilter>("auto");

  const [timelineDrawerOpen, setTimelineDrawerOpen] = useState(false);
  const [timelineDrawerEntryId, setTimelineDrawerEntryId] = useState<string | null>(null);
  const effectiveEventSourceType: NewsEventSourceType = authoritativeLock ? "authoritative" : eventSourceType;

  const { data: eventsData, loading: eventsLoading } = useQuery<{ newsEvents: NewsEventListItem[] }>(NEWS_EVENTS_QUERY, {
    variables: {
      limit: 24,
      windowDays: EVENT_LIST_WINDOW_DAYS,
      status: "active",
      sourceType: effectiveEventSourceType,
      minHeatScore,
      minCredibilityScore,
      sortBy,
      dedupeSimilar: true
    },
    fetchPolicy: "cache-and-network"
  });

  const handleAuthoritativeLockChange = useCallback((checked: boolean) => {
    setAuthoritativeLock(checked);
    if (checked) {
      setEventSourceType("authoritative");
    }
  }, []);

  const events = eventsData?.newsEvents ?? [];

  useEffect(() => {
    if (events.length === 0) {
      setSelectedEventId(null);
      return;
    }
    if (!selectedEventId || !events.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(events[0]!.id);
    }
  }, [events, selectedEventId]);

  const {
    data: eventData,
    loading: eventLoading,
    error: eventError,
    refetch: refetchEvent
  } = useQuery<{ newsEvent: NewsEventDetails | null }>(NEWS_EVENT_QUERY, {
    variables: { id: selectedEventId, timelineLimit: 220, itemsLimit: 260 },
    skip: !selectedEventId,
    fetchPolicy: "network-only"
  });

  const event = eventData?.newsEvent ?? null;

  const items = useMemo(() => {
    const rows = event?.items ?? [];
    return [...rows].sort((a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf());
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
        processedAt: item.processedArticle.processedAt
      });
    }
    return map;
  }, [items]);

  const timeline = useMemo(() => buildTimelineNodes(event?.timeline ?? [], timelineGranularity), [event?.timeline, timelineGranularity]);

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
    const intervalMs = clampInt(1400 / Math.max(TIMELINE_SPEED_MIN, speed), 120, 5000);
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
    const startMs = cursorStartIso ? dayjs(cursorStartIso).valueOf() : Number.NaN;
    const endMs = cursorEndIso ? dayjs(cursorEndIso).valueOf() : Number.NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return null;
    }
    return inferGranularityFromTimestampsMs([startMs, endMs]);
  }, [cursorEndIso, cursorStartIso]);

  const cursorGranularityLabel = cursorGranularity ? formatGranularityLabel(cursorGranularity) : null;

  const keyPoints = useMemo(() => normalizeStringArray(cursorEntry?.keyPoints), [cursorEntry?.keyPoints]);

  const cursorLinkedSources = useMemo(() => {
    const set = new Set<string>();
    for (const articleId of normalizeStringArray(cursorEntry?.referencedArticleIds)) {
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

  const timelineEntryReferences = useMemo(() => {
    const articleIds = normalizeStringArray(selectedTimelineEntry?.referencedArticleIds);
    const resolved: ReferencedArticleView[] = [];
    const unresolved: string[] = [];

    for (const articleId of articleIds) {
      const article = articleById.get(articleId);
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
      unresolved
    };
  }, [articleById, selectedTimelineEntry?.referencedArticleIds]);

  const eventOptions = useMemo(
    () =>
      events.map((evt) => ({
        value: evt.id,
        label: `${resolveEventTitle(evt)} (${evt.itemCount}) · H${evt.heatScore.toFixed(2)} · C${evt.credibilityScore.toFixed(0)}`
      })),
    [events]
  );

  const sourceTypeOptions = useMemo(
    () => [
      {
        value: "authoritative" as const,
        label: t("dashboard.charts.spacetimeTimeline.sourceTypeAuthoritative", { defaultValue: "Authoritative" })
      },
      {
        value: "mixed" as const,
        label: t("dashboard.charts.spacetimeTimeline.sourceTypeMixed", { defaultValue: "Mixed" })
      },
      {
        value: "blog" as const,
        label: t("dashboard.charts.spacetimeTimeline.sourceTypeBlog", { defaultValue: "Blog" })
      },
      {
        value: "all" as const,
        label: t("dashboard.charts.spacetimeTimeline.sourceTypeAll", { defaultValue: "All" })
      }
    ],
    [t]
  );

  const sortOptions = useMemo(
    () => [
      {
        value: "heat" as const,
        label: t("dashboard.charts.spacetimeTimeline.sortByHeat", { defaultValue: "Heat" })
      },
      {
        value: "credibility" as const,
        label: t("dashboard.charts.spacetimeTimeline.sortByCredibility", { defaultValue: "Credibility" })
      },
      {
        value: "latest" as const,
        label: t("dashboard.charts.spacetimeTimeline.sortByLatest", { defaultValue: "Latest" })
      }
    ],
    [t]
  );

  const granularityOptions = useMemo(
    () => [
      {
        value: "auto" as const,
        label: t("dashboard.charts.spacetimeTimeline.granularityAuto", { defaultValue: "Auto" })
      },
      {
        value: "day" as const,
        label: t("dashboard.charts.spacetimeTimeline.granularityDay", { defaultValue: "Daily" })
      },
      {
        value: "week" as const,
        label: t("dashboard.charts.spacetimeTimeline.granularityWeek", { defaultValue: "Weekly" })
      },
      {
        value: "month" as const,
        label: t("dashboard.charts.spacetimeTimeline.granularityMonth", { defaultValue: "Monthly" })
      }
    ],
    [t]
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
    [timeline.length]
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
            title={t("dashboard.charts.spacetimeGeoHeatmap.title", { defaultValue: "Geo Sentiment Heatmap" })}
            className="glass-card sm-panel-card h-[520px]"
            variant="borderless"
          >
            <div className="flex flex-col gap-2 h-full">
              <Space wrap size="small" align="center">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t("dashboard.charts.spacetimeGeoHeatmap.scope", { defaultValue: "Scope" })}
                </Typography.Text>
                <Segmented
                  size="small"
                  value={geoScope}
                  options={[
                    { label: t("dashboard.charts.spacetimeGeoHeatmap.scopeGlobal", { defaultValue: "Global" }), value: "global" },
                    { label: t("dashboard.charts.spacetimeGeoHeatmap.scopeEvent", { defaultValue: "Event" }), value: "event" }
                  ]}
                  onChange={(value) => setGeoScope(value as "global" | "event")}
                />
                <Switch
                  size="small"
                  checked={geoFollowCursor}
                  onChange={setGeoFollowCursor}
                  disabled={geoScope !== "event" || timeline.length === 0 || !cursorStartIso}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t("dashboard.charts.spacetimeGeoHeatmap.followTimeline", { defaultValue: "Follow timeline" })}
                </Typography.Text>
              </Space>

              <div className="flex-1 min-h-0">
                <SpacetimeGeoHeatmap
                  eventId={geoScope === "event" ? selectedEventId : null}
                  followCursor={geoScope === "event" && geoFollowCursor}
                  cursorBucketStartIso={geoScope === "event" ? cursorStartIso : null}
                />
              </div>
            </div>
          </Card>
        </div>

        <div className="xl:col-span-1">
          <Card
            title={t("dashboard.charts.spacetimeTimeline.title", { defaultValue: "Timeline Player" })}
            className="glass-card sm-panel-card h-[520px]"
            variant="borderless"
          >
            <div className="h-full flex flex-col gap-3">
              <Space direction="vertical" size={6}>
                <Space wrap size="small" align="center">
                  <Typography.Text type="secondary">
                    {t("dashboard.charts.spacetimeTimeline.event", { defaultValue: "Event" })}
                  </Typography.Text>
                  <Select
                    value={selectedEventId ?? undefined}
                    options={eventOptions}
                    loading={eventsLoading}
                    onChange={(value) => setSelectedEventId(value)}
                    style={{ minWidth: 280 }}
                    placeholder={t("dashboard.charts.spacetimeTimeline.eventPlaceholder", { defaultValue: "Select an event" })}
                  />
                </Space>

                <Space wrap size="small" align="center">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("dashboard.charts.spacetimeTimeline.sourceType", { defaultValue: "Sources" })}
                  </Typography.Text>
                  <Select
                    size="small"
                    style={{ width: 140 }}
                    value={effectiveEventSourceType}
                    options={sourceTypeOptions}
                    disabled={authoritativeLock}
                    onChange={(value) => setEventSourceType(value as NewsEventSourceType)}
                  />
                  <Switch size="small" checked={authoritativeLock} onChange={handleAuthoritativeLockChange} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("dashboard.charts.spacetimeTimeline.lockAuthoritative", {
                      defaultValue: "Lock authoritative mode"
                    })}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("dashboard.charts.spacetimeTimeline.sortBy", { defaultValue: "Sort" })}
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
                    {t("dashboard.charts.spacetimeTimeline.minHeat", { defaultValue: "Min heat" })}
                  </Typography.Text>
                  <InputNumber
                    size="small"
                    min={0}
                    max={12}
                    step={0.1}
                    precision={1}
                    value={minHeatScore}
                    onChange={(value) => setMinHeatScore(typeof value === "number" ? Math.max(0, value) : 0)}
                    style={{ width: 92 }}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t("dashboard.charts.spacetimeTimeline.minCredibility", { defaultValue: "Min credibility" })}
                  </Typography.Text>
                  <InputNumber
                    size="small"
                    min={0}
                    max={100}
                    step={1}
                    precision={0}
                    value={minCredibilityScore}
                    onChange={(value) =>
                      setMinCredibilityScore(typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0)
                    }
                    style={{ width: 92 }}
                  />
                </Space>

                <Space wrap size="small" align="center">
                  <Tag color={playing ? "green" : "default"}>
                    {playing
                      ? t("dashboard.charts.spacetimeTimeline.playing", { defaultValue: "Playing" })
                      : t("dashboard.charts.spacetimeTimeline.paused", { defaultValue: "Paused" })}
                  </Tag>
                  {event ? (
                    <Tag color={event.sourceType === "authoritative" ? "blue" : "default"}>
                      {sourceTypeLabel(event.sourceType)}
                    </Tag>
                  ) : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {event ? resolveEventTitle(event) : t("common.emptyValue", { defaultValue: "N/A" })}
                  </Typography.Text>
                </Space>
              </Space>

              {eventLoading ? (
                <Skeleton active paragraph={{ rows: 7 }} />
              ) : eventError ? (
                <div className="flex flex-col gap-2">
                  <Typography.Text type="danger">
                    {t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
                  </Typography.Text>
                  <Button onClick={() => void refetchEvent()}>{t("common.retry", { defaultValue: "Retry" })}</Button>
                </div>
              ) : !event ? (
                <ChartEmptyState
                  title={t("dashboard.charts.spacetimeTimeline.emptyTitle", { defaultValue: "No event" })}
                  description={t("dashboard.charts.spacetimeTimeline.emptyDescription", { defaultValue: "Select an event to play its timeline." })}
                />
              ) : timeline.length === 0 ? (
                <ChartEmptyState
                  title={t("dashboard.charts.spacetimeTimeline.noTimelineTitle", { defaultValue: "No timeline" })}
                  description={t("dashboard.charts.spacetimeTimeline.noTimelineDescription", { defaultValue: "This event has no timeline entries." })}
                />
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <Space wrap size="small" align="center">
                      <Button size="small" onClick={() => setPlaying((prev) => !prev)}>
                        {playing ? t("common.pause", { defaultValue: "Pause" }) : t("common.play", { defaultValue: "Play" })}
                      </Button>
                      <Button size="small" onClick={() => jumpCursor(-1)} disabled={cursorIndex <= 0}>
                        {t("common.prev", { defaultValue: "Prev" })}
                      </Button>
                      <Button size="small" onClick={() => jumpCursor(1)} disabled={cursorIndex >= timeline.length - 1}>
                        {t("common.next", { defaultValue: "Next" })}
                      </Button>
                      <Button size="small" onClick={() => jumpCursor(10)} disabled={cursorIndex >= timeline.length - 1}>
                        {t("common.fastForward", { defaultValue: "Fast" })}
                      </Button>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t("dashboard.charts.spacetimeTimeline.granularity", { defaultValue: "Granularity" })}
                      </Typography.Text>
                      <Select
                        value={timelineGranularity}
                        options={granularityOptions}
                        size="small"
                        style={{ width: 126 }}
                        onChange={(value) => setTimelineGranularity(value as TimelineGranularityFilter)}
                      />
                    </Space>

                    <Space wrap size="small" align="center">
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t("dashboard.charts.spacetimeTimeline.playSpeed", { defaultValue: "Speed" })}
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
                          setSpeed(Math.max(TIMELINE_SPEED_MIN, Math.min(TIMELINE_SPEED_MAX, next)));
                        }}
                        style={{ width: 96 }}
                      />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        x
                      </Typography.Text>
                      {speedPresetValues.map((preset) => (
                        <Button
                          key={preset}
                          size="small"
                          type={Math.abs(speed - preset) < 0.001 ? "primary" : "default"}
                          onClick={() => setSpeed(preset)}
                        >
                          {preset}x
                        </Button>
                      ))}
                    </Space>

                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t("dashboard.charts.spacetimeTimeline.step", { defaultValue: "Step" })}: {cursorIndex + 1}/{timeline.length}
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
                    <Space direction="vertical" size={6} style={{ width: "100%" }}>
                      <Space wrap size="small" align="center">
                        <Typography.Text strong>
                          {cursorEntry?.title?.trim() || t("dashboard.charts.spacetimeTimeline.bucket", { defaultValue: "Bucket" })}
                        </Typography.Text>
                        {cursorStartIso ? (
                          <Tag color="purple" className="text-xs">
                            {formatDateTime(cursorStartIso, locale, { dateStyle: "medium" })}{" "}
                            {cursorEndIso ? (
                              <>
                                - {formatDateTime(cursorEndIso, locale, { dateStyle: "medium" })}
                              </>
                            ) : null}
                          </Tag>
                        ) : null}
                        {cursorGranularityLabel ? (
                          <Tag color="geekblue" className="text-xs">
                            {t("dashboard.charts.spacetimeTimeline.bucketGranularity", { defaultValue: "Bucket" })}: {cursorGranularityLabel}
                          </Tag>
                        ) : null}
                        {cursorEntry && cursorEntry.aggregatedCount > 1 ? (
                          <Tag color="blue" className="text-xs">
                            {t("dashboard.charts.spacetimeTimeline.aggregatedBuckets", {
                              defaultValue: "{{count}} nodes",
                              count: cursorEntry.aggregatedCount
                            })}
                          </Tag>
                        ) : null}
                        <Button size="small" onClick={openTimelineDetails} disabled={!cursorEntry}>
                          {t("dashboard.charts.spacetimeTimeline.viewReferences", { defaultValue: "References" })}
                        </Button>
                      </Space>
                      {cursorEntry?.summary ? (
                        <Typography.Paragraph type="secondary" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
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
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t("dashboard.charts.spacetimeTimeline.linkedSources", {
                            defaultValue: "Linked sources: {{count}}",
                            count: cursorLinkedSources.length
                          })}
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
            title={t("dashboard.charts.spacetimePropagation.title", { defaultValue: "Propagation Flow" })}
            className="glass-card"
            variant="borderless"
          >
            <SpacetimePropagation
              eventId={selectedEventId}
              cursorStartIso={cursorStartIso}
              cursorEndIso={cursorEndIso}
              linkedSources={cursorLinkedSources}
              loading={eventLoading}
            />
          </Card>
        </div>

        <div className="xl:col-span-1">
          <Card
            title={t("dashboard.charts.knowledgeGraph3d.title", { defaultValue: "Knowledge Graph (3D)" })}
            className="glass-card"
            variant="borderless"
          >
            <KnowledgeGraph3D defaultSeed={suggestedSeed} />
          </Card>
        </div>
      </div>

      <Drawer
        title={selectedTimelineEntry?.title?.trim() || t("dashboard.charts.spacetimeTimeline.detailsTitle", { defaultValue: "Timeline Details" })}
        open={timelineDrawerOpen}
        onClose={() => setTimelineDrawerOpen(false)}
        width={560}
      >
        {!selectedTimelineEntry ? (
          <Empty description={t("dashboard.dataEmpty", { defaultValue: "No data" })} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div className="flex flex-col gap-3">
            <Space wrap size="small">
              <Tag color="purple">
                {formatDateTime(selectedTimelineEntry.bucketStart, locale, { dateStyle: "medium" })}
              </Tag>
              {selectedTimelineEntry.aggregatedCount > 1 ? (
                <Tag color="blue">
                  {t("dashboard.charts.spacetimeTimeline.aggregatedBuckets", {
                    defaultValue: "{{count}} nodes",
                    count: selectedTimelineEntry.aggregatedCount
                  })}
                </Tag>
              ) : null}
              <Tag color="default">
                {t("dashboard.charts.spacetimeTimeline.references", {
                  defaultValue: "Refs: {{count}}",
                  count: timelineEntryReferences.resolved.length + timelineEntryReferences.unresolved.length
                })}
              </Tag>
            </Space>

            {selectedTimelineEntry.summary ? (
              <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                {selectedTimelineEntry.summary}
              </Typography.Paragraph>
            ) : null}

            {timelineEntryReferences.resolved.length === 0 ? (
              <ChartEmptyState
                title={t("dashboard.charts.spacetimeTimeline.noReferencesTitle", { defaultValue: "No references" })}
                description={t("dashboard.charts.spacetimeTimeline.noReferencesDescription", {
                  defaultValue: "No referenced articles were found for this timeline node."
                })}
              />
            ) : (
              <List
                dataSource={timelineEntryReferences.resolved}
                renderItem={(article) => {
                  const url = safeHttpUrl(article.url);
                  const title = article.title?.trim() || url || article.id;
                  const publishedAt = article.publishedAt ?? article.crawlAt ?? article.processedAt;

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
                              <Tag color="geekblue">{article.sourceLabel || t("common.notAvailable", { defaultValue: "N/A" })}</Tag>
                            </Space>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {t("dashboard.charts.spacetimeTimeline.publishedAt", { defaultValue: "Published" })}: {" "}
                              {publishedAt
                                ? formatDateTime(publishedAt, locale, { dateStyle: "medium", timeStyle: "short" })
                                : t("common.notAvailable", { defaultValue: "N/A" })}
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
                  defaultValue: "{{count}} references are outside the current article window.",
                  count: timelineEntryReferences.unresolved.length
                })}
              </Typography.Text>
            ) : null}
          </div>
        )}
      </Drawer>
    </div>
  );
}
