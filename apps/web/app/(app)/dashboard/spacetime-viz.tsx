"use client";

import { gql, useQuery } from "@apollo/client";
import { Button, Card, Segmented, Select, Skeleton, Slider, Space, Switch, Tag, Typography } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

import { KnowledgeGraph3D } from "./charts/knowledge-graph-3d";
import { SpacetimeGeoHeatmap } from "./charts/spacetime-geo-heatmap";
import { SpacetimePropagation } from "./charts/spacetime-propagation";

interface NewsEventListItem {
  id: string;
  title?: string | null;
  primaryTopic?: string | null;
  primaryEntity?: string | null;
  lastAt: string;
  itemCount: number;
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

interface NewsEventDetails {
  id: string;
  title?: string | null;
  primaryTopic?: string | null;
  primaryEntity?: string | null;
  startAt: string;
  lastAt: string;
  itemCount: number;
  timeline?: TimelineEntry[];
}

const NEWS_EVENTS_QUERY = gql`
  query SpacetimeNewsEvents($limit: Int, $windowDays: Int, $status: NewsEventStatus) {
    newsEvents(limit: $limit, windowDays: $windowDays, status: $status) {
      id
      title
      primaryTopic
      primaryEntity
      lastAt
      itemCount
    }
  }
`;

const NEWS_EVENT_QUERY = gql`
  query SpacetimeNewsEvent($id: String!, $timelineLimit: Int) {
    newsEvent(id: $id, timelineLimit: $timelineLimit) {
      id
      title
      primaryTopic
      primaryEntity
      startAt
      lastAt
      itemCount
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
    }
  }
`;

const resolveEventTitle = (event: NewsEventListItem) => {
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

export function SpacetimeViz() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [geoScope, setGeoScope] = useState<"global" | "event">("global");
  const [geoFollowCursor, setGeoFollowCursor] = useState(false);

  const { data: eventsData, loading: eventsLoading } = useQuery<{ newsEvents: NewsEventListItem[] }>(NEWS_EVENTS_QUERY, {
    variables: { limit: 20, windowDays: 30, status: "active" },
    fetchPolicy: "cache-and-network"
  });

  const events = eventsData?.newsEvents ?? [];

  useEffect(() => {
    if (selectedEventId) return;
    if (events.length === 0) return;
    setSelectedEventId(events[0]!.id);
  }, [events, selectedEventId]);

  const {
    data: eventData,
    loading: eventLoading,
    error: eventError,
    refetch: refetchEvent
  } = useQuery<{ newsEvent: NewsEventDetails | null }>(NEWS_EVENT_QUERY, {
    variables: { id: selectedEventId, timelineLimit: 180 },
    skip: !selectedEventId,
    fetchPolicy: "network-only"
  });

  const event = eventData?.newsEvent ?? null;

  const timeline = useMemo(() => {
    const entries = event?.timeline ?? [];
    return [...entries].sort((a, b) => dayjs(a.bucketStart).valueOf() - dayjs(b.bucketStart).valueOf());
  }, [event?.timeline]);

  useEffect(() => {
    setCursorIndex(0);
    setPlaying(false);
  }, [selectedEventId]);

  useEffect(() => {
    if (geoScope === "global") {
      setGeoFollowCursor(false);
    }
  }, [geoScope]);

  useEffect(() => {
    if (!playing) return;
    if (timeline.length <= 1) return;
    const intervalMs = clampInt(1400 / Math.max(0.25, speed), 120, 5000);
    const timer = setInterval(() => {
      setCursorIndex((prev) => (prev + 1 < timeline.length ? prev + 1 : 0));
    }, intervalMs);
    return () => clearInterval(timer);
  }, [playing, speed, timeline.length]);

  const cursorEntry = timeline[cursorIndex] ?? null;
  const cursorNext = timeline[cursorIndex + 1] ?? null;
  const cursorStartIso = cursorEntry?.bucketStart ?? null;
  const cursorEndIso = cursorNext?.bucketStart ?? event?.lastAt ?? null;

  const keyPoints = useMemo(() => normalizeStringArray(cursorEntry?.keyPoints), [cursorEntry?.keyPoints]);

  const eventOptions = useMemo(
    () =>
      events.map((evt) => ({
        value: evt.id,
        label: `${resolveEventTitle(evt)} (${evt.itemCount})`
      })),
    [events]
  );

  const speedOptions = useMemo(
    () => [1, 2, 4, 8].map((value) => ({ value, label: `${value}x` })),
    []
  );

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

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2">
          <Card
            title={t("dashboard.charts.spacetimeGeoHeatmap.title", { defaultValue: "Geo Sentiment Heatmap" })}
            className="glass-card sm-panel-card h-[520px]"
            bordered={false}
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
            bordered={false}
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
                    style={{ minWidth: 240 }}
                    placeholder={t("dashboard.charts.spacetimeTimeline.eventPlaceholder", { defaultValue: "Select an event" })}
                  />
                </Space>

                <Space wrap size="small" align="center">
                  <Tag color={playing ? "green" : "default"}>
                    {playing
                      ? t("dashboard.charts.spacetimeTimeline.playing", { defaultValue: "Playing" })
                      : t("dashboard.charts.spacetimeTimeline.paused", { defaultValue: "Paused" })}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {event ? resolveEventTitle(event) : t("common.emptyValue", { defaultValue: "N/A" })}
                  </Typography.Text>
                </Space>
              </Space>

              {eventLoading ? (
                <Skeleton active paragraph={{ rows: 6 }} />
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
                      <Select value={speed} options={speedOptions} onChange={setSpeed} style={{ width: 90 }} size="small" />
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
                        <Tag>
                          {formatDateTime(cursorEntry!.bucketStart, locale, { dateStyle: "medium" })}
                        </Tag>
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
            bordered={false}
          >
            <SpacetimePropagation
              eventId={selectedEventId}
              cursorStartIso={cursorStartIso}
              cursorEndIso={cursorEndIso}
              loading={eventLoading}
            />
          </Card>
        </div>

        <div className="xl:col-span-1">
          <Card
            title={t("dashboard.charts.knowledgeGraph3d.title", { defaultValue: "Knowledge Graph (3D)" })}
            className="glass-card"
            bordered={false}
          >
            <KnowledgeGraph3D defaultSeed={suggestedSeed} />
          </Card>
        </div>
      </div>
    </div>
  );
}
