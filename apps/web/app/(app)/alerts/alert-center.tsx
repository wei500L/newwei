"use client";

import { gql, useApolloClient, useMutation } from "@apollo/client";
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Input,
  List,
  Modal,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
  message
} from "antd";
import type { EChartsOption } from "echarts";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import {
  AlertEventsStreamDocument,
  AlertMetricProvider,
  useAlertEventReplayLazyQuery,
  useAlertEventsQuery,
  useAlertRuleTuningSuggestionQuery,
} from "@/graphql/generated";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

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

interface UpdateAlertEventStatusData {
  updateAlertEventStatus: { id: string; status: string };
}

interface UpdateAlertEventStatusVariables {
  input: {
    eventId: string;
    status: string;
    note?: string | null;
  };
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type LocaleCode = ReturnType<typeof resolveLocale>;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const formatFixed = (value: unknown, digits = 4): string => {
  const numberValue = toNumber(value);
  return typeof numberValue === "number" ? numberValue.toFixed(digits) : "";
};

const formatPercent = (value: unknown, digits = 1): string => {
  const numberValue = toNumber(value);
  return typeof numberValue === "number" ? `${(numberValue * 100).toFixed(digits)}%` : "";
};

const DetailRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <Typography.Text type="secondary">{label}</Typography.Text>
    <div>{children}</div>
  </div>
);

const EconomicAnomalyEvidence = ({
  context,
  locale,
  t
}: {
  context: Record<string, unknown> | null;
  locale: LocaleCode;
  t: TranslateFn;
}) => {
  if (!context) {
    return (
      <Typography.Text type="secondary">
        {t("alerts.center.evidence.empty", { defaultValue: "No evidence available." })}
      </Typography.Text>
    );
  }

  const itemName = toStringValue(context.itemName);
  const recordedAt =
    typeof context.recordedAt === "string" || typeof context.recordedAt === "number"
      ? context.recordedAt
      : undefined;
  const recordedAtLabel = recordedAt
    ? formatDateTime(recordedAt, locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short"
      })
    : "";

  const model = isRecord(context.model) ? context.model : null;
  const modelKind = toStringValue(model?.kind);
  const observed = toNumber(context.observed);
  const expected = toNumber(context.expected);
  const lower = toNumber(context.lower);
  const upper = toNumber(context.upper);
  const sigma = toNumber(context.sigma);
  const residual = toNumber(context.residual);
  const score = toNumber(context.score);
  const fallback = isRecord(context.fallback) ? context.fallback : null;

  const scoreColor = typeof score === "number" ? (score >= 3 ? "red" : score >= 2 ? "orange" : "green") : "default";

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Space size={[6, 6]} wrap>
        {itemName ? <Tag>{itemName}</Tag> : null}
        {modelKind ? <Tag color="blue">{modelKind}</Tag> : null}
        {typeof score === "number" ? <Tag color={scoreColor}>{`score ${score.toFixed(3)}`}</Tag> : null}
        {recordedAtLabel ? <Tag>{recordedAtLabel}</Tag> : null}
      </Space>

      {typeof expected === "number" && typeof sigma === "number" ? (
        <Descriptions size="small" bordered column={2}>
          <Descriptions.Item label={t("alerts.center.evidence.observed", { defaultValue: "Observed" })}>
            {typeof observed === "number" ? observed : t("common.notAvailable")}
          </Descriptions.Item>
          <Descriptions.Item label={t("alerts.center.evidence.expected", { defaultValue: "Expected" })}>
            {expected}
          </Descriptions.Item>
          <Descriptions.Item label={t("alerts.center.evidence.residual", { defaultValue: "Residual" })}>
            {typeof residual === "number" ? residual : t("common.notAvailable")}
          </Descriptions.Item>
          <Descriptions.Item label={t("alerts.center.evidence.sigma", { defaultValue: "Sigma" })}>
            {sigma}
          </Descriptions.Item>
          <Descriptions.Item label={t("alerts.center.evidence.ci", { defaultValue: "CI" })} span={2}>
            {typeof lower === "number" && typeof upper === "number"
              ? `[${lower}, ${upper}]`
              : t("common.notAvailable")}
          </Descriptions.Item>
        </Descriptions>
      ) : fallback ? (
        <Alert
          type="warning"
          showIcon
          message={t("alerts.center.evidence.fallback", { defaultValue: "Model service unavailable. Using fallback detector." })}
          description={safeJsonStringify(fallback)}
        />
      ) : (
        <Typography.Text type="secondary">
          {t("alerts.center.evidence.empty", { defaultValue: "No evidence available." })}
        </Typography.Text>
      )}
    </Space>
  );
};

