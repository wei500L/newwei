'use client';

import { gql, useQuery } from '@apollo/client';
import { Button, Card, Col, Drawer, Empty, Grid, List, Row, Select, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { NewsCard } from '@/app/(app)/items/components/news-card';
import dayjs from '@/lib/dayjs';
import { formatDateTime, resolveLocale } from '@/lib/i18n';

export interface TopicGroupItem {
  id: string;
  itemMetaId: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  createdAt: string;
}

export interface TopicGroup {
  topic: string;
  count: number;
  latestAt: string;
  items: TopicGroupItem[];
}

export interface EventGroupItem {
  id: string;
  itemMetaId: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  createdAt: string;
}

export interface EventGroup {
  eventId: string;
  count: number;
  latestAt: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  topics?: string[] | null;
  entities?: string[] | null;
  items: EventGroupItem[];
}

const TOPIC_GROUPS_QUERY = gql`
  query TopicGroups(
    $limit: Int
    $itemsPerGroup: Int
    $windowDays: Int
    $eventLimit: Int
    $eventItemsPerGroup: Int
    $eventWindowDays: Int
    $eventMinGroupSize: Int
  ) {
    topicGroups(limit: $limit, itemsPerGroup: $itemsPerGroup, windowDays: $windowDays) {
      topic
      count
      latestAt
      items {
        id
        itemMetaId
        title
        summary
        source
        publishedAt
        createdAt
      }
    }
    eventGroups(
      limit: $eventLimit
      itemsPerGroup: $eventItemsPerGroup
      windowDays: $eventWindowDays
      minGroupSize: $eventMinGroupSize
    ) {
      eventId
      count
      latestAt
      title
      summary
      source
      publishedAt
      topics
      entities
      items {
        id
        itemMetaId
        title
        summary
        source
        publishedAt
        createdAt
      }
    }
  }
`;

const DEFAULT_LIMIT = 12;
const DEFAULT_ITEMS_PER_GROUP = 4;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_EVENT_LIMIT = 8;
const DEFAULT_EVENT_ITEMS_PER_GROUP = 4;
const DEFAULT_EVENT_MIN_GROUP_SIZE = 2;

interface TopicsContentProps {
  initialData?: {
    topicGroups: TopicGroup[];
    eventGroups: EventGroup[];
  } | null;
}

const parsePositiveInt = (value: string | null, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
};

export function TopicsContent({ initialData = null }: TopicsContentProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const latestAtLabel = t('pages.topics.latestAtLabel', { defaultValue: 'Latest' });
  const latestAtHelp = t('pages.topics.latestAtHelp', {
    defaultValue: 'Sorted by Published time when available; falls back to Ingested time.'
  });
  const screens = Grid.useBreakpoint();
  const [selectedEvent, setSelectedEvent] = useState<EventGroup | null>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const windowDays = useMemo(
    () => parsePositiveInt(searchParams.get('window'), DEFAULT_WINDOW_DAYS),
    [searchParams]
  );
  const minGroupSize = useMemo(
    () => parsePositiveInt(searchParams.get('minGroup'), DEFAULT_EVENT_MIN_GROUP_SIZE),
    [searchParams]
  );
  const updateFilters = useCallback(
    (updates: { windowDays?: number; minGroupSize?: number }) => {
      const next = new URLSearchParams(searchParams.toString());
      const nextWindow = updates.windowDays ?? windowDays;
      const nextMinGroup = updates.minGroupSize ?? minGroupSize;
      if (nextWindow === DEFAULT_WINDOW_DAYS) {
        next.delete('window');
      } else {
        next.set('window', String(nextWindow));
      }
      if (nextMinGroup === DEFAULT_EVENT_MIN_GROUP_SIZE) {
        next.delete('minGroup');
      } else {
        next.set('minGroup', String(nextMinGroup));
      }
      const nextQuery = next.toString();
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
    },
    [minGroupSize, pathname, router, searchParams, windowDays]
  );

  const { data, loading, refetch } = useQuery<{
    topicGroups: TopicGroup[];
    eventGroups: EventGroup[];
  }>(TOPIC_GROUPS_QUERY, {
    variables: {
      limit: DEFAULT_LIMIT,
      itemsPerGroup: DEFAULT_ITEMS_PER_GROUP,
      windowDays,
      eventLimit: DEFAULT_EVENT_LIMIT,
      eventItemsPerGroup: DEFAULT_EVENT_ITEMS_PER_GROUP,
      eventWindowDays: windowDays,
      eventMinGroupSize: minGroupSize
    },
    fetchPolicy: 'network-only'
  });

  const resolvedData = data ?? initialData ?? undefined;
  const groups = resolvedData?.topicGroups ?? [];
  const eventGroups = resolvedData?.eventGroups ?? [];
  const sortedEventGroups = useMemo(() => {
    return [...eventGroups].sort((a, b) => {
      const timeDiff = dayjs(b.latestAt).valueOf() - dayjs(a.latestAt).valueOf();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return b.count - a.count;
    });
  }, [eventGroups]);
  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) => {
      const timeDiff = dayjs(b.latestAt).valueOf() - dayjs(a.latestAt).valueOf();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return b.count - a.count;
    });
  }, [groups]);
  const cardSpan = screens.xl ? 6 : screens.lg ? 8 : screens.md ? 12 : 24;
  const drawerWidth = screens.lg ? 720 : undefined;
  const windowOptions = useMemo(
    () =>
      [7, 14, 30, 90].map((days) => ({
        value: days,
        label: t('pages.topics.filters.windowOption', {
          defaultValue: '{{days}} days',
          days
        })
      })),
    [t]
  );
  const groupSizeOptions = useMemo(
    () =>
      [2, 3, 5].map((size) => ({
        value: size,
        label: t('pages.topics.filters.groupOption', {
          defaultValue: '{{count}}+ reports',
          count: size
        })
      })),
    [t]
  );

  const resolveEventTitle = (group: EventGroup) => {
    const topics = group.topics ?? [];
    const entities = group.entities ?? [];
    return (
      group.title ??
      entities[0] ??
      topics[0] ??
      t('pages.topics.eventFallbackTitle', { defaultValue: 'Untitled Event' })
    );
  };

  const selectedEventTitle = selectedEvent ? resolveEventTitle(selectedEvent) : '';
  const selectedEventTopics = selectedEvent?.topics ?? [];
  const selectedEventEntities = selectedEvent?.entities ?? [];
  const selectedEventSources = useMemo(() => {
    if (!selectedEvent) {
      return [];
    }
    const sources = selectedEvent.items
      .map((item) => item.source)
      .filter((source): source is string => Boolean(source));
    return Array.from(new Set(sources));
  }, [selectedEvent]);
  const selectedEventItems = useMemo(() => {
    if (!selectedEvent) {
      return [];
    }
    return [...selectedEvent.items].sort((a, b) => {
      const aTime = dayjs(a.publishedAt ?? a.createdAt).valueOf();
      const bTime = dayjs(b.publishedAt ?? b.createdAt).valueOf();
      return bTime - aTime;
    });
  }, [selectedEvent]);

  let content: ReactNode;
  if (loading && sortedGroups.length === 0 && sortedEventGroups.length === 0) {
    content = (
      <Card className="content-card">
        <Skeleton active paragraph={{ rows: 6 }} />
      </Card>
    );
  } else if (!loading && sortedGroups.length === 0 && sortedEventGroups.length === 0) {
    content = (
      <Empty
        description={t('pages.topics.empty', {
          defaultValue: 'Aggregation not ready yet. Try widening the window.'
        })}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  } else {
    content = (
      <div className="flex flex-col gap-6">
        <Space align="center" size="middle" wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('pages.topics.title', { defaultValue: 'Topics & Events' })}
          </Typography.Title>
          <Button size="small" onClick={() => void refetch()}>
            {t('common.refresh')}
          </Button>
          <Space size="small" align="center">
            <Typography.Text type="secondary">
              {t('pages.topics.filters.windowLabel', { defaultValue: 'Window' })}
            </Typography.Text>
            <Select
              size="small"
              value={windowDays}
              options={windowOptions}
              onChange={(value) => updateFilters({ windowDays: value })}
            />
          </Space>
          <Space size="small" align="center">
            <Typography.Text type="secondary">
              {t('pages.topics.filters.groupLabel', { defaultValue: 'Min group size' })}
            </Typography.Text>
            <Select
              size="small"
              value={minGroupSize}
              options={groupSizeOptions}
              onChange={(value) => updateFilters({ minGroupSize: value })}
            />
          </Space>
        </Space>

        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div className="flex flex-col gap-3">
            <Typography.Title level={5} style={{ margin: 0 }}>
              {t('pages.topics.eventsTitle', { defaultValue: 'Events' })}
            </Typography.Title>
            {sortedEventGroups.length === 0 ? (
              <Empty
                description={t('pages.topics.eventsEmpty', {
                  defaultValue: 'Aggregation not ready for events yet.'
                })}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              sortedEventGroups.map((group) => {
                const topics = group.topics ?? [];
                const entities = group.entities ?? [];
                const eventTitle = resolveEventTitle(group);

                return (
                  <Card
                    key={group.eventId}
                    className="content-card"
                    title={
                      <Space size="small" align="center">
                        <Typography.Text strong>{eventTitle}</Typography.Text>
                        <Tag>{group.count}</Tag>
                      </Space>
                    }
                    extra={
                      <Space size="small" align="center">
                        <Tooltip title={latestAtHelp}>
                          <Typography.Text type="secondary">
                            {latestAtLabel}:{' '}
                            {formatDateTime(group.latestAt, locale, {
                              year: 'numeric',
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
                          </Typography.Text>
                        </Tooltip>
                        <Button size="small" onClick={() => setSelectedEvent(group)}>
                          {t('pages.topics.eventDetail.action', { defaultValue: 'Details' })}
                        </Button>
                      </Space>
                    }
                  >
                    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                      {group.summary ? (
                        <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }}>
                          {group.summary}
                        </Typography.Paragraph>
                      ) : null}
                      {(topics.length > 0 || entities.length > 0) && (
                        <Space wrap size={[6, 6]}>
                          {topics.slice(0, 3).map((topic) => (
                            <Tag key={`topic-${group.eventId}-${topic}`} color="blue">
                              {topic}
                            </Tag>
                          ))}
                          {entities.slice(0, 3).map((entity) => (
                            <Tag key={`entity-${group.eventId}-${entity}`} color="purple">
                              {entity}
                            </Tag>
                          ))}
                        </Space>
                      )}
                      <Row gutter={[16, 16]}>
                        {group.items.map((item) => (
                          <Col key={item.id} xs={24} md={cardSpan}>
                            <NewsCard
                              item={{
                                id: item.itemMetaId,
                                title: item.title ?? eventTitle,
                                summary: item.summary ?? undefined,
                                source: item.source ?? undefined,
                                createdAt: item.createdAt,
                                publishedAt: item.publishedAt ?? undefined,
                                ingestedAt: item.createdAt,
                                topics,
                                entities
                              }}
                            />
                          </Col>
                        ))}
                      </Row>
                    </Space>
                  </Card>
                );
              })
            )}
          </div>

          <div className="flex flex-col gap-3">
            <Typography.Title level={5} style={{ margin: 0 }}>
              {t('pages.topics.topicsTitle', { defaultValue: 'Topics' })}
            </Typography.Title>
            {sortedGroups.length === 0 ? (
              <Empty
                description={t('pages.topics.topicsEmpty', {
                  defaultValue: 'Aggregation not ready for topics yet.'
                })}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              sortedGroups.map((group) => (
                <Card
                  key={group.topic}
                  className="content-card"
                  title={
                    <Space size="small" align="center">
                      <Typography.Text strong>{group.topic}</Typography.Text>
                      <Tag>{group.count}</Tag>
                    </Space>
                  }
                  extra={
                    <Tooltip title={latestAtHelp}>
                      <Typography.Text type="secondary">
                        {latestAtLabel}:{' '}
                        {formatDateTime(group.latestAt, locale, {
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </Typography.Text>
                    </Tooltip>
                  }
                >
                  <Row gutter={[16, 16]}>
                    {group.items.map((item) => (
                      <Col key={item.id} xs={24} md={cardSpan}>
                        <NewsCard
                          item={{
                            id: item.itemMetaId,
                            title: item.title ?? group.topic,
                            summary: item.summary ?? undefined,
                            source: item.source ?? undefined,
                            createdAt: item.createdAt,
                            publishedAt: item.publishedAt ?? undefined,
                            ingestedAt: item.createdAt,
                            topics: [group.topic]
                          }}
                        />
                      </Col>
                    ))}
                  </Row>
                </Card>
              ))
            )}
          </div>
        </Space>
      </div>
    );
  }

  return (
    <>
      {content}
      <Drawer
        title={t('pages.topics.eventDetail.title', { defaultValue: 'Event Details' })}
        width={drawerWidth}
        open={Boolean(selectedEvent)}
        onClose={() => setSelectedEvent(null)}
        destroyOnClose
      >
        {selectedEvent ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space direction="vertical" size={2}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                {selectedEventTitle}
              </Typography.Title>
              <Tooltip title={latestAtHelp}>
                <Typography.Text type="secondary">
                  {latestAtLabel}:{' '}
                  {formatDateTime(selectedEvent.latestAt, locale, {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </Typography.Text>
              </Tooltip>
            </Space>

            {selectedEvent.summary ? (
              <Typography.Paragraph type="secondary">
                {selectedEvent.summary}
              </Typography.Paragraph>
            ) : null}

            <Space direction="vertical" size="small">
              <Typography.Text type="secondary">
                {t('pages.topics.eventDetail.count', {
                  defaultValue: '{{count}} reports',
                  count: selectedEvent.count
                })}
              </Typography.Text>
              {(selectedEventTopics.length > 0 || selectedEventEntities.length > 0) && (
                <Space wrap size={[6, 6]}>
                  {selectedEventTopics.map((topic) => (
                    <Tag key={`detail-topic-${selectedEvent.eventId}-${topic}`} color="blue">
                      {topic}
                    </Tag>
                  ))}
                  {selectedEventEntities.map((entity) => (
                    <Tag key={`detail-entity-${selectedEvent.eventId}-${entity}`} color="purple">
                      {entity}
                    </Tag>
                  ))}
                </Space>
              )}
              {selectedEventSources.length > 0 && (
                <Space wrap size={[6, 6]}>
                  {selectedEventSources.map((source) => (
                    <Tag key={`detail-source-${selectedEvent.eventId}-${source}`} color="geekblue">
                      {source}
                    </Tag>
                  ))}
                </Space>
              )}
            </Space>

            <Typography.Title level={5} style={{ margin: 0 }}>
              {t('pages.topics.eventDetail.timelineTitle', { defaultValue: 'Timeline' })}
            </Typography.Title>
            <List
              dataSource={selectedEventItems}
              rowKey="id"
              locale={{
                emptyText: t('pages.topics.eventDetail.timelineEmpty', {
                  defaultValue: 'No related items.'
                })
              }}
              renderItem={(item) => {
                const publishedLabel = t('items.time.published', { defaultValue: 'Published' });
                const ingestedLabel = t('items.time.ingested', { defaultValue: 'Ingested' });
                const publishedAt = item.publishedAt ?? null;
                const ingestedAt = item.createdAt;
                const formatOptions = {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit'
                } as const;
                return (
                  <List.Item
                    key={item.id}
                    actions={[
                      <Button
                        key="open"
                        size="small"
                        onClick={() => router.push(`/items/${item.itemMetaId}`)}
                      >
                        {t('pages.topics.eventDetail.openItem', { defaultValue: 'Open item' })}
                      </Button>
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space size="small">
                          <Typography.Text strong>
                            {item.title ?? selectedEventTitle}
                          </Typography.Text>
                          {item.source ? <Tag>{item.source}</Tag> : null}
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size={0}>
                          <Typography.Text type="secondary">
                            {publishedLabel}:{' '}
                            {publishedAt
                              ? formatDateTime(publishedAt, locale, formatOptions)
                              : t('common.notAvailable')}
                          </Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {ingestedLabel}: {formatDateTime(ingestedAt, locale, formatOptions)}
                          </Typography.Text>
                          {item.summary ? (
                            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }} ellipsis={{ rows: 2 }}>
                              {item.summary}
                            </Typography.Paragraph>
                          ) : null}
                        </Space>
                      }
                    />
                  </List.Item>
                );
              }}
            />
          </Space>
        ) : null}
      </Drawer>
    </>
  );
}
