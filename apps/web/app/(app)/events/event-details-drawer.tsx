"use client";

import { gql, useQuery } from "@apollo/client";
import { Alert, Button, Divider, Empty, List, Skeleton, Space, Tag, Tabs, Tooltip, Typography } from "antd";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import dayjs from "@/lib/dayjs";
import { formatDateTime, formatRelativeTime, formatTimeZoneOffsetLabel, getDefaultTimeZone, resolveLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";

interface EventItem {
  id: string;
  eventId: string;
  processedArticleId: string;
  processedItemId?: string | null;
  similarity?: number | null;
  assignedBy: string;
  createdAt: string;
  processedArticle: {
    id: string;
    articleId: string;
    title?: string | null;
    summary?: string | null;
    publishedAt?: string | null;
    language?: string | null;
    processedAt: string;
    article: {
      id: string;
      url: string;
      sourceLabel?: string | null;
      crawlAt: string;
    };
  };
}

interface TimelineEntry {
  id: string;
  eventId: string;
  bucketStart: string;
  title?: string | null;
  summary?: string | null;
  keyPoints?: unknown;
  referencedArticleIds?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface NewsEvent {
  id: string;
  status: "active" | "archived";
  language?: string | null;
  primaryTopic?: string | null;
  primaryEntity?: string | null;
  title?: string | null;
  summary?: string | null;
  startAt: string;
  lastAt: string;
  itemCount: number;
  items?: EventItem[];
  timeline?: TimelineEntry[];
}

const NEWS_EVENT_QUERY = gql`
  query NewsEvent($id: String!, $itemsLimit: Int, $timelineLimit: Int) {
    newsEvent(id: $id, itemsLimit: $itemsLimit, timelineLimit: $timelineLimit) {
      id
      status
      language
      primaryTopic
      primaryEntity
      title
      summary
      startAt
      lastAt
      itemCount
      items {
        id
        eventId
        processedArticleId
        processedItemId
        similarity
        assignedBy
        createdAt
        processedArticle {
          id
          articleId
          title
          summary
          publishedAt
          language
          processedAt
          article {
            id
            url
            sourceLabel
            crawlAt
          }
        }
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
    }
  }
`;

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function formatSimilarity(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.round(value * 100)}%`;
}

export function EventDetailsDrawer({ eventId }: { eventId: string }) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const timeZone = getDefaultTimeZone();
  const timeZoneLabel = useMemo(() => formatTimeZoneOffsetLabel(new Date(), timeZone), [timeZone]);
  const router = useRouter();

  const { data, loading, error } = useQuery<{ newsEvent: NewsEvent | null }>(NEWS_EVENT_QUERY, {
    variables: { id: eventId, itemsLimit: 80, timelineLimit: 400 },
    fetchPolicy: "network-only"
  });

  const event = data?.newsEvent ?? null;
  const timeline = useMemo(() => {
    const entries = event?.timeline ?? [];
    return [...entries].sort((a, b) => dayjs(a.bucketStart).valueOf() - dayjs(b.bucketStart).valueOf());
  }, [event?.timeline]);
  const items = useMemo(() => {
    const rows = event?.items ?? [];
    return [...rows].sort((a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf());
  }, [event?.items]);

  if (loading && !event) {
    return <Skeleton active paragraph={{ rows: 10 }} />;
  }

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message={t("pages.events.drawer.loadFailed", { defaultValue: "Failed to load event." })}
        description={error.message}
      />
    );
  }

  if (!event) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t("pages.events.drawer.notFound", { defaultValue: "Event not found." })}
      />
    );
  }

  const title = event.title?.trim() ? event.title.trim() : event.primaryEntity?.trim() || event.primaryTopic?.trim() || event.id;
  const language = event.language?.trim() ?? "";
  const topic = event.primaryTopic?.trim() ?? "";
  const entity = event.primaryEntity?.trim() ?? "";
  const startRelative = formatRelativeTime(event.startAt, locale, { timeZone });
  const lastRelative = formatRelativeTime(event.lastAt, locale, { timeZone });
  const startTooltip = formatDateTime(event.startAt, locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    timeZoneName: "short"
  });
  const lastTooltip = formatDateTime(event.lastAt, locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    timeZoneName: "short"
  });

  return (
    <div className="flex flex-col gap-3">
      <Space direction="vertical" size={6}>
        <Typography.Title level={5} style={{ marginBottom: 0 }}>
          {title}
        </Typography.Title>
        <Space wrap size={[8, 6]}>
          <Button type="link" onClick={() => router.push(`/events/${event.id}`)}>
            {t("pages.events.actions.open", { defaultValue: "Open" })}
          </Button>
        </Space>
        <Space wrap size={[6, 6]}>
          <Tag color={event.status === "active" ? "green" : "default"}>{event.status}</Tag>
          <Tag>{t("pages.events.drawer.items", { defaultValue: "Items" })}: {event.itemCount}</Tag>
          {language ? <Tag color="blue">{language}</Tag> : null}
          {topic ? <Tag color="geekblue">{topic}</Tag> : null}
          {entity ? <Tag color="purple">{entity}</Tag> : null}
          <Tooltip title={`${timeZone} (${timeZoneLabel || timeZone})`}>
            <Tag>{timeZoneLabel || timeZone}</Tag>
          </Tooltip>
        </Space>
        <Space wrap size={[12, 0]}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("pages.events.fields.startAt", { defaultValue: "Start" })}:{" "}
            <Tooltip title={`${startTooltip}${startRelative ? ` (${startRelative})` : ""}`}>
              <span>{formatDateTime(event.startAt, locale, { dateStyle: "medium", timeZone })}</span>
            </Tooltip>
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("pages.events.fields.lastAt", { defaultValue: "Last" })}:{" "}
            <Tooltip title={`${lastTooltip}${lastRelative ? ` (${lastRelative})` : ""}`}>
              <span>{formatDateTime(event.lastAt, locale, { dateStyle: "medium", timeZone })}</span>
            </Tooltip>
            {lastRelative ? <span className="ml-1 opacity-80">({lastRelative})</span> : null}
          </Typography.Text>
        </Space>
        {event.summary ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {event.summary}
          </Typography.Paragraph>
        ) : null}
      </Space>

      <Divider style={{ margin: "8px 0" }} />

      <Tabs
        defaultActiveKey="timeline"
        items={[
          {
            key: "timeline",
            label: t("pages.events.drawer.tabs.timeline", { defaultValue: "Timeline" }),
            children: timeline.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("pages.events.drawer.timelineEmpty", {
                  defaultValue: "No timeline entries yet. Enable timeline generation and wait for the scheduled job."
                })}
              />
            ) : (
              <List
                dataSource={timeline}
                renderItem={(entry) => {
                  const keyPoints = normalizeStringArray(entry.keyPoints);
                  const referencedIds = normalizeStringArray(entry.referencedArticleIds);
                  return (
                    <List.Item key={entry.id}>
                      <List.Item.Meta
                        title={
                          <Space wrap size={[8, 6]}>
                            <Typography.Text strong>
                              {formatDateTime(entry.bucketStart, locale, { dateStyle: "medium", timeZone })}
                            </Typography.Text>
                            {referencedIds.length > 0 ? (
                              <Tag>{t("pages.events.drawer.references", { defaultValue: "Refs" })}: {referencedIds.length}</Tag>
                            ) : null}
                          </Space>
                        }
                        description={
                          <div className="flex flex-col gap-1">
                            {entry.title ? <Typography.Text>{entry.title}</Typography.Text> : null}
                            {entry.summary ? (
                              <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} style={{ marginBottom: 0 }}>
                                {entry.summary}
                              </Typography.Paragraph>
                            ) : null}
                            {keyPoints.length > 0 ? (
                              <Space wrap size={[6, 6]}>
                                {keyPoints.slice(0, 10).map((point, idx) => (
                                  <Tag key={`${entry.id}-${idx}`} color="default">
                                    {point}
                                  </Tag>
                                ))}
                              </Space>
                            ) : null}
                          </div>
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            )
          },
          {
            key: "items",
            label: t("pages.events.drawer.tabs.articles", { defaultValue: "Articles" }),
            children: items.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("pages.events.drawer.itemsEmpty", { defaultValue: "No articles in this event yet." })}
              />
            ) : (
              <List
                dataSource={items}
                renderItem={(item) => {
                  const processed = item.processedArticle;
                  const url = safeHttpUrl(processed.article.url);
                  const similarity = formatSimilarity(item.similarity);
                  const sourceLabel = processed.article.sourceLabel?.trim() ?? "";
                  const publishedLabel = t("items.time.published", { defaultValue: "Published" });
                  const ingestedLabel = t("items.time.ingested", { defaultValue: "Ingested" });
                  const publishedAt = processed.publishedAt ?? null;
                  const ingestedAt = processed.article.crawlAt ?? processed.processedAt ?? null;
                  return (
                    <List.Item
                      key={item.id}
                      extra={
                        url ? (
                          <a href={url} target="_blank" rel="noreferrer">
                            {t("pages.events.drawer.openOriginal", { defaultValue: "Open" })}
                          </a>
                        ) : null
                      }
                    >
                      <List.Item.Meta
                        title={
                          <Space wrap size={[6, 6]}>
                            <Typography.Text strong>{processed.title ?? processed.articleId}</Typography.Text>
                            <Tag color="default">{item.assignedBy}</Tag>
                            {similarity ? <Tag color="blue">{similarity}</Tag> : null}
                            {sourceLabel ? <Tag color="geekblue">{sourceLabel}</Tag> : null}
                            <Tag>
                              {publishedLabel}:{" "}
                              {publishedAt
                                ? formatDateTime(publishedAt, locale, { dateStyle: "medium", timeZone })
                                : t("common.notAvailable")}
                            </Tag>
                            <Tag>
                              {ingestedLabel}:{" "}
                              {ingestedAt
                                ? formatDateTime(ingestedAt, locale, { dateStyle: "medium", timeZone })
                                : t("common.notAvailable")}
                            </Tag>
                          </Space>
                        }
                        description={
                          processed.summary ? (
                            <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} style={{ marginBottom: 0 }}>
                              {processed.summary}
                            </Typography.Paragraph>
                          ) : null
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            )
          }
        ]}
      />
    </div>
  );
}
