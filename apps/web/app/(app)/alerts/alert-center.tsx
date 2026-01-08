"use client";

import { gql, useApolloClient, useMutation } from "@apollo/client";
import { Alert, Badge, Button, Card, Col, List, Modal, Row, Space, Spin, Tag, Typography } from "antd";
import type { EChartsOption } from "echarts";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";

import {
  AlertEventsStreamDocument,
  useAlertEventReplayLazyQuery,
  useAlertEventsQuery,
} from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";

const severityColor: Record<string, string> = {
  low: "green",
  medium: "orange",
  high: "red"
};

const eventStatusBadge: Record<string, "success" | "processing" | "error" | "default"> = {
  delivered: "success",
  pending: "processing",
  failed: "error",
  confirmed: "success",
  ignored: "default"
};

const deliveryStatusColor: Record<string, string> = {
  pending: "orange",
  sent: "green",
  failed: "red"
};

const UPDATE_ALERT_EVENT_STATUS = gql`
  mutation UpdateAlertEventStatus($input: UpdateAlertEventStatusInput!) {
    updateAlertEventStatus(input: $input) {
      id
      status
    }
  }
`;

type UpdateAlertEventStatusData = {
  updateAlertEventStatus: { id: string; status: string };
};

type UpdateAlertEventStatusVariables = {
  input: {
    eventId: string;
    status: string;
  };
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

const toStringValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }
  return undefined;
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
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageAlerts = permissions.includes("alerts.manage");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const eventParam = searchParams.get("eventId");
  const [replayOpen, setReplayOpen] = useState(false);
  const { echartsTheme, colors, fontFamily } = useChartTheme();
  const [loadReplay, { data: replayData, loading: replayLoading, error: replayError }] =
    useAlertEventReplayLazyQuery();

  const { data: eventsData, loading: eventsLoading, refetch: refetchEvents } = useAlertEventsQuery({
    variables: { limit: 20 }
  });
  const [updateEventStatus, { loading: updatingStatus }] = useMutation<
    UpdateAlertEventStatusData,
    UpdateAlertEventStatusVariables
  >(UPDATE_ALERT_EVENT_STATUS);

  useEffect(() => {
    const sub = client
      .subscribe({
        query: AlertEventsStreamDocument
      })
      .subscribe({
        next: () => {
          void refetchEvents();
        }
      });
    return () => sub.unsubscribe();
  }, [client, refetchEvents]);
  const events = eventsData?.alertEvents ?? [];
  const sortedEvents = useMemo(() => {
    return [...events].sort((a, b) => {
      const aTime = new Date(a.triggeredAt).getTime();
      const bTime = new Date(b.triggeredAt).getTime();
      return bTime - aTime;
    });
  }, [events]);

  useEffect(() => {
    if (sortedEvents.length === 0) {
      setSelectedEventId(null);
      return;
    }
    if (eventParam && sortedEvents.some((event) => event.id === eventParam)) {
      setSelectedEventId(eventParam);
      return;
    }
    if (!selectedEventId || !sortedEvents.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(sortedEvents[0]?.id ?? null);
    }
  }, [eventParam, sortedEvents, selectedEventId]);

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

  useEffect(() => {
    setReplayOpen(false);
  }, [selectedEventId]);

  const replay =
    replayData?.alertEventReplay && replayData.alertEventReplay.eventId === selectedEvent?.id
      ? replayData.alertEventReplay
      : null;
  const replayPoints = replay?.points ?? [];
  const replayUnit = replay?.unit ?? null;
  const replayOption = useMemo(() => {
    if (!replay || replayPoints.length === 0) {
      return {};
    }

    const operator = selectedEvent?.operator ?? null;
    const thresholdValue =
      typeof selectedEvent?.thresholdValue === "number" && Number.isFinite(selectedEvent.thresholdValue)
        ? selectedEvent.thresholdValue
        : null;
    const thresholdLower =
      typeof selectedEvent?.thresholdLower === "number" && Number.isFinite(selectedEvent.thresholdLower)
        ? selectedEvent.thresholdLower
        : null;
    const thresholdUpper =
      typeof selectedEvent?.thresholdUpper === "number" && Number.isFinite(selectedEvent.thresholdUpper)
        ? selectedEvent.thresholdUpper
        : null;

    const markLineData: any[] = [];
    if (operator && ["gt", "gte", "lt", "lte", "eq"].includes(operator) && thresholdValue !== null) {
      markLineData.push({
        yAxis: thresholdValue,
        lineStyle: { type: "dashed", color: colors.accent },
        label: { formatter: `threshold ${thresholdValue}` }
      });
    }
    if (operator && ["outside_range", "within_range"].includes(operator) && thresholdLower !== null && thresholdUpper !== null) {
      markLineData.push(
        {
          yAxis: thresholdLower,
          lineStyle: { type: "dashed", color: colors.accent },
          label: { formatter: `lower ${thresholdLower}` }
        },
        {
          yAxis: thresholdUpper,
          lineStyle: { type: "dashed", color: colors.accent },
          label: { formatter: `upper ${thresholdUpper}` }
        }
      );
    }

    return {
      tooltip: { trigger: "axis" },
      grid: { top: 20, left: 40, right: 20, bottom: 30, containLabel: true },
      xAxis: { type: "time" },
      yAxis: { type: "value", name: replayUnit ?? undefined },
      series: [
        {
          type: "line",
          smooth: true,
          showSymbol: false,
          data: replayPoints.map((point) => [point.timestamp, point.value]),
          lineStyle: { width: 2, color: colors.primary },
          areaStyle: { opacity: 0.06, color: colors.primary },
          ...(markLineData.length > 0
            ? {
                markLine: {
                  symbol: "none",
                  data: markLineData
                } as any
              }
            : {})
        }
      ],
      textStyle: { fontFamily }
    };
  }, [
    colors.accent,
    colors.primary,
    fontFamily,
    replay,
    replayPoints,
    replayUnit,
    selectedEvent?.operator,
    selectedEvent?.thresholdLower,
    selectedEvent?.thresholdUpper,
    selectedEvent?.thresholdValue
  ]) as EChartsOption;

  const handleOpenReplay = () => {
    if (!selectedEvent) {
      return;
    }
    setReplayOpen(true);
    loadReplay({
      variables: {
        eventId: selectedEvent.id,
        windowDays: 30
      }
    });
  };

  const handleRefresh = async () => {
    await refetchEvents();
  };

  const handleEventStatusUpdate = async (status: string) => {
    if (!selectedEvent || !canManageAlerts) {
      return;
    }
    await updateEventStatus({
      variables: {
        input: {
          eventId: selectedEvent.id,
          status
        }
      }
    });
    await refetchEvents();
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
    "previous",
    "threshold",
    "lower",
    "upper",
    "changePercent",
    "windowMinutes",
    "sourceName",
    "sourceEndpoint",
    "sourceFunction",
    "sourceDocUrl",
    "sourceField",
    "unit",
    "recordedAt",
    "itemName"
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

  const evidenceWindowMinutes =
    selectedEvent?.changeWindowMin ?? toNumber(context?.windowMinutes);
  const evidenceUnit = toStringValue(context?.unit);
  const evidencePrevious = toNumber(context?.previous);
  const evidenceRecordedAt =
    typeof context?.recordedAt === "string" || typeof context?.recordedAt === "number"
      ? context?.recordedAt
      : undefined;
  const evidenceRecordedAtLabel = evidenceRecordedAt
    ? formatDateTime(evidenceRecordedAt, locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short"
      })
    : "";
  const evidenceSource =
    toStringValue(context?.sourceName) ??
    toStringValue(context?.sourceEndpoint) ??
    toStringValue(context?.sourceFunction) ??
    toStringValue(context?.sourceField);
  const evidenceSourceDoc = toStringValue(context?.sourceDocUrl);

  const thresholdSummary = selectedEvent
    ? buildThresholdSummary(
        selectedEvent.operator,
        selectedEvent.thresholdValue ?? toNumber(context?.threshold),
        selectedEvent.thresholdLower ?? toNumber(context?.lower),
        selectedEvent.thresholdUpper ?? toNumber(context?.upper),
        t
      )
    : t("common.notAvailable");

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

      <Card className="content-card">
        <Alert
          type={canManageAlerts ? "info" : "warning"}
          message={t("alerts.center.configNotice.title", {
            defaultValue: "Alert rules are managed in Admin"
          })}
          description={
            canManageAlerts ? (
              <Link href="/admin/alerts">
                {t("alerts.center.configNotice.link", { defaultValue: "Open alert configuration" })}
              </Link>
            ) : (
              t("alerts.center.configNotice.description", {
                defaultValue: "Alert rule configuration is limited to administrators."
              })
            )
          }
        />
      </Card>

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
              dataSource={sortedEvents}
              locale={{
                emptyText: (
                  <ChartEmptyState
                    className="h-auto py-6"
                    description={t("alerts.center.emptyEvents", {
                      defaultValue: "No recent alerts."
                    })}
                  />
                )
              }}
              renderItem={(event) => {
                const isSelected = event.id === selectedEventId;
                const eventContext =
                  event.context && typeof event.context === "object"
                    ? (event.context as Record<string, unknown>)
                    : null;
                const contextSummary = buildContextSummary(eventContext);
                const eventThresholdSummary = buildThresholdSummary(
                  event.operator,
                  event.thresholdValue ?? toNumber(eventContext?.threshold),
                  event.thresholdLower ?? toNumber(eventContext?.lower),
                  event.thresholdUpper ?? toNumber(eventContext?.upper),
                  t
                );
                const eventEvidenceSource =
                  toStringValue(eventContext?.sourceName) ??
                  toStringValue(eventContext?.sourceEndpoint) ??
                  toStringValue(eventContext?.sourceField) ??
                  toStringValue(eventContext?.sourceFunction);
                return (
                  <List.Item
                    onClick={() => handleSelectEvent(event.id)}
                    className={isSelected ? "bg-slate-50" : undefined}
                    style={{ cursor: "pointer" }}
                    role="button"
                    tabIndex={0}
                    aria-selected={isSelected}
                    onKeyDown={(eventKey) => {
                      if (eventKey.key === "Enter" || eventKey.key === " ") {
                        eventKey.preventDefault();
                        handleSelectEvent(event.id);
                      }
                    }}
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
                              minute: "2-digit",
                              timeZoneName: "short"
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
                            {t("alerts.events.evidence", {
                              defaultValue: "Evidence {{source}} · Threshold {{threshold}}",
                              source: eventEvidenceSource ?? t("common.notAvailable"),
                              threshold: eventThresholdSummary
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
                    {evidenceWindowMinutes !== null && evidenceWindowMinutes !== undefined ? (
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.window", {
                          defaultValue: "Window {{minutes}} min",
                          minutes: evidenceWindowMinutes
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
                      second: "2-digit",
                      timeZoneName: "short"
                    })}
                  </Typography.Text>
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.metricValue", { defaultValue: "Metric value" })}>
                  <Space direction="vertical" size={2}>
                    <Space size="small" align="baseline">
                      <Typography.Text strong>{selectedEvent.metricValue}</Typography.Text>
                      {evidenceUnit ? (
                        <Typography.Text type="secondary">{evidenceUnit}</Typography.Text>
                      ) : null}
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
                    {evidencePrevious !== undefined ? (
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.previousValue", {
                          defaultValue: "Previous {{value}}",
                          value: evidencePrevious
                        })}
                      </Typography.Text>
                    ) : null}
                    {evidenceRecordedAtLabel ? (
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.recordedAt", {
                          defaultValue: "Recorded at {{time}}",
                          time: evidenceRecordedAtLabel
                        })}
                      </Typography.Text>
                    ) : null}
                  </Space>
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.replay", { defaultValue: "Replay" })}>
                  <>
                    <Space size="small">
                      <Button size="small" onClick={handleOpenReplay} disabled={!selectedEvent} loading={replayLoading}>
                        {t("alerts.center.detail.openReplay", { defaultValue: "Open replay" })}
                      </Button>
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.replayHint", {
                          defaultValue: "Shows recent metric history around this alert."
                        })}
                      </Typography.Text>
                    </Space>
                    <Modal
                      title={t("alerts.center.detail.replayTitle", {
                        defaultValue: "Replay: {{metric}}",
                        metric: selectedEvent.metricSlug ?? t("common.notAvailable")
                      })}
                      open={replayOpen}
                      onCancel={() => setReplayOpen(false)}
                      footer={null}
                      width={840}
                      destroyOnClose
                    >
                      {replayLoading ? (
                        <div className="flex justify-center py-10">
                          <Spin />
                        </div>
                      ) : replayError ? (
                        <Alert
                          type="error"
                          showIcon
                          message={t("alerts.center.detail.replayError", { defaultValue: "Failed to load replay." })}
                          description={replayError.message}
                        />
                      ) : replay ? (
                        replayPoints.length > 0 ? (
                          <DashboardChart option={replayOption} theme={echartsTheme} height={320} />
                        ) : (
                          <ChartEmptyState
                            className="h-auto py-8"
                            description={t("alerts.center.detail.replayEmpty", {
                              defaultValue: "No replay data available for this event."
                            })}
                          />
                        )
                      ) : (
                        <Alert
                          type="info"
                          showIcon
                          message={t("alerts.center.detail.replayUnsupported", {
                            defaultValue: "Replay is not available for this provider."
                          })}
                        />
                      )}
                    </Modal>
                  </>
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.source", { defaultValue: "Source" })}>
                  {evidenceSource || evidenceSourceDoc ? (
                    <Space direction="vertical" size={2}>
                      {evidenceSource ? <Typography.Text>{evidenceSource}</Typography.Text> : null}
                      {evidenceSourceDoc ? (
                        <Typography.Link href={evidenceSourceDoc} target="_blank" rel="noreferrer">
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
                <DetailRow label={t("alerts.center.detail.feedback", { defaultValue: "Feedback" })}>
                  {canManageAlerts ? (
                    <Space>
                      <Button
                        type="primary"
                        size="small"
                        loading={updatingStatus}
                        disabled={selectedEvent.status === "confirmed"}
                        onClick={() => void handleEventStatusUpdate("confirmed")}
                      >
                        {t("alerts.center.detail.confirm", { defaultValue: "Confirm" })}
                      </Button>
                      <Button
                        size="small"
                        loading={updatingStatus}
                        disabled={selectedEvent.status === "ignored"}
                        onClick={() => void handleEventStatusUpdate("ignored")}
                      >
                        {t("alerts.center.detail.ignore", { defaultValue: "Ignore" })}
                      </Button>
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">
                      {t("alerts.center.detail.feedbackAdminOnly", {
                        defaultValue: "Feedback actions are available to administrators only."
                      })}
                    </Typography.Text>
                  )}
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
                          {delivery.channelName ? (
                            <Typography.Text>{delivery.channelName}</Typography.Text>
                          ) : null}
                          {!delivery.channelName && delivery.target ? (
                            <Typography.Text>{delivery.target}</Typography.Text>
                          ) : null}
                          {delivery.channelName && delivery.target ? (
                            <Typography.Text type="secondary">{delivery.target}</Typography.Text>
                          ) : null}
                          <Typography.Text type="secondary">
                            {delivery.sentAt
                              ? formatDateTime(delivery.sentAt, locale, {
                                  year: "numeric",
                                  month: "2-digit",
                                  day: "2-digit",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  timeZoneName: "short"
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
              <ChartEmptyState
                className="h-auto py-6"
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