const EntitySentimentEvidence = ({
  context,
  locale,
  t
}: {
  context: Record<string, unknown> | null;
  locale: LocaleCode;
  t: TranslateFn;
}) => {
  if (!context) {
    return (
      <Typography.Text type="secondary">
        {t("alerts.center.evidence.empty", { defaultValue: "No evidence available." })}
      </Typography.Text>
    );
  }

  const entityName = toStringValue(context.entityName);
  const entityType = toStringValue(context.entityType);
  const minEntityConfidence = toNumber(context.minEntityConfidence);
  const z = toNumber(context.z);

  const window = isRecord(context.window) ? context.window : null;
  const baseline = isRecord(context.baseline) ? context.baseline : null;

  const windowStart = toStringValue(window?.start);
  const windowEnd = toStringValue(window?.end);
  const baselineStart = toStringValue(baseline?.start);
  const baselineEnd = toStringValue(baseline?.end);

  const windowMinutes = toNumber(window?.minutes);
  const baselineMinutes = toNumber(baseline?.minutes);

  const windowTotal = toNumber(window?.total);
  const windowNegative = toNumber(window?.negative);
  const windowNegativeRatio = toNumber(window?.negativeRatio);
  const baselineTotal = toNumber(baseline?.total);
  const baselineNegative = toNumber(baseline?.negative);
  const baselineNegativeRatio = toNumber(baseline?.negativeRatio);

  const evidenceItems = Array.isArray(context.evidence) ? context.evidence : [];

  const formatWindowLabel = (start: string | undefined, end: string | undefined): string => {
    if (!start || !end) return "";
    return `${formatDateTime(start, locale, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short"
    })} → ${formatDateTime(end, locale, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short"
    })}`;
  };

  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Space size={[6, 6]} wrap>
        {entityName ? <Tag>{entityName}</Tag> : null}
        {entityType ? <Tag color="blue">{entityType}</Tag> : null}
        {typeof z === "number" ? <Tag color={z >= 3 ? "red" : z >= 2 ? "orange" : "green"}>{`z ${z.toFixed(3)}`}</Tag> : null}
        {typeof minEntityConfidence === "number" ? <Tag>{`minConf ${minEntityConfidence.toFixed(2)}`}</Tag> : null}
      </Space>

      <Descriptions size="small" bordered column={1}>
        <Descriptions.Item label={t("alerts.center.evidence.window", { defaultValue: "Window" })}>
          <Space direction="vertical" size={0}>
            {windowMinutes ? (
              <Typography.Text type="secondary">{`${windowMinutes} min`}</Typography.Text>
            ) : null}
            {windowStart && windowEnd ? (
              <Typography.Text type="secondary">{formatWindowLabel(windowStart, windowEnd)}</Typography.Text>
            ) : null}
            <Typography.Text>
              {t("alerts.center.evidence.negRatio", {
                defaultValue: "Negative ratio {{ratio}} ({{neg}} / {{total}})",
                ratio: formatPercent(windowNegativeRatio, 1) || t("common.notAvailable"),
                neg: typeof windowNegative === "number" ? windowNegative : t("common.notAvailable"),
                total: typeof windowTotal === "number" ? windowTotal : t("common.notAvailable")
              })}
            </Typography.Text>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label={t("alerts.center.evidence.baseline", { defaultValue: "Baseline" })}>
          <Space direction="vertical" size={0}>
            {baselineMinutes ? (
              <Typography.Text type="secondary">{`${baselineMinutes} min`}</Typography.Text>
            ) : null}
            {baselineStart && baselineEnd ? (
              <Typography.Text type="secondary">{formatWindowLabel(baselineStart, baselineEnd)}</Typography.Text>
            ) : null}
            <Typography.Text>
              {t("alerts.center.evidence.negRatio", {
                defaultValue: "Negative ratio {{ratio}} ({{neg}} / {{total}})",
                ratio: formatPercent(baselineNegativeRatio, 1) || t("common.notAvailable"),
                neg: typeof baselineNegative === "number" ? baselineNegative : t("common.notAvailable"),
                total: typeof baselineTotal === "number" ? baselineTotal : t("common.notAvailable")
              })}
            </Typography.Text>
          </Space>
        </Descriptions.Item>
      </Descriptions>

      {evidenceItems.length > 0 ? (
        <>
          <Divider style={{ margin: "8px 0" }} />
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.evidenceItems", { defaultValue: "Evidence items" })}
          </Typography.Text>
          <List
            size="small"
            dataSource={evidenceItems}
            renderItem={(item, index) => {
              const record = isRecord(item) ? item : null;
              const itemMetaId = toStringValue(record?.itemMetaId);
              const title = toStringValue(record?.title) ?? t("common.notAvailable");
              const source = toStringValue(record?.source);
              const summary = toStringValue(record?.summary);
              const publishedAt = toStringValue(record?.publishedAt);
              const ingestedAt = toStringValue(record?.ingestedAt) ?? toStringValue(record?.createdAt);
              const publishedLabel = t("items.time.published", { defaultValue: "Published" });
              const ingestedLabel = t("items.time.ingested", { defaultValue: "Ingested" });
              const formatOptions = {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                timeZoneName: "short"
              } as const;
              const publishedText = publishedAt
                ? formatDateTime(publishedAt, locale, formatOptions)
                : t("common.notAvailable");
              const ingestedText = ingestedAt
                ? formatDateTime(ingestedAt, locale, formatOptions)
                : t("common.notAvailable");

              return (
                <List.Item key={`${itemMetaId ?? "item"}-${index}`}>
                  <Space direction="vertical" size={0} style={{ width: "100%" }}>
                    <Typography.Text>
                      {itemMetaId ? <Link href={`/items/${itemMetaId}`}>{title}</Link> : title}
                    </Typography.Text>
                    <Space size="small" wrap>
                      {source ? <Tag>{source}</Tag> : null}
                      <Space direction="vertical" size={0}>
                        <Typography.Text type="secondary">
                          {publishedLabel}: {publishedText}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {ingestedLabel}: {ingestedText}
                        </Typography.Text>
                      </Space>
                    </Space>
                    {summary ? <Typography.Text type="secondary">{summary}</Typography.Text> : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </>
      ) : (
        <Typography.Text type="secondary">
          {t("alerts.center.evidence.noEvidenceItems", { defaultValue: "No evidence items." })}
        </Typography.Text>
      )}
    </Space>
  );
};

const EntityAssociationEvidence = ({
  context,
  locale,
  t,
  onOpenEvent
}: {
  context: Record<string, unknown> | null;
  locale: LocaleCode;
  t: TranslateFn;
  onOpenEvent: (eventId: string) => void;
}) => {
  if (!context) {
    return (
      <Typography.Text type="secondary">
        {t("alerts.center.evidence.empty", { defaultValue: "No evidence available." })}
      </Typography.Text>
    );
  }

  const seed = isRecord(context.seed) ? context.seed : null;
  const seedName = toStringValue(seed?.name);
  const seedType = toStringValue(seed?.type);

  const sourceEvent = isRecord(context.sourceEvent) ? context.sourceEvent : null;
  const sourceEventId = toStringValue(sourceEvent?.id);
  const sourceEventTriggeredAt = toStringValue(sourceEvent?.triggeredAt);
  const sourceEventMetricValue = toNumber(sourceEvent?.metricValue);
  const sourceEventStatus = toStringValue(sourceEvent?.status);
  const sourceTriggeredLabel = sourceEventTriggeredAt
    ? formatDateTime(sourceEventTriggeredAt, locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short"
      })
    : "";

  const targets = Array.isArray(context.targets) ? context.targets : [];

  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Space size={[6, 6]} wrap>
        {seedName ? <Tag>{seedName}</Tag> : null}
        {seedType ? <Tag color="blue">{seedType}</Tag> : null}
      </Space>

      {sourceEventId ? (
        <Descriptions size="small" bordered column={1}>
          <Descriptions.Item label={t("alerts.center.evidence.sourceEvent", { defaultValue: "Source event" })}>
            <Space direction="vertical" size={2}>
              <Space size="small" wrap>
                <Tag>{sourceEventId}</Tag>
                {sourceEventStatus ? <Tag>{sourceEventStatus}</Tag> : null}
                {typeof sourceEventMetricValue === "number" ? (
                  <Tag>{`metric ${sourceEventMetricValue}`}</Tag>
                ) : null}
              </Space>
              {sourceTriggeredLabel ? (
                <Typography.Text type="secondary">{sourceTriggeredLabel}</Typography.Text>
              ) : null}
              <Button size="small" onClick={() => onOpenEvent(sourceEventId)}>
                {t("alerts.center.evidence.openSourceEvent", { defaultValue: "Open source event" })}
              </Button>
            </Space>
          </Descriptions.Item>
        </Descriptions>
      ) : (
        <Typography.Text type="secondary">
          {t("alerts.center.evidence.sourceEventMissing", { defaultValue: "No source event." })}
        </Typography.Text>
      )}

      <Divider style={{ margin: "8px 0" }} />
      <Typography.Text type="secondary">
        {t("alerts.center.evidence.targets", { defaultValue: "Associated targets" })}
      </Typography.Text>
      <List
        size="small"
        dataSource={targets}
        locale={{
          emptyText: t("alerts.center.evidence.targetsEmpty", { defaultValue: "No targets." })
        }}
        renderItem={(item, index) => {
          const record = isRecord(item) ? item : null;
          const name = toStringValue(record?.name) ?? t("common.notAvailable");
          const type = toStringValue(record?.type);
          const relationType = toStringValue(record?.relationType);
          const score = toNumber(record?.score);
          const weight = toNumber(record?.weight);
          const confidence = toNumber(record?.confidence);
          return (
            <List.Item key={`${toStringValue(record?.entityId) ?? "entity"}-${index}`}>
              <Space direction="vertical" size={0} style={{ width: "100%" }}>
                <Space size="small" wrap>
                  <Typography.Text>{name}</Typography.Text>
                  {type ? <Tag color="blue">{type}</Tag> : null}
                  {relationType ? <Tag>{relationType}</Tag> : null}
                  {typeof score === "number" ? <Tag color="orange">{`score ${score.toFixed(3)}`}</Tag> : null}
                </Space>
                <Typography.Text type="secondary">
                  {t("alerts.center.evidence.targetMeta", {
                    defaultValue: "weight {{weight}} · conf {{conf}}",
                    weight: formatFixed(weight, 3) || t("common.notAvailable"),
                    conf: formatFixed(confidence, 3) || t("common.notAvailable")
                  })}
                </Typography.Text>
              </Space>
            </List.Item>
          );
        }}
      />
    </Space>
  );
};

export function AlertCenterContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const client = useApolloClient();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageAlerts = permissions.includes("alerts.manage");
  const [messageApi, messageContext] = message.useMessage();
  const [eventsLimit, setEventsLimit] = useState(20);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [feedbackNote, setFeedbackNote] = useState<string>("");
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const eventParam = searchParams.get("eventId");
  const [replayOpen, setReplayOpen] = useState(false);
  const [rawContextOpen, setRawContextOpen] = useState(false);
  const { echartsTheme, colors, fontFamily } = useChartTheme();
  const [loadReplay, { data: replayData, loading: replayLoading, error: replayError }] =
    useAlertEventReplayLazyQuery();

  const { data: eventsData, loading: eventsLoading, refetch: refetchEvents } = useAlertEventsQuery({
    variables: { limit: eventsLimit }
  });
  const selectedRuleId = selectedEventId
    ? eventsData?.alertEvents?.find((event) => event.id === selectedEventId)?.ruleId ?? null
    : null;
  const {
    data: tuningData,
    loading: tuningLoading,
    error: tuningError,
    refetch: refetchTuning
  } = useAlertRuleTuningSuggestionQuery({
    variables: { ruleId: selectedRuleId ?? "", windowDays: 30 },
    skip: !canManageAlerts || !selectedRuleId
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
  const events = eventsData?.alertEvents;
  const sortedEvents = useMemo(() => {
    return [...(events ?? [])].sort((a, b) => {
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

  const handleOpenEvent = async (eventId: string) => {
    if (!eventId) {
      return;
    }
    const exists = sortedEvents.some((event) => event.id === eventId);
    if (!exists) {
      const nextLimit = Math.max(eventsLimit, 100);
      setEventsLimit(nextLimit);
      try {
        await refetchEvents({ limit: nextLimit });
      } catch (error) {
        messageApi.error(
          error instanceof Error ? error.message : t("common.error.unexpected", { defaultValue: "Unexpected error" })
        );
      }
    }
    handleSelectEvent(eventId);
  };

  const selectedEvent = useMemo(
    () => (events ?? []).find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId]
  );

  useEffect(() => {
    if (!selectedEvent) {
      setFeedbackNote("");
      return;
    }
    const context =
      selectedEvent.context && typeof selectedEvent.context === "object"
        ? (selectedEvent.context as Record<string, unknown>)
        : null;
    const feedback =
      context?.feedback && typeof context.feedback === "object" && !Array.isArray(context.feedback)
        ? (context.feedback as Record<string, unknown>)
        : null;
    const note = typeof feedback?.note === "string" ? feedback.note : "";
    setFeedbackNote(note);
  }, [selectedEvent]);

  useEffect(() => {
    setReplayOpen(false);
  }, [selectedEventId]);

  const replay =
    replayData?.alertEventReplay && replayData.alertEventReplay.eventId === selectedEvent?.id
      ? replayData.alertEventReplay
      : null;
  const replayPoints = replay?.points;
  const replayUnit = replay?.unit;
  const replayOption = useMemo(() => {
    if (!replay || !replayPoints || replayPoints.length === 0) {
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

    interface MarkLineDataItem {
      yAxis: number;
      lineStyle?: { type?: string; color?: string };
      label?: { formatter?: string };
    }
    const markLineData: MarkLineDataItem[] = [];
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
                }
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
    try {
      await updateEventStatus({
        variables: {
          input: {
            eventId: selectedEvent.id,
            status,
            note: feedbackNote?.trim() ? feedbackNote.trim() : null
          }
        }
      });
      messageApi.success(
        t("alerts.center.detail.feedbackUpdated", { defaultValue: "Feedback updated." })
      );
      await refetchEvents();
      if (canManageAlerts && selectedEvent.ruleId) {
        await refetchTuning({ ruleId: selectedEvent.ruleId, windowDays: 30 });
      }
    } catch (error) {
      messageApi.error(
        error instanceof Error ? error.message : t("common.error.unexpected", { defaultValue: "Unexpected error" })
      );
    }
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
    "feedback",
    "latest",
    "previous",
    "metricSlug",
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
  if (selectedEvent?.metricProvider === AlertMetricProvider.EconomicAnomaly) {
    ["observed", "expected", "sigma", "residual", "score", "model", "diagnostics", "fallback"].forEach((key) =>
      excludedContextKeys.add(key)
    );
  }
  if (selectedEvent?.metricProvider === AlertMetricProvider.EntitySentiment) {
    ["entityName", "entityType", "window", "baseline", "z", "minEntityConfidence", "evidence"].forEach((key) =>
      excludedContextKeys.add(key)
    );
  }
  if (selectedEvent?.metricProvider === AlertMetricProvider.EntityAssociation) {
    ["seed", "sourceEvent", "targets", "minAssociationWeight", "maxTargets"].forEach((key) =>
      excludedContextKeys.add(key)
    );
  }
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

  const feedback =
    context?.feedback && typeof context.feedback === "object" && !Array.isArray(context.feedback)
      ? (context.feedback as Record<string, unknown>)
      : null;
  const feedbackStatus = toStringValue(feedback?.status);
  const feedbackUpdatedAt =
    typeof feedback?.updatedAt === "string" || typeof feedback?.updatedAt === "number"
      ? feedback.updatedAt
      : undefined;
  const feedbackUpdatedAtLabel = feedbackUpdatedAt
    ? formatDateTime(feedbackUpdatedAt, locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short"
      })
    : "";
  const feedbackUpdatedById = toStringValue(feedback?.updatedById);
  const feedbackStoredNote = typeof feedback?.note === "string" ? feedback.note : null;
  const reviewStatus =
    feedbackStatus === "confirmed" || feedbackStatus === "ignored"
      ? feedbackStatus
      : selectedEvent?.status === "confirmed" || selectedEvent?.status === "ignored"
        ? selectedEvent.status
        : null;

  const thresholdSummary = selectedEvent
    ? buildThresholdSummary(
        selectedEvent.operator,
        selectedEvent.thresholdValue ?? toNumber(context?.threshold),
        selectedEvent.thresholdLower ?? toNumber(context?.lower),
        selectedEvent.thresholdUpper ?? toNumber(context?.upper),
        t
      )
    : t("common.notAvailable");

  const handleCopyRawContext = async () => {
    if (!context) {
      return;
    }
    try {
      await navigator.clipboard.writeText(safeJsonStringify(context));
      messageApi.success(t("alerts.center.contextCopied", { defaultValue: "Copied." }));
    } catch (error) {
      messageApi.error(
        error instanceof Error ? error.message : t("alerts.center.contextCopyFailed", { defaultValue: "Copy failed." })
      );
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {messageContext}
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
                const seed = isRecord(eventContext?.seed) ? (eventContext?.seed as Record<string, unknown>) : null;
                const eventEvidenceSource =
                  toStringValue(eventContext?.sourceName) ??
                  toStringValue(eventContext?.sourceEndpoint) ??
                  toStringValue(eventContext?.sourceField) ??
                  toStringValue(eventContext?.sourceFunction) ??
                  (event.metricProvider === AlertMetricProvider.EconomicAnomaly
                    ? toStringValue(eventContext?.itemName) ?? toStringValue(event.metricSlug)
                    : null) ??
                  (event.metricProvider === AlertMetricProvider.EntitySentiment
                    ? toStringValue(eventContext?.entityName) ?? toStringValue(event.metricSlug)
                    : null) ??
                  (event.metricProvider === AlertMetricProvider.EntityAssociation
                    ? toStringValue(seed?.name) ?? toStringValue(event.metricSlug)
                    : null);
                const changeLabel =
                  typeof event.changePercent === "number" ? `${event.changePercent.toFixed(2)}%` : t("common.notAvailable");
                return (
                  <List.Item
                    onClick={() => handleSelectEvent(event.id)}
                    className={isSelected ? "bg-slate-50" : undefined}
                    style={{ cursor: "pointer" }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
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
                              change: changeLabel
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
                <DetailRow label={t("alerts.center.detail.evidence", { defaultValue: "Evidence" })}>
                  {selectedEvent.metricProvider === AlertMetricProvider.EconomicAnomaly ? (
                    <EconomicAnomalyEvidence context={context} locale={locale} t={t} />
                  ) : selectedEvent.metricProvider === AlertMetricProvider.EntitySentiment ? (
                    <EntitySentimentEvidence context={context} locale={locale} t={t} />
                  ) : selectedEvent.metricProvider === AlertMetricProvider.EntityAssociation ? (
                    <EntityAssociationEvidence context={context} locale={locale} t={t} onOpenEvent={(eventId) => void handleOpenEvent(eventId)} />
                  ) : (
                    <Typography.Text type="secondary">
                      {t("alerts.center.evidence.unsupported", { defaultValue: "No structured evidence for this provider." })}
                    </Typography.Text>
                  )}
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
                        replayPoints && replayPoints.length > 0 ? (
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
                  <Space direction="vertical" size={8} style={{ width: "100%" }}>
                    <Space size="small" wrap>
                      {reviewStatus ? (
                        <Tag color={reviewStatus === "confirmed" ? "green" : "default"}>{reviewStatus}</Tag>
                      ) : (
                        <Tag>
                          {t("alerts.center.detail.unreviewed", { defaultValue: "unreviewed" })}
                        </Tag>
                      )}
                      {feedbackUpdatedAtLabel ? (
                        <Typography.Text type="secondary">
                          {t("alerts.center.detail.feedbackUpdatedAt", {
                            defaultValue: "Updated {{time}}",
                            time: feedbackUpdatedAtLabel
                          })}
                        </Typography.Text>
                      ) : null}
                      {feedbackUpdatedById ? (
                        <Typography.Text type="secondary">
                          {t("alerts.center.detail.feedbackUpdatedBy", {
                            defaultValue: "By {{user}}",
                            user: feedbackUpdatedById
                          })}
                        </Typography.Text>
                      ) : null}
                    </Space>
                    {feedbackStoredNote ? (
                      <Typography.Text>{feedbackStoredNote}</Typography.Text>
                    ) : reviewStatus ? (
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.feedbackEmpty", { defaultValue: "No feedback note." })}
                      </Typography.Text>
                    ) : (
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.feedbackNotReviewed", { defaultValue: "Not reviewed yet." })}
                      </Typography.Text>
                    )}

                    {canManageAlerts ? (
                      <>
                        <Input.TextArea
                          value={feedbackNote}
                          onChange={(event) => setFeedbackNote(event.target.value)}
                          rows={2}
                          placeholder={t("alerts.center.detail.feedbackNotePlaceholder", {
                            defaultValue: "Optional note (why confirmed/ignored)"
                          })}
                        />
                        <Space>
                          <Button
                            type="primary"
                            size="small"
                            loading={updatingStatus}
                            onClick={() => void handleEventStatusUpdate("confirmed")}
                          >
                            {t("alerts.center.detail.confirm", { defaultValue: "Confirm" })}
                          </Button>
                          <Button
                            size="small"
                            loading={updatingStatus}
                            onClick={() => void handleEventStatusUpdate("ignored")}
                          >
                            {t("alerts.center.detail.ignore", { defaultValue: "Ignore" })}
                          </Button>
                        </Space>
                      </>
                    ) : (
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.feedbackAdminOnly", {
                          defaultValue: "Feedback actions are available to administrators only."
                        })}
                      </Typography.Text>
                    )}
                  </Space>
                </DetailRow>
                <DetailRow label={t("alerts.center.detail.tuning", { defaultValue: "Tuning suggestion" })}>
                  {canManageAlerts ? (
                    tuningLoading ? (
                      <Spin size="small" />
                    ) : tuningError ? (
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.tuningError", {
                          defaultValue: "Failed to load tuning suggestion."
                        })}
                      </Typography.Text>
                    ) : tuningData?.alertRuleTuningSuggestion ? (
                      <Space direction="vertical" size={2}>
                        <Typography.Text type="secondary">
                          {t("alerts.center.detail.tuningStats", {
                            defaultValue:
                              "Reviewed {{reviewed}} · Confirmed {{confirmed}} · Ignored {{ignored}} · FP rate {{rate}}",
                            reviewed: tuningData.alertRuleTuningSuggestion.reviewedEvents,
                            confirmed: tuningData.alertRuleTuningSuggestion.confirmedEvents,
                            ignored: tuningData.alertRuleTuningSuggestion.ignoredEvents,
                            rate:
                              typeof tuningData.alertRuleTuningSuggestion.falsePositiveRate === "number"
                                ? `${(tuningData.alertRuleTuningSuggestion.falsePositiveRate * 100).toFixed(1)}%`
                                : t("common.notAvailable")
                          })}
                        </Typography.Text>
                        {tuningData.alertRuleTuningSuggestion.message ? (
                          <Typography.Text>{tuningData.alertRuleTuningSuggestion.message}</Typography.Text>
                        ) : (
                          <Typography.Text type="secondary">
                            {t("alerts.center.detail.tuningEmpty", { defaultValue: "No tuning suggestion." })}
                          </Typography.Text>
                        )}
                        {typeof tuningData.alertRuleTuningSuggestion.suggestedThresholdValue === "number" ? (
                          <Typography.Text type="secondary">
                            {t("alerts.center.detail.tuningThreshold", {
                              defaultValue: "Suggested threshold {{value}}",
                              value: tuningData.alertRuleTuningSuggestion.suggestedThresholdValue
                            })}
                          </Typography.Text>
                        ) : null}
                        {typeof tuningData.alertRuleTuningSuggestion.suggestedThresholdLower === "number" ||
                        typeof tuningData.alertRuleTuningSuggestion.suggestedThresholdUpper === "number" ? (
                          <Typography.Text type="secondary">
                            {t("alerts.center.detail.tuningRange", {
                              defaultValue: "Suggested range {{lower}} - {{upper}}",
                              lower:
                                tuningData.alertRuleTuningSuggestion.suggestedThresholdLower ??
                                t("common.notAvailable"),
                              upper:
                                tuningData.alertRuleTuningSuggestion.suggestedThresholdUpper ??
                                t("common.notAvailable")
                            })}
                          </Typography.Text>
                        ) : null}
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">
                        {t("common.notAvailable")}
                      </Typography.Text>
                    )
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
                  <Space direction="vertical" size={4} style={{ width: "100%" }}>
                    <Space size="small">
                      <Button size="small" onClick={() => setRawContextOpen(true)} disabled={!context}>
                        {t("alerts.center.detail.viewRawContext", { defaultValue: "View raw" })}
                      </Button>
                      <Button size="small" onClick={() => void handleCopyRawContext()} disabled={!context}>
                        {t("alerts.center.detail.copyRawContext", { defaultValue: "Copy raw" })}
                      </Button>
                    </Space>
                    {additionalContext.length > 0 ? (
                      additionalContext.map(([key, value]) => (
                        <div key={key} className="flex justify-between gap-4">
                          <Typography.Text type="secondary">{key}</Typography.Text>
                          <Typography.Text>{formatContextValue(value)}</Typography.Text>
                        </div>
                      ))
                    ) : (
                      <Typography.Text type="secondary">
                        {t("alerts.center.detail.contextEmpty", { defaultValue: "No additional context." })}
                      </Typography.Text>
                    )}
                  </Space>
                  <Modal
                    open={rawContextOpen}
                    onCancel={() => setRawContextOpen(false)}
                    title={t("alerts.center.detail.rawContextTitle", { defaultValue: "Raw context" })}
                    footer={
                      <Space>
                        <Button onClick={() => setRawContextOpen(false)}>
                          {t("common.close", { defaultValue: "Close" })}
                        </Button>
                        <Button type="primary" onClick={() => void handleCopyRawContext()} disabled={!context}>
                          {t("alerts.center.detail.copyRawContext", { defaultValue: "Copy raw" })}
                        </Button>
                      </Space>
                    }
                  >
                    <Input.TextArea value={context ? safeJsonStringify(context) : ""} readOnly rows={12} />
                  </Modal>
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
