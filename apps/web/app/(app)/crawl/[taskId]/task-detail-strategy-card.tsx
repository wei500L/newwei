"use client";

/**
 * Crawl Task Detail 策略 Tag 卡片（FE-批5A：自 task-detail.tsx 拆出）。
 * scanFullPage / virtualScroll / qualityProfile / pageTypeHint /
 * autoExpandDetails 五个策略信号以 Tag 呈现，无信号时不渲染卡片。
 */

import { Card, Space, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import {
  pageTypeHintLabel,
  qualityProfileLabel,
  type CrawlTaskConfig,
  type StrategyViewModel,
} from "./task-detail-config-core-model";

interface StrategyCardProps {
  config: CrawlTaskConfig;
  strategy: StrategyViewModel;
}

export function TaskDetailStrategyCard({ config, strategy }: StrategyCardProps) {
  const { t } = useTranslation();
  const { virtualScroll } = strategy;
  const qualitySummary = qualityProfileLabel(strategy.qualityProfileValue, t);
  const pageTypeSummary = pageTypeHintLabel(strategy.pageTypeHintValue, t);

  const tags = [];
  if (config?.scanFullPage) {
    tags.push(
      <Tag key="scanFullPage" color="blue">
        {t("crawl.settings.scanFullPage")}
      </Tag>,
    );
  }
  if (virtualScroll) {
    tags.push(
      <Tag key="virtualScroll" color="cyan">
        {t("crawl.virtualScroll.title")}
      </Tag>,
    );
  }
  if (qualitySummary) {
    tags.push(
      <Tag key="qualityProfile" color="purple">
        {qualitySummary}
      </Tag>,
    );
  }
  if (pageTypeSummary) {
    tags.push(
      <Tag key="pageTypeHint" color="magenta">
        {pageTypeSummary}
      </Tag>,
    );
  }
  if (strategy.autoExpandDetails) {
    tags.push(
      <Tag key="autoExpandDetails" color="green">
        {t("crawl.settings.autoExpandDetails")}
      </Tag>,
    );
  }

  if (!tags.length) {
    return null;
  }
  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={t("crawl.detail.strategy.title")}
    >
      <Space wrap size={[4, 6]}>
        {tags}
      </Space>
      <Typography.Paragraph
        type="secondary"
        style={{ marginBottom: 0, marginTop: 8 }}
      >
        {t("crawl.detail.strategy.noLlmHint")}
      </Typography.Paragraph>
    </Card>
  );
}
