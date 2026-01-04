'use client';

import { Card, Col, Collapse, Descriptions, Empty, List, Row, Skeleton, Space, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useItemQuery } from '@/graphql/generated';
import { formatDateTime, resolveLocale } from '@/lib/i18n';

interface ItemDetailProps {
  itemId: string;
}

interface PayloadPanel {
  key: string;
  label: string;
  children: ReactNode;
}

const parseJson = <T,>(value?: string | null): T | null => {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const toStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
};

const toEntityNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
};

const toString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export function ItemDetail({ itemId }: ItemDetailProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data, loading, error } = useItemQuery({
    variables: { id: itemId }
  });

  const item = data?.item ?? null;
  const processedResult = useMemo(
    () => parseJson<Record<string, unknown>>(item?.processed?.result),
    [item?.processed?.result]
  );
  const rawPayload = useMemo(
    () => parseJson<Record<string, unknown>>(item?.raw?.payload),
    [item?.raw?.payload]
  );
  const processedStatus = item?.processed?.status ?? null;
  const rawSource = item?.raw?.source ?? null;

  const summary = toString(processedResult?.summary);
  const keyPoints = toStringList(processedResult?.key_points);
  const topics = toStringList(processedResult?.topics);
  const entities = toEntityNames(processedResult?.entities);
  const tags = toStringList(item?.processed?.tags);
  const publishedAt = toString(processedResult?.published_at);
  const source =
    toString(processedResult?.source) ?? toString(rawPayload?.sourceName) ?? toString(item?.raw?.source);
  const author = toString(processedResult?.author);
  const language = toString(processedResult?.language);
  const location = toString(processedResult?.location);
  const category = toString(processedResult?.category);
  const qualityScore = typeof processedResult?.quality_score === 'number' ? processedResult.quality_score : undefined;
  const originalUrl = toString(rawPayload?.url);
  const cleanedMarkdown = toString(processedResult?.cleaned_markdown);
  const hasSummaryContent = Boolean(summary) || keyPoints.length > 0;

  const formattedPublishedAt = publishedAt
    ? formatDateTime(publishedAt, locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    : t('common.notAvailable');

  if (loading && !item) {
    return (
      <Card className="content-card">
        <Skeleton active paragraph={{ rows: 8 }} />
      </Card>
    );
  }

  if (error) {
    return <Typography.Text type="danger">{error.message}</Typography.Text>;
  }

  if (!item) {
    return (
      <Empty
        description={t('items.detail.empty', { defaultValue: 'Item not found.' })}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      />
    );
  }

  const payloadPanels = [
    processedResult
      ? {
          key: 'processed',
          label: t('items.detail.payloadProcessed', { defaultValue: 'Processed JSON' }),
          children: (
            <pre className="max-h-[360px] overflow-auto rounded-lg bg-slate-950/5 p-4 text-xs">
              {JSON.stringify(processedResult, null, 2)}
            </pre>
          )
        }
      : null,
    cleanedMarkdown
      ? {
          key: 'markdown',
          label: t('items.detail.payloadMarkdown', { defaultValue: 'Cleaned Markdown' }),
          children: (
            <pre className="max-h-[360px] overflow-auto rounded-lg bg-slate-950/5 p-4 text-xs">
              {cleanedMarkdown}
            </pre>
          )
        }
      : null,
    rawPayload
      ? {
          key: 'raw',
          label: t('items.detail.payloadRaw', { defaultValue: 'Raw JSON' }),
          children: (
            <pre className="max-h-[360px] overflow-auto rounded-lg bg-slate-950/5 p-4 text-xs">
              {JSON.stringify(rawPayload, null, 2)}
            </pre>
          )
        }
      : null
  ].filter((panel): panel is PayloadPanel => Boolean(panel));

  return (
    <div className="flex flex-col gap-6">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {item.title}
        </Typography.Title>
        <Space size={[8, 8]} wrap>
          <Tag color="blue">{item.status}</Tag>
          {source ? <Tag color="geekblue">{source}</Tag> : null}
          {qualityScore !== undefined ? (
            <Tag color="purple">{t('items.detail.fields.quality', { defaultValue: 'Quality' })}: {Math.round(qualityScore * 100)}%</Tag>
          ) : null}
        </Space>
        <Typography.Text type="secondary">
          {t('items.detail.fields.publishedAt', { defaultValue: 'Published at' })}: {formattedPublishedAt}
        </Typography.Text>
        {originalUrl ? (
          <Typography.Link href={originalUrl} target="_blank" rel="noreferrer">
            {t('items.detail.readOriginal', { defaultValue: 'Read original' })}
          </Typography.Link>
        ) : null}
      </Space>

      <Card className="content-card" title={t('items.detail.summaryTitle', { defaultValue: 'Summary' })}>
        {hasSummaryContent ? (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {summary ? <Typography.Paragraph>{summary}</Typography.Paragraph> : (
              <Typography.Text type="secondary">
                {t('items.detail.summaryEmpty', { defaultValue: 'No summary available.' })}
              </Typography.Text>
            )}
            {keyPoints.length > 0 ? (
              <div>
                <Typography.Text strong>
                  {t('items.detail.keyPointsTitle', { defaultValue: 'Key points' })}
                </Typography.Text>
                <List
                  size="small"
                  dataSource={keyPoints}
                  renderItem={(point) => (
                    <List.Item>
                      <Typography.Text type="secondary">{point}</Typography.Text>
                    </List.Item>
                  )}
                />
              </div>
            ) : (
              <Typography.Text type="secondary">
                {t('items.detail.keyPointsEmpty', { defaultValue: 'No key points.' })}
              </Typography.Text>
            )}
          </Space>
        ) : (
          <Empty
            description={t('items.detail.summaryEmpty', { defaultValue: 'No summary available.' })}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card className="content-card" title={t('items.detail.metaTitle', { defaultValue: 'Metadata' })}>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label={t('items.detail.fields.itemId', { defaultValue: 'Item ID' })}>
                {item.id}
              </Descriptions.Item>
              <Descriptions.Item
                label={t('items.detail.fields.externalId', { defaultValue: 'External ID' })}
              >
                {item.meta?.externalId ?? t('common.notAvailable')}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.status', { defaultValue: 'Status' })}>
                <Tag color="blue">{item.status}</Tag>
              </Descriptions.Item>
              <Descriptions.Item
                label={t('items.detail.fields.processedStatus', { defaultValue: 'Processed status' })}
              >
                {processedStatus ? <Tag color="geekblue">{processedStatus}</Tag> : t('common.notAvailable')}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.createdAt', { defaultValue: 'Created at' })}>
                {formatDateTime(item.createdAt, locale, {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.updatedAt', { defaultValue: 'Updated at' })}>
                {formatDateTime(item.updatedAt, locale, {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.publishedAt', { defaultValue: 'Published at' })}>
                {formattedPublishedAt}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.source', { defaultValue: 'Source' })}>
                {source ?? t('common.notAvailable')}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.rawSource', { defaultValue: 'Raw source' })}>
                {rawSource ?? t('common.notAvailable')}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.author', { defaultValue: 'Author' })}>
                {author ?? t('common.notAvailable')}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.language', { defaultValue: 'Language' })}>
                {language ?? t('common.notAvailable')}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.location', { defaultValue: 'Location' })}>
                {location ?? t('common.notAvailable')}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.category', { defaultValue: 'Category' })}>
                {category ?? t('common.notAvailable')}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card className="content-card" title={t('items.detail.contextTitle', { defaultValue: 'Context' })}>
            {topics.length === 0 && entities.length === 0 && tags.length === 0 ? (
              <Empty
                description={t('items.detail.contextEmpty', { defaultValue: 'No tags or entities.' })}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                {topics.length > 0 ? (
                  <Space wrap size={[6, 6]}>
                    {topics.map((topic) => (
                      <Tag key={`topic-${topic}`} color="blue">
                        {topic}
                      </Tag>
                    ))}
                  </Space>
                ) : null}
                {entities.length > 0 ? (
                  <Space wrap size={[6, 6]}>
                    {entities.map((entity) => (
                      <Tag key={`entity-${entity}`} color="purple">
                        {entity}
                      </Tag>
                    ))}
                  </Space>
                ) : null}
                {tags.length > 0 ? (
                  <Space wrap size={[6, 6]}>
                    {tags.map((tag) => (
                      <Tag key={`tag-${tag}`}>{tag}</Tag>
                    ))}
                  </Space>
                ) : null}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Card className="content-card" title={t('items.detail.payloadTitle', { defaultValue: 'Payload' })}>
        {payloadPanels.length > 0 ? (
          <Collapse items={payloadPanels} />
        ) : (
          <Empty
            description={t('items.detail.payloadEmpty', { defaultValue: 'No payload available.' })}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        )}
      </Card>
    </div>
  );
}
