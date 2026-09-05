"use client";

/**
 * Crawl Task Detail 结果列表卡片（FE-批5A：自 task-detail.tsx 拆出）。
 * 搜索输入与已提交搜索分离（Enter/按钮提交 trim、清空即时复位）、
 * limit 选择（10/20/50）、加载且无结果时 Spin（旧结果保留展示）。
 */

import { SearchOutlined } from "@ant-design/icons";
import { Button, Card, Input, List, Select, Space, Spin } from "antd";
import { useTranslation } from "react-i18next";

import type { SupportedLocale } from "@/lib/i18n";

import type { CrawlResultActionController } from "./hooks/use-crawl-result-actions";
import { TaskDetailResultItem } from "./task-detail-result-item";
import type { CrawlTaskDetailResult } from "./task-detail-types";

const limitOptions = [
  {
    value: 10,
    labelKey: "crawl.detail.results.latest10",
    defaultValue: "Latest 10",
  },
  {
    value: 20,
    labelKey: "crawl.detail.results.latest20",
    defaultValue: "Latest 20",
  },
  {
    value: 50,
    labelKey: "crawl.detail.results.latest50",
    defaultValue: "Latest 50",
  },
];

interface TaskDetailResultsProps {
  results: CrawlTaskDetailResult[];
  loading: boolean;
  limit: number;
  searchInput: string;
  onLimitChange: (limit: number) => void;
  onSearchInputChange: (value: string) => void;
  onSearchSubmit: () => void;
  canViewItems: boolean;
  canCreateItem: boolean;
  resultActions: CrawlResultActionController;
  locale: SupportedLocale;
}

export function TaskDetailResults({
  results,
  loading,
  limit,
  searchInput,
  onLimitChange,
  onSearchInputChange,
  onSearchSubmit,
  canViewItems,
  canCreateItem,
  resultActions,
  locale,
}: TaskDetailResultsProps) {
  const { t } = useTranslation();
  return (
    <Card
      title={t("crawl.detail.results.title")}
      style={{ marginTop: 24 }}
      extra={
        <Space>
          <Space.Compact style={{ width: 260 }}>
            <Input
              id="crawl-task-result-search"
              name="crawlTaskResultSearch"
              placeholder={t("crawl.detail.results.searchPlaceholder")}
              allowClear
              value={searchInput}
              onChange={(event) => onSearchInputChange(event.target.value)}
              onPressEnter={() => onSearchSubmit()}
            />
            <Button
              icon={<SearchOutlined />}
              aria-label={t("crawl.detail.results.searchPlaceholder")}
              onClick={() => onSearchSubmit()}
            />
          </Space.Compact>
          <Select
            value={limit}
            style={{ width: 140 }}
            onChange={onLimitChange}
            options={limitOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey, {
                defaultValue: option.defaultValue,
              }),
            }))}
          />
        </Space>
      }
    >
      {loading && results.length === 0 ? (
        <Spin />
      ) : (
        <List
          dataSource={results}
          locale={{ emptyText: t("crawl.detail.results.empty") }}
          renderItem={(result) => (
            <TaskDetailResultItem
              key={result.id}
              result={result}
              canViewItems={canViewItems}
              canCreateItem={canCreateItem}
              resultActions={resultActions}
              locale={locale}
            />
          )}
        />
      )}
    </Card>
  );
}
