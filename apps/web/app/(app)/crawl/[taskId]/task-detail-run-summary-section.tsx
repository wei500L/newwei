"use client";

/**
 * Crawl Task Detail 运行结果与资源段（FE-批5A：自 task-detail.tsx 拆出）。
 * 内存四组字段、最近成功/错误时间与原始配置 JSON。
 */

import { Descriptions } from "antd";

import { formatDateTime, type SupportedLocale } from "@/lib/i18n";

import type { CrawlTaskConfig } from "./task-detail-config-core-model";
import { markdownPreviewStyle } from "./task-detail-formatters";
import type { CrawlTaskDetailTask } from "./task-detail-types";
import type { TaskDetailTranslate } from "./task-detail-types";

interface RunSummarySectionProps {
  t: TaskDetailTranslate;
  task: CrawlTaskDetailTask;
  config: CrawlTaskConfig;
  locale: SupportedLocale;
}

export function TaskDetailRunSummarySection({
  t,
  task,
  config,
  locale,
}: RunSummarySectionProps) {

  return (
    <>
      <Descriptions.Item label={t("crawl.detail.fields.lastServerMemory")}>
        {task.lastServerMemoryMb != null
          ? t("crawl.detail.memoryValue", { value: task.lastServerMemoryMb })
          : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.lastPeakMemory")}>
        {task.lastPeakMemoryMb != null
          ? t("crawl.detail.memoryValue", { value: task.lastPeakMemoryMb })
          : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item
        label={t("crawl.detail.fields.lastMemoryEfficiency")}
      >
        {task.lastMemoryEfficiency != null
          ? t("crawl.detail.percentValue", {
              value: task.lastMemoryEfficiency,
            })
          : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.serverMemory")}>
        {task.memoryStats?.serverMemoryMb != null
          ? t("crawl.detail.memoryValue", {
              value: task.memoryStats.serverMemoryMb,
            })
          : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.peakMemory")}>
        {task.memoryStats?.peakMemoryMb != null
          ? t("crawl.detail.memoryValue", {
              value: task.memoryStats.peakMemoryMb,
            })
          : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.efficiency")}>
        {task.memoryStats?.efficiencyPercent != null
          ? t("crawl.detail.percentValue", {
              value: task.memoryStats.efficiencyPercent,
            })
          : t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.lastSuccess")}>
        {task.lastSuccessAt
          ? formatDateTime(task.lastSuccessAt, locale, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : t("common.never")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.lastError")}>
        {task.lastError ?? t("common.emptyValue")}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.configuration")}>
        {config ? (
          <pre className="markdown-preview" style={markdownPreviewStyle}>
            {JSON.stringify(config, null, 2)}
          </pre>
        ) : (
          t("crawl.detail.default")
        )}
      </Descriptions.Item>
    </>
  );
}
