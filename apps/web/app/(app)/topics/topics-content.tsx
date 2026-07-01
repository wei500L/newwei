'use client';

import { gql, useQuery } from '@apollo/client';
import { Button, Card, Col, Drawer, Empty, Grid, List, Row, Select, Skeleton, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { NewsCard } from '@/app/(app)/items/components/news-card';
import { ArticlePublishedTime } from '@/components/article-published-time';
import dayjs from '@/lib/dayjs';
import { formatDateTime, resolveLocale } from '@/lib/i18n';

import {
  DEFAULT_EVENT_MIN_GROUP_SIZE,
  DEFAULT_TAB,
  DEFAULT_WINDOW_DAYS,
  parsePositiveInt,
  resolveTopicsFilterLayoutMode,
  type TopicsTabKey
} from './topics-view-state';

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
const DEFAULT_EVENT_LIMIT = 8;
const DEFAULT_EVENT_ITEMS_PER_GROUP = 4;

const DATE_TIME_FORMAT = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
} as const;

interface TopicsContentProps {
  initialData?: {
    topicGroups: TopicGroup[];
    eventGroups: EventGroup[];
  } | null;
}

const uniqueLabels = (values: (string | null | undefined)[]) => {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim() ?? '')
        .filter((value) => value.length > 0)
    )
  );
};

const splitPreview = <T,>(values: T[], max: number) => {
  return {
    visible: values.slice(0, max),
    hiddenCount: Math.max(values.length - max, 0)
  };
};

