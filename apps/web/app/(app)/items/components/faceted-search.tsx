'use client';

import { Button, Card, Checkbox, Collapse, DatePicker, Input, Space, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  FACETED_SECTION_KEYS,
  filterFacetOptions,
  getFacetedSelectionCounts,
  resolveFacetedDefaultActiveKeys,
  type FacetedFilterBehavior,
  type FacetedSectionKey
} from './faceted-search-state';

const { RangePicker } = DatePicker;
const SECTION_SEARCH_MIN_OPTIONS = 8;

export interface FilterState {
  dateRange?: [Dayjs, Dayjs] | null;
  sourceIds?: string[];
  regions?: string[];
  topics?: string[];
  sentiments?: string[];
}

interface FacetedSearchProps {
  filters: FilterState;
  onFilterChange: (filters: FilterState) => void;
  regions?: string[];
  topics?: string[];
  sentiments?: string[];
  behavior?: FacetedFilterBehavior;
  stickySummary?: boolean;
  maxSectionBodyHeight?: number;
}

function toSectionKeys(value: string | number | Array<string | number>): FacetedSectionKey[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.filter((item): item is FacetedSectionKey =>
    typeof item === "string" && FACETED_SECTION_KEYS.includes(item as FacetedSectionKey)
  );
}

function hasSameKeys(a: FacetedSectionKey[], b: FacetedSectionKey[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

export function FacetedSearch({
  filters,
  onFilterChange,
  regions = [],
  topics = [],
  sentiments = [],
  behavior = 'legacy',
  stickySummary = false,
  maxSectionBodyHeight = 240
}: FacetedSearchProps) {
  const { t } = useTranslation();
  const [sectionSearch, setSectionSearch] = useState<Record<FacetedSectionKey, string>>({
    region: '',
    topic: '',
    sentiment: ''
  });

  const handleDateChange = (dates: [Dayjs | null, Dayjs | null] | null) => {
    if (!dates || !dates[0] || !dates[1]) {
      onFilterChange({ ...filters, dateRange: undefined });
      return;
    }
    onFilterChange({ ...filters, dateRange: [dates[0], dates[1]] });
  };

  const handleRegionChange = (checkedValues: Array<string | number>) => {
    onFilterChange({ ...filters, regions: checkedValues as string[] });
  };

  const handleTopicChange = (checkedValues: Array<string | number>) => {
    onFilterChange({ ...filters, topics: checkedValues as string[] });
  };

  const handleSentimentChange = (checkedValues: Array<string | number>) => {
    onFilterChange({ ...filters, sentiments: checkedValues as string[] });
  };

  const orderedSentiments = useMemo(
    () => [
      ...['positive', 'neutral', 'negative'].filter((value) => sentiments.includes(value)),
      ...sentiments.filter((value) => !['positive', 'neutral', 'negative'].includes(value))
    ],
    [sentiments]
  );

  const availableSectionKeys = useMemo(() => {
    const keys: FacetedSectionKey[] = [];
    if (regions.length > 0) {
      keys.push('region');
    }
    if (topics.length > 0) {
      keys.push('topic');
    }
    if (orderedSentiments.length > 0) {
      keys.push('sentiment');
    }
    return keys;
  }, [orderedSentiments.length, regions.length, topics.length]);

  const defaultActiveKeys = useMemo(
    () =>
      resolveFacetedDefaultActiveKeys({
        behavior,
        availableKeys: availableSectionKeys,
        filters
      }),
    [availableSectionKeys, behavior, filters]
  );

  const [activeKeys, setActiveKeys] = useState<FacetedSectionKey[]>(defaultActiveKeys);

  useEffect(() => {
    setActiveKeys((prev) => {
      if (behavior === 'legacy') {
        return hasSameKeys(prev, availableSectionKeys) ? prev : availableSectionKeys;
      }

      const availableSet = new Set(availableSectionKeys);
      const kept = prev.filter((key) => availableSet.has(key));
      const merged = Array.from(new Set([...kept, ...defaultActiveKeys]));
      return hasSameKeys(prev, merged) ? prev : merged;
    });
  }, [availableSectionKeys, behavior, defaultActiveKeys]);

  const selectionCounts = useMemo(() => getFacetedSelectionCounts(filters), [filters]);

  const summaryTags = useMemo(
    () =>
      [
        selectionCounts.sourceIds > 0
          ? {
              key: 'source',
              label: t('pages.rss.sourceLabel', { defaultValue: 'RSS Sources' }),
              count: selectionCounts.sourceIds
            }
          : null,
        selectionCounts.regions > 0
          ? {
              key: 'region',
              label: t('items.filters.region', { defaultValue: 'Region' }),
              count: selectionCounts.regions
            }
          : null,
        selectionCounts.topics > 0
          ? {
              key: 'topic',
              label: t('items.filters.topic', { defaultValue: 'Topic' }),
              count: selectionCounts.topics
            }
          : null,
        selectionCounts.sentiments > 0
          ? {
              key: 'sentiment',
              label: t('items.filters.sentiment', { defaultValue: 'Sentiment' }),
              count: selectionCounts.sentiments
            }
          : null,
        selectionCounts.dateRange > 0
          ? {
              key: 'date',
              label: t('items.filters.date', { defaultValue: 'Date Range' }),
              count: selectionCounts.dateRange
            }
          : null
      ].filter((item): item is { key: string; label: string; count: number } => Boolean(item)),
    [selectionCounts, t]
  );

  const hasActiveFilters = summaryTags.length > 0;

  const formatSentimentLabel = (value: string): string => {
    if (value === 'positive') {
      return t('items.sentiment.positive', { defaultValue: 'Positive' });
    }
    if (value === 'neutral') {
      return t('items.sentiment.neutral', { defaultValue: 'Neutral' });
    }
    if (value === 'negative') {
      return t('items.sentiment.negative', { defaultValue: 'Negative' });
    }
    return value;
  };

  const renderSection = (
    key: FacetedSectionKey,
    label: string,
    selectedCount: number,
    options: string[],
    selectedValues: string[] | undefined,
    onChange: (values: Array<string | number>) => void,
    formatter?: (value: string) => string
  ) => {
    const keyword = sectionSearch[key] ?? '';
    const filteredValues =
      behavior === 'layered' ? filterFacetOptions(options, keyword) : options;
    const showSearch = behavior === 'layered' && options.length > SECTION_SEARCH_MIN_OPTIONS;

    return {
      key,
      label:
        selectedCount > 0
          ? `${label} · ${t('items.filters.selectedCountInline', {
              count: selectedCount,
              defaultValue: '{{count}} selected'
            })}`
          : label,
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          {showSearch ? (
            <Input
              allowClear
              value={keyword}
              size="small"
              placeholder={t('items.filters.sectionSearchPlaceholder', {
                label,
                defaultValue: 'Search {{label}}'
              })}
              onChange={(event) => {
                const value = event.target.value;
                setSectionSearch((prev) => ({ ...prev, [key]: value }));
              }}
            />
          ) : null}

          {filteredValues.length > 0 ? (
            <div
              style={{
                maxHeight: behavior === 'layered' ? maxSectionBodyHeight : undefined,
                overflowY: behavior === 'layered' ? 'auto' : undefined,
                paddingRight: behavior === 'layered' ? 4 : 0
              }}
            >
              <Checkbox.Group
                options={filteredValues.map((value) => ({
                  value,
                  label: formatter ? formatter(value) : value
                }))}
                value={selectedValues}
                onChange={onChange}
                style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
              />
            </div>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('items.filters.empty', { defaultValue: 'No filter options for current results.' })}
            </Typography.Text>
          )}
        </Space>
      )
    };
  };

  const collapseItems = [
    ...(regions.length
      ? [
          renderSection(
            "region",
            t("items.filters.region", { defaultValue: "Region" }),
            selectionCounts.regions,
            regions,
            filters.regions,
            handleRegionChange
          )
        ]
      : []),
    ...(topics.length
      ? [
          renderSection(
            "topic",
            t("items.filters.topic", { defaultValue: "Topic" }),
            selectionCounts.topics,
            topics,
            filters.topics,
            handleTopicChange
          )
        ]
      : []),
    ...(orderedSentiments.length
      ? [
          renderSection(
            "sentiment",
            t("items.filters.sentiment", { defaultValue: "Sentiment" }),
            selectionCounts.sentiments,
            orderedSentiments,
            filters.sentiments,
            handleSentimentChange,
            formatSentimentLabel
          )
        ]
      : [])
  ];

  const handleClearAll = () => {
    onFilterChange({
      ...(filters.sourceIds?.length ? { sourceIds: [...filters.sourceIds] } : {})
    });
  };

  return (
    <Card className="h-full" styles={{ body: { padding: '12px' } }}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div className="flex items-center justify-between gap-3">
          <Typography.Title level={5} style={{ margin: 0 }}>
            {t('items.filters.title', { defaultValue: 'Filters' })}
          </Typography.Title>
          {hasActiveFilters ? (
            <Button type="link" size="small" onClick={handleClearAll} className="px-0">
              {t('items.filters.clearAll', { defaultValue: 'Clear all' })}
            </Button>
          ) : null}
        </div>

        {behavior === 'layered' ? (
          <div className={stickySummary ? 'items-filter-summary' : undefined}>
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('items.filters.selectedSummary', { defaultValue: 'Selected' })}
              </Typography.Text>
              {summaryTags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {summaryTags.slice(0, 4).map((item) => (
                    <Tag className="items-compact-tag" key={item.key} color="blue">
                      {item.label}: {item.count}
                    </Tag>
                  ))}
                  {summaryTags.length > 4 ? (
                    <Tag className="items-compact-tag">
                      {t('items.filters.more', {
                        count: summaryTags.length - 4,
                        defaultValue: '+{{count}} more'
                      })}
                    </Tag>
                  ) : null}
                </div>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('items.filters.selectedCountInline', {
                    count: 0,
                    defaultValue: '{{count}} selected'
                  })}
                </Typography.Text>
              )}
            </Space>
          </div>
        ) : null}

        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text strong>
            {t('items.filters.date', { defaultValue: 'Date Range' })}
          </Typography.Text>
          <RangePicker
            style={{ width: '100%' }}
            value={filters.dateRange ?? null}
            onChange={handleDateChange as (value: [Dayjs | null, Dayjs | null] | null) => void}
          />
        </Space>

        {collapseItems.length ? (
          <Collapse
            activeKey={activeKeys}
            onChange={(next) => setActiveKeys(toSectionKeys(next))}
            ghost
            items={collapseItems}
          />
        ) : (
          <Typography.Text type="secondary">
            {t('items.filters.empty', { defaultValue: 'No filter options for current results.' })}
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
}
