"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import type { useRouter } from "next/navigation";
import { useMemo } from "react";
import type { useTranslation } from "react-i18next";

import { buildAdminSettingsHref } from "@/app/(app)/admin/settings/settings-navigation";
import { formatDateTime, type SupportedLocale } from "@/lib/i18n";

import {
  resolveCrawlQualityRateAlerts,
  resolveCrawlQualityThresholds,
  resolveCrawlQualityThresholdStatus,
} from "./news-sources.helpers";
import type {
  Crawl4aiQualitySnapshot,
  Crawl4aiQueueStats,
  NewsSourceReadinessSummary,
} from "./news-sources.types";

export interface NewsSourcesOpsPanelsProps {
  t: ReturnType<typeof useTranslation>["t"];
  locale: SupportedLocale;
  router: ReturnType<typeof useRouter>;
  canManage: boolean;
  readinessSummary: NewsSourceReadinessSummary | null;
  readinessLoading: boolean;
  readinessError: string | null;
  crawlQueueStats: Crawl4aiQueueStats | null;
  crawlQueueLoading: boolean;
  crawlQueueError: string | null;
  crawlQualityStats: Crawl4aiQualitySnapshot | null;
  crawlQualityLoading: boolean;
  crawlQualityError: string | null;
  loadReadinessSummary: () => Promise<void>;
  loadCrawlQueueStats: () => Promise<void>;
  loadCrawlQualityStats: () => Promise<void>;
  openCreate: () => void;
  openOpmlImport: () => Promise<void>;
}

