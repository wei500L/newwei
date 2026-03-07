'use client';

import { App, Button, Card, Checkbox, Collapse, Empty, Input, List, Select, Skeleton, Space, Tag, Typography } from 'antd';
import { useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { ChartEmptyState } from '@/components/chart-empty-state';
import { createApiClient } from '@/lib/api-client';
import { captureClientError } from '@/lib/client-telemetry';
import {
  type ContentSubscriptionBatchResponse,
  type ContentSubscriptionCatalogItem,
  type ContentSubscriptionCatalogResponse,
  type ContentSubscriptionItem,
  type ContentSubscriptionKind,
  type ContentSubscriptionListResponse,
  buildContentSubscriptionKey,
} from '@/lib/content-subscriptions';
import { formatDateTime, resolveLocale } from '@/lib/i18n';

interface ContentSubscriptionsTabProps {
  accessToken?: string;
  active: boolean;
}

const DATE_TIME_FORMAT = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
} as const;
const UNCATEGORIZED_TAXONOMY_FILTER = '__uncategorized__';

interface GroupedItems<T extends { taxonomyPath: string | null; taxonomyDisplayName: string | null; taxonomyLabels: string[] }> {
  groupKey: string;
  title: string;
  labels: string[];
  items: T[];
}

export function ContentSubscriptionsTab({ accessToken, active }: ContentSubscriptionsTabProps) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const locale = resolveLocale(i18n.language);
  const apiClient = useMemo(() => createApiClient({ accessToken }), [accessToken]);

  const [loading, setLoading] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [subscriptions, setSubscriptions] = useState<ContentSubscriptionListResponse | null>(null);
  const [catalog, setCatalog] = useState<ContentSubscriptionCatalogResponse | null>(null);
  const [recommendations, setRecommendations] = useState<ContentSubscriptionCatalogResponse | null>(null);
  const [subscriptionQuery, setSubscriptionQuery] = useState('');
  const [catalogInput, setCatalogInput] = useState('');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogKind, setCatalogKind] = useState<'all' | ContentSubscriptionKind>('all');
  const [taxonomyFilter, setTaxonomyFilter] = useState<string | null>(null);
  const [selectedSubscriptionKeys, setSelectedSubscriptionKeys] = useState<string[]>([]);
  const [selectedCatalogKeys, setSelectedCatalogKeys] = useState<string[]>([]);

  const loadSubscriptions = useCallback(async () => {
    const response = await apiClient.get<ContentSubscriptionListResponse>('user-content-subscriptions');
    setSubscriptions(response.data ?? null);
  }, [apiClient]);

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    try {
      const params = new URLSearchParams();
      if (catalogKind !== 'all') {
        params.set('kind', catalogKind);
      }
      if (catalogQuery.trim()) {
        params.set('query', catalogQuery.trim());
      }
      if (taxonomyFilter === UNCATEGORIZED_TAXONOMY_FILTER) {
        params.set('taxonomyPath', UNCATEGORIZED_TAXONOMY_FILTER);
      } else if (taxonomyFilter) {
        params.set('taxonomyPath', taxonomyFilter);
      }
      params.set('limit', '200');
      const response = await apiClient.get<ContentSubscriptionCatalogResponse>(
        `user-content-subscriptions/catalog${params.toString() ? `?${params.toString()}` : ''}`,
      );
      setCatalog(response.data ?? null);
    } catch (error) {
      captureClientError('Failed to load content subscription catalog', error);
      message.error(
        t('subscriptions.content.catalogLoadFailed', {
          defaultValue: 'Failed to load subscription catalog.',
        }),
      );
    } finally {
      setLoadingCatalog(false);
    }
  }, [apiClient, catalogKind, catalogQuery, message, t, taxonomyFilter]);

  const loadRecommendations = useCallback(async () => {
    const response = await apiClient.get<ContentSubscriptionCatalogResponse>(
      'user-content-subscriptions/recommendations?limit=12',
    );
    setRecommendations(response.data ?? null);
  }, [apiClient]);

  const loadAll = useCallback(async () => {
    if (!accessToken) {
      return;
    }
    setLoading(true);
    try {
      await Promise.all([loadSubscriptions(), loadRecommendations()]);
    } catch (error) {
      captureClientError('Failed to load content subscriptions center', error);
      message.error(
        t('subscriptions.content.loadFailed', {
          defaultValue: 'Failed to load content subscriptions.',
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken, loadRecommendations, loadSubscriptions, message, t]);

  useEffect(() => {
    if (!active || !accessToken) {
      return;
    }
    void loadAll();
  }, [accessToken, active, loadAll]);

  useEffect(() => {
    if (!active || !accessToken || !subscriptions) {
      return;
    }
    void loadCatalog();
  }, [accessToken, active, catalogKind, catalogQuery, loadCatalog, subscriptions, taxonomyFilter]);

  const subscribedKeys = useMemo(() => {
    return new Set((subscriptions?.items ?? []).map((item) => buildContentSubscriptionKey(item.kind, item.normalizedValue)));
  }, [subscriptions?.items]);

  const filteredSubscriptions = useMemo(() => {
    const query = subscriptionQuery.trim().toLowerCase();
    if (!query) {
      return subscriptions?.items ?? [];
    }
    return (subscriptions?.items ?? []).filter((item) => {
      return [item.displayValue, item.taxonomyDisplayName ?? '', ...(item.taxonomyLabels ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [subscriptionQuery, subscriptions?.items]);

  const subscriptionGroups = useMemo(
    () => groupByTaxonomy(filteredSubscriptions),
    [filteredSubscriptions],
  );
  const catalogGroups = useMemo(() => groupByTaxonomy(catalog?.items ?? []), [catalog?.items]);
  const taxonomyOptions = useMemo(() => {
    const groups = groupByTaxonomy(catalog?.items ?? []);
    return groups.map((group) => ({
      value: group.groupKey,
      label: `${group.title} (${group.items.length})`,
    }));
  }, [catalog?.items]);

  const selectedSubscriptionItems = useMemo(() => {
    const selected = new Set(selectedSubscriptionKeys);
    return filteredSubscriptions.filter((item) => selected.has(buildContentSubscriptionKey(item.kind, item.normalizedValue)));
  }, [filteredSubscriptions, selectedSubscriptionKeys]);

  const selectedCatalogItems = useMemo(() => {
    const selected = new Set(selectedCatalogKeys);
    return (catalog?.items ?? []).filter((item) => selected.has(buildContentSubscriptionKey(item.kind, item.normalizedValue)));
  }, [catalog?.items, selectedCatalogKeys]);

  useEffect(() => {
    const availableKeys = new Set(
      filteredSubscriptions.map((item) =>
        buildContentSubscriptionKey(item.kind, item.normalizedValue),
      ),
    );
    setSelectedSubscriptionKeys((current) =>
      current.filter((entry) => availableKeys.has(entry)),
    );
  }, [filteredSubscriptions]);

  useEffect(() => {
    const availableKeys = new Set(
      (catalog?.items ?? []).map((item) =>
        buildContentSubscriptionKey(item.kind, item.normalizedValue),
      ),
    );
    setSelectedCatalogKeys((current) =>
      current.filter((entry) => availableKeys.has(entry)),
    );
  }, [catalog?.items]);

  const handleBatchRemove = async () => {
    if (selectedSubscriptionItems.length === 0) {
      return;
    }
    try {
      await apiClient.post<ContentSubscriptionBatchResponse>('user-content-subscriptions/batch-delete', {
        subscriptions: selectedSubscriptionItems.map((item) => ({
          kind: item.kind,
          value: item.displayValue,
        })),
      });
      message.success(
        t('subscriptions.content.batchRemoved', {
          defaultValue: 'Subscriptions removed.',
        }),
      );
      setSelectedSubscriptionKeys([]);
      await Promise.all([loadSubscriptions(), loadRecommendations(), loadCatalog()]);
    } catch (error) {
      captureClientError('Failed to remove content subscriptions', error);
      message.error(
        t('subscriptions.content.batchRemoveFailed', {
          defaultValue: 'Failed to remove selected subscriptions.',
        }),
      );
    }
  };

  const handleBatchSubscribe = async (items: ContentSubscriptionCatalogItem[], source: 'recommendation' | 'manual' = 'manual') => {
    if (items.length === 0) {
      return;
    }
    try {
      const response = await apiClient.post<ContentSubscriptionBatchResponse>('user-content-subscriptions/batch-upsert', {
        subscriptions: items.map((item) => ({
          kind: item.kind,
          value: item.displayValue,
          source,
        })),
      });
      const subscribedCount = (response.data?.items ?? []).filter((item) => item.status === 'subscribed').length;
      const limitReached = (response.data?.items ?? []).some((item) => item.status === 'limit_reached');
      if (subscribedCount > 0) {
        message.success(
          t('subscriptions.content.batchAdded', {
            defaultValue: 'Added {{count}} subscriptions.',
            count: subscribedCount,
          }),
        );
      } else if (limitReached) {
        message.warning(
          t('subscriptions.content.limitReached', {
            defaultValue: 'Subscription limit reached for this type.',
          }),
        );
      } else {
        message.info(
          t('subscriptions.content.noChanges', {
            defaultValue: 'No new subscriptions were added.',
          }),
        );
      }
      setSelectedCatalogKeys([]);
      await Promise.all([loadSubscriptions(), loadRecommendations(), loadCatalog()]);
    } catch (error) {
      captureClientError('Failed to add content subscriptions', error);
      message.error(
        t('subscriptions.content.batchAddFailed', {
          defaultValue: 'Failed to add selected subscriptions.',
        }),
      );
    }
  };

  if (!accessToken) {
    return (
      <ChartEmptyState
        variant="permission"
        title={t('common.accessDenied', { defaultValue: 'Access denied' })}
        description={t('subscriptions.content.signInRequired', {
          defaultValue: 'Please sign in to manage content subscriptions.',
        })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        className="content-card"
        extra={
          <Button size="small" onClick={() => void loadAll()}>
            {t('common.refresh')}
          </Button>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {t('subscriptions.content.summary', {
              defaultValue:
                'Manage personalized topic and entity subscriptions, browse by taxonomy, and add AI-ranked recommendations.',
            })}
          </Typography.Text>
          <Space wrap size={[8, 8]}>
            <Tag color="blue">
              {t('subscriptions.content.topicCount', {
                defaultValue: 'Topics: {{count}}',
                count: subscriptions?.counts.topic ?? 0,
              })}
            </Tag>
            <Tag color="purple">
              {t('subscriptions.content.entityCount', {
                defaultValue: 'Entities: {{count}}',
                count: subscriptions?.counts.entity ?? 0,
              })}
            </Tag>
            <Tag>
              {t('subscriptions.content.limitLabel', {
                defaultValue: 'Per type limit: {{count}}',
                count: subscriptions?.limitPerKind ?? 50,
              })}
            </Tag>
          </Space>
        </Space>
      </Card>

      <Card
        className="content-card"
        title={t('subscriptions.content.currentTitle', { defaultValue: 'Content subscriptions' })}
        extra={
          <Space size="small">
            <Input.Search
              allowClear
              value={subscriptionQuery}
              onChange={(event) => setSubscriptionQuery(event.target.value)}
              placeholder={t('subscriptions.content.searchPlaceholder', {
                defaultValue: 'Search subscribed topics or entities',
              })}
              style={{ width: 260 }}
            />
            <Button danger disabled={selectedSubscriptionItems.length === 0} onClick={() => void handleBatchRemove()}>
              {t('subscriptions.content.batchUnsubscribe', {
                defaultValue: 'Unsubscribe selected',
              })}
            </Button>
          </Space>
        }
      >
        {loading && !subscriptions ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : subscriptionGroups.length === 0 ? (
          <Empty
            description={t('subscriptions.content.currentEmpty', {
              defaultValue: 'No content subscriptions yet.',
            })}
          />
        ) : (
          <Collapse
            items={subscriptionGroups.map((group) => ({
              key: group.groupKey,
              label: `${group.title} (${group.items.length})`,
              children: (
                <List
                  dataSource={group.items}
                  renderItem={(item) => (
                    <List.Item
                      actions={[
                        <Button
                          key="remove"
                          type="link"
                          danger
                          onClick={() => void handleBatchRemoveSingle(item)}
                        >
                          {t('common.remove', { defaultValue: 'Remove' })}
                        </Button>,
                      ]}
                    >
                      <Space align="start" size="middle" style={{ width: '100%', justifyContent: 'space-between' }}>
                        <Checkbox
                          checked={selectedSubscriptionKeys.includes(buildContentSubscriptionKey(item.kind, item.normalizedValue))}
                          onChange={(event) => {
                            const key = buildContentSubscriptionKey(item.kind, item.normalizedValue);
                            setSelectedSubscriptionKeys((current) =>
                              event.target.checked
                                ? Array.from(new Set([...current, key]))
                                : current.filter((entry) => entry !== key),
                            );
                          }}
                        />
                        <Space direction="vertical" size={4} style={{ flex: 1 }}>
                          <Space wrap size={[6, 6]}>
                            <Typography.Text strong>{item.displayValue}</Typography.Text>
                            <Tag color={item.kind === 'topic' ? 'blue' : 'purple'}>{item.kind}</Tag>
                            {item.taxonomyDisplayName ? <Tag>{item.taxonomyDisplayName}</Tag> : null}
                          </Space>
                          {item.taxonomyLabels.length > 0 ? (
                            <Space wrap size={[4, 4]}>
                              {item.taxonomyLabels.map((label) => (
                                <Tag key={`${item.id}-${label}`}>{label}</Tag>
                              ))}
                            </Space>
                          ) : null}
                        </Space>
                      </Space>
                    </List.Item>
                  )}
                />
              ),
            }))}
          />
        )}
      </Card>

      <Card
        className="content-card"
        title={t('subscriptions.content.catalogTitle', { defaultValue: 'Browse by category' })}
        extra={
          <Space size="small">
            <Select
              value={catalogKind}
              style={{ width: 140 }}
              options={[
                { value: 'all', label: t('subscriptions.content.kindAll', { defaultValue: 'All types' }) },
                { value: 'topic', label: t('subscriptions.content.kindTopics', { defaultValue: 'Topics' }) },
                { value: 'entity', label: t('subscriptions.content.kindEntities', { defaultValue: 'Entities' }) },
              ]}
              onChange={(value) => setCatalogKind(value)}
            />
            <Input.Search
              allowClear
              value={catalogInput}
              onChange={(event) => setCatalogInput(event.target.value)}
              onSearch={(value) => setCatalogQuery(value)}
              placeholder={t('subscriptions.content.catalogSearch', {
                defaultValue: 'Search the subscription catalog',
              })}
              style={{ width: 260 }}
            />
            <Button onClick={() => setCatalogQuery(catalogInput)}>{t('common.search', { defaultValue: 'Search' })}</Button>
            <Button disabled={selectedCatalogItems.length === 0} onClick={() => void handleBatchSubscribe(selectedCatalogItems)}>
              {t('subscriptions.content.batchSubscribe', { defaultValue: 'Subscribe selected' })}
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap size={[8, 8]}>
            <Button size="small" type={taxonomyFilter === null ? 'primary' : 'default'} onClick={() => setTaxonomyFilter(null)}>
              {t('subscriptions.content.allCategories', { defaultValue: 'All categories' })}
            </Button>
            {taxonomyOptions.map((option) => (
              <Button
                key={option.value}
                size="small"
                type={taxonomyFilter === option.value ? 'primary' : 'default'}
                onClick={() => setTaxonomyFilter(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </Space>
          {loadingCatalog && !catalog ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : catalogGroups.length === 0 ? (
            <Empty
              description={t('subscriptions.content.catalogEmpty', {
                defaultValue: 'No catalog matches the current filter.',
              })}
            />
          ) : (
            <Collapse
              items={catalogGroups.map((group) => ({
                key: group.groupKey,
                label: `${group.title} (${group.items.length})`,
                children: (
                  <List
                    dataSource={group.items}
                    renderItem={(item) => {
                      const subscriptionKey = buildContentSubscriptionKey(item.kind, item.normalizedValue);
                      const isSubscribed = subscribedKeys.has(subscriptionKey);
                      return (
                        <List.Item
                          actions={[
                            <Button
                              key="subscribe"
                              type="link"
                              disabled={isSubscribed}
                              onClick={() => void handleBatchSubscribe([item])}
                            >
                              {isSubscribed
                                ? t('subscriptions.content.subscribed', { defaultValue: 'Subscribed' })
                                : t('subscriptions.content.subscribe', { defaultValue: 'Subscribe' })}
                            </Button>,
                          ]}
                        >
                          <Space align="start" size="middle" style={{ width: '100%', justifyContent: 'space-between' }}>
                            <Checkbox
                              disabled={isSubscribed}
                              checked={selectedCatalogKeys.includes(subscriptionKey)}
                              onChange={(event) => {
                                setSelectedCatalogKeys((current) =>
                                  event.target.checked
                                    ? Array.from(new Set([...current, subscriptionKey]))
                                    : current.filter((entry) => entry !== subscriptionKey),
                                );
                              }}
                            />
                            <Space direction="vertical" size={4} style={{ flex: 1 }}>
                              <Space wrap size={[6, 6]}>
                                <Typography.Text strong>{item.displayValue}</Typography.Text>
                                <Tag color={item.kind === 'topic' ? 'blue' : 'purple'}>{item.kind}</Tag>
                                {item.taxonomyDisplayName ? <Tag>{item.taxonomyDisplayName}</Tag> : null}
                                <Tag>
                                  {t('subscriptions.content.itemCount', {
                                    defaultValue: '{{count}} items',
                                    count: item.count,
                                  })}
                                </Tag>
                              </Space>
                              <Typography.Text type="secondary">
                                {t('subscriptions.content.lastSeenAt', {
                                  defaultValue: 'Last seen {{time}}',
                                  time: formatDateTime(item.lastSeenAt, locale, DATE_TIME_FORMAT),
                                })}
                              </Typography.Text>
                            </Space>
                          </Space>
                        </List.Item>
                      );
                    }}
                  />
                ),
              }))}
            />
          )}
        </Space>
      </Card>

      <Card
        className="content-card"
        title={t('subscriptions.content.recommendationsTitle', { defaultValue: 'Recommended subscriptions' })}
      >
        {loading && !recommendations ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : (recommendations?.items?.length ?? 0) === 0 ? (
          <Empty
            description={t('subscriptions.content.recommendationsEmpty', {
              defaultValue: 'Read more articles to unlock personalized recommendations.',
            })}
          />
        ) : (
          <List
            dataSource={recommendations?.items ?? []}
            renderItem={(item) => {
              const isSubscribed = subscribedKeys.has(buildContentSubscriptionKey(item.kind, item.normalizedValue));
              return (
                <List.Item
                  actions={[
                    <Button
                      key="add"
                      type="link"
                      disabled={isSubscribed}
                      onClick={() => void handleBatchSubscribe([item], 'recommendation')}
                    >
                      {isSubscribed
                        ? t('subscriptions.content.subscribed', { defaultValue: 'Subscribed' })
                        : t('subscriptions.content.addOne', { defaultValue: 'Add' })}
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space wrap size={[6, 6]}>
                        <Typography.Text strong>{item.displayValue}</Typography.Text>
                        <Tag color={item.kind === 'topic' ? 'blue' : 'purple'}>{item.kind}</Tag>
                        {item.taxonomyDisplayName ? <Tag>{item.taxonomyDisplayName}</Tag> : null}
                      </Space>
                    }
                    description={
                      <Space wrap size={[6, 6]}>
                        <Typography.Text type="secondary">
                          {t('subscriptions.content.itemCount', {
                            defaultValue: '{{count}} items',
                            count: item.count,
                          })}
                        </Typography.Text>
                        {typeof item.score === 'number' ? (
                          <Typography.Text type="secondary">
                            {t('subscriptions.content.relevanceScore', {
                              defaultValue: 'Relevance {{score}}',
                              score: item.score.toFixed(2),
                            })}
                          </Typography.Text>
                        ) : null}
                      </Space>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Card>
    </div>
  );

  async function handleBatchRemoveSingle(item: ContentSubscriptionItem) {
    try {
      await apiClient.post<ContentSubscriptionBatchResponse>('user-content-subscriptions/batch-delete', {
        subscriptions: [{ kind: item.kind, value: item.displayValue }],
      });
      setSelectedSubscriptionKeys((current) =>
        current.filter(
          (entry) => entry !== buildContentSubscriptionKey(item.kind, item.normalizedValue),
        ),
      );
      message.success(
        t('subscriptions.content.removedSingle', {
          defaultValue: 'Subscription removed.',
        }),
      );
      await Promise.all([loadSubscriptions(), loadRecommendations(), loadCatalog()]);
    } catch (error) {
      captureClientError('Failed to remove single content subscription', error);
      message.error(
        t('subscriptions.content.removeSingleFailed', {
          defaultValue: 'Failed to remove subscription.',
        }),
      );
    }
  }
}

function groupByTaxonomy<T extends { taxonomyPath: string | null; taxonomyDisplayName: string | null; taxonomyLabels: string[] }>(
  items: T[],
): GroupedItems<T>[] {
  const groups = new Map<string, GroupedItems<T>>();
  for (const item of items) {
    const groupKey = item.taxonomyPath ?? UNCATEGORIZED_TAXONOMY_FILTER;
    const current = groups.get(groupKey);
    if (current) {
      current.items.push(item);
      continue;
    }
    groups.set(groupKey, {
      groupKey,
      title: item.taxonomyDisplayName ?? 'Uncategorized',
      labels: item.taxonomyLabels ?? [],
      items: [item],
    });
  }

  return Array.from(groups.values()).sort((a, b) => b.items.length - a.items.length || a.title.localeCompare(b.title));
}
