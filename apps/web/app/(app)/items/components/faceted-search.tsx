"use client";

import { Card, Checkbox, Collapse, DatePicker, Space, Typography } from "antd";
import type { Dayjs } from "dayjs";

import dayjs from "@/lib/dayjs";
import { useTranslation } from "react-i18next";

const { RangePicker } = DatePicker;
export interface FilterState {
  dateRange?: [Dayjs, Dayjs] | null;
  regions?: string[];
  topics?: string[];
  sentiments?: string[];
}

interface FacetedSearchProps {
  filters: FilterState;
  onFilterChange: (filters: FilterState) => void;
  regions?: string[];
  topics?: string[];
}

export function FacetedSearch({
  filters,
  onFilterChange,
  regions = ["US", "EU", "Asia", "Global"],
  topics = ["Tech", "Finance", "Politics", "Energy"],
}: FacetedSearchProps) {
  const { t } = useTranslation();

  const handleDateChange = (dates: any, dateStrings: [string, string]) => {
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

  const collapseItems = [
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
    },
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
    },
    {
      key: "sentiment",
      label: t("items.filters.sentiment", { defaultValue: "Sentiment" }),
      children: (
        <Checkbox.Group
          options={[
            { label: t("items.sentiment.positive", { defaultValue: "Positive" }), value: "positive" },
            { label: t("items.sentiment.neutral", { defaultValue: "Neutral" }), value: "neutral" },
            { label: t("items.sentiment.negative", { defaultValue: "Negative" }), value: "negative" }
          ]}
          value={filters.sentiments}
          onChange={handleSentimentChange}
          style={{ display: "flex", flexDirection: "column", gap: "8px" }}
        />
      )
    }
  ];

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

        <Collapse
          defaultActiveKey={["region", "topic", "sentiment"]}
          ghost
          items={collapseItems}
        />
      </Space>
    </Card>
  );
}
