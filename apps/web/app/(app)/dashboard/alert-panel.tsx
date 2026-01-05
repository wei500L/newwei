"use client";

import { useApolloClient } from "@apollo/client";
import { Badge, Button, Divider, List, Space, Tag, Typography } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type {
  AlertEventsStreamSubscription} from "@/graphql/generated";
import {
  useAlertEventsQuery,
  useAlertRulesQuery,
  useTriggerAlertRuleMutation,
  AlertEventsStreamDocument
} from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

const severityColor: Record<string, string> = {
  low: "green",
  medium: "orange",
  high: "red",
};

const buildThresholdSummary = (
  operator: string | null | undefined,
  thresholdValue: number | undefined,
  lower: number | undefined,
  upper: number | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
) => {
  if (!operator) {
    return t("common.notAvailable");
  }
  const operatorSymbolMap: Record<string, string> = {
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    eq: "="
  };
  if (operator === "outside_range" || operator === "within_range") {
    if (lower === undefined || upper === undefined) {
      return t("common.notAvailable");
    }
    const range = `${lower} - ${upper}`;
    return t(
      operator === "outside_range"
        ? "alerts.center.threshold.outside"
        : "alerts.center.threshold.within",
      { defaultValue: `${operator === "outside_range" ? "Outside" : "Within"} ${range}`, range }
    );
  }
  if (operator === "change_up_pct" || operator === "change_down_pct") {
    if (thresholdValue === undefined) {
      return t("common.notAvailable");
    }
    const symbol = operator === "change_up_pct" ? ">=" : "<=";
    return t("alerts.center.threshold.changePct", {
      defaultValue: `Change ${symbol} ${thresholdValue}%`,
      symbol,
      value: thresholdValue
    });
  }
  if (thresholdValue === undefined) {
    return t("common.notAvailable");
  }
  const symbol = operatorSymbolMap[operator] ?? operator;
  return `${symbol} ${thresholdValue}`;
};

export function AlertPanel() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: rulesData, refetch: refetchRules } = useAlertRulesQuery();
  const { data: eventsData, refetch: refetchEvents } = useAlertEventsQuery({
    variables: { limit: 10 },
  });
  const [triggerRule, { loading }] = useTriggerAlertRuleMutation();
  const client = useApolloClient();

  useEffect(() => {
    const sub = client
      .subscribe<AlertEventsStreamSubscription>({
        query: AlertEventsStreamDocument,
      })
      .subscribe({
        next: () => {
          void Promise.all([refetchRules(), refetchEvents()]);
        },
      });
    return () => sub.unsubscribe();
  }, [client, refetchEvents, refetchRules]);

  const rules = rulesData?.alertRules ?? [];
  const events = eventsData?.alertEvents ?? [];

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <div>
        <Typography.Title level={5}>{t("alerts.rules.title")}</Typography.Title>
        <List
          dataSource={rules}
          renderItem={(rule) => (
            <List.Item
              actions={[
                <Button
                  key="trigger"
                  size="small"
                  loading={loading}
                  onClick={async () => {
                    await triggerRule({ variables: { ruleId: rule.id } });
                    await Promise.all([refetchRules(), refetchEvents()]);
                  }}
                >
                  {t("alerts.rules.triggerNow")}
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <Typography.Text strong>{rule.name}</Typography.Text>
                    <Tag color={severityColor[rule.severity] ?? "blue"}>
                      {rule.severity}
                    </Tag>
                    <Tag>{rule.operator}</Tag>
                  </Space>
                }
                description={
                  <Space direction="vertical" size={0}>
                    <Typography.Text type="secondary">
                      {t("alerts.rules.summary", {
                        provider: rule.metricProvider,
                        metric: rule.metricSlug,
                        cooldown: rule.cooldownSeconds,
                        interval: rule.checkIntervalSec
                      })}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {t("alerts.rules.threshold", {
                        defaultValue: "Threshold {{threshold}}",
                        threshold: buildThresholdSummary(
                          rule.operator,
                          rule.thresholdValue ?? undefined,
                          rule.thresholdLower ?? undefined,
                          rule.thresholdUpper ?? undefined,
                          t
                        )
                      })}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {t("alerts.rules.channels", {
                        channels:
                          rule.channels.map((c) => c.name).join(", ") ||
                          t("common.notAvailable")
                      })}
                    </Typography.Text>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      </div>
      <Divider />
      <div>
        <Typography.Title level={5}>{t("alerts.events.title")}</Typography.Title>
        <List
          dataSource={events}
          renderItem={(event) => (
            <List.Item>
              <List.Item.Meta
                title={
                  <Space>
                    <Badge
                      status={
                        event.status === "delivered"
                          ? "success"
                          : event.status === "pending"
                            ? "processing"
                            : "error"
                      }
                    />
                    <Typography.Text>
                      {formatDateTime(event.triggeredAt, locale, {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZoneName: "short"
                      })}
                    </Typography.Text>
                    <Tag color={severityColor[event.severity] ?? "blue"}>
                      {event.severity}
                    </Tag>
                  </Space>
                }
                description={
                  <Space direction="vertical">
                    <Typography.Text type="secondary">
                      {t("alerts.events.metrics", {
                        value: event.metricValue,
                        change: event.changePercent ?? t("common.notAvailable")
                      })}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {t("alerts.events.evidence", {
                        defaultValue: "Metric {{metric}} · Threshold {{threshold}}",
                        metric: event.metricSlug ?? t("common.notAvailable"),
                        threshold: buildThresholdSummary(
                          event.operator,
                          event.thresholdValue ?? undefined,
                          event.thresholdLower ?? undefined,
                          event.thresholdUpper ?? undefined,
                          t
                        )
                      })}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {event.message ?? t("alerts.events.triggered")}
                    </Typography.Text>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      </div>
    </Space>
  );
}
