"use client";

import { Alert, App, Button, Card, Col, List, Row, Space, Spin, Tag, Typography } from "antd";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";

import { AlertConfigForm } from "@/app/(app)/dashboard/alert-config-form";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { PageHeader } from "@/components/page-header";
import { useAlertRulesQuery, useTriggerAlertRuleMutation } from "@/graphql/generated";

const severityColor: Record<string, string> = {
  low: "green",
  medium: "orange",
  high: "red"
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

export function AlertsConfigContent() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageAlerts = permissions.includes("alerts.manage");

  const { data, loading, refetch } = useAlertRulesQuery({
    skip: !canManageAlerts
  });
  const [triggerRule, { loading: triggeringRule }] = useTriggerAlertRuleMutation();

  if (status === "loading" || loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spin size="large" />
      </div>
    );
  }

  if (!canManageAlerts) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          kicker={t("nav.groups.admin")}
          title={t("alerts.config.title")}
        />
        <Alert
          type="warning"
          showIcon
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </div>
    );
  }

  const rules = data?.alertRules ?? [];

  const handleTrigger = async (ruleId: string) => {
    try {
      await triggerRule({ variables: { ruleId } });
      await refetch();
      message.success(t("alerts.rules.triggered"));
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("alerts.rules.triggerFailed")
      );
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t("nav.groups.admin")}
        title={t("alerts.config.title")}
        actions={
          <Button size="small" onClick={() => void refetch()}>
            {t("common.refresh")}
          </Button>
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card
            className="content-card"
            title={t("alerts.config.rulesTitle")}
          >
            <List
              dataSource={rules}
              locale={{
                emptyText: (
                  <ChartEmptyState
                    className="h-auto py-6"
                    description={t("alerts.center.emptyRules")}
                  />
                )
              }}
              renderItem={(rule) => (
                <List.Item
                  actions={[
                    <Button
                      key="trigger"
                      size="small"
                      loading={triggeringRule}
                      onClick={() => void handleTrigger(rule.id)}
                    >
                      {t("alerts.rules.triggerNow")}
                    </Button>
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space size="small">
                        <Typography.Text strong>{rule.name}</Typography.Text>
                        <Tag color={severityColor[rule.severity] ?? "blue"}>{rule.severity}</Tag>
                        <Tag>{rule.status}</Tag>
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
                          {t("alerts.center.detail.window", {
                            minutes: rule.changeWindowMin ?? t("common.notAvailable")
                          })}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          {t("alerts.rules.threshold", {
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
                              rule.channels.map((channel) => channel.name).join(", ") ||
                              t("common.notAvailable")
                          })}
                        </Typography.Text>
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card className="content-card">
            <AlertConfigForm />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
