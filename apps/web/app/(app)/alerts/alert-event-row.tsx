"use client";

import { Badge, Checkbox, List, Popover, Space, Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { AlertMetricProvider } from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

import {
  toNumber,
  toStringValue,
  isRecord,
  formatContextValue,
} from "./evidence-utils";
import {
  buildThresholdSummary,
  type AlertEventItem,
  type TranslateFn,
  type LocaleCode,
} from "./alert-center-list-model";

/**
 * Alert Center 事件行（FE-批3B 从 alert-center.tsx 提取）。
 *
 * 行内展示保持原样：状态 Badge、severity/status Tag、触发时间、metricValue
 * 与证据摘要（source/threshold）、规则与指标摘要、消息两行截断、
 * context 摘要 Tag、悬浮预览（Popover）、勾选框（冒泡阻止）。
 */

const severityColor: Record<string, string> = {
  low: "green",
  medium: "orange",
  high: "red",
};

const eventStatusBadge: Record<
  string,
  "success" | "processing" | "error" | "default"
> = {
  delivered: "success",
  pending: "processing",
  failed: "error",
  confirmed: "success",
  ignored: "default",
};

export interface AlertEventRowContextSummaryEntry {
  key: string;
  label: string;
  value: unknown;
}

export interface AlertEventRowProps {
  event: AlertEventItem;
  isSelected: boolean;
  isChecked: boolean;
  locale: LocaleCode;
  objectKeyLabels: { key: string; label: string }[];
  onToggleChecked: (eventId: string, checked: boolean) => void;
  onSelectEvent: (eventId: string) => void;
}

/** 行级 context 摘要（前 3 个对象键），label 已本地化。 */
export function buildRowContextSummary(
  eventContext: Record<string, unknown> | null,
  objectKeyLabels: { key: string; label: string }[],
): AlertEventRowContextSummaryEntry[] {
  if (!eventContext) {
    return [];
  }
  return objectKeyLabels
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      value: eventContext[entry.key],
    }))
    .filter(
      (entry) =>
        entry.value !== null &&
        entry.value !== undefined &&
        entry.value !== "",
    )
    .slice(0, 3);
}

/** 行级证据来源（provider 特化回退链）。 */
export function buildRowEvidenceSource(
  event: AlertEventItem,
  eventContext: Record<string, unknown> | null,
): string | undefined {
  const seed = isRecord(eventContext?.seed)
    ? (eventContext.seed as Record<string, unknown>)
    : null;
  return (
    toStringValue(eventContext?.sourceName) ??
    toStringValue(eventContext?.sourceEndpoint) ??
    toStringValue(eventContext?.sourceField) ??
    toStringValue(eventContext?.sourceFunction) ??
    toStringValue(eventContext?.source) ??
    (event.metricProvider === AlertMetricProvider.EconomicAnomaly
      ? (toStringValue(eventContext?.itemName) ??
        toStringValue(event.metricSlug))
      : null) ??
    (event.metricProvider === AlertMetricProvider.EntitySentiment
      ? (toStringValue(eventContext?.entityName) ??
        toStringValue(event.metricSlug))
      : null) ??
    (event.metricProvider === AlertMetricProvider.EntityAssociation
      ? (toStringValue(seed?.name) ?? toStringValue(event.metricSlug))
      : null) ??
    toStringValue(event.metricSlug)
  );
}

