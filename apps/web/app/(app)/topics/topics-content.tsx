'use client';

import { gql, useQuery } from '@apollo/client';
import { Button, Card, Col, Empty, Grid, Row, Skeleton, Space, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { NewsCard } from '@/app/(app)/items/components/news-card';
import { formatDateTime, resolveLocale } from '@/lib/i18n';

interface TopicGroupItem {
  id: string;
  itemMetaId: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  createdAt: string;
}

interface TopicGroup {
  topic: string;
  count: number;
  latestAt: string;
  items: TopicGroupItem[];
}

const TOPIC_GROUPS_QUERY = gql`
  query TopicGroups($limit: Int, $itemsPerGroup: Int, $windowDays: Int) {
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
  }
`;

const DEFAULT_LIMIT = 12;
const DEFAULT_ITEMS_PER_GROUP = 4;
const DEFAULT_WINDOW_DAYS = 30;

export function TopicsContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const screens = Grid.useBreakpoint();

  const { data, loading, refetch } = useQuery<{ topicGroups: TopicGroup[] }>(TOPIC_GROUPS_QUERY, {
    variables: {
      limit: DEFAULT_LIMIT,
      itemsPerGroup: DEFAULT_ITEMS_PER_GROUP,
      windowDays: DEFAULT_WINDOW_DAYS
    },
    fetchPolicy: 'network-only'
  });

  const groups = data?.topicGroups ?? [];
  const cardSpan = screens.xl ? 6 : screens.lg ? 8 : screens.md ? 12 : 24;

  if (loading && groups.length === 0) {
    return (
      <Card className="content-card">
        <Skeleton active paragraph={{ rows: 6 }} />
      </Card>
    );
  }

  if (!loading && groups.length === 0) {
    return (
      <Empty
        description={t("pages.topics.empty", { defaultValue: "No topics available yet." })}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Space align="center" size="middle">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.topics.title", { defaultValue: "Topics & Events" })}
        </Typography.Title>
        <Button size="small" onClick={() => void refetch()}>
          {t('common.refresh')}
        </Button>
      </Space>

      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {groups.map((group) => (
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
              <Typography.Text type="secondary">
                {formatDateTime(group.latestAt, locale, {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </Typography.Text>
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
        ))}
      </Space>
    </div>
  );
}
