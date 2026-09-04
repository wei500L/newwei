"use client";

import { Button, Space, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { AlertMetricProvider } from "@/graphql/generated";
import { formatDateTime, type resolveLocale } from "@/lib/i18n";

import { buildThresholdSummary, type AlertEventItem } from "./alert-center-list-model";
import { buildAlertEventDetailModel } from "./alert-event-detail-model";
import {
  DetailRow,
  formatContextValue,
  formatMetricChange,
  toNumber,
} from "./evidence-utils";

/**
 * Alert Center 详情 Overview 页签（FE-批3B 从 alert-center.tsx 提取）。
 * 规则/阈值/触发时间/指标值/来源/对象/状态/消息（展开收起）/上下文
 * （展开收起 + 复制原始上下文）。
 */

const severityColor: Record<string, string> = {
  low: "green",
  medium: "orange",
  high: "red",
};

export interface AlertEventOverviewTabProps {
  selectedEvent: AlertEventItem;
  locale: ReturnType<typeof resolveLocale>;
  objectKeyLabels: { key: string; label: string }[];
  expandMessage: boolean;
  expandContext: boolean;
  onToggleExpandMessage: () => void;
  onToggleExpandContext: () => void;
  onCopyRawContext: () => void;
}

export function AlertEventOverviewTab({
  selectedEvent,
  locale,
  objectKeyLabels,
  expandMessage,
  expandContext,
  onToggleExpandMessage,
  onToggleExpandContext,
  onCopyRawContext,
}: AlertEventOverviewTabProps) {
  const { t } = useTranslation();

  const model = buildAlertEventDetailModel(selectedEvent, objectKeyLabels);
  const {
    context,
    objectEntries,
    additionalContext,
    evidenceWindowMinutes,
    evidenceUnit,
    evidencePrevious,
    evidenceRecordedAt,
    evidenceSource,
    evidenceSourceDoc,
  } = model;

  const visibleAdditionalContext = expandContext
    ? additionalContext
    : additionalContext.slice(0, 6);

  const evidenceRecordedAtLabel = evidenceRecordedAt
    ? formatDateTime(evidenceRecordedAt, locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      })
    : "";

  const metricProviderLabel = (
    provider: AlertMetricProvider | string | null | undefined,
  ) =>
    provider
      ? t(`alerts.metricProviders.${provider}`, { defaultValue: provider })
      : t("common.notAvailable");

  const thresholdSummary = buildThresholdSummary(
    selectedEvent.operator,
    selectedEvent.thresholdValue ?? toNumber(context?.threshold),
    selectedEvent.thresholdLower ?? toNumber(context?.lower),
    selectedEvent.thresholdUpper ?? toNumber(context?.upper),
    t,
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <DetailRow label={t("alerts.center.detail.rule")}>
        <Space direction="vertical" size={2}>
          <Typography.Text strong>
            {selectedEvent.ruleName ?? t("common.notAvailable")}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t("alerts.center.detail.metric", {
              metric: selectedEvent.metricSlug ?? t("common.notAvailable"),
            })}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t("alerts.center.detail.provider", {
              provider: metricProviderLabel(selectedEvent.metricProvider),
            })}
          </Typography.Text>
        </Space>
      </DetailRow>
      <DetailRow label={t("alerts.center.detail.threshold")}>
        <Space direction="vertical" size={2}>
          <Typography.Text>
            {t("alerts.center.detail.operator", {
              operator: selectedEvent.operator ?? t("common.notAvailable"),
            })}
          </Typography.Text>
          <Typography.Text type="secondary">{thresholdSummary}</Typography.Text>
          {evidenceWindowMinutes !== null &&
          evidenceWindowMinutes !== undefined ? (
            <Typography.Text type="secondary">
              {t("alerts.center.detail.window", {
                minutes: evidenceWindowMinutes,
              })}
            </Typography.Text>
          ) : null}
        </Space>
      </DetailRow>
      <DetailRow label={t("alerts.center.detail.triggeredAt")}>
        <Typography.Text>
          {formatDateTime(selectedEvent.triggeredAt, locale, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            timeZoneName: "short",
          })}
        </Typography.Text>
      </DetailRow>
      <DetailRow label={t("alerts.center.detail.metricValue")}>
        <Space direction="vertical" size={2}>
          <Space size="small" align="baseline">
            <Typography.Text strong>{selectedEvent.metricValue}</Typography.Text>
            {evidenceUnit ? (
              <Typography.Text type="secondary">{evidenceUnit}</Typography.Text>
            ) : null}
            <Typography.Text type="secondary">
              {t("alerts.center.detail.changePercent", {
                value: formatMetricChange(
                  selectedEvent.changePercent,
                  t("common.notAvailable"),
                ),
              })}
            </Typography.Text>
          </Space>
          {evidencePrevious !== undefined ? (
            <Typography.Text type="secondary">
              {t("alerts.center.detail.previousValue", {
                value: evidencePrevious,
              })}
            </Typography.Text>
          ) : null}
          {evidenceRecordedAtLabel ? (
            <Typography.Text type="secondary">
              {t("alerts.center.detail.recordedAt", {
                time: evidenceRecordedAtLabel,
              })}
            </Typography.Text>
          ) : null}
        </Space>
      </DetailRow>
      <DetailRow label={t("alerts.center.detail.source")}>
        {evidenceSource || evidenceSourceDoc ? (
          <Space direction="vertical" size={2}>
            {evidenceSource ? (
              <Typography.Text>{evidenceSource}</Typography.Text>
            ) : null}
            {evidenceSourceDoc ? (
              <Typography.Link
                href={evidenceSourceDoc}
                target="_blank"
                rel="noreferrer"
              >
                {evidenceSourceDoc}
              </Typography.Link>
            ) : null}
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {t("common.notAvailable")}
          </Typography.Text>
        )}
      </DetailRow>
      <DetailRow label={t("alerts.center.detail.objects")}>
        {objectEntries.length > 0 ? (
          <Space size={[8, 8]} wrap>
            {objectEntries.map((entry) => (
              <Tag key={entry.key}>
                {entry.label}: {formatContextValue(entry.value)}
              </Tag>
            ))}
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {t("alerts.center.detail.objectsEmpty")}
          </Typography.Text>
        )}
      </DetailRow>
      <DetailRow label={t("alerts.center.detail.status")}>
        <Space>
          <Tag color={severityColor[selectedEvent.severity] ?? "blue"}>
            {selectedEvent.severity}
          </Tag>
          <Tag>{selectedEvent.status}</Tag>
        </Space>
      </DetailRow>
      <DetailRow label={t("alerts.center.detail.message")}>
        <Typography.Paragraph
          style={{ marginBottom: 4 }}
          ellipsis={expandMessage ? false : { rows: 3 }}
        >
          {selectedEvent.message ?? t("alerts.events.triggered")}
        </Typography.Paragraph>
        {(selectedEvent.message?.length ?? 0) > 180 ? (
          <Button
            type="link"
            size="small"
            onClick={onToggleExpandMessage}
          >
            {expandMessage
              ? t("alerts.center.actions.collapse")
              : t("alerts.center.actions.expand")}
          </Button>
        ) : null}
      </DetailRow>
      <DetailRow label={t("alerts.center.detail.context")}>
        <Space direction="vertical" size={4} style={{ width: "100%" }}>
          <Button size="small" onClick={onCopyRawContext} disabled={!context}>
            {t("alerts.center.detail.copyRawContext")}
          </Button>
          {visibleAdditionalContext.length > 0 ? (
            visibleAdditionalContext.map(([key, value]) => (
              <div key={key} className="flex justify-between gap-4">
                <Typography.Text type="secondary">{key}</Typography.Text>
                <Typography.Text>{formatContextValue(value)}</Typography.Text>
              </div>
            ))
          ) : (
            <Typography.Text type="secondary">
              {t("alerts.center.detail.contextEmpty")}
            </Typography.Text>
          )}
          {additionalContext.length > 6 ? (
            <Button type="link" size="small" onClick={onToggleExpandContext}>
              {expandContext
                ? t("alerts.center.actions.showLessContext")
                : t("alerts.center.actions.showAllContext", {
                    count: additionalContext.length,
                  })}
            </Button>
          ) : null}
        </Space>
      </DetailRow>
    </Space>
  );
}