export function AlertEventRow({
  event,
  isSelected,
  isChecked,
  locale,
  objectKeyLabels,
  onToggleChecked,
  onSelectEvent,
}: AlertEventRowProps) {
  const { t } = useTranslation();

  const eventContext =
    event.context && typeof event.context === "object"
      ? (event.context as Record<string, unknown>)
      : null;
  const contextSummary = buildRowContextSummary(eventContext, objectKeyLabels);
  const eventEvidenceSource = buildRowEvidenceSource(event, eventContext);

  const changeLabel =
    typeof event.changePercent === "number"
      ? `${event.changePercent.toFixed(2)}%`
      : t("common.notAvailable");

  const hoverPreview = (
    <Space direction="vertical" size={4} style={{ maxWidth: 320 }}>
      <Typography.Text strong>
        {event.ruleName ?? t("common.notAvailable")}
      </Typography.Text>
      <Typography.Text type="secondary">
        {t("alerts.events.metrics", {
          value: event.metricValue,
          change: changeLabel,
        })}
      </Typography.Text>
      <Typography.Text type="secondary">
        {t("alerts.events.evidence", {
          source: eventEvidenceSource ?? t("common.notAvailable"),
          threshold: buildRowThresholdSummary(event, eventContext, t),
        })}
      </Typography.Text>
    </Space>
  );

  return (
    <List.Item key={event.id}>
      <div className="flex w-full items-start gap-3">
        <Checkbox
          checked={isChecked}
          onChange={(changeEvent) =>
            onToggleChecked(event.id, changeEvent.target.checked)
          }
          onClick={(changeEvent) => changeEvent.stopPropagation()}
        />
        <Popover content={hoverPreview} placement="rightTop">
          <button
            type="button"
            className="w-full text-left"
            onClick={() => onSelectEvent(event.id)}
          >
            <div
              className="rounded-lg border p-3 transition-colors"
              style={{
                borderColor: isSelected ? "#93c5fd" : "#e2e8f0",
                background: isSelected ? "rgba(239,246,255,0.8)" : "#fff",
              }}
            >
              <Space size="small" wrap>
                <Badge status={eventStatusBadge[event.status] ?? "default"} />
                <Tag color={severityColor[event.severity] ?? "blue"}>
                  {event.severity}
                </Tag>
                <Tag>{event.status}</Tag>
                <Typography.Text>
                  {formatDateTime(event.triggeredAt, locale, {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZoneName: "short",
                  })}
                </Typography.Text>
              </Space>

              <Space
                direction="vertical"
                size={2}
                style={{ width: "100%", marginTop: 6 }}
              >
                <Space size="small" wrap>
                  <Typography.Text strong>{event.metricValue}</Typography.Text>
                  <Typography.Text type="secondary">
                    {t("alerts.events.evidence", {
                      source:
                        eventEvidenceSource ?? t("common.notAvailable"),
                      threshold: buildRowThresholdSummary(
                        event,
                        eventContext,
                        t,
                      ),
                    })}
                  </Typography.Text>
                </Space>
                <Typography.Text type="secondary">
                  {t("alerts.center.eventSummary", {
                    rule: event.ruleName ?? t("common.notAvailable"),
                    metric: event.metricSlug ?? t("common.notAvailable"),
                  })}
                </Typography.Text>
                <Typography.Paragraph
                  type="secondary"
                  style={{ marginBottom: 0 }}
                  ellipsis={{ rows: 2 }}
                >
                  {event.message ?? t("alerts.events.triggered")}
                </Typography.Paragraph>
                {contextSummary.length > 0 ? (
                  <Space size={[4, 4]} wrap>
                    {contextSummary.map((entry) => (
                      <Tag
                        key={`${event.id}-${entry.key}`}
                        className="text-xs"
                      >
                        {entry.label}: {formatContextValue(entry.value)}
                      </Tag>
                    ))}
                  </Space>
                ) : null}
              </Space>
            </div>
          </button>
        </Popover>
      </div>
    </List.Item>
  );
}

/** 行级 threshold 摘要（复用详情域的 buildThresholdSummary 语义）。 */
function buildRowThresholdSummary(
  event: AlertEventItem,
  eventContext: Record<string, unknown> | null,
  t: TranslateFn,
): string {
  return buildThresholdSummary(
    event.operator,
    event.thresholdValue ?? toNumber(eventContext?.threshold),
    event.thresholdLower ?? toNumber(eventContext?.lower),
    event.thresholdUpper ?? toNumber(eventContext?.upper),
    t,
  );
}
