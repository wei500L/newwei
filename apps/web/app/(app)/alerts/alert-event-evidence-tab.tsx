"use client";

import { Button, Card, Col, List, Row, Space, Statistic, Tag, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { AlertMetricProvider } from "@/graphql/generated";
import { formatDateTime, type resolveLocale } from "@/lib/i18n";

import type { AlertEventItem, TranslateFn } from "./alert-center-list-model";
import { buildAlertEventDetailModel } from "./alert-event-detail-model";
import { EconomicAnomalyEvidence } from "./economic-anomaly-evidence";
import { EntityAssociationEvidence } from "./entity-association-evidence";
import { EntitySentimentEvidence } from "./entity-sentiment-evidence";
import { DetailRow } from "./evidence-utils";
import { RealtimeSignalEvidence } from "./realtime-signal-evidence";

/**
 * Alert Center 详情 Evidence 页签（FE-批3B 从 alert-center.tsx 提取）。
 * 四种 evidence 组件分发 + 相似告警卡 + 规则趋势分析卡。
 */

export interface AlertEventEvidenceTabProps {
  selectedEvent: AlertEventItem;
  locale: ReturnType<typeof resolveLocale>;
  objectKeyLabels: { key: string; label: string }[];
  similarAlerts: { event: AlertEventItem; reason: "same_rule" | "same_metric" }[];
  ruleTrendAnalysis: {
    points: { date: string; triggers: number; falsePositiveRate: number | null }[];
    totalTriggers: number;
    averageDailyTriggers: number;
    falsePositiveRate: number | null;
  };
  ruleTrendOption: EChartsOption;
  echartsTheme: string;
  colors: { primary: string; accent: string };
  fontFamily: string;
  onSelectEvent: (eventId: string) => void;
  onOpenEvent: (eventId: string) => void;
}

export function AlertEventEvidenceTab({
  selectedEvent,
  locale,
  objectKeyLabels,
  similarAlerts,
  ruleTrendAnalysis,
  ruleTrendOption,
  echartsTheme,
  colors,
  fontFamily,
  onSelectEvent,
  onOpenEvent,
}: AlertEventEvidenceTabProps) {
  const { t } = useTranslation();

  const model = buildAlertEventDetailModel(selectedEvent, objectKeyLabels);
  const { context } = model;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <DetailRow label={t("alerts.center.detail.evidence")}>
        {selectedEvent.metricProvider ===
        AlertMetricProvider.EconomicAnomaly ? (
          <EconomicAnomalyEvidence
            context={context}
            locale={locale}
            t={t}
          />
        ) : selectedEvent.metricProvider ===
          AlertMetricProvider.EntitySentiment ? (
          <EntitySentimentEvidence
            context={context}
            locale={locale}
            t={t}
            colors={{ primary: colors.primary, accent: colors.accent }}
            fontFamily={fontFamily}
          />
        ) : selectedEvent.metricProvider ===
          AlertMetricProvider.EntityAssociation ? (
          <EntityAssociationEvidence
            context={context}
            locale={locale}
            t={t}
            onOpenEvent={(eventId) => void onOpenEvent(eventId)}
          />
        ) : selectedEvent.metricProvider ===
          AlertMetricProvider.RealtimeSignal ? (
          <RealtimeSignalEvidence
            context={context}
            locale={locale}
            t={t}
          />
        ) : (
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.unsupported")}
          </Typography.Text>
        )}
      </DetailRow>

      <Card
        size="small"
        title={t("alerts.center.analysis.similarTitle")}
      >
        {similarAlerts.length === 0 ? (
          <Typography.Text type="secondary">
            {t("alerts.center.analysis.similarEmpty")}
          </Typography.Text>
        ) : (
          <List
            size="small"
            dataSource={similarAlerts}
            renderItem={(item) => (
              <List.Item>
                <Space
                  direction="vertical"
                  size={0}
                  style={{ width: "100%" }}
                >
                  <Space size="small" wrap>
                    <Button
                      type="link"
                      size="small"
                      onClick={() => onSelectEvent(item.event.id)}
                    >
                      {item.event.ruleName ?? item.event.id}
                    </Button>
                    <Tag color="blue">
                      {item.reason === "same_rule"
                        ? t("alerts.center.analysis.sameRule")
                        : t("alerts.center.analysis.sameMetric")}
                    </Tag>
                    <Tag>{item.event.status}</Tag>
                  </Space>
                  <Typography.Text type="secondary">
                    {formatDateTime(item.event.triggeredAt, locale, {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZoneName: "short",
                    })}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>

      <Card
        size="small"
        title={t("alerts.center.analysis.ruleTrendTitle")}
      >
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={24} sm={8}>
            <Statistic
              title={t("alerts.center.analysis.totalTriggers")}
              value={ruleTrendAnalysis.totalTriggers}
            />
          </Col>
          <Col xs={24} sm={8}>
            <Statistic
              title={t("alerts.center.analysis.dailyAverage")}
              value={Number(
                ruleTrendAnalysis.averageDailyTriggers.toFixed(2),
              )}
            />
          </Col>
          <Col xs={24} sm={8}>
            <Statistic
              title={t("alerts.center.analysis.falsePositiveRate")}
              value={
                typeof ruleTrendAnalysis.falsePositiveRate === "number"
                  ? Number(
                      (ruleTrendAnalysis.falsePositiveRate * 100).toFixed(1),
                    )
                  : "--"
              }
              suffix={
                typeof ruleTrendAnalysis.falsePositiveRate === "number"
                  ? "%"
                  : undefined
              }
            />
          </Col>
        </Row>
        {ruleTrendAnalysis.points.length === 0 ? (
          <ChartEmptyState
            className="h-auto py-6"
            description={t("alerts.center.analysis.ruleTrendEmpty")}
          />
        ) : (
          <DashboardChart
            option={ruleTrendOption}
            theme={echartsTheme}
            height={240}
          />
        )}
      </Card>
    </Space>
  );
}
