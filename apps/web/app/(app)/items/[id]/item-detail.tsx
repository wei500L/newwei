'use client';

import { InfoCircleOutlined } from '@ant-design/icons';
import { Card, Col, Collapse, Descriptions, List, Row, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ChartEmptyState } from '@/components/chart-empty-state';
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
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      if (entry && typeof entry === 'object') {
        return (entry as { name?: unknown }).name;
      }
      return undefined;
    })
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
  const [showDelayHint, setShowDelayHint] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  useEffect(() => {
    if (!loading) {
      setShowDelayHint(false);
      return;
    }
    const timeout = setTimeout(() => setShowDelayHint(true), 1200);
    return () => clearTimeout(timeout);
  }, [loading]);

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
  const duplicateSimilarity = item?.processed?.duplicateSimilarity ?? null;
  const duplicateOf = item?.processed?.duplicateOf ?? null;
  const llm = item?.processed?.llm ?? null;

  const summary = toString(processedResult?.summary);
  const keyPoints = toStringList(processedResult?.key_points);
  const topics = toStringList(processedResult?.topics);
  const entities = toEntityNames(processedResult?.entities);
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
  const summaryText = summary?.trim();
  const canExpandSummary = Boolean(summaryText && summaryText.length > 300);
  const displaySummary =
    summaryText && !summaryExpanded && canExpandSummary
      ? `${summaryText.slice(0, 300).trimEnd()}…`
      : summaryText;
  const expandLabel = t('common.expand', { defaultValue: 'Show more' });
  const collapseLabel = t('common.collapse', { defaultValue: 'Show less' });
  const keyPointsDisplay = keyPoints.slice(0, 8);
  const extraKeyPoints = Math.max(keyPoints.length - keyPointsDisplay.length, 0);
  const topicsDisplay = topics.slice(0, 5);
  const entitiesDisplay = entities.slice(0, 5);
  const extraTopics = Math.max(topics.length - topicsDisplay.length, 0);
  const extraEntities = Math.max(entities.length - entitiesDisplay.length, 0);
  const duplicateScoreLabel =
    typeof duplicateSimilarity === 'number'
      ? `${Math.round(duplicateSimilarity * 100)}%`
      : t('common.notAvailable');
  const llmModel = llm?.model ?? t('common.notAvailable');
  const llmLatency =
    typeof llm?.latencyMs === 'number'
      ? `${Math.round(llm.latencyMs)} ms`
      : t('common.notAvailable');
  const llmCost =
    typeof llm?.costUsd === 'number'
      ? `$${llm.costUsd.toFixed(4)}`
      : t('common.notAvailable');
  const llmTokens =
    typeof llm?.totalTokens === 'number'
      ? Math.round(llm.totalTokens).toString()
      : t('common.notAvailable');
  const llmSummary = useMemo(() => {
    const bits: string[] = [];
    if (llm?.model) {
      bits.push(llm.model);
    }
    if (typeof llm?.latencyMs === 'number') {
      bits.push(`${Math.round(llm.latencyMs)} ms`);
    }
    if (typeof llm?.costUsd === 'number') {
      bits.push(`$${llm.costUsd.toFixed(4)}`);
    }
    return bits.length > 0 ? bits.join(' | ') : null;
  }, [llm?.costUsd, llm?.latencyMs, llm?.model]);
  const publishedLabel = t('items.time.published', { defaultValue: 'Published' });
  const ingestedLabel = t('items.time.ingested', { defaultValue: 'Ingested' });

  const formattedPublishedAt = publishedAt
    ? formatDateTime(publishedAt, locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      })
    : t('common.notAvailable');

  useEffect(() => {
    setSummaryExpanded(false);
  }, [itemId]);

  if (loading && !item) {
    return (
      <Card className="content-card">
        <Space direction="vertical" size="large">
          <Skeleton active paragraph={{ rows: 8 }} />
          {showDelayHint ? (
            <ChartEmptyState
              className="h-auto"
              description={t('common.loadingDelayed', {
                defaultValue: 'Data is taking longer than usual. Please hold on or refresh.'
              })}
            />
          ) : null}
        </Space>
      </Card>
    );
  }

  if (error) {
    return <Typography.Text type="danger">{error.message}</Typography.Text>;
  }

  if (!item) {
    return (
      <ChartEmptyState
        className="h-auto py-12"
        description={t('items.detail.empty', { defaultValue: 'Item not found.' })}
      />
    );
  }

  const formattedIngestedAt = formatDateTime(item.createdAt, locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

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
        <Typography.Title level={4} ellipsis={{ rows: 2 }} style={{ margin: 0 }}>
          {item.title}
        </Typography.Title>
        <Space size={[8, 8]} wrap>
          <Tag color="blue">{item.status}</Tag>
          {qualityScore !== undefined ? (
            <Tag color="purple">{t('items.detail.fields.quality', { defaultValue: 'Quality' })}: {Math.round(qualityScore * 100)}%</Tag>
          ) : null}
          {typeof duplicateSimilarity === 'number' ? (
            <Tag color="gold">
              {duplicateOf
                ? t('items.duplicate.duplicate', { defaultValue: 'Duplicate' })
                : t('items.duplicate.similarity', { defaultValue: 'Similarity' })}{' '}
              {Math.round(duplicateSimilarity * 100)}%
            </Tag>
          ) : null}
        </Space>
        <Space size={[8, 0]} wrap align="center">
          {source ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {source}
            </Typography.Text>
          ) : null}
          {publishedAt ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {publishedLabel}: {formattedPublishedAt}
            </Typography.Text>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {ingestedLabel}: {formattedIngestedAt}
          </Typography.Text>
          {llmSummary ? (
            <Tooltip
              title={
                <div className="text-xs">
                  {llm?.model ? <div>Model: {llm.model}</div> : null}
                  {llm?.promptVersion ? <div>Prompt: {llm.promptVersion}</div> : null}
                  {typeof llm?.totalTokens === 'number' ? (
                    <div>Tokens: {Math.round(llm.totalTokens)}</div>
                  ) : null}
                  {typeof llm?.latencyMs === 'number' ? (
                    <div>Latency: {Math.round(llm.latencyMs)} ms</div>
                  ) : null}
                  {typeof llm?.costUsd === 'number' ? (
                    <div>Cost: ${llm.costUsd.toFixed(4)}</div>
                  ) : null}
                </div>
              }
            >
              <Space size={4}>
                <InfoCircleOutlined className="text-slate-400" />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  LLM: {llmSummary}
                </Typography.Text>
              </Space>
            </Tooltip>
          ) : null}
        </Space>
        {originalUrl ? (
          <Typography.Link href={originalUrl} target="_blank" rel="noreferrer">
            {t('items.detail.readOriginal', { defaultValue: 'Read original' })}
          </Typography.Link>
        ) : null}
      </Space>

      <Card className="content-card" title={t('items.detail.summaryTitle', { defaultValue: 'Summary' })}>
        {hasSummaryContent ? (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {displaySummary ? (
              <div>
                <Typography.Paragraph
                  ellipsis={summaryExpanded ? false : { rows: 3 }}
                  style={{ lineHeight: 1.8, marginBottom: 0 }}
                >
                  {displaySummary}
                </Typography.Paragraph>
                {canExpandSummary ? (
                  <Typography.Link
                    onClick={() => setSummaryExpanded((expanded) => !expanded)}
                    style={{ fontSize: 12 }}
                  >
                    {summaryExpanded ? collapseLabel : expandLabel}
                  </Typography.Link>
                ) : null}
              </div>
            ) : (
              <Typography.Text type="secondary">
                {t('items.detail.summaryEmpty', { defaultValue: 'No summary available.' })}
              </Typography.Text>
            )}
            {keyPointsDisplay.length > 0 ? (
              <div>
                <Typography.Text strong>
                  {t('items.detail.keyPointsTitle', { defaultValue: 'Key points' })}
                </Typography.Text>
                <List
                  size="small"
                  dataSource={keyPointsDisplay}
                  renderItem={(point) => (
                    <List.Item>
                      <Typography.Text type="secondary">{point}</Typography.Text>
                    </List.Item>
                  )}
                />
                {extraKeyPoints > 0 ? (
                  <Typography.Text type="secondary">
                    {t('items.detail.keyPointsMore', {
                      defaultValue: '+{{count}} more',
                      count: extraKeyPoints
                    })}
                  </Typography.Text>
                ) : null}
              </div>
            ) : (
              <Typography.Text type="secondary">
                {t('items.detail.keyPointsEmpty', { defaultValue: 'No key points.' })}
              </Typography.Text>
            )}
          </Space>
        ) : (
          <ChartEmptyState
            className="h-auto py-6"
            description={t('items.detail.summaryEmpty', { defaultValue: 'No summary available.' })}
          />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card className="content-card" title={t('items.detail.metaTitle', { defaultValue: 'Metadata' })}>
            <Descriptions column={1} size="small">
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
              <Descriptions.Item
                label={t('items.detail.fields.duplicateSimilarity', { defaultValue: 'Duplicate similarity' })}
              >
                {duplicateScoreLabel}
              </Descriptions.Item>
              <Descriptions.Item
                label={t('items.detail.fields.duplicateOf', { defaultValue: 'Duplicate of' })}
              >
                {duplicateOf ?? t('common.notAvailable')}
              </Descriptions.Item>
              <Descriptions.Item
                label={t('items.detail.fields.llmModel', { defaultValue: 'LLM model' })}
              >
                {llmModel}
              </Descriptions.Item>
              <Descriptions.Item
                label={t('items.detail.fields.llmLatency', { defaultValue: 'LLM latency' })}
              >
                {llmLatency}
              </Descriptions.Item>
              <Descriptions.Item
                label={t('items.detail.fields.llmCost', { defaultValue: 'LLM cost' })}
              >
                {llmCost}
              </Descriptions.Item>
              <Descriptions.Item
                label={t('items.detail.fields.llmTokens', { defaultValue: 'LLM total tokens' })}
              >
                {llmTokens}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.createdAt', { defaultValue: 'Created at' })}>
                {formatDateTime(item.createdAt, locale, {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZoneName: 'short'
                })}
              </Descriptions.Item>
              <Descriptions.Item label={t('items.detail.fields.updatedAt', { defaultValue: 'Updated at' })}>
                {formatDateTime(item.updatedAt, locale, {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZoneName: 'short'
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
            {topics.length === 0 && entities.length === 0 ? (
              <ChartEmptyState
                className="h-auto py-6"
                description={t('items.detail.contextEmpty', { defaultValue: 'No topics or entities.' })}
              />
            ) : (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                {topicsDisplay.length > 0 ? (
                  <Space wrap size={[6, 6]}>
                    {topicsDisplay.map((topic) => (
                      <Tag key={`topic-${topic}`} color="blue">
                        {topic}
                      </Tag>
                    ))}
                    {extraTopics > 0 ? <Tag>+{extraTopics}</Tag> : null}
                  </Space>
                ) : null}
                {entitiesDisplay.length > 0 ? (
                  <Space wrap size={[6, 6]}>
                    {entitiesDisplay.map((entity) => (
                      <Tag key={`entity-${entity}`} color="purple">
                        {entity}
                      </Tag>
                    ))}
                    {extraEntities > 0 ? <Tag>+{extraEntities}</Tag> : null}
                  </Space>
                ) : null}
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Card className="content-card" title={t('items.detail.payloadTitle', { defaultValue: 'Full text & JSON' })}>
        {payloadPanels.length > 0 ? (
          <Collapse items={payloadPanels} ghost />
        ) : (
          <ChartEmptyState
            className="h-auto py-6"
            description={t('items.detail.payloadEmpty', { defaultValue: 'No payload available.' })}
          />
        )}
      </Card>
    </div>
  );
}
