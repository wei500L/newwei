"use client";

import { Badge, Button, Divider, List, Space, Tag, Typography } from "antd";
import dayjs from "dayjs";
import {
  useAlertEventsQuery,
  useAlertRulesQuery,
  useTriggerAlertRuleMutation,
  AlertEventsDocument,
  AlertEventsSubscription
} from "@/graphql/generated";
import { useEffect } from "react";
import { useApolloClient } from "@apollo/client";

const severityColor: Record<string, string> = {
  low: "green",
  medium: "orange",
  high: "red"
};

export function AlertPanel() {
  const { data: rulesData, refetch: refetchRules } = useAlertRulesQuery();
  const { data: eventsData, refetch: refetchEvents } = useAlertEventsQuery({ variables: { limit: 10 } });
  const [triggerRule, { loading }] = useTriggerAlertRuleMutation();
  const client = useApolloClient();

  useEffect(() => {
    const sub = client.subscribe<AlertEventsSubscription>({ query: AlertEventsDocument }).subscribe({
      next: () => {
        void Promise.all([refetchRules(), refetchEvents()]);
      }
    });
    return () => sub.unsubscribe();
  }, [client, refetchEvents, refetchRules]);

  const rules = rulesData?.alertRules ?? [];
  const events = eventsData?.alertEvents ?? [];

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <div>
        <Typography.Title level={5}>Alert Rules</Typography.Title>
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
                  Trigger now
                </Button>
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <Typography.Text strong>{rule.name}</Typography.Text>
                    <Tag color={severityColor[rule.severity] ?? "blue"}>{rule.severity}</Tag>
                    <Tag>{rule.operator}</Tag>
                  </Space>
                }
                description={
                  <Space direction="vertical" size={0}>
                    <Typography.Text type="secondary">
                      Metric: {rule.metricSlug} • Cooldown: {rule.cooldownSeconds}s • Interval: {rule.checkIntervalSec}s
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      Channels: {rule.channels.map((c) => c.name).join(", ") || "n/a"}
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
        <Typography.Title level={5}>Recent Alert Events</Typography.Title>
        <List
          dataSource={events}
          renderItem={(event) => (
            <List.Item>
              <List.Item.Meta
                title={
                  <Space>
                    <Badge status={event.status === "delivered" ? "success" : event.status === "pending" ? "processing" : "error"} />
                    <Typography.Text>{dayjs(event.triggeredAt).format("YYYY-MM-DD HH:mm")}</Typography.Text>
                    <Tag color={severityColor[event.severity] ?? "blue"}>{event.severity}</Tag>
                  </Space>
                }
                description={
                  <Space direction="vertical">
                    <Typography.Text type="secondary">
                      Value: {event.metricValue} • Change: {event.changePercent ?? "n/a"}%
                    </Typography.Text>
                    <Typography.Text type="secondary">{event.message ?? "Triggered"}</Typography.Text>
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
