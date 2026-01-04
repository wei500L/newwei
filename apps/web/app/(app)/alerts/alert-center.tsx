"use client";

import { useApolloClient } from "@apollo/client";
import { Badge, Button, Card, Col, Empty, List, Row, Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { AlertConfigForm } from "@/app/(app)/dashboard/alert-config-form";
import {
  AlertEventsStreamDocument,
  useAlertEventsQuery,
  useAlertRulesQuery,
  useTriggerAlertRuleMutation
} from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

const severityColor: Record<string, string> = {
  low: "green",
  medium: "orange",
  high: "red"
};

const eventStatusBadge: Record<string, "success" | "processing" | "error" | "default"> = {
  delivered: "success",
  pending: "processing",
  failed: "error"
};

const deliveryStatusColor: Record<string, string> = {
  pending: "orange",
  sent: "green",
  failed: "red"
};

const formatMetricChange = (value: number | null | undefined, fallback: string) => {
  if (typeof value !== "number") {
    return fallback;
  }
  return `${value.toFixed(2)}%`;
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const formatContextValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toString() : String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatContextValue(item)).filter(Boolean).join(", ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const DetailRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <Typography.Text type="secondary">{label}</Typography.Text>
    <div>{children}</div>
  </div>
);

export function AlertCenterContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const client = useApolloClient();
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const eventParam = searchParams.get("eventId");

  const { data: rulesData, loading: rulesLoading, refetch: refetchRules } = useAlertRulesQuery();
  const { data: eventsData, loading: eventsLoading, refetch: refetchEvents } = useAlertEventsQuery({
    variables: { limit: 20 }
  });
  const [triggerRule, { loading: triggeringRule }] = useTriggerAlertRuleMutation();

  useEffect(() => {
    const sub = client
      .subscribe({
        query: AlertEventsStreamDocument
      })
      .subscribe({
        next: () => {
          void Promise.all([refetchRules(), refetchEvents()]);
        }
      });
    return () => sub.unsubscribe();
  }, [client, refetchEvents, refetchRules]);

  const rules = rulesData?.alertRules ?? [];
  const events = eventsData?.alertEvents ?? [];

  useEffect(() => {
    if (events.length === 0) {
      setSelectedEventId(null);
      return;
    }
    if (eventParam && events.some((event) => event.id === eventParam)) {
      setSelectedEventId(eventParam);
      return;
    }
    if (!selectedEventId || !events.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(events[0]?.id ?? null);
    }
  }, [eventParam, events, selectedEventId]);

  const handleSelectEvent = (eventId: string) => {
    setSelectedEventId(eventId);
    const next = new URLSearchParams(searchParams.toString());
    next.set("eventId", eventId);
    const nextQuery = next.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  };

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId]
  );

  const handleRefresh = async () => {
    await Promise.all([refetchRules(), refetchEvents()]);
  };

  const context =
    selectedEvent?.context && typeof selectedEvent.context === "object"
      ? (selectedEvent.context as Record<string, unknown>)
      : null;
  const contextEntries = context ? Object.entries(context) : [];
  const objectKeys = [
    { key: "countryName", labelKey: "alerts.center.detail.object.country", defaultLabel: "Country" },
    { key: "countryCode", labelKey: "alerts.center.detail.object.countryCode", defaultLabel: "Country code" },
    { key: "resource", labelKey: "alerts.center.detail.object.resource", defaultLabel: "Resource" },
    { key: "action", labelKey: "alerts.center.detail.object.action", defaultLabel: "Action" },
    { key: "queueName", labelKey: "alerts.center.detail.object.queue", defaultLabel: "Queue" },
    { key: "sourceId", labelKey: "alerts.center.detail.object.source", defaultLabel: "Source" },
    { key: "createdById", labelKey: "alerts.center.detail.object.actor", defaultLabel: "Actor" },
    { key: "statuses", labelKey: "alerts.center.detail.object.statuses", defaultLabel: "Statuses" }
  ];
  const objectEntries = objectKeys
    .map((entry) => ({
      key: entry.key,
      label: t(entry.labelKey, { defaultValue: entry.defaultLabel }),
      value: context?.[entry.key]
    }))
    .filter((entry) => entry.value !== null && entry.value !== undefined && entry.value !== "");
  const excludedContextKeys = new Set([
    ...objectKeys.map((entry) => entry.key),
    "latest",
    "threshold",
    "lower",
    "upper",
    "changePercent"
  ]);
  const additionalContext = contextEntries.filter(([key]) => !excludedContextKeys.has(key));

  const buildContextSummary = (input: Record<string, unknown> | null) => {
    if (!input) {
      return [];
    }
    return objectKeys
      .map((entry) => ({
        key: entry.key,
        label: t(entry.labelKey, { defaultValue: entry.defaultLabel }),
        value: input[entry.key]
      }))
      .filter((entry) => entry.value !== null && entry.value !== undefined && entry.value !== "")
      .slice(0, 4);
  };

  const thresholdSummary = (() => {
    if (!selectedEvent) {
      return t("common.notAvailable");
    }
    const thresholdValue = selectedEvent.thresholdValue ?? toNumber(context?.threshold);
    const lower = selectedEvent.thresholdLower ?? toNumber(context?.lower);
    const upper = selectedEvent.thresholdUpper ?? toNumber(context?.upper);
    const operator = selectedEvent.operator;
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
  })();

  return (
    <div className="flex flex-col gap-6">
      <Space align="center" size="middle">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("alerts.center.title", { defaultValue: "Alert Center" })}
        </Typography.Title>
        <Button size="small" onClick={() => void handleRefresh()}>
          {t("common.refresh")}
        </Button>
      </Space>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card
            className="content-card"
            title={t("alerts.center.rulesTitle", { defaultValue: "Rules" })}
            extra={
              <Button size="small" onClick={() => void refetchRules()}>
                {t("common.refresh")}
              </Button>
            }
          >
            <List
              loading={rulesLoading}
              dataSource={rules}
              locale={{
                emptyText: t("alerts.center.emptyRules", {
                  defaultValue: "No alert rules configured."
                })
              }}
              renderItem={(rule) => (
                <List.Item
                  actions={[
                    <Button
                      key="trigger"
                      size="small"
                      loading={triggeringRule}
                      onClick={async () => {
                        await triggerRule({ variables: { ruleId: rule.id } });
                        await Promise.all([refetchRules(), refetchEvents()]);
                      }}
                    >
                      {t("alerts.rules.triggerNow", { defaultValue: "Trigger now" })}
                    </Button>
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space size="small">
                        <Typography.Text strong>{rule.name}</Typography.Text>
                        <Tag color={severityColor[rule.severity] ?? "blue"}>{rule.severity}</Tag>
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
                            interval: rule.checkIntervalSec,
                            defaultValue:
                              "Provider {{provider}} · Metric {{metric}} · Cooldown {{cooldown}}s · Interval {{interval}}s"
                          })}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          {t("alerts.rules.channels", {
                            channels:
                              rule.channels.map((channel) => channel.name).join(", ") ||
                              t("common.notAvailable"),
                            defaultValue: "Channels: {{channels}}"
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

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card
            className="content-card"
            title={t("alerts.center.eventsTitle", { defaultValue: "Trigger History" })}
            extra={
              <Button size="small" onClick={() => void refetchEvents()}>
                {t("common.refresh")}
              </Button>
            }
          >
            <List
              loading={eventsLoading}
              dataSource={events}
              locale={{
                emptyText: t("alerts.center.emptyEvents", {
                  defaultValue: "No alert events yet."
                })
              }}
              renderItem={(event) => {
                const isSelected = event.id === selectedEventId;
                const eventContext =
                  event.context && typeof event.context === "object"
                    ? (event.context as Record<string, unknown>)
                    : null;
                const contextSummary = buildContextSummary(eventContext);
                return (
                  <List.Item
                    onClick={() => handleSelectEvent(event.id)}
                    className={isSelected ? "bg-slate-50" : undefined}
                    style={{ cursor: "pointer" }}
                  >
                    <List.Item.Meta
                      title={
                        <Space size="small" align="center">
                          <Badge status={eventStatusBadge[event.status] ?? "default"} />
                          <Typography.Text>
                            {formatDateTime(event.triggeredAt, locale, {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit"
                            })}
                          </Typography.Text>
                          <Tag color={severityColor[event.severity] ?? "blue"}>{event.severity}</Tag>
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size={0}>
                          <Typography.Text type="secondary">
                            {t("alerts.events.metrics", {
                              value: event.metricValue,
                              change: event.changePercent ?? t("common.notAvailable")
                            })}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {t("alerts.center.eventSummary", {
                              defaultValue: "Rule {{rule}} · Metric {{metric}}",
                              rule: event.ruleName ?? t("common.notAvailable"),
                              metric: event.metricSlug ?? t("common.notAvailable")
                            })}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            {event.message ?? t("alerts.events.triggered")}
                          </Typography.Text>
                          {contextSummary.length > 0 ? (
                            <Space size={[4, 4]} wrap>
                              {contextSummary.map((entry) => (
                                <Tag key={`${event.id}-${entry.key}`} className="text-xs">
                                  {entry.label}: {formatContextValue(entry.value)}
                                </Tag>
                              ))}
                            </Space>
                          ) : null}
                        </Space>
                      }
                    />
                  </List.Item>
                );
              }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card
            className="content-card"
            title={t("alerts.center.evidenceTitle", { defaultValue: "Evidence Details" })}
          >
            {selectedEvent ? (
              <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                <DetailRow label={t("alerts.center.detail.rule", { defaultValue: "Rule" })}>
                  <Space direction="vertical" size={2}>
                    <Typography.Text strong>
                      {selectedEvent.ruleName ?? t("common.notAvailable")}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.metric", {
                        defaultValue: "Metric {{metric}}",
                        metric: selectedEvent.metricSlug ?? t("common.notAvailable")
                      })}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.provider", {
                        defaultValue: "Provider {{provider}}",
                        provider: selectedEvent.metricProvider ?? t("common.notAvailable")
                      })}
                    </Typography.Text>
                  </Space>
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.threshold", { defaultValue: "Threshold" })}>
                  <Space direction="vertical" size={2}>
                    <Typography.Text>
                      {t("alerts.center.detail.operator", {
                        defaultValue: "Operator {{operator}}",
                        operator: selectedEvent.operator ?? t("common.notAvailable")
                      })}
                    </Typography.Text>
                    <Typography.Text type="secondary">{thresholdSummary}</Typography.Text>
                    {selectedEvent.changeWindowMin !== null && selectedEvent.changeWindowMin !== undefined ? (
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.window", {
                          defaultValue: "Window {{minutes}} min",
                          minutes: selectedEvent.changeWindowMin
                        })}
                      </Typography.Text>
                    ) : null}
                  </Space>
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.triggeredAt", { defaultValue: "Triggered at" })}>
                  <Typography.Text>
                    {formatDateTime(selectedEvent.triggeredAt, locale, {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit"
                    })}
                  </Typography.Text>
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.metricValue", { defaultValue: "Metric value" })}>
                  <Space>
                    <Typography.Text strong>{selectedEvent.metricValue}</Typography.Text>
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.changePercent", {
                        defaultValue: "Change {{value}}",
                        value: formatMetricChange(
                          selectedEvent.changePercent,
                          t("common.notAvailable")
                        )
                      })}
                    </Typography.Text>
                  </Space>
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.objects", { defaultValue: "Objects" })}>
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
                      {t("alerts.center.detail.objectsEmpty", { defaultValue: "No object context." })}
                    </Typography.Text>
                  )}
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.status", { defaultValue: "Status" })}>
                  <Space>
                    <Tag color={severityColor[selectedEvent.severity] ?? "blue"}>
                      {selectedEvent.severity}
                    </Tag>
                    <Tag>{selectedEvent.status}</Tag>
                  </Space>
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.message", { defaultValue: "Message" })}>
                  <Typography.Text>
                    {selectedEvent.message ?? t("alerts.events.triggered")}
                  </Typography.Text>
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.context", { defaultValue: "Context" })}>
                  {additionalContext.length > 0 ? (
                    <Space direction="vertical" size={4} style={{ width: "100%" }}>
                      {additionalContext.map(([key, value]) => (
                        <div key={key} className="flex justify-between gap-4">
                          <Typography.Text type="secondary">{key}</Typography.Text>
                          <Typography.Text>{formatContextValue(value)}</Typography.Text>
                        </div>
                      ))}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.contextEmpty", { defaultValue: "No additional context." })}
                    </Typography.Text>
                  )}
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.deliveries", { defaultValue: "Deliveries" })}>
                  <List
                    size="small"
                    dataSource={selectedEvent.deliveries}
                    locale={{
                      emptyText: t("alerts.center.deliveriesEmpty", {
                        defaultValue: "No delivery records."
                      })
                    }}
                    renderItem={(delivery) => (
                      <List.Item>
                        <Space size="small">
                          <Tag color={deliveryStatusColor[delivery.status] ?? "default"}>
                            {delivery.status}
                          </Tag>
                          <Tag>{delivery.channelType}</Tag>
                          <Typography.Text type="secondary">
                            {delivery.sentAt
                              ? formatDateTime(delivery.sentAt, locale, {
                                  year: "numeric",
                                  month: "2-digit",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit"
                                })
                              : t("common.notAvailable")}
                          </Typography.Text>
                          {delivery.error ? (
                            <Typography.Text type="secondary">{delivery.error}</Typography.Text>
                          ) : null}
                        </Space>
                      </List.Item>
                    )}
                  />
                </DetailRow>
              </Space>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("alerts.center.selectEvent", {
                  defaultValue: "Select an event to see evidence details."
                })}
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
