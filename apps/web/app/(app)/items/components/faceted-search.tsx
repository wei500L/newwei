"use client";

import { Card, Checkbox, Collapse, DatePicker, Space, Typography } from "antd";
import type { Dayjs } from "dayjs";
import { useTranslation } from "react-i18next";

const { RangePicker } = DatePicker;
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
}

export function FacetedSearch({
  filters,
  onFilterChange,
  regions = [],
  topics = [],
  sentiments = [],
}: FacetedSearchProps) {
  const { t } = useTranslation();

  const handleDateChange = (dates: any) => {
    onFilterChange({ ...filters, dateRange: dates });
  };

  const handleRegionChange = (checkedValues: any[]) => {
    onFilterChange({ ...filters, regions: checkedValues as string[] });
  };

  const handleTopicChange = (checkedValues: any[]) => {
    onFilterChange({ ...filters, topics: checkedValues as string[] });
  };

  const handleSentimentChange = (checkedValues: any[]) => {
    onFilterChange({ ...filters, sentiments: checkedValues as string[] });
  };

  const orderedSentiments = [
    ...["positive", "neutral", "negative"].filter((value) => sentiments.includes(value)),
    ...sentiments.filter((value) => !["positive", "neutral", "negative"].includes(value))
  ];

  const collapseItems = [
    ...(regions.length
      ? [
          {
            key: "region",
            label: t("items.filters.region", { defaultValue: "Region" }),
            children: (
              <Checkbox.Group
                options={regions}
                value={filters.regions}
                onChange={handleRegionChange}
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              />
            )
          }
        ]
      : []),
    ...(topics.length
      ? [
          {
            key: "topic",
            label: t("items.filters.topic", { defaultValue: "Topic" }),
            children: (
              <Checkbox.Group
                options={topics}
                value={filters.topics}
                onChange={handleTopicChange}
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              />
            )
          }
        ]
      : []),
    ...(orderedSentiments.length
      ? [
          {
            key: "sentiment",
            label: t("items.filters.sentiment", { defaultValue: "Sentiment" }),
            children: (
              <Checkbox.Group
                options={orderedSentiments.map((value) => ({
                  value,
                  label:
                    value === "positive"
                      ? t("items.sentiment.positive", { defaultValue: "Positive" })
                      : value === "neutral"
                        ? t("items.sentiment.neutral", { defaultValue: "Neutral" })
                        : value === "negative"
                          ? t("items.sentiment.negative", { defaultValue: "Negative" })
                          : value
                }))}
                value={filters.sentiments}
                onChange={handleSentimentChange}
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              />
            )
          }
        ]
      : [])
  ];

  const defaultActiveKey = collapseItems.map((item) => item.key);

  return (
    <Card className="h-full" styles={{ body: { padding: "12px" } }}>
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Typography.Title level={5}>{t("items.filters.title", { defaultValue: "Filters" })}</Typography.Title>

        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text strong>{t("items.filters.date", { defaultValue: "Date Range" })}</Typography.Text>
          <RangePicker
            style={{ width: "100%" }}
            value={filters.dateRange}
            onChange={handleDateChange as any}
          />
        </Space>

        {collapseItems.length ? (
          <Collapse
            defaultActiveKey={defaultActiveKey}
            ghost
            items={collapseItems}
          />
        ) : (
          <Typography.Text type="secondary">
            {t("items.filters.empty", { defaultValue: "No filter options for current results." })}
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
}
