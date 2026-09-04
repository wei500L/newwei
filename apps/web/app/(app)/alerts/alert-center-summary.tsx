"use client";

import { Alert, Button, Card, Col, Row, Statistic, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";

import type { AlertStats, AlertTrendPoint } from "./alert-center.utils";

/**
 * Alert Center 摘要域（FE-批3B 从 alert-center.tsx 提取）。
 *
 * - 采样提示：isLikelySampled 时的 warning Alert + Load more 按钮
 *   （300→500 上限语义，行为保持）；
 * - 统计卡行：total/pending/confirmed/ignored/误报率；
 * - 趋势卡：trend chart + 窗口标签。
 */

export interface AlertCenterSummaryProps {
  isLikelySampled: boolean;
  canLoadMoreHistory: boolean;
  eventsLimit: number;
  eventsLoading: boolean;
  onLoadMore: () => void;
  stats: AlertStats;
  trendPoints: AlertTrendPoint[];
  trendOption: EChartsOption;
  echartsTheme: string;
  trendWindowLabel: string;
}

export function AlertCenterSummary({
  isLikelySampled,
  canLoadMoreHistory,
  eventsLimit,
  eventsLoading,
  onLoadMore,
  stats,
  trendPoints,
  trendOption,
  echartsTheme,
  trendWindowLabel,
}: AlertCenterSummaryProps) {
  const { t } = useTranslation();

  const falsePositivePercent =
    typeof stats.falsePositiveRate === "number"
      ? Number((stats.falsePositiveRate * 100).toFixed(1))
      : null;

  return (
    <>
      {isLikelySampled ? (
        <Alert
          type="warning"
          showIcon
          message={t("alerts.center.sampleWarning.message", {
            count: eventsLimit,
          })}
          description={
            canLoadMoreHistory ? (
              <Button
                size="small"
                onClick={onLoadMore}
                loading={eventsLoading}
              >
                {t("alerts.center.sampleWarning.loadMore")}
              </Button>
            ) : (
              t("alerts.center.sampleWarning.reachLimit")
            )
          }
        />
      ) : null}

      <Row gutter={[12, 12]}>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t("alerts.center.stats.total")}
              value={stats.total}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t("alerts.center.stats.pending")}
              value={stats.pending}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t("alerts.center.stats.confirmed")}
              value={stats.confirmed}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t("alerts.center.stats.ignored")}
              value={stats.ignored}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8} xl={8}>
          <Card size="small" className="content-card">
            <Statistic
              title={t("alerts.center.stats.falsePositiveRate")}
              value={falsePositivePercent ?? "--"}
              suffix={falsePositivePercent !== null ? "%" : undefined}
            />
          </Card>
        </Col>
      </Row>

      <Card
        className="content-card"
        title={t("alerts.center.trend.title")}
        extra={
          <Typography.Text type="secondary">{trendWindowLabel}</Typography.Text>
        }
      >
        {trendPoints.length === 0 ? (
          <ChartEmptyState
            className="h-auto py-8"
            description={t("alerts.center.trend.empty")}
          />
        ) : (
          <DashboardChart
            option={trendOption}
            theme={echartsTheme}
            height={280}
          />
        )}
      </Card>
    </>
  );
}
