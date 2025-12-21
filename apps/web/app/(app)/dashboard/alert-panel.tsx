"use client";

import { Badge, Button, Divider, List, Space, Tag, Typography } from "antd";
import {
  useAlertEventsQuery,
  useAlertRulesQuery,
  useTriggerAlertRuleMutation,
  AlertEventsStreamDocument,
  AlertEventsStreamSubscription,
} from "@/graphql/generated";
import { useEffect } from "react";
import { useApolloClient } from "@apollo/client";
import { useTranslation } from "react-i18next";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

const severityColor: Record<string, string> = {
  low: "green",
  medium: "orange",
  high: "red",
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
                        minute: "2-digit"
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
