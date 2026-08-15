"use client";

import { DownOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Card, List, Popover, Space, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { formatDateTime, type SupportedLocale } from "@/lib/i18n";
import { safeHttpUrl } from "@/lib/url";
import { useSituationMonitorSettingsStore } from "@/store/situation-monitor-settings";

import type {
  SituationMonitorCategory,
  SituationMonitorCoverageSummary,
  SituationMonitorInsightsResponse,
} from "../types/situation-monitor-content";
import type { SituationMonitorMatchResult } from "../types/situation-monitor-monitors";
import {
  formatWindowOptionLabel,
  getExternalSnapshotCategoryStatusColor,
  getSituationMonitorCategoryLabels,
  stopSituationMonitorInteractiveEvent,
} from "../utils/situation-monitor-format";

import { useSituationMonitorHeadlines } from "./situation-monitor-headlines";

export interface SituationMonitorFeedsPanelProps {
  category: SituationMonitorCategory;
  data: SituationMonitorInsightsResponse | null;
  initialLoading: boolean;
  translateToZh: boolean;
  locale: SupportedLocale;
  rateLimitedCategories: Set<string>;
  noActiveSourcesConfigured: boolean;
  coverageSummary: SituationMonitorCoverageSummary | undefined;
  recommendedWindowHours: number | null;
  expandedClusterIds: string[];
  toggleClusterExpansion: (clusterId: string) => void;
  monitorMatchesByKey: Map<string, SituationMonitorMatchResult[]>;
  monitorColorById: Map<string, string>;
}

export function SituationMonitorFeedsPanel(
  props: SituationMonitorFeedsPanelProps,
) {
  const {
    category,
    data,
    initialLoading,
    translateToZh,
    locale,
    rateLimitedCategories,
    noActiveSourcesConfigured,
    coverageSummary,
    recommendedWindowHours,
    expandedClusterIds,
    toggleClusterExpansion,
    monitorMatchesByKey,
    monitorColorById,
  } = props;
  const { t } = useTranslation();
  const setWindowHours = useSituationMonitorSettingsStore(
    (state) => state.setWindowHours,
  );
  const categoryLabels = getSituationMonitorCategoryLabels(t);
  const internalFeedTooltip = t("situationMonitor.feeds.internalTooltip");
  const gdeltFeedTooltip = t("situationMonitor.feeds.gdeltTooltip");
  const clusterItemsPerCategory = 6;
  const {
    renderHeadlineSummary,
    renderHeadlineTopics,
    renderHeadlineDetails,
    renderHeadlineItemLink,
    renderHeadlineMonitorMatches,
    renderClusterMonitorMatches,
  } = useSituationMonitorHeadlines({
    translateToZh,
    monitorMatchesByKey,
    monitorColorById,
  });

    const clusters = data?.clusters?.[category] ?? [];
    const diagnostics = data?.diagnostics?.categories?.[category];
    const snapshotCategoryState =
      data?.externalSnapshot?.categories?.[category];
    const emptyReason =
      clusters.length > 0
        ? null
        : snapshotCategoryState?.reasonCode === "gdelt_rate_limited" ||
            rateLimitedCategories.has(category)
          ? {
              tag: t("situationMonitor.feeds.emptyReason.rateLimited"),
              description: t(
                "situationMonitor.feeds.emptyDescription.rateLimited",
              ),
            }
          : snapshotCategoryState?.reasonCode === "gdelt_request_failed" ||
              snapshotCategoryState?.reasonCode === "gdelt_invalid_response"
            ? {
                tag: t("situationMonitor.feeds.emptyReason.upstream"),
                description: t(
                  "situationMonitor.feeds.emptyDescription.upstream",
                ),
              }
            : noActiveSourcesConfigured
              ? {
                  tag: t("situationMonitor.feeds.emptyReason.unconfigured"),
                  description: t(
                    "situationMonitor.feeds.emptyDescription.unconfigured",
                  ),
                }
              : coverageSummary?.hasOlderItemsOutsideWindow &&
                  recommendedWindowHours
                ? {
                    tag: t("situationMonitor.feeds.emptyReason.outsideWindow"),
                    description: t(
                      "situationMonitor.feeds.emptyDescription.outsideWindow",
                    ),
                  }
                : {
                    tag: t("situationMonitor.feeds.emptyReason.noData"),
                    description: t(
                      "situationMonitor.feeds.emptyDescription.noData",
                    ),
                  };
    return (
      <Card
        title={
          <Space size={10}>
            <span>{categoryLabels[category]}</span>
            {snapshotCategoryState?.status === "reused" ? (
              <Popover
                content={t("situationMonitor.snapshot.reusedCategoryHint", {
                  time: snapshotCategoryState.contentGeneratedAt
                    ? formatDateTime(
                        snapshotCategoryState.contentGeneratedAt,
                        locale,
                        {
                          dateStyle: "medium",
                          timeStyle: "short",
                        },
                      )
                    : "--",
                })}
              >
                <Tag
                  color={getExternalSnapshotCategoryStatusColor(
                    snapshotCategoryState.status,
                  )}
                  className="cursor-help"
                >
                  {t("situationMonitor.snapshot.reusedCategory")}
                </Tag>
              </Popover>
            ) : null}
            <Tag color="geekblue">
              {t("situationMonitor.feeds.clusterCount", {
                count: diagnostics?.clusterCount ?? clusters.length,
              })}
            </Tag>
            <Tag color="default">
              {t("situationMonitor.feeds.articleCount", {
                count: diagnostics?.totalCount ?? 0,
              })}
            </Tag>
            {diagnostics ? (
              <Popover content={internalFeedTooltip}>
                <Tag color="blue" className="cursor-help">
                  {t("situationMonitor.feeds.internalCount", {
                    count: diagnostics.internalCount,
                  })}
                </Tag>
              </Popover>
            ) : null}
            {diagnostics ? (
              <Popover content={gdeltFeedTooltip}>
                <Tag color="purple" className="cursor-help">
                  {t("situationMonitor.feeds.externalCount", {
                    count: diagnostics.gdeltFallbackCount,
                  })}
                </Tag>
              </Popover>
            ) : null}
          </Space>
        }
        className="sm-panel-card glass-panel border border-[var(--border)] h-full"
        size="small"
        loading={initialLoading}
      >
        {clusters.length === 0 ? (
          <Space direction="vertical" size={4}>
            {emptyReason ? (
              <Tag color="default" style={{ width: "fit-content" }}>
                {emptyReason.tag}
              </Tag>
            ) : null}
            <Typography.Text type="secondary">
              {emptyReason?.description ??
                t("situationMonitor.feeds.empty")}
            </Typography.Text>
            {data?.diagnostics?.effectiveScope === "tagged" ? (
              <Typography.Text type="secondary">
                {t("situationMonitor.feeds.taggedHint")}
              </Typography.Text>
            ) : null}
            {recommendedWindowHours ? (
              <Button
                size="small"
                onClick={() => setWindowHours(recommendedWindowHours)}
              >
                {t("situationMonitor.actions.switchWindow", {
                  window: formatWindowOptionLabel(
                    recommendedWindowHours,
                    t,
                    locale,
                  ),
                })}
              </Button>
            ) : null}
          </Space>
        ) : (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {clusters.slice(0, clusterItemsPerCategory).map((cluster) => {
              const lead = cluster.lead;
              const href = lead.link ? safeHttpUrl(lead.link) : null;
              const leadDate = Number.isFinite(cluster.latestTimestamp)
                ? new Date(cluster.latestTimestamp)
                : null;
              const expanded = expandedClusterIds.includes(cluster.id);
              return (
                <Card
                  key={cluster.id}
                  size="small"
                  className="border border-[var(--border)]"
                >
                  <Space
                    direction="vertical"
                    size={8}
                    style={{ width: "100%" }}
                  >
                    <Space wrap size={8}>
                      {cluster.isAlert ? (
                        <Tag color="red">
                          {t("situationMonitor.feeds.alert")}
                        </Tag>
                      ) : null}
                      {cluster.mixedSource ? (
                        <Tag color="green">
                          {t("situationMonitor.feeds.mixedCluster")}
                        </Tag>
                      ) : null}
                      <Tag color="blue">
                        {t("situationMonitor.feeds.internalCount", {
                          count: cluster.internalCount,
                        })}
                      </Tag>
                      <Tag color="purple">
                        {t("situationMonitor.feeds.externalCount", {
                          count: cluster.externalCount,
                        })}
                      </Tag>
                      <Tag color="default">
                        {t("situationMonitor.feeds.sourcesCount", {
                          count: cluster.distinctSourceCount,
                        })}
                      </Tag>
                      {renderClusterMonitorMatches(cluster)}
                    </Space>

                    <Space wrap size={8}>
                      {href ? (
                        <Typography.Link
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {translateToZh
                            ? (lead.titleZh ?? lead.title)
                            : lead.title}
                        </Typography.Link>
                      ) : (
                        <Typography.Text strong>
                          {translateToZh
                            ? (lead.titleZh ?? lead.title)
                            : lead.title}
                        </Typography.Text>
                      )}
                      {renderHeadlineItemLink(lead)}
                      {renderHeadlineDetails(lead)}
                    </Space>

                    {renderHeadlineSummary(lead)}

                    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white/20 px-3 py-2 dark:bg-white/[0.03]">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <Space wrap size={[8, 8]} style={{ flex: 1 }}>
                          <Typography.Text type="secondary">
                            {leadDate
                              ? formatDateTime(leadDate, locale, {
                                  month: "2-digit",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : "—"}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {t("situationMonitor.feeds.rawArticleCount", {
                              count: cluster.items.length,
                            })}
                          </Typography.Text>
                          {renderHeadlineTopics(lead)}
                        </Space>
                        <Button
                          size="small"
                          icon={expanded ? <DownOutlined /> : <RightOutlined />}
                          className="self-start sm:ml-3 sm:self-center"
                          data-sm-interactive
                          onPointerDown={stopSituationMonitorInteractiveEvent}
                          onMouseDown={stopSituationMonitorInteractiveEvent}
                          onClick={(event) => {
                            stopSituationMonitorInteractiveEvent(event);
                            toggleClusterExpansion(cluster.id);
                          }}
                        >
                          {expanded
                            ? t("situationMonitor.feeds.hideRawArticles")
                            : t("situationMonitor.feeds.viewRawArticles")}
                        </Button>
                      </div>
                    </div>

                    {expanded ? (
                      <List
                        size="small"
                        dataSource={cluster.items}
                        renderItem={(entry) => {
                          const rawHref = entry.link
                            ? safeHttpUrl(entry.link)
                            : null;
                          const rawDate = Number.isFinite(entry.timestamp)
                            ? new Date(entry.timestamp)
                            : null;
                          return (
                            <List.Item key={`${cluster.id}:${entry.id}`}>
                              <Space
                                direction="vertical"
                                size={2}
                                style={{ width: "100%" }}
                              >
                                <Space size={8} wrap>
                                  {entry.isAlert ? (
                                    <Tag color="red">
                                      {t("situationMonitor.feeds.alert")}
                                    </Tag>
                                  ) : null}
                                  {entry.origin === "gdelt" ? (
                                    <Popover content={gdeltFeedTooltip}>
                                      <Tag
                                        color="purple"
                                        className="cursor-help"
                                      >
                                        {t(
                                          "situationMonitor.notice.gdeltLabel",
                                        )}
                                      </Tag>
                                    </Popover>
                                  ) : (
                                    <Popover content={internalFeedTooltip}>
                                      <Tag color="blue" className="cursor-help">
                                        {t(
                                          "situationMonitor.notice.internalLabel",
                                        )}
                                      </Tag>
                                    </Popover>
                                  )}
                                  {renderHeadlineMonitorMatches(entry)}
                                  {rawHref ? (
                                    <Typography.Link
                                      href={rawHref}
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
                                  {rawDate ? (
                                    <Typography.Text type="secondary">
                                      {formatDateTime(rawDate, locale, {
                                        month: "2-digit",
                                        day: "2-digit",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </Typography.Text>
                                  ) : null}
                                  {renderHeadlineTopics(entry)}
                                </Space>
                              </Space>
                            </List.Item>
                          );
                        }}
                      />
                    ) : null}
                  </Space>
                </Card>
              );
            })}
          </Space>
        )}
      </Card>
    );

}
