"use client";

/**
 * Crawl Task Detail Markdown 字段段（FE-批5A：自 task-detail.tsx 拆出）。
 * 生成器 / 策略 / 过滤器 / clean markdown 四项摘要。
 */

import { Descriptions } from "antd";

import type { CrawlTaskConfig } from "./task-detail-config-core-model";
import type { TaskDetailTranslate } from "./task-detail-types";
import {
  buildCleanMarkdownSummary,
  buildMarkdownFilterSummary,
  buildMarkdownStrategySummary,
  buildMarkdownSummary,
} from "./task-detail-markdown-model";

interface MarkdownSectionProps {
  t: TaskDetailTranslate;
  config: CrawlTaskConfig;
}

export function TaskDetailMarkdownSection({
  t,
  config,
}: MarkdownSectionProps) {
  return (
    <>
      <Descriptions.Item label={t("crawl.detail.fields.markdownGenerator")}>
        {buildMarkdownSummary(config, t)}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.markdownStrategy")}>
        {buildMarkdownStrategySummary(config, t)}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.markdownFilter")}>
        {buildMarkdownFilterSummary(config, t)}
      </Descriptions.Item>
      <Descriptions.Item label={t("crawl.detail.fields.cleanMarkdown")}>
        {buildCleanMarkdownSummary(config, t)}
      </Descriptions.Item>
    </>
  );
}
