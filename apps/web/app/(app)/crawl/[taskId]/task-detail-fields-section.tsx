"use client";

/**
 * Crawl Task Detail 基础字段段（FE-批5A：自 task-detail.tsx 拆出）。
 * Descriptions 基础九项：显示名/关键词/并发/图片与媒体开关/自动入
 * Items（canManage 时为 Switch，否则只读文案）/上次运行汇总/运行次数。
 */

import { Descriptions, Space, Switch, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import type { CrawlTaskConfig } from "./task-detail-config-core-model";
import type { CrawlTaskDetailTask } from "./task-detail-types";

interface FieldsSectionProps {
  task: CrawlTaskDetailTask;
  config: CrawlTaskConfig;
  canManage: boolean;
  hasItemsWrite: boolean;
  updatingIngest: boolean;
  onToggleIngest: (enabled: boolean) => void;
}

export function TaskDetailFieldsSection({
  task,
  config,
  canManage,
  hasItemsWrite,
  updatingIngest,
  onToggleIngest,
}: FieldsSectionProps) {
  const { t } = useTranslation();
  const includeImagesEnabled = Boolean(config?.includeImages);
  const storeMediaEnabled = Boolean(config?.storeMedia);
  const ingestToItemsEnabled = Boolean(config?.ingestToItems);

  return (
    <>
      <Descriptions.Item label={t("crawl.detail.fields.displayName")}>
        {task.displayName ?? task.targetUrl}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.keywords")}>
        {task.keywords.length ? (
          <Space wrap>
            {task.keywords.map((keyword) => (
              <Tag key={keyword}>{keyword}</Tag>
            ))}
          </Space>
        ) : (
          t("common.emptyValue")
        )}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.concurrency")}>
        {task.concurrency}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.includeImages")}>
        {includeImagesEnabled ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.storeMedia")}>
        {storeMediaEnabled ? t("common.enabled") : t("common.disabled")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.ingestToItems")}
      >
        {canManage ? (
          <Space direction="vertical" size={4}>
            <Switch
              checked={ingestToItemsEnabled}
              loading={updatingIngest}
              onChange={(checked) => onToggleIngest(checked)}
            />
            <Typography.Text type="secondary">
              {hasItemsWrite
                ? t("crawl.settings.ingestToItemsHint")
                : t("crawl.settings.ingestToItemsNoPermission")}
            </Typography.Text>
          </Space>
        ) : ingestToItemsEnabled ? (
          t("common.enabled")
        ) : (
          t("common.disabled")
        )}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.lastRunItems")}
      >
        {task.lastRunSummary
          ? t("crawl.detail.lastRunItemsValue", {
              queued: task.lastRunSummary.itemsQueued ?? 0,
              failed: task.lastRunSummary.itemsQueueFailed ?? 0,
            })
          : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.lastRunResults")}
      >
        {task.lastRunSummary
          ? t("crawl.detail.lastRunResultsValue", {
              inserted: task.lastRunSummary.inserted,
              skipped: task.lastRunSummary.skipped,
            })
          : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.runCount")}>
        {task.runCount}
      </Descriptions.Item>
    </>
  );
}