export function TopicsContent({ initialData = null }: TopicsContentProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const latestAtLabel = t('pages.topics.latestAtLabel');
  const latestAtHelp = t('pages.topics.latestAtHelp');
  const screens = Grid.useBreakpoint();
  const filterLayoutMode = resolveTopicsFilterLayoutMode(screens);
  const isDesktopStickyFilter = filterLayoutMode === 'desktopSticky';
  const [selectedEvent, setSelectedEvent] = useState<EventGroup | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<TopicGroup | null>(null);
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
  const activeTab = useMemo<TopicsTabKey>(() => {
    const value = searchParams.get('tab');
    return value === 'topics' ? 'topics' : DEFAULT_TAB;
  }, [searchParams]);

  const updateFilters = useCallback(
    (updates: { windowDays?: number; minGroupSize?: number; tab?: TopicsTabKey }) => {
      const next = new URLSearchParams(searchParams.toString());
      const nextWindow = updates.windowDays ?? windowDays;
      const nextMinGroup = updates.minGroupSize ?? minGroupSize;
      const nextTab = updates.tab ?? activeTab;
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
      if (nextTab === DEFAULT_TAB) {
        next.delete('tab');
      } else {
        next.set('tab', nextTab);
      }
      const nextQuery = next.toString();
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
    },
    [activeTab, minGroupSize, pathname, router, searchParams, windowDays]
  );

  const { data, loading, error, refetch } = useQuery<{
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
  const sortedEventGroups = useMemo(() => {
    const groups = resolvedData?.eventGroups ?? [];
    return [...groups].sort((a, b) => {
      const timeDiff = dayjs(b.latestAt).valueOf() - dayjs(a.latestAt).valueOf();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return b.count - a.count;
    });
  }, [resolvedData?.eventGroups]);
  const sortedGroups = useMemo(() => {
    const groups = resolvedData?.topicGroups ?? [];
    return [...groups].sort((a, b) => {
      const timeDiff = dayjs(b.latestAt).valueOf() - dayjs(a.latestAt).valueOf();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return b.count - a.count;
    });
  }, [resolvedData?.topicGroups]);
  const drawerWidth = screens.lg ? 720 : undefined;

  const windowOptions = useMemo(
    () =>
      [7, 14, 30, 90].map((days) => ({
        value: days,
        label: t('pages.topics.filters.windowOption', {
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
      t('pages.topics.eventFallbackTitle')
    );
  };

  const openEventDrawer = useCallback((group: EventGroup) => {
    setSelectedTopic(null);
    setSelectedEvent(group);
  }, []);

  const openTopicDrawer = useCallback((group: TopicGroup) => {
    setSelectedEvent(null);
    setSelectedTopic(group);
  }, []);

  const onRowKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>, action: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  }, []);

  const selectedEventTitle = selectedEvent ? resolveEventTitle(selectedEvent) : '';
  const selectedEventTopics = selectedEvent?.topics ?? [];
  const selectedEventEntities = selectedEvent?.entities ?? [];
  const selectedEventSources = useMemo(() => {
    if (!selectedEvent) {
      return [];
    }
    return uniqueLabels(selectedEvent.items.map((item) => item.source));
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

  const selectedTopicSources = useMemo(() => {
    if (!selectedTopic) {
      return [];
    }
    return uniqueLabels(selectedTopic.items.map((item) => item.source));
  }, [selectedTopic]);

  const selectedTopicItems = useMemo(() => {
    if (!selectedTopic) {
      return [];
    }
    return [...selectedTopic.items].sort((a, b) => {
      const aTime = dayjs(a.publishedAt ?? a.createdAt).valueOf();
      const bTime = dayjs(b.publishedAt ?? b.createdAt).valueOf();
      return bTime - aTime;
    });
  }, [selectedTopic]);

  let content: ReactNode;
  if (loading && sortedGroups.length === 0 && sortedEventGroups.length === 0) {
    content = (
      <Card className="content-card">
        <Skeleton active paragraph={{ rows: 6 }} />
      </Card>
    );
  } else {
    content = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Space direction="vertical" size={2}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t('pages.topics.title')}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t('pages.topics.subtitle')}
            </Typography.Text>
          </Space>
        </div>

        <Card
          size="small"
          className={`content-card ${isDesktopStickyFilter ? 'sticky top-2 z-10' : ''}`}
          styles={{
            body: {
              padding: isDesktopStickyFilter ? '12px 16px' : '14px 16px'
            }
          }}
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('pages.topics.filters.windowLabel')}
                </Typography.Text>
                <Select
                  size="small"
                  value={windowDays}
                  options={windowOptions}
                  onChange={(value) => updateFilters({ windowDays: value })}
                  style={isDesktopStickyFilter ? { minWidth: 132 } : { width: '100%' }}
                />
              </div>

              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('pages.topics.filters.groupLabel')}
                </Typography.Text>
                <Select
                  size="small"
                  value={minGroupSize}
                  options={groupSizeOptions}
                  onChange={(value) => updateFilters({ minGroupSize: value })}
                  style={isDesktopStickyFilter ? { minWidth: 152 } : { width: '100%' }}
                />
              </div>
            </div>

            <Button
              size="small"
              onClick={() => void refetch()}
              loading={loading}
              className="self-start lg:self-auto"
            >
              {t('common.refresh')}
            </Button>
          </div>
        </Card>

        <Card className="content-card">
          {error ? (
            <Typography.Text type="danger">
              {t('pages.topics.loadFailed')}: {error.message}
            </Typography.Text>
          ) : null}

          <Tabs
            activeKey={activeTab}
            destroyOnHidden
            onChange={(key) => updateFilters({ tab: key === 'topics' ? 'topics' : 'events' })}
            items={[
              {
                key: 'events',
                label: t('pages.topics.tabs.events'),
                children:
                  sortedEventGroups.length === 0 ? (
                    <Empty
                      description={t('pages.topics.eventsEmpty')}
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                  ) : (
                    <List
                      dataSource={sortedEventGroups}
                      rowKey="eventId"
                      renderItem={(group) => {
                        const eventTitle = resolveEventTitle(group);
                        const topics = uniqueLabels(group.topics ?? []);
                        const entities = uniqueLabels(group.entities ?? []);
                        const sources = uniqueLabels(group.items.map((item) => item.source));
                        const topicPreview = splitPreview(topics, 3);
                        const entityPreview = splitPreview(entities, 3);
                        const sourcePreview = splitPreview(sources, 3);

                        return (
                          <List.Item
                            key={group.eventId}
                            actions={[
                              <Button
                                key="details"
                                size="small"
                                onClick={() => openEventDrawer(group)}
                              >
                                {t('pages.topics.list.openDetails')}
                              </Button>
                            ]}
                          >
                            <div
                              role="button"
                              tabIndex={0}
                              className="w-full cursor-pointer"
                              onClick={() => openEventDrawer(group)}
                              onKeyDown={(event) => onRowKeyDown(event, () => openEventDrawer(group))}
                            >
                              <List.Item.Meta
                                title={
                                  <Space size={[6, 6]} wrap>
                                    <Typography.Text strong>{eventTitle}</Typography.Text>
                                    <Tag>
                                      {t('pages.topics.list.countLabel')}: {group.count}
                                    </Tag>
                                  </Space>
                                }
                                description={
                                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                                    {group.summary ? (
                                      <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>
                                        {group.summary}
                                      </Typography.Paragraph>
                                    ) : null}
                                    <Tooltip title={latestAtHelp}>
                                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                        {latestAtLabel}: {formatDateTime(group.latestAt, locale, DATE_TIME_FORMAT)}
                                      </Typography.Text>
                                    </Tooltip>
                                    <Space wrap size={[6, 6]}>
                                      {topicPreview.visible.map((topic) => (
                                        <Tag key={`event-topic-${group.eventId}-${topic}`} color="blue">
                                          {topic}
                                        </Tag>
                                      ))}
                                      {topicPreview.hiddenCount > 0 ? (
                                        <Tag color="blue">
                                          {t('pages.topics.list.moreTag', {
                                            count: topicPreview.hiddenCount
                                          })}
                                        </Tag>
                                      ) : null}

                                      {entityPreview.visible.map((entity) => (
                                        <Tag key={`event-entity-${group.eventId}-${entity}`} color="purple">
                                          {entity}
                                        </Tag>
                                      ))}
                                      {entityPreview.hiddenCount > 0 ? (
                                        <Tag color="purple">
                                          {t('pages.topics.list.moreTag', {
                                            count: entityPreview.hiddenCount
                                          })}
                                        </Tag>
                                      ) : null}

                                      {sourcePreview.visible.map((source) => (
                                        <Tag key={`event-source-${group.eventId}-${source}`} color="geekblue">
                                          {source}
                                        </Tag>
                                      ))}
                                      {sourcePreview.hiddenCount > 0 ? (
                                        <Tag color="geekblue">
                                          {t('pages.topics.list.moreTag', {
                                            count: sourcePreview.hiddenCount
                                          })}
                                        </Tag>
                                      ) : null}
                                    </Space>
                                  </Space>
                                }
                              />
                            </div>
                          </List.Item>
                        );
                      }}
                    />
                  )
              },
              {
                key: 'topics',
                label: t('pages.topics.tabs.topics'),
                children:
                  sortedGroups.length === 0 ? (
                    <Empty
                      description={t('pages.topics.topicsEmpty')}
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                  ) : (
                    <List
                      dataSource={sortedGroups}
                      rowKey="topic"
                      renderItem={(group) => {
                        const sources = uniqueLabels(group.items.map((item) => item.source));
                        const sourcePreview = splitPreview(sources, 3);

                        return (
                          <List.Item
                            key={group.topic}
                            actions={[
                              <Button
                                key="preview"
                                size="small"
                                onClick={() => openTopicDrawer(group)}
                              >
                                {t('pages.topics.list.openTopic')}
                              </Button>
                            ]}
                          >
                            <div
                              role="button"
                              tabIndex={0}
                              className="w-full cursor-pointer"
                              onClick={() => openTopicDrawer(group)}
                              onKeyDown={(event) => onRowKeyDown(event, () => openTopicDrawer(group))}
                            >
                              <List.Item.Meta
                                title={
                                  <Space size={[6, 6]} wrap>
                                    <Typography.Text strong>{group.topic}</Typography.Text>
                                    <Tag>
                                      {t('pages.topics.list.countLabel')}: {group.count}
                                    </Tag>
                                  </Space>
                                }
                                description={
                                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                                    <Tooltip title={latestAtHelp}>
                                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                        {latestAtLabel}: {formatDateTime(group.latestAt, locale, DATE_TIME_FORMAT)}
                                      </Typography.Text>
                                    </Tooltip>
                                    {sourcePreview.visible.length > 0 ? (
                                      <Space wrap size={[6, 6]}>
                                        {sourcePreview.visible.map((source) => (
                                          <Tag key={`topic-source-${group.topic}-${source}`} color="geekblue">
                                            {source}
                                          </Tag>
                                        ))}
                                        {sourcePreview.hiddenCount > 0 ? (
                                          <Tag color="geekblue">
                                            {t('pages.topics.list.moreTag', {
                                              count: sourcePreview.hiddenCount
                                            })}
                                          </Tag>
                                        ) : null}
                                      </Space>
                                    ) : null}
                                  </Space>
                                }
                              />
                            </div>
                          </List.Item>
                        );
                      }}
                    />
                  )
              }
            ]}
          />
        </Card>
      </div>
    );
  }

  return (
    <>
      {content}
      <Drawer
        title={t('pages.topics.eventDetail.title')}
        width={drawerWidth}
        open={Boolean(selectedEvent)}
        onClose={() => setSelectedEvent(null)}
        destroyOnHidden
      >
        {selectedEvent ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space direction="vertical" size={2}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                {selectedEventTitle}
              </Typography.Title>
              <Tooltip title={latestAtHelp}>
                <Typography.Text type="secondary">
                  {latestAtLabel}: {formatDateTime(selectedEvent.latestAt, locale, DATE_TIME_FORMAT)}
                </Typography.Text>
              </Tooltip>
            </Space>

            {selectedEvent.summary ? (
              <Typography.Paragraph type="secondary">{selectedEvent.summary}</Typography.Paragraph>
            ) : null}

            <Space direction="vertical" size="small">
              <Typography.Text type="secondary">
                {t('pages.topics.eventDetail.count', {
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
              {t('pages.topics.eventDetail.timelineTitle')}
            </Typography.Title>
            <List
              dataSource={selectedEventItems}
              rowKey="id"
              locale={{
                emptyText: t('pages.topics.eventDetail.timelineEmpty')
              }}
              renderItem={(item) => {
                const ingestedLabel = t('items.time.ingested');
                const publishedAt = item.publishedAt ?? null;
                const ingestedAt = item.createdAt;
                return (
                  <List.Item
                    key={item.id}
                    actions={[
                      <Button
                        key="open"
                        size="small"
                        onClick={() => router.push(`/items/${item.itemMetaId}`)}
                      >
                        {t('pages.topics.eventDetail.openItem')}
                      </Button>
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space size="small">
                          <Typography.Text strong>{item.title ?? selectedEventTitle}</Typography.Text>
                          {item.source ? <Tag color="geekblue">{item.source}</Tag> : null}
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size={0}>
                          <ArticlePublishedTime
                            publishedAt={publishedAt}
                            locale={locale}
                            formatOptions={DATE_TIME_FORMAT}
                            primaryStrong
                            secondaryStyle={{ fontSize: 12 }}
                          />
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {ingestedLabel}: {formatDateTime(ingestedAt, locale, DATE_TIME_FORMAT)}
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

      <Drawer
        title={t('pages.topics.topicDetail.title')}
        width={drawerWidth}
        open={Boolean(selectedTopic)}
        onClose={() => setSelectedTopic(null)}
        destroyOnHidden
      >
        {selectedTopic ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space direction="vertical" size={2}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                {selectedTopic.topic}
              </Typography.Title>
              <Tooltip title={latestAtHelp}>
                <Typography.Text type="secondary">
                  {latestAtLabel}: {formatDateTime(selectedTopic.latestAt, locale, DATE_TIME_FORMAT)}
                </Typography.Text>
              </Tooltip>
              <Typography.Text type="secondary">
                {t('pages.topics.eventDetail.count', {
                  count: selectedTopic.count
                })}
              </Typography.Text>
            </Space>

            {selectedTopicSources.length > 0 ? (
              <Space wrap size={[6, 6]}>
                {selectedTopicSources.map((source) => (
                  <Tag key={`topic-detail-source-${selectedTopic.topic}-${source}`} color="geekblue">
                    {source}
                  </Tag>
                ))}
              </Space>
            ) : null}

            <Typography.Title level={5} style={{ margin: 0 }}>
              {t('pages.topics.topicDetail.relatedItemsTitle')}
            </Typography.Title>

            {selectedTopicItems.length === 0 ? (
              <Empty
                description={t('pages.topics.topicDetail.empty')}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              <Row gutter={[16, 16]}>
                {selectedTopicItems.map((item) => (
                  <Col key={item.id} xs={24} lg={12}>
                    <NewsCard
                      item={{
                        id: item.itemMetaId,
                        title: item.title ?? selectedTopic.topic,
                        summary: item.summary ?? undefined,
                        source: item.source ?? undefined,
                        createdAt: item.createdAt,
                        publishedAt: item.publishedAt ?? undefined,
                        ingestedAt: item.createdAt,
                        topics: [selectedTopic.topic]
                      }}
                    />
                  </Col>
                ))}
              </Row>
            )}
          </Space>
        ) : null}
      </Drawer>
    </>
  );
}