export function NewsSourcesOpsPanels({
  t,
  locale,
  router,
  canManage,
  readinessSummary,
  readinessLoading,
  readinessError,
  crawlQueueStats,
  crawlQueueLoading,
  crawlQueueError,
  crawlQualityStats,
  crawlQualityLoading,
  crawlQualityError,
  loadReadinessSummary,
  loadCrawlQueueStats,
  loadCrawlQualityStats,
  openCreate,
  openOpmlImport,
}: NewsSourcesOpsPanelsProps) {
  const schedulerSettingsHref = buildAdminSettingsHref({
    page: "ingestion",
    panel: "news-source-scheduler",
  });
  const readinessState = !readinessSummary
    ? null
    : readinessSummary.total === 0
      ? "empty"
      : readinessSummary.active === 0
        ? "inactive"
        : readinessSummary.circuitOpen > 0 || readinessSummary.failing > 0
          ? "degraded"
          : "ready";
  const readinessTone =
    readinessState === "empty"
      ? "info"
      : readinessState === "inactive" || readinessState === "degraded"
        ? "warning"
        : "success";
  const crawlQualityThresholds = useMemo(
    () => resolveCrawlQualityThresholds(crawlQualityStats),
    [crawlQualityStats],
  );
  const crawlQualityThresholdStatus = useMemo(
    () =>
      resolveCrawlQualityThresholdStatus(
        crawlQualityStats,
        crawlQualityThresholds,
      ),
    [crawlQualityStats, crawlQualityThresholds],
  );
  const crawlQualityRateAlerts = useMemo(
    () =>
      resolveCrawlQualityRateAlerts(crawlQualityStats, crawlQualityThresholds),
    [crawlQualityStats, crawlQualityThresholds],
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Card
            size="small"
            title={t("newsSources.readiness.title")}
            extra={
              <Button
                size="small"
                onClick={() => void loadReadinessSummary()}
                loading={readinessLoading}
              >
                {t("common.refresh")}
              </Button>
            }
          >
            {readinessError ? (
              <Alert
                type="warning"
                showIcon
                message={t("newsSources.readiness.loadFailed")}
                description={readinessError}
                style={{ marginBottom: 12 }}
              />
            ) : null}
            {readinessSummary ? (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <Alert
                  type={readinessTone}
                  showIcon
                  message={
                    readinessState === "empty"
                      ? t("newsSources.readiness.noSourcesConfigured")
                      : readinessState === "inactive"
                      ? t("newsSources.readiness.noActiveSources")
                      : readinessState === "degraded"
                        ? t("newsSources.readiness.degraded")
                        : t("newsSources.readiness.ready")
                  }
                  description={
                    readinessState === "empty"
                      ? t("newsSources.readiness.noSourcesConfiguredDescription")
                      : readinessState === "inactive"
                      ? t("newsSources.readiness.noActiveSourcesDescription")
                      : readinessState === "degraded"
                        ? t("newsSources.readiness.degradedDescription")
                        : undefined
                  }
                  action={
                    canManage ? (
                      <Space wrap>
                        <Button size="small" onClick={openCreate}>
                          {t("newsSources.actions.new")}
                        </Button>
                        <Button
                          size="small"
                          onClick={() => void openOpmlImport()}
                        >
                          {t("newsSources.actions.importOpml")}
                        </Button>
                        <Button size="small" href={schedulerSettingsHref}>
                          {t("newsSources.readiness.openSchedulerSettings")}
                        </Button>
                      </Space>
                    ) : null
                  }
                />
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.readiness.total")}
                      value={readinessSummary.total}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.readiness.active")}
                      value={readinessSummary.active}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.readiness.inactive")}
                      value={readinessSummary.inactive}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.readiness.circuitOpen")}
                      value={readinessSummary.circuitOpen}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.readiness.failing")}
                      value={readinessSummary.failing}
                    />
                  </Col>
                </Row>
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {readinessLoading
                  ? t("common.loading")
                  : t("common.noData")}
              </Typography.Text>
            )}
          </Card>
          <Card
            size="small"
            title={t("newsSources.queue.title")}
            extra={
              <Button
                size="small"
                onClick={() => void loadCrawlQueueStats()}
                loading={crawlQueueLoading}
              >
                {t("common.refresh")}
              </Button>
            }
          >
            {crawlQueueError ? (
              <Alert
                type="warning"
                showIcon
                message={t("newsSources.queue.loadFailed")}
                description={crawlQueueError}
                style={{ marginBottom: 12 }}
              />
            ) : null}
            {crawlQueueStats ? (
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.pending")}
                      value={crawlQueueStats.pending}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.waiting")}
                      value={crawlQueueStats.counts.waiting ?? 0}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.active")}
                      value={crawlQueueStats.counts.active ?? 0}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.delayed")}
                      value={crawlQueueStats.counts.delayed ?? 0}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.failed")}
                      value={crawlQueueStats.counts.failed ?? 0}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.queue.concurrency")}
                      value={crawlQueueStats.maxConcurrency ?? "-"}
                    />
                  </Col>
                </Row>
                <Typography.Text type="secondary">
                  {t("newsSources.queue.updatedAt", {
                    time: formatDateTime(crawlQueueStats.updatedAt, locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </Typography.Text>
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {crawlQueueLoading
                  ? t("common.loading")
                  : t("common.noData")}
              </Typography.Text>
            )}
          </Card>

          <Card
            size="small"
            title={t("newsSources.quality.title")}
            extra={
              <Space size={8}>
                <Button
                  size="small"
                  onClick={() => void router.push("/admin/alerts")}
                >
                  {t("newsSources.quality.manageThresholds")}
                </Button>
                <Button
                  size="small"
                  onClick={() => void loadCrawlQualityStats()}
                  loading={crawlQualityLoading}
                >
                  {t("common.refresh")}
                </Button>
              </Space>
            }
          >
            {crawlQualityError ? (
              <Alert
                type="warning"
                showIcon
                message={t("newsSources.quality.loadFailed")}
                description={crawlQualityError}
                style={{ marginBottom: 12 }}
              />
            ) : null}
            {crawlQualityStats ? (
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.taskCount")}
                      value={crawlQualityStats.taskCount}
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.lowSignal")}
                      value={Number(
                        (crawlQualityStats.lowSignalRatio * 100).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.emptyMarkdown")}
                      value={Number(
                        (crawlQualityStats.emptyMarkdownRate * 100).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.expansionTrigger")}
                      value={Number(
                        (crawlQualityStats.expansionTriggerRate * 100).toFixed(
                          1,
                        ),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.expansionSuccess")}
                      value={Number(
                        (crawlQualityStats.expansionSuccessRate * 100).toFixed(
                          1,
                        ),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Statistic
                      title={t("newsSources.quality.avgMarkdownChars")}
                      value={crawlQualityStats.avgMarkdownChars}
                    />
                  </Col>
                </Row>
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.publishConfidenceRejects")}
                      value={
                        crawlQualityStats.candidateRejects?.publishConfidence ??
                        0
                      }
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.patternRejects")}
                      value={
                        (crawlQualityStats.candidateRejects?.includePattern ??
                          0) +
                        (crawlQualityStats.candidateRejects?.excludePattern ??
                          0)
                      }
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.fitMarkdownPreference")}
                      value={Number(
                        (
                          (crawlQualityStats.fitMarkdownPreferenceRate ?? 0) *
                          100
                        ).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.headSignalSuccess")}
                      value={Number(
                        (
                          (crawlQualityStats.headSignalSuccessRate ?? 0) * 100
                        ).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                </Row>
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.headSignalSoftFailure")}
                      value={Number(
                        (
                          (crawlQualityStats.headSignalSoftFailureRate ?? 0) *
                          100
                        ).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t("newsSources.quality.headSignalTruncated")}
                      value={Number(
                        (
                          (crawlQualityStats.headSignalTruncatedRate ?? 0) * 100
                        ).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={t(
                        "newsSources.quality.headSignalNoPublishSignal",
                      )}
                      value={Number(
                        (
                          (crawlQualityStats.headSignalNoPublishSignalRate ??
                            0) * 100
                        ).toFixed(1),
                      )}
                      suffix="%"
                    />
                  </Col>
                </Row>
                <Row gutter={[16, 12]}>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={
                        <Space size={4} wrap>
                          <span>
                            {t("newsSources.quality.http304HitRate")}
                          </span>
                          <Tag
                            color={
                              (crawlQualityThresholdStatus?.preflightRunCount ??
                                0) <= 0
                                ? "default"
                                : crawlQualityThresholdStatus?.http304Breached
                                ? "red"
                                : "green"
                            }
                          >
                            {(crawlQualityThresholdStatus?.preflightRunCount ??
                              0) <= 0
                              ? t("newsSources.quality.thresholdStatusNoData")
                              : crawlQualityThresholdStatus?.http304Breached
                                ? t(
                                    "newsSources.quality.thresholdStatusBreached",
                                  )
                                : t(
                                    "newsSources.quality.thresholdStatusNormal",
                                  )}
                          </Tag>
                          <Tag>
                            {`<= ${Number(
                              (
                                crawlQualityThresholds.http304HitRateLow * 100
                              ).toFixed(1),
                            )}%`}
                          </Tag>
                        </Space>
                      }
                      value={
                        (crawlQualityThresholdStatus?.preflightRunCount ?? 0) >
                        0
                          ? Number(
                              ((crawlQualityStats.http304HitRate ?? 0) * 100)
                                .toFixed(1),
                            )
                          : "-"
                      }
                      suffix={
                        (crawlQualityThresholdStatus?.preflightRunCount ?? 0) >
                        0
                          ? "%"
                          : ""
                      }
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={
                        <Space size={4} wrap>
                          <span>
                            {t("newsSources.quality.preflightFailureRate")}
                          </span>
                          <Tag
                            color={
                              (crawlQualityThresholdStatus?.preflightRunCount ??
                                0) <= 0
                                ? "default"
                                : crawlQualityThresholdStatus?.preflightFailureBreached
                                ? "red"
                                : "green"
                            }
                          >
                            {(crawlQualityThresholdStatus?.preflightRunCount ??
                              0) <= 0
                              ? t("newsSources.quality.thresholdStatusNoData")
                              : crawlQualityThresholdStatus?.preflightFailureBreached
                                ? t(
                                    "newsSources.quality.thresholdStatusBreached",
                                  )
                                : t(
                                    "newsSources.quality.thresholdStatusNormal",
                                  )}
                          </Tag>
                          <Tag>
                            {`>= ${Number(
                              (
                                crawlQualityThresholds.preflightFailureRateHigh *
                                100
                              ).toFixed(1),
                            )}%`}
                          </Tag>
                        </Space>
                      }
                      value={
                        (crawlQualityThresholdStatus?.preflightRunCount ?? 0) >
                        0
                          ? Number(
                              (
                                (crawlQualityStats.preflightFailureRate ?? 0) *
                                100
                              ).toFixed(1),
                            )
                          : "-"
                      }
                      suffix={
                        (crawlQualityThresholdStatus?.preflightRunCount ?? 0) >
                        0
                          ? "%"
                          : ""
                      }
                    />
                  </Col>
                  <Col xs={12} sm={8} md={6}>
                    <Statistic
                      title={
                        <Space size={4} wrap>
                          <span>
                            {t("newsSources.quality.orgHashDedupeHitRate")}
                          </span>
                          <Tag
                            color={
                              (crawlQualityThresholdStatus?.dedupeEvaluatedCount ??
                                0) <= 0
                                ? "default"
                                : crawlQualityThresholdStatus?.orgHashDedupeBreached
                                ? "red"
                                : "green"
                            }
                          >
                            {(crawlQualityThresholdStatus?.dedupeEvaluatedCount ??
                              0) <= 0
                              ? t("newsSources.quality.thresholdStatusNoData")
                              : crawlQualityThresholdStatus?.orgHashDedupeBreached
                                ? t(
                                    "newsSources.quality.thresholdStatusBreached",
                                  )
                                : t(
                                    "newsSources.quality.thresholdStatusNormal",
                                  )}
                          </Tag>
                          <Tag>
                            {`>= ${Number(
                              (
                                crawlQualityThresholds.orgHashDedupeHitRateHigh *
                                100
                              ).toFixed(1),
                            )}%`}
                          </Tag>
                        </Space>
                      }
                      value={
                        (crawlQualityThresholdStatus?.dedupeEvaluatedCount ??
                          0) > 0
                          ? Number(
                              (
                                (crawlQualityStats.orgHashDedupeHitRate ?? 0) *
                                100
                              ).toFixed(1),
                            )
                          : "-"
                      }
                      suffix={
                        (crawlQualityThresholdStatus?.dedupeEvaluatedCount ??
                          0) > 0
                          ? "%"
                          : ""
                      }
                    />
                  </Col>
                </Row>
                <Typography.Text type="secondary">
                  {t("newsSources.quality.thresholdHint")}
                </Typography.Text>
                {crawlQualityStats.taskCount === 0 ? (
                  <Alert
                    type="info"
                    showIcon
                    message={t("newsSources.quality.noSamples")}
                    description={t("newsSources.quality.noSamplesDescription")}
                  />
                ) : null}
                {crawlQualityRateAlerts.length > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={t("newsSources.quality.crawlQualityAlertTitle")}
                    description={crawlQualityRateAlerts
                      .map((entry) =>
                        t(
                          `newsSources.quality.crawlQualityAlert.${entry.key}`,
                          {
                            defaultValue:
                              "{{metric}} {{overall}}% (threshold {{operator}} {{threshold}}%; {{extremeLabel}} source: {{source}} {{sourceRate}}%)",
                            metric:
                              entry.key === "softFailure"
                                ? t(
                                    "newsSources.quality.headSignalSoftFailure",
                                  )
                                : entry.key === "truncated"
                                  ? t(
                                      "newsSources.quality.headSignalTruncated",
                                    )
                                  : entry.key === "noPublishSignal"
                                    ? t(
                                        "newsSources.quality.headSignalNoPublishSignal",
                                      )
                                    : entry.key === "preflightFailure"
                                      ? t(
                                          "newsSources.quality.preflightFailureRate",
                                        )
                                      : entry.key === "orgHashDedupeHigh"
                                        ? t(
                                            "newsSources.quality.orgHashDedupeHitRate",
                                          )
                                        : t(
                                            "newsSources.quality.http304HitRate",
                                          ),
                            overall: Number(
                              (entry.overallRate * 100).toFixed(1),
                            ),
                            operator: entry.direction === "high" ? ">=" : "<=",
                            threshold: Number(
                              (entry.threshold * 100).toFixed(1),
                            ),
                            extremeLabel:
                              entry.direction === "high"
                                ? t("newsSources.quality.highestSource")
                                : t("newsSources.quality.lowestSource"),
                            source: entry.extremeSource?.sourceId ?? "unknown",
                            sourceRate: Number(
                              ((entry.extremeSource?.rate ?? 0) * 100).toFixed(
                                1,
                              ),
                            ),
                          },
                        ),
                      )
                      .join(" | ")}
                  />
                ) : null}
                <Typography.Text type="secondary">
                  {t("newsSources.quality.publishConfidenceBuckets", {
                    lt04: crawlQualityStats.publishConfidenceBuckets?.lt04 ?? 0,
                    from04To06:
                      crawlQualityStats.publishConfidenceBuckets?.from04To06 ??
                      0,
                    from06To08:
                      crawlQualityStats.publishConfidenceBuckets?.from06To08 ??
                      0,
                    gte08:
                      crawlQualityStats.publishConfidenceBuckets?.gte08 ?? 0,
                  })}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {t("newsSources.quality.updatedAt", {
                    from: formatDateTime(crawlQualityStats.from, locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                    to: formatDateTime(crawlQualityStats.to, locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </Typography.Text>
              </Space>
            ) : (
              <Typography.Text type="secondary">
                {crawlQualityLoading
                  ? t("common.loading")
                  : t("common.noData")}
              </Typography.Text>
            )}
          </Card>

    </Space>
  );
}
