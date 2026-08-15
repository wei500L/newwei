"use client";

import { Alert, Button, Card, List, Space, Tag, Grid, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { formatDateTime, type SupportedLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";

import type {
  SituationMonitorCoverageSummary,
  SituationMonitorInsightsResponse,
} from "../types/situation-monitor-content";
import type { SituationMonitorMatchResult } from "../types/situation-monitor-monitors";
import {
  formatWindowCompactLabel,
  formatWindowOptionLabel,
  getCoverageModeColor,
  getCoverageModeLabel,
  getExternalSnapshotStatusColor,
  getExternalSnapshotStatusLabel,
  getSituationMonitorCategoryLabels,
} from "../utils/situation-monitor-format";

import { useSituationMonitorHeadlines } from "./situation-monitor-headlines";

export interface SituationMonitorSummaryAction {
  key: string;
  label: string;
  onClick: () => void;
  type?: "primary" | "default";
}

interface SharedPanelProps {
  data: SituationMonitorInsightsResponse | null;
  initialLoading: boolean;
  locale: SupportedLocale;
  translateToZh: boolean;
  coverageSummary: SituationMonitorCoverageSummary | undefined;
}

export interface SituationMonitorSummaryPanelProps extends SharedPanelProps {
  windowHours: number;
}

export function SituationMonitorSummaryPanel(
  props: SituationMonitorSummaryPanelProps,
) {
  const { data, initialLoading, locale, coverageSummary, windowHours } = props;
  const { t } = useTranslation();

  return (
    <Card
      size="small"
      title={t("situationMonitor.summary.title")}
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        <Space wrap size={8}>
          <Tag color="geekblue">
            {t("situationMonitor.summary.articles", {
              count: coverageSummary?.articleCount ?? data?.analyzedItems ?? 0,
            })}
          </Tag>
          <Tag color="cyan">
            {t("situationMonitor.summary.clusters", {
              count: coverageSummary?.clusterCount ?? 0,
            })}
          </Tag>
          <Tag color="blue">
            {t("situationMonitor.summary.internal", {
              count: coverageSummary?.internalAnalyzedItems ?? 0,
            })}
          </Tag>
          <Tag color="purple">
            {t("situationMonitor.summary.external", {
              count: coverageSummary?.externalAnalyzedItems ?? 0,
            })}
          </Tag>
          <Tag color="green">
            {t("situationMonitor.summary.mixedClusters", {
              count: coverageSummary?.mixedSourceClusterCount ?? 0,
            })}
          </Tag>
        </Space>
        <Space wrap size={8}>
          <Tag color="default">
            {formatWindowCompactLabel(windowHours, t, locale)}
          </Tag>
          <Tag color={getCoverageModeColor(coverageSummary?.mode ?? "empty")}>
            {getCoverageModeLabel(coverageSummary?.mode ?? "empty", t)}
          </Tag>
        </Space>
        <Typography.Text type="secondary">
          {t("situationMonitor.summary.caption")}
        </Typography.Text>
      </Space>
    </Card>
  );
}

export interface SituationMonitorCoveragePanelProps extends SharedPanelProps {
  freshSnapshotCategoryCount: number;
  reusedSnapshotCategoryCount: number;
}

export function SituationMonitorCoveragePanel(
  props: SituationMonitorCoveragePanelProps,
) {
  const {
    data,
    initialLoading,
    locale,
    coverageSummary,
    freshSnapshotCategoryCount,
    reusedSnapshotCategoryCount,
  } = props;
  const { t } = useTranslation();
  const categoryLabels = getSituationMonitorCategoryLabels(t);

  return (
    <Card
      size="small"
      title={t("situationMonitor.coverage.title")}
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        <Space wrap size={8}>
          <Tag
            color={getExternalSnapshotStatusColor(
              data?.externalSnapshot?.status ?? "idle",
            )}
          >
            {getExternalSnapshotStatusLabel(
              data?.externalSnapshot?.status ?? "idle",
              t,
            )}
          </Tag>
          {data?.externalSnapshot?.stale ? (
            <Tag color="volcano">
              {t("situationMonitor.snapshot.stale")}
            </Tag>
          ) : null}
          {freshSnapshotCategoryCount > 0 ? (
            <Tag color="green">
              {t("situationMonitor.snapshot.freshCategories", {
                count: freshSnapshotCategoryCount,
              })}
            </Tag>
          ) : null}
          {reusedSnapshotCategoryCount > 0 ? (
            <Tag color="gold">
              {t("situationMonitor.snapshot.reusedCategories", {
                count: reusedSnapshotCategoryCount,
              })}
            </Tag>
          ) : null}
        </Space>
        <Typography.Text type="secondary">
          {t("situationMonitor.coverage.visibleCategories", {
            count: coverageSummary?.visibleCategoryCount ?? 0,
          })}
        </Typography.Text>
        <Typography.Text type="secondary">
          {t("situationMonitor.coverage.quality", {
            dedupe:
              coverageSummary?.dedupeRatio !== null &&
              coverageSummary?.dedupeRatio !== undefined
                ? `${(coverageSummary.dedupeRatio * 100).toFixed(1)}%`
                : "--",
            sources:
              coverageSummary?.avgSourcesPerCluster !== null &&
              coverageSummary?.avgSourcesPerCluster !== undefined
                ? coverageSummary.avgSourcesPerCluster.toFixed(1)
                : "--",
          })}
        </Typography.Text>
        <Typography.Text type="secondary">
          {t("situationMonitor.coverage.generatedAt", {
            time: data?.externalSnapshot?.generatedAt
              ? formatDateTime(data.externalSnapshot.generatedAt, locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : "--",
          })}
        </Typography.Text>
        <Typography.Text type="secondary">
          {t("situationMonitor.coverage.missingCategories", {
            categories: coverageSummary?.missingCategories.length
              ? coverageSummary.missingCategories
                  .map((category) => categoryLabels[category])
                  .join(", ")
              : t("situationMonitor.coverage.noneMissing"),
          })}
        </Typography.Text>
      </Space>
    </Card>
  );
}

export interface SituationMonitorNextActionsPanelProps {
  initialLoading: boolean;
  recommendedWindowHours: number | null;
  locale: SupportedLocale;
  summaryActionItems: SituationMonitorSummaryAction[];
}

export function SituationMonitorNextActionsPanel(
  props: SituationMonitorNextActionsPanelProps,
) {
  const { initialLoading, recommendedWindowHours, locale, summaryActionItems } =
    props;
  const { t } = useTranslation();

  return (
    <Card
      size="small"
      title={t("situationMonitor.actions.title")}
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        {recommendedWindowHours ? (
          <Alert
            type="info"
            showIcon
            message={t("situationMonitor.actions.recommendedWindow", {
              window: formatWindowOptionLabel(recommendedWindowHours, t, locale),
            })}
          />
        ) : null}
        <Space wrap>
          {summaryActionItems.map((action) => (
            <Button
              key={`summary:${action.key}`}
              type={action.type}
              size="small"
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </Space>
      </Space>
    </Card>
  );
}

export interface SituationMonitorAlertsPanelProps extends SharedPanelProps {
  monitorMatchesByKey: Map<string, SituationMonitorMatchResult[]>;
  monitorColorById: Map<string, string>;
}

export function SituationMonitorAlertsPanel(
  props: SituationMonitorAlertsPanelProps,
) {
  const {
    data,
    initialLoading,
    locale,
    translateToZh,
    monitorMatchesByKey,
    monitorColorById,
  } = props;
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();
  const categoryLabels = getSituationMonitorCategoryLabels(t);
  const alertsPerPanel = screens.lg ? 10 : 6;
  const {
    renderHeadlineSummary,
    renderHeadlineTopics,
    renderHeadlineDetails,
    renderHeadlineItemLink,
    renderHeadlineMonitorMatches,
  } = useSituationMonitorHeadlines({
    translateToZh,
    monitorMatchesByKey,
    monitorColorById,
  });

  return (
    <Card
      title={
        <Space size={10}>
          <span>
            {t("situationMonitor.alerts.title")}
          </span>
          <Tag color="geekblue">{data?.alerts?.length ?? 0}</Tag>
        </Space>
      }
      className="sm-panel-card glass-panel border border-[var(--border)] h-full"
      loading={initialLoading}
    >
      {data?.alerts?.length ? (
        <List
          size="small"
          dataSource={data.alerts.slice(0, alertsPerPanel)}
          renderItem={(entry) => {
            const href = entry.link ? safeHttpUrl(entry.link) : null;
            const date = Number.isFinite(entry.timestamp)
              ? new Date(entry.timestamp)
              : null;
            return (
              <List.Item key={entry.id}>
                <Space direction="vertical" size={2} style={{ width: "100%" }}>
                  <Space size={8} wrap>
                    <Tag
                      color={entry.severity === "critical" ? "red" : "orange"}
                    >
                      {entry.severity.toUpperCase()}
                    </Tag>
                    <Tag color="blue">{categoryLabels[entry.category]}</Tag>
                    {renderHeadlineMonitorMatches(entry)}
                    {href ? (
                      <Typography.Link
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {translateToZh
                          ? (entry.titleZh ?? entry.title)
                          : entry.title}
                      </Typography.Link>
                    ) : (
                      <Typography.Text>
                        {translateToZh
                          ? (entry.titleZh ?? entry.title)
                          : entry.title}
                      </Typography.Text>
                    )}
                    {renderHeadlineItemLink(entry)}
                    {renderHeadlineDetails(entry)}
                  </Space>
                  {renderHeadlineSummary(entry)}
                  <Space size={8} wrap>
                    <Typography.Text type="secondary">
                      {entry.source}
                    </Typography.Text>
                    {date ? (
                      <Typography.Text type="secondary">
                        {formatDateTime(date, locale, {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Typography.Text>
                    ) : null}
                    {entry.alertKeyword ? (
                      <Typography.Text type="secondary">
                        {entry.alertKeyword}
                      </Typography.Text>
                    ) : null}
                    {renderHeadlineTopics(entry)}
                  </Space>
                </Space>
              </List.Item>
            );
          }}
        />
      ) : (
        <Typography.Text type="secondary">
          {t("situationMonitor.alerts.empty")}
        </Typography.Text>
      )}
    </Card>
  );
}
