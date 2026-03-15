"use client";

import { gql, useApolloClient, useMutation } from '@apollo/client';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  DatePicker,
  Descriptions,
  Divider,
  Input,
  List,
  Pagination,
  Popover,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Tag,
  Tabs,
  Tooltip,
  Typography,
  message
} from 'antd';
import type { Dayjs } from 'dayjs';
import type { EChartsOption } from 'echarts';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ArticlePublishedTime } from '@/components/article-published-time';
import { ChartEmptyState } from '@/components/chart-empty-state';
import { DashboardChart } from '@/components/echart';
import {
  AlertEventsStreamDocument,
  AlertMetricProvider,
  useAlertEventReplayLazyQuery,
  useAlertEventsQuery,
  useAlertRuleTuningSuggestionQuery
} from '@/graphql/generated';
import { useChartTheme } from '@/hooks/use-chart-theme';
import {
  buildCsv,
  downloadCsv,
  downloadTextFile,
  formatDateForFilename
} from '@/lib/data-export';
import dayjs from '@/lib/dayjs';
import { formatDateTime, resolveLocale } from '@/lib/i18n';

import {
  buildAlertExportJson,
  buildAlertExportRows,
  buildAlertStats,
  buildAlertTrend,
  buildRuleTrendAnalysis,
  buildSimilarAlerts,
  filterAlertEvents,
  resolveSelectedEventId,
  resolveFilterTimeWindow,
  type AlertDatePreset,
  type AlertFilterState
} from './alert-center.utils';

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
  const canRenderCiRange =
    typeof lower === 'number' &&
    typeof upper === 'number' &&
    typeof observed === 'number' &&
    typeof expected === 'number' &&
    upper > lower;
  const ciMin = canRenderCiRange ? Math.min(lower, observed, expected) : 0;
  const ciMax = canRenderCiRange ? Math.max(upper, observed, expected) : 0;
  const ciSpan = canRenderCiRange ? ciMax - ciMin : 0;
  const toPercentPosition = (value: number) =>
    ciSpan > 0 ? Math.max(0, Math.min(100, ((value - ciMin) / ciSpan) * 100)) : 50;

  const scoreColor = typeof score === "number" ? (score >= 3 ? "red" : score >= 2 ? "orange" : "green") : "default";

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Space size={[6, 6]} wrap>
        {itemName ? <Tag>{itemName}</Tag> : null}
        {modelKind ? <Tag color="blue">{modelKind}</Tag> : null}
        {typeof score === "number" ? <Tag color={scoreColor}>{`score ${score.toFixed(3)}`}</Tag> : null}
        {recordedAtLabel ? <Tag>{recordedAtLabel}</Tag> : null}
      </Space>

      {typeof expected === 'number' && typeof sigma === 'number' ? (
        <>
          <Descriptions size="small" bordered column={2}>
            <Descriptions.Item label={t('alerts.center.evidence.observed', { defaultValue: 'Observed' })}>
              {typeof observed === 'number' ? observed : t('common.notAvailable')}
            </Descriptions.Item>
            <Descriptions.Item label={t('alerts.center.evidence.expected', { defaultValue: 'Expected' })}>
              {expected}
            </Descriptions.Item>
            <Descriptions.Item label={t('alerts.center.evidence.residual', { defaultValue: 'Residual' })}>
              {typeof residual === 'number' ? residual : t('common.notAvailable')}
            </Descriptions.Item>
            <Descriptions.Item label={t('alerts.center.evidence.sigma', { defaultValue: 'Sigma' })}>
              {sigma}
            </Descriptions.Item>
            <Descriptions.Item label={t('alerts.center.evidence.ci', { defaultValue: 'CI' })} span={2}>
              {typeof lower === 'number' && typeof upper === 'number'
                ? `[${lower}, ${upper}]`
                : t('common.notAvailable')}
            </Descriptions.Item>
          </Descriptions>
          {canRenderCiRange ? (
            <Card size="small" style={{ marginTop: 8 }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text type="secondary">
                  {t('alerts.center.evidence.ciVisualization', {
                    defaultValue: 'Confidence interval visualization'
                  })}
                </Typography.Text>
                <div style={{ position: 'relative', height: 22 }}>
                  <div
                    style={{
                      position: 'absolute',
                      top: 10,
                      left: 0,
                      width: '100%',
                      height: 3,
                      borderRadius: 999,
                      background: '#e2e8f0'
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      top: 8,
                      left: `${toPercentPosition(lower)}%`,
                      width: `${Math.max(
                        2,
                        toPercentPosition(upper) - toPercentPosition(lower)
                      )}%`,
                      height: 7,
                      borderRadius: 999,
                      background: '#93c5fd'
                    }}
                  />
                  <Tooltip title={`${t('alerts.center.evidence.expected', { defaultValue: 'Expected' })}: ${expected}`}>
                    <div
                      style={{
                        position: 'absolute',
                        top: 2,
                        left: `${toPercentPosition(expected)}%`,
                        width: 2,
                        height: 18,
                        background: '#0f172a'
                      }}
                    />
                  </Tooltip>
                  <Tooltip title={`${t('alerts.center.evidence.observed', { defaultValue: 'Observed' })}: ${observed}`}>
                    <div
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: `${toPercentPosition(observed)}%`,
                        width: 2,
                        height: 22,
                        background: '#dc2626'
                      }}
                    />
                  </Tooltip>
                </div>
                <Space size={[8, 8]} wrap>
                  <Tag color="blue">{`CI [${lower.toFixed(3)}, ${upper.toFixed(3)}]`}</Tag>
                  <Tag>{`expected ${expected.toFixed(3)}`}</Tag>
                  <Tag color="red">{`observed ${observed.toFixed(3)}`}</Tag>
                </Space>
              </Space>
            </Card>
          ) : null}
        </>
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
  t,
  colors,
  fontFamily
}: {
  context: Record<string, unknown> | null;
  locale: LocaleCode;
  t: TranslateFn;
  colors: {
    primary: string;
    accent: string;
  };
  fontFamily: string;
}) => {
  const safeContext = context ?? null;
  const window = isRecord(safeContext?.window) ? safeContext.window : null;
  const baseline = isRecord(safeContext?.baseline) ? safeContext.baseline : null;
  const windowNegativeRatio = toNumber(window?.negativeRatio);
  const baselineNegativeRatio = toNumber(baseline?.negativeRatio);
  const ratioTrendOption: EChartsOption = (() => {
    const windowRatio = typeof windowNegativeRatio === 'number' ? windowNegativeRatio * 100 : null;
    const baselineRatio = typeof baselineNegativeRatio === 'number' ? baselineNegativeRatio * 100 : null;
    if (windowRatio === null && baselineRatio === null) {
      return {};
    }
    return {
      tooltip: { trigger: 'axis', valueFormatter: (value) => `${Number(value).toFixed(1)}%` },
      grid: { top: 24, left: 28, right: 20, bottom: 24, containLabel: true },
      xAxis: {
        type: 'category',
        data: [
          t('alerts.center.evidence.window', { defaultValue: 'Window' }),
          t('alerts.center.evidence.baseline', { defaultValue: 'Baseline' })
        ]
      },
      yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
      series: [
        {
          type: 'bar',
          data: [windowRatio ?? 0, baselineRatio ?? 0],
          itemStyle: {
            color: ({ dataIndex }: { dataIndex: number }) =>
              dataIndex === 0 ? colors.accent : colors.primary
          },
          barMaxWidth: 42
        }
      ],
      textStyle: { fontFamily }
    };
  })();

  if (!safeContext) {
    return (
      <Typography.Text type="secondary">
        {t("alerts.center.evidence.empty", { defaultValue: "No evidence available." })}
      </Typography.Text>
    );
  }

  const entityName = toStringValue(safeContext.entityName);
  const entityType = toStringValue(safeContext.entityType);
  const minEntityConfidence = toNumber(safeContext.minEntityConfidence);
  const z = toNumber(safeContext.z);

  const windowStart = toStringValue(window?.start);
  const windowEnd = toStringValue(window?.end);
  const baselineStart = toStringValue(baseline?.start);
  const baselineEnd = toStringValue(baseline?.end);

  const windowMinutes = toNumber(window?.minutes);
  const baselineMinutes = toNumber(baseline?.minutes);

  const windowTotal = toNumber(window?.total);
  const windowNegative = toNumber(window?.negative);
  const baselineTotal = toNumber(baseline?.total);
  const baselineNegative = toNumber(baseline?.negative);

  const evidenceItems = Array.isArray(safeContext.evidence) ? safeContext.evidence : [];

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

      {Object.keys(ratioTrendOption).length > 0 ? (
        <Card size="small">
          <Typography.Text type="secondary">
            {t('alerts.center.evidence.sentimentCompare', {
              defaultValue: 'Negative sentiment ratio comparison'
            })}
          </Typography.Text>
          <DashboardChart option={ratioTrendOption} height={200} />
        </Card>
      ) : null}

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
              const ingestedLabel = t("items.time.ingested", { defaultValue: "Ingested" });
              const formatOptions = {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                timeZoneName: "short"
              } as const;
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
                        <ArticlePublishedTime
                          publishedAt={publishedAt}
                          locale={locale}
                          formatOptions={formatOptions}
                          primaryStrong
                          secondaryStyle={{ fontSize: 12 }}
                        />
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
                {(typeof score === 'number' || typeof confidence === 'number') && (
                  <Progress
                    percent={Math.max(
                      0,
                      Math.min(100, Math.round(((score ?? confidence ?? 0) * 100) / 1))
                    )}
                    size="small"
                    showInfo={false}
                    strokeColor="#f97316"
                  />
                )}
              </Space>
            </List.Item>
          );
        }}
      />
    </Space>
  );
};

const RealtimeSignalEvidence = ({
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

  const source =
    toStringValue(context.source) ??
    toStringValue(context.sourceName) ??
    toStringValue(context.sourceEndpoint) ??
    toStringValue(context.sourceFunction) ??
    toStringValue(context.sourceField);
  const stale = context.stale === true;
  const latestTimestamp = toStringValue(context.latestTimestamp);
  const maxStaleMinutes = toNumber(context.maxStaleMinutes);
  const snapshotFreshness = toStringValue(context.snapshotFreshness);
  const snapshotRetainedPrevious = context.snapshotRetainedPrevious === true;
  const snapshotFreshnessLabel = snapshotFreshness
    ? t(`alerts.center.evidence.realtime.snapshotFreshnessValues.${snapshotFreshness}`, {
        defaultValue: snapshotFreshness
      })
    : undefined;
  const countryCodes = Array.isArray(context.countryCodes)
    ? context.countryCodes
        .map((entry) => toStringValue(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];

  const summaryRows = [
    {
      key: "militaryCount",
      label: t("alerts.center.evidence.realtime.militaryCount", {
        defaultValue: "Military flights"
      }),
      value: toNumber(context.militaryCount)
    },
    {
      key: "currentValidPositionCount",
      label: t("alerts.center.evidence.realtime.currentValidPositionCount", {
        defaultValue: "Current valid positions"
      }),
      value: toNumber(context.currentValidPositionCount)
    },
    {
      key: "snapshotValidPositionCount",
      label: t("alerts.center.evidence.realtime.snapshotValidPositionCount", {
        defaultValue: "Map snapshot positions"
      }),
      value: toNumber(context.snapshotValidPositionCount)
    },
    {
      key: "droppedStalePositionCount",
      label: t("alerts.center.evidence.realtime.droppedStalePositionCount", {
        defaultValue: "Dropped stale positions"
      }),
      value: toNumber(context.droppedStalePositionCount)
    },
    {
      key: "disruptions",
      label: t("alerts.center.evidence.realtime.disruptions", {
        defaultValue: "AIS disruptions"
      }),
      value: toNumber(context.disruptions)
    },
    {
      key: "outages",
      label: t("alerts.center.evidence.realtime.outages", {
        defaultValue: "Internet outages"
      }),
      value: toNumber(context.outages)
    },
    {
      key: "unrestCount",
      label: t("alerts.center.evidence.realtime.unrest", {
        defaultValue: "Unrest events"
      }),
      value: toNumber(context.unrestCount)
    },
    {
      key: "acledCount",
      label: t("alerts.center.evidence.realtime.acled", {
        defaultValue: "ACLED"
      }),
      value: toNumber(context.acledCount)
    },
    {
      key: "gdeltCount",
      label: t("alerts.center.evidence.realtime.gdelt", {
        defaultValue: "GDELT"
      }),
      value: toNumber(context.gdeltCount)
    },
    {
      key: "dedupeReducedBy",
      label: t("alerts.center.evidence.realtime.dedupeReducedBy", {
        defaultValue: "Deduped"
      }),
      value: toNumber(context.dedupeReducedBy)
    },
    {
      key: "defcon",
      label: t("alerts.center.evidence.realtime.defcon", {
        defaultValue: "DEFCON"
      }),
      value: toNumber(context.defcon)
    },
    {
      key: "adjustedScore",
      label: t("alerts.center.evidence.realtime.adjustedScore", {
        defaultValue: "Adjusted score"
      }),
      value: toNumber(context.adjustedScore)
    },
    {
      key: "openLocations",
      label: t("alerts.center.evidence.realtime.openLocations", {
        defaultValue: "Open locations"
      }),
      value: toNumber(context.openLocations)
    },
    {
      key: "activeSpikes",
      label: t("alerts.center.evidence.realtime.activeSpikes", {
        defaultValue: "Active spikes"
      }),
      value: toNumber(context.activeSpikes)
    },
    {
      key: "avgPop",
      label: t("alerts.center.evidence.realtime.avgPop", {
        defaultValue: "Avg pop"
      }),
      value: toNumber(context.avgPop)
    }
  ].filter((entry) => typeof entry.value === "number");

  const tensions = Array.isArray(context.tensions)
    ? context.tensions
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .slice(0, 5)
    : [];
  const leads = Array.isArray(context.leads)
    ? context.leads
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .slice(0, 5)
    : [];
  const spikes = Array.isArray(context.spikes)
    ? context.spikes
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .slice(0, 5)
    : [];
  const hasStructuredEvidence =
    summaryRows.length > 0 ||
    countryCodes.length > 0 ||
    tensions.length > 0 ||
    leads.length > 0 ||
    spikes.length > 0;

  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Space size={[6, 6]} wrap>
        {source ? (
          <Tag color="blue">
            {t("alerts.center.evidence.realtime.source", {
              defaultValue: "Source"
            })}
            : {source}
          </Tag>
        ) : null}
        {stale ? (
          <Tag color="red">
            {t("alerts.center.evidence.realtime.stale", { defaultValue: "Stale snapshot" })}
          </Tag>
        ) : null}
        {snapshotFreshness ? (
          <Tag color={snapshotFreshness === "fresh" ? "green" : snapshotFreshness === "stale" ? "orange" : "default"}>
            {t("alerts.center.evidence.realtime.snapshotFreshness", {
              defaultValue: "Snapshot"
            })}
            : {snapshotFreshnessLabel}
          </Tag>
        ) : null}
        {snapshotRetainedPrevious ? (
          <Tag color="gold">
            {t("alerts.center.evidence.realtime.snapshotRetainedPrevious", {
              defaultValue: "Retained previous snapshot"
            })}
          </Tag>
        ) : null}
        {typeof maxStaleMinutes === "number" ? (
          <Tag>
            {t("alerts.center.evidence.realtime.maxStaleMinutes", {
              defaultValue: "Max stale {{minutes}} min",
              minutes: maxStaleMinutes
            })}
          </Tag>
        ) : null}
      </Space>

      {latestTimestamp ? (
        <Typography.Text type="secondary">
          {t("alerts.center.evidence.realtime.latestTimestamp", {
            defaultValue: "Latest point {{time}}",
            time: formatDateTime(latestTimestamp, locale, {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              timeZoneName: "short"
            })
          })}
        </Typography.Text>
      ) : null}

      {!hasStructuredEvidence ? (
        <Typography.Text type="secondary">
          {t("alerts.center.evidence.realtime.emptyStructured", {
            defaultValue: "No structured realtime evidence fields."
          })}
        </Typography.Text>
      ) : null}

      {summaryRows.length > 0 ? (
        <Descriptions size="small" bordered column={2}>
          {summaryRows.map((entry) => (
            <Descriptions.Item key={entry.key} label={entry.label}>
              {entry.value}
            </Descriptions.Item>
          ))}
        </Descriptions>
      ) : null}

      {countryCodes.length > 0 ? (
        <div>
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.realtime.countryCodes", {
              defaultValue: "Country codes"
            })}
          </Typography.Text>
          <div style={{ marginTop: 6 }}>
            <Space size={[6, 6]} wrap>
              {countryCodes.map((code) => (
                <Tag key={code}>{code}</Tag>
              ))}
            </Space>
          </div>
        </div>
      ) : null}

      {tensions.length > 0 ? (
        <>
          <Divider style={{ margin: "8px 0" }} />
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.realtime.tensions", {
              defaultValue: "Top tensions"
            })}
          </Typography.Text>
          <List
            size="small"
            dataSource={tensions}
            renderItem={(item, index) => {
              const label =
                toStringValue(item.label) ??
                toStringValue(item.id) ??
                `tension-${index + 1}`;
              const score = toNumber(item.score);
              const changePercent = toNumber(item.changePercent);
              const trend = toStringValue(item.trend);
              return (
                <List.Item key={`${label}-${index}`}>
                  <Space size={[8, 8]} wrap>
                    <Typography.Text>{label}</Typography.Text>
                    {typeof score === "number" ? (
                      <Tag color="orange">{`score ${score.toFixed(2)}`}</Tag>
                    ) : null}
                    {typeof changePercent === "number" ? (
                      <Tag>{`${changePercent.toFixed(2)}%`}</Tag>
                    ) : null}
                    {trend ? <Tag color="blue">{trend}</Tag> : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </>
      ) : null}

      {leads.length > 0 ? (
        <>
          <Divider style={{ margin: "8px 0" }} />
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.realtime.leads", {
              defaultValue: "Prediction leads"
            })}
          </Typography.Text>
          <List
            size="small"
            dataSource={leads}
            renderItem={(item, index) => {
              const title =
                toStringValue(item.title) ??
                toStringValue(item.id) ??
                `lead-${index + 1}`;
              const shift = toNumber(item.shift);
              const confidence = toNumber(item.confidence);
              return (
                <List.Item key={`${title}-${index}`}>
                  <Space size={[8, 8]} wrap>
                    <Typography.Text>{title}</Typography.Text>
                    {typeof shift === "number" ? (
                      <Tag color="purple">{`shift ${shift.toFixed(2)}`}</Tag>
                    ) : null}
                    {typeof confidence === "number" ? (
                      <Tag>{`conf ${confidence.toFixed(2)}`}</Tag>
                    ) : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </>
      ) : null}

      {spikes.length > 0 ? (
        <>
          <Divider style={{ margin: "8px 0" }} />
          <Typography.Text type="secondary">
            {t("alerts.center.evidence.realtime.spikes", {
              defaultValue: "Keyword spikes"
            })}
          </Typography.Text>
          <List
            size="small"
            dataSource={spikes}
            renderItem={(item, index) => {
              const term =
                toStringValue(item.term) ??
                toStringValue(item.id) ??
                `spike-${index + 1}`;
              const count = toNumber(item.count);
              const multiplier = toNumber(item.multiplier);
              return (
                <List.Item key={`${term}-${index}`}>
                  <Space size={[8, 8]} wrap>
                    <Typography.Text>{term}</Typography.Text>
                    {typeof count === "number" ? <Tag>{`count ${count}`}</Tag> : null}
                    {typeof multiplier === "number" ? (
                      <Tag color="gold">{`${multiplier.toFixed(2)}x`}</Tag>
                    ) : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </>
      ) : null}
    </Space>
  );
};

const { CheckableTag } = Tag;

const DEFAULT_FILTER_STATE: AlertFilterState = {
  severities: [],
  statuses: [],
  providers: [],
  ruleKeyword: '',
  datePreset: '30d',
  customRangeMs: null
};

const REALTIME_SIGNAL_PROVIDER = AlertMetricProvider.RealtimeSignal;

const PROVIDER_FILTER_OPTIONS = [
  AlertMetricProvider.EconomicAnomaly,
  AlertMetricProvider.EntitySentiment,
  AlertMetricProvider.EntityAssociation,
  AlertMetricProvider.EconomicData,
  AlertMetricProvider.SystemMetric,
  AlertMetricProvider.SystemEvent,
  AlertMetricProvider.PipelineJob,
  AlertMetricProvider.CrawlTask,
  REALTIME_SIGNAL_PROVIDER,
];

const SEVERITY_OPTIONS = ['low', 'medium', 'high'];
const STATUS_OPTIONS = ['delivered', 'pending', 'failed', 'confirmed', 'ignored'];
const MAX_EVENTS_LIMIT = 500;
const CONTEXT_OBJECT_KEYS = [
  { key: 'countryName', labelKey: 'alerts.center.detail.object.country', defaultLabel: 'Country' },
  { key: 'countryCode', labelKey: 'alerts.center.detail.object.countryCode', defaultLabel: 'Country code' },
  { key: 'resource', labelKey: 'alerts.center.detail.object.resource', defaultLabel: 'Resource' },
  { key: 'action', labelKey: 'alerts.center.detail.object.action', defaultLabel: 'Action' },
  { key: 'queueName', labelKey: 'alerts.center.detail.object.queue', defaultLabel: 'Queue' },
  { key: 'sourceId', labelKey: 'alerts.center.detail.object.source', defaultLabel: 'Source' },
  { key: 'createdById', labelKey: 'alerts.center.detail.object.actor', defaultLabel: 'Actor' },
  { key: 'statuses', labelKey: 'alerts.center.detail.object.statuses', defaultLabel: 'Statuses' }
];
type AlertExportScope = 'selected' | 'page';

export function AlertCenterContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const client = useApolloClient();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageAlerts = permissions.includes('alerts.manage');
  const [messageApi, messageContext] = message.useMessage();

  const [eventsLimit, setEventsLimit] = useState(300);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [feedbackNote, setFeedbackNote] = useState<string>('');
  const [bulkNote, setBulkNote] = useState<string>('');
  const [includeRawExport, setIncludeRawExport] = useState<boolean>(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [detailTab, setDetailTab] = useState<string>('overview');
  const [filterState, setFilterState] = useState<AlertFilterState>(DEFAULT_FILTER_STATE);
  const [appliedRuleKeyword, setAppliedRuleKeyword] = useState<string>('');
  const [openFilterPanelKeys, setOpenFilterPanelKeys] = useState<string[]>([]);
  const [listPage, setListPage] = useState<number>(1);
  const [listPageSize, setListPageSize] = useState<number>(30);
  const [exportScope, setExportScope] = useState<AlertExportScope>('selected');
  const [expandMessage, setExpandMessage] = useState<boolean>(false);
  const [expandContext, setExpandContext] = useState<boolean>(false);

  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const eventParam = searchParams.get('eventId');

  const { echartsTheme, colors, fontFamily } = useChartTheme();

  const [loadReplay, { data: replayData, loading: replayLoading, error: replayError }] =
    useAlertEventReplayLazyQuery();

  const {
    data: eventsData,
    loading: eventsLoading,
    refetch: refetchEvents
  } = useAlertEventsQuery({
    variables: { limit: eventsLimit }
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

  const sortedEvents = useMemo(() => {
    const events = eventsData?.alertEvents ?? [];
    return [...events].sort((a, b) => {
      const aTime = new Date(a.triggeredAt).getTime();
      const bTime = new Date(b.triggeredAt).getTime();
      return bTime - aTime;
    });
  }, [eventsData?.alertEvents]);

  useEffect(() => {
    if (!filterState.ruleKeyword.trim()) {
      setAppliedRuleKeyword('');
      return;
    }
    const timer = window.setTimeout(() => {
      setAppliedRuleKeyword(filterState.ruleKeyword);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [filterState.ruleKeyword]);

  const filterStateForQuery = useMemo<AlertFilterState>(
    () => ({
      ...filterState,
      ruleKeyword: appliedRuleKeyword
    }),
    [appliedRuleKeyword, filterState]
  );
  const filterWindow = useMemo(
    () =>
      resolveFilterTimeWindow({
        ...DEFAULT_FILTER_STATE,
        datePreset: filterState.datePreset,
        customRangeMs: filterState.customRangeMs
      }),
    [filterState.customRangeMs, filterState.datePreset]
  );
  const filteredEvents = useMemo(
    () => filterAlertEvents(sortedEvents, filterStateForQuery, filterWindow),
    [filterStateForQuery, filterWindow, sortedEvents]
  );
  const filteredEventIdSet = useMemo(
    () => new Set(filteredEvents.map((event) => event.id)),
    [filteredEvents]
  );
  const selectedRuleId = useMemo(
    () => sortedEvents.find((event) => event.id === selectedEventId)?.ruleId ?? null,
    [selectedEventId, sortedEvents]
  );

  const {
    data: tuningData,
    loading: tuningLoading,
    error: tuningError,
    refetch: refetchTuning
  } = useAlertRuleTuningSuggestionQuery({
    variables: { ruleId: selectedRuleId ?? '', windowDays: 30 },
    skip: !canManageAlerts || !selectedRuleId
  });

  const selectedEvent = useMemo(
    () => sortedEvents.find((event) => event.id === selectedEventId) ?? null,
    [selectedEventId, sortedEvents]
  );

  useEffect(() => {
    const nextSelectedEventId = resolveSelectedEventId({
      eventParam,
      selectedEventId,
      sortedEvents,
      filteredEvents
    });
    if (nextSelectedEventId !== selectedEventId) {
      setSelectedEventId(nextSelectedEventId);
    }
  }, [eventParam, filteredEvents, selectedEventId, sortedEvents]);

  useEffect(() => {
    const existingIds = new Set(sortedEvents.map((event) => event.id));
    setSelectedEventIds((prev) => prev.filter((id) => existingIds.has(id)));
  }, [sortedEvents]);

  useEffect(() => {
    if (!selectedEvent) {
      setFeedbackNote('');
      return;
    }
    const eventContext =
      selectedEvent.context && typeof selectedEvent.context === 'object'
        ? (selectedEvent.context as Record<string, unknown>)
        : null;
    const feedback =
      eventContext?.feedback && typeof eventContext.feedback === 'object' && !Array.isArray(eventContext.feedback)
        ? (eventContext.feedback as Record<string, unknown>)
        : null;
    const note = typeof feedback?.note === 'string' ? feedback.note : '';
    setFeedbackNote(note);
  }, [selectedEvent]);

  useEffect(() => {
    setDetailTab('overview');
    setExpandContext(false);
    setExpandMessage(false);
  }, [selectedEventId]);

  useEffect(() => {
    setListPage(1);
  }, [filterStateForQuery]);

  useEffect(() => {
    if (detailTab !== 'replay' || !selectedEvent) {
      return;
    }
    if (replayData?.alertEventReplay?.eventId === selectedEvent.id) {
      return;
    }
    loadReplay({
      variables: {
        eventId: selectedEvent.id,
        windowDays: 30
      }
    });
  }, [detailTab, loadReplay, replayData?.alertEventReplay?.eventId, selectedEvent]);

  const replay =
    replayData?.alertEventReplay && replayData.alertEventReplay.eventId === selectedEvent?.id
      ? replayData.alertEventReplay
      : null;
  const replayPoints = replay?.points;
  const replayUnit = replay?.unit;

  const handleSelectEvent = (eventId: string) => {
    setSelectedEventId(eventId);
    const next = new URLSearchParams(searchParams.toString());
    next.set('eventId', eventId);
    const nextQuery = next.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  };

  const handleOpenEvent = async (eventId: string) => {
    if (!eventId) {
      return;
    }

    const exists = sortedEvents.some((event) => event.id === eventId);
    if (!exists) {
      const nextLimit = Math.max(eventsLimit, 500);
      setEventsLimit(nextLimit);
      try {
        await refetchEvents({ limit: nextLimit });
      } catch (error) {
        messageApi.error(
          error instanceof Error
            ? error.message
            : t('common.error.unexpected', { defaultValue: 'Unexpected error' })
        );
      }
    }

    handleSelectEvent(eventId);
  };

  const executeStatusUpdate = async (
    eventIds: string[],
    status: 'confirmed' | 'ignored',
    note: string | null
  ) => {
    if (!canManageAlerts || eventIds.length === 0) {
      return 0;
    }

    const uniqueIds = [...new Set(eventIds)];
    const batchSize = 20;
    let successCount = 0;
    let failCount = 0;
    let processed = 0;
    setBatchProgress({ done: 0, total: uniqueIds.length });

    for (let index = 0; index < uniqueIds.length; index += batchSize) {
      const currentBatch = uniqueIds.slice(index, index + batchSize);
      const results = await Promise.allSettled(
        currentBatch.map((eventId) =>
          updateEventStatus({
            variables: {
              input: {
                eventId,
                status,
                note
              }
            }
          })
        )
      );
      successCount += results.filter((result) => result.status === 'fulfilled').length;
      failCount += results.filter((result) => result.status === 'rejected').length;
      processed += currentBatch.length;
      setBatchProgress({ done: processed, total: uniqueIds.length });
    }

    setBatchProgress(null);

    if (successCount > 0) {
      messageApi.success(
        t('alerts.center.batch.updateSuccess', {
          defaultValue: 'Updated {{count}} alerts to {{status}}.',
          count: successCount,
          status
        })
      );
    }
    if (failCount > 0) {
      messageApi.warning(
        t('alerts.center.batch.updatePartial', {
          defaultValue: '{{count}} alerts failed to update.',
          count: failCount
        })
      );
    }

    if (successCount > 0) {
      await refetchEvents();
      if (selectedRuleId && canManageAlerts) {
        await refetchTuning({ ruleId: selectedRuleId, windowDays: 30 });
      }
    }

    return successCount;
  };

  const handleEventStatusUpdate = async (status: 'confirmed' | 'ignored') => {
    if (!selectedEvent || !canManageAlerts) {
      return;
    }
    const note = feedbackNote.trim() ? feedbackNote.trim() : null;
    await executeStatusUpdate([selectedEvent.id], status, note);
  };

  const handleQuickConfirm = async () => {
    if (!selectedEvent || !canManageAlerts) {
      return;
    }
    await executeStatusUpdate([selectedEvent.id], 'confirmed', null);
  };

  const handleBulkUpdate = async (status: 'confirmed' | 'ignored') => {
    if (selectedEventIds.length === 0) {
      return;
    }
    const note = bulkNote.trim() ? bulkNote.trim() : null;
    const updated = await executeStatusUpdate(selectedEventIds, status, note);
    if (updated > 0) {
      setSelectedEventIds([]);
      setBulkNote('');
    }
  };

  const selectedEventIdSet = useMemo(() => new Set(selectedEventIds), [selectedEventIds]);
  const selectedEventsForBatch = useMemo(
    () => sortedEvents.filter((event) => selectedEventIdSet.has(event.id)),
    [selectedEventIdSet, sortedEvents]
  );
  const listPageCount = Math.max(1, Math.ceil(filteredEvents.length / listPageSize));
  const currentPageEvents = useMemo(() => {
    const start = (listPage - 1) * listPageSize;
    return filteredEvents.slice(start, start + listPageSize);
  }, [filteredEvents, listPage, listPageSize]);
  const exportEvents = useMemo(
    () => (exportScope === 'page' ? currentPageEvents : selectedEventsForBatch),
    [currentPageEvents, exportScope, selectedEventsForBatch]
  );

  const handleExportCsv = async () => {
    if (exportEvents.length === 0) {
      return;
    }
    try {
      const rows = buildAlertExportRows(exportEvents, {
        includeContext: includeRawExport,
        includeDeliveries: includeRawExport
      });
      const csv = await buildCsv(rows);
      const filename = `alerts-${formatDateForFilename(new Date())}.csv`;
      downloadCsv({ csv, filename });
      messageApi.success(t('alerts.center.export.success', { defaultValue: 'Export completed.' }));
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t('alerts.center.export.failed', { defaultValue: 'Export failed.' })
      );
    }
  };

  const handleExportJson = () => {
    if (exportEvents.length === 0) {
      return;
    }
    try {
      const filename = `alerts-${formatDateForFilename(new Date())}.json`;
      const payload = JSON.stringify(
        buildAlertExportJson(exportEvents, {
          includeContext: includeRawExport,
          includeDeliveries: includeRawExport
        }),
        null,
        2
      );
      downloadTextFile(payload, filename, 'application/json;charset=utf-8');
      messageApi.success(t('alerts.center.export.success', { defaultValue: 'Export completed.' }));
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t('alerts.center.export.failed', { defaultValue: 'Export failed.' })
      );
    }
  };

  const stats = useMemo(() => buildAlertStats(filteredEvents), [filteredEvents]);
  const trendPoints = useMemo(
    () => buildAlertTrend(filteredEvents, filterWindow),
    [filterWindow, filteredEvents]
  );

  const similarAlerts = useMemo(
    () => buildSimilarAlerts(selectedEvent, sortedEvents, 5),
    [selectedEvent, sortedEvents]
  );
  const ruleTrendAnalysis = useMemo(
    () => buildRuleTrendAnalysis(selectedEvent?.ruleId, sortedEvents, filterWindow),
    [filterWindow, selectedEvent?.ruleId, sortedEvents]
  );

  const selectedIndexInFiltered = filteredEvents.findIndex((event) => event.id === selectedEventId);
  const previousEventId = selectedIndexInFiltered > 0 ? filteredEvents[selectedIndexInFiltered - 1]?.id : null;
  const nextEventId =
    selectedIndexInFiltered >= 0 && selectedIndexInFiltered < filteredEvents.length - 1
      ? filteredEvents[selectedIndexInFiltered + 1]?.id
      : null;

  const customRangeValue = useMemo<[Dayjs, Dayjs] | null>(() => {
    if (!filterState.customRangeMs) {
      return null;
    }
    const [start, end] = filterState.customRangeMs;
    if (typeof start !== 'number' || typeof end !== 'number') {
      return null;
    }
    return [dayjs(start), dayjs(end)] as [Dayjs, Dayjs];
  }, [filterState.customRangeMs]);

  const toggleProviderTag = (provider: AlertMetricProvider, checked: boolean) => {
    setFilterState((prev) => ({
      ...prev,
      providers: checked
        ? [...new Set([...prev.providers, provider])]
        : prev.providers.filter((item) => item !== provider)
    }));
  };

  const toggleTimeTag = (preset: AlertDatePreset, checked: boolean) => {
    if (checked) {
      setFilterState((prev) => ({
        ...prev,
        datePreset: preset,
        customRangeMs: preset === 'custom' ? prev.customRangeMs : null
      }));
      return;
    }
    setFilterState((prev) => ({
      ...prev,
      datePreset: prev.datePreset === preset ? 'today' : prev.datePreset
    }));
  };

  const selectedInFilterCount = useMemo(
    () =>
      selectedEventIds.reduce(
        (count, eventId) => (filteredEventIdSet.has(eventId) ? count + 1 : count),
        0
      ),
    [filteredEventIdSet, selectedEventIds]
  );
  const selectedVisibleCount = useMemo(
    () =>
      currentPageEvents.reduce((count, event) => (selectedEventIdSet.has(event.id) ? count + 1 : count), 0),
    [currentPageEvents, selectedEventIdSet]
  );
  const hiddenSelectedCount = Math.max(selectedEventIds.length - selectedInFilterCount, 0);
  const allVisibleSelected = currentPageEvents.length > 0 && selectedVisibleCount === currentPageEvents.length;

  const handleSelectAllVisible = (checked: boolean) => {
    const visibleIds = currentPageEvents.map((event) => event.id);
    if (checked) {
      setSelectedEventIds((prev) => [...new Set([...prev, ...visibleIds])]);
      return;
    }
    const visibleSet = new Set(visibleIds);
    setSelectedEventIds((prev) => prev.filter((id) => !visibleSet.has(id)));
  };

  const handleToggleEventSelection = (eventId: string, checked: boolean) => {
    setSelectedEventIds((prev) => {
      if (checked) {
        return [...new Set([...prev, eventId])];
      }
      return prev.filter((id) => id !== eventId);
    });
  };

  const handleResetFilters = () => {
    setFilterState(DEFAULT_FILTER_STATE);
  };

  const handleRefresh = async () => {
    await refetchEvents();
    if (canManageAlerts && selectedRuleId) {
      await refetchTuning({ ruleId: selectedRuleId, windowDays: 30 });
    }
  };

  const isLikelySampled = sortedEvents.length >= eventsLimit;
  const canLoadMoreHistory = eventsLimit < MAX_EVENTS_LIMIT;
  const handleLoadMoreEvents = async () => {
    if (!canLoadMoreHistory) {
      return;
    }
    const nextLimit = Math.min(eventsLimit + 200, MAX_EVENTS_LIMIT);
    setEventsLimit(nextLimit);
    await refetchEvents({ limit: nextLimit });
  };

  useEffect(() => {
    if (listPage > listPageCount) {
      setListPage(listPageCount);
    }
  }, [listPage, listPageCount]);

  useEffect(() => {
    if (!selectedEventId) {
      return;
    }
    const index = filteredEvents.findIndex((event) => event.id === selectedEventId);
    if (index < 0) {
      return;
    }
    const targetPage = Math.floor(index / listPageSize) + 1;
    if (targetPage !== listPage) {
      setListPage(targetPage);
    }
  }, [filteredEvents, listPage, listPageSize, selectedEventId]);

  const replayOption = useMemo<EChartsOption>(() => {
    if (!replay || !replayPoints || replayPoints.length === 0) {
      return {};
    }

    const operator = selectedEvent?.operator ?? null;
    const thresholdValue =
      typeof selectedEvent?.thresholdValue === 'number' && Number.isFinite(selectedEvent.thresholdValue)
        ? selectedEvent.thresholdValue
        : null;
    const thresholdLower =
      typeof selectedEvent?.thresholdLower === 'number' && Number.isFinite(selectedEvent.thresholdLower)
        ? selectedEvent.thresholdLower
        : null;
    const thresholdUpper =
      typeof selectedEvent?.thresholdUpper === 'number' && Number.isFinite(selectedEvent.thresholdUpper)
        ? selectedEvent.thresholdUpper
        : null;

    const markLineData: {
      yAxis: number;
      lineStyle?: { type?: 'dashed'; color?: string };
      label?: { formatter?: string };
    }[] = [];
    if (operator && ['gt', 'gte', 'lt', 'lte', 'eq'].includes(operator) && thresholdValue !== null) {
      markLineData.push({
        yAxis: thresholdValue,
        lineStyle: { type: 'dashed', color: colors.accent },
        label: { formatter: `threshold ${thresholdValue}` }
      });
    }
    if (operator && ['outside_range', 'within_range'].includes(operator) && thresholdLower !== null && thresholdUpper !== null) {
      markLineData.push(
        {
          yAxis: thresholdLower,
          lineStyle: { type: 'dashed', color: colors.accent },
          label: { formatter: `lower ${thresholdLower}` }
        },
        {
          yAxis: thresholdUpper,
          lineStyle: { type: 'dashed', color: colors.accent },
          label: { formatter: `upper ${thresholdUpper}` }
        }
      );
    }

    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 20, left: 40, right: 20, bottom: 30, containLabel: true },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', name: replayUnit ?? undefined },
      series: [
        {
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: replayPoints.map((point) => [point.timestamp, point.value]),
          lineStyle: { width: 2, color: colors.primary },
          areaStyle: { opacity: 0.06, color: colors.primary },
          ...(markLineData.length > 0
            ? {
                markLine: {
                  symbol: 'none',
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
  ]);

  const trendOption = useMemo<EChartsOption>(() => {
    if (trendPoints.length === 0) {
      return {};
    }

    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: [
          t('alerts.center.filters.severity.low', { defaultValue: 'Low' }),
          t('alerts.center.filters.severity.medium', { defaultValue: 'Medium' }),
          t('alerts.center.filters.severity.high', { defaultValue: 'High' })
        ]
      },
      grid: { top: 36, left: 26, right: 14, bottom: 30, containLabel: true },
      xAxis: {
        type: 'category',
        data: trendPoints.map((point) => dayjs(point.date).format('MM-DD'))
      },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        {
          name: t('alerts.center.filters.severity.low', { defaultValue: 'Low' }),
          type: 'line',
          smooth: true,
          data: trendPoints.map((point) => point.low),
          lineStyle: { color: '#16a34a' }
        },
        {
          name: t('alerts.center.filters.severity.medium', { defaultValue: 'Medium' }),
          type: 'line',
          smooth: true,
          data: trendPoints.map((point) => point.medium),
          lineStyle: { color: '#ea580c' }
        },
        {
          name: t('alerts.center.filters.severity.high', { defaultValue: 'High' }),
          type: 'line',
          smooth: true,
          data: trendPoints.map((point) => point.high),
          lineStyle: { color: '#dc2626' }
        }
      ],
      textStyle: { fontFamily }
    };
  }, [fontFamily, t, trendPoints]);

  const ruleTrendOption = useMemo<EChartsOption>(() => {
    if (ruleTrendAnalysis.points.length === 0) {
      return {};
    }

    return {
      tooltip: { trigger: 'axis' },
      grid: { top: 30, left: 26, right: 20, bottom: 30, containLabel: true },
      legend: {
        data: [
          t('alerts.center.analysis.triggerFrequency', { defaultValue: 'Trigger frequency' }),
          t('alerts.center.analysis.falsePositiveTrend', { defaultValue: 'False positive rate' })
        ]
      },
      xAxis: {
        type: 'category',
        data: ruleTrendAnalysis.points.map((point) => dayjs(point.date).format('MM-DD'))
      },
      yAxis: [
        { type: 'value', minInterval: 1 },
        { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' } }
      ],
      series: [
        {
          name: t('alerts.center.analysis.triggerFrequency', { defaultValue: 'Trigger frequency' }),
          type: 'bar',
          barMaxWidth: 24,
          data: ruleTrendAnalysis.points.map((point) => point.triggers),
          itemStyle: { color: colors.primary }
        },
        {
          name: t('alerts.center.analysis.falsePositiveTrend', { defaultValue: 'False positive rate' }),
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          data: ruleTrendAnalysis.points.map((point) =>
            typeof point.falsePositiveRate === 'number'
              ? Number((point.falsePositiveRate * 100).toFixed(2))
              : null
          ),
          lineStyle: { color: colors.accent }
        }
      ],
      textStyle: { fontFamily }
    };
  }, [colors.accent, colors.primary, fontFamily, ruleTrendAnalysis.points, t]);

  const trendWindowLabel = useMemo(() => {
    if (filterWindow.startMs === null || filterWindow.endMs === null) {
      return t('alerts.center.trend.followFilters', { defaultValue: 'Following current filters' });
    }
    const startLabel = formatDateTime(filterWindow.startMs, locale, {
      month: '2-digit',
      day: '2-digit'
    });
    const endLabel = formatDateTime(filterWindow.endMs, locale, {
      month: '2-digit',
      day: '2-digit'
    });
    return `${startLabel} - ${endLabel}`;
  }, [filterWindow.endMs, filterWindow.startMs, locale, t]);

  const context =
    selectedEvent?.context && typeof selectedEvent.context === 'object'
      ? (selectedEvent.context as Record<string, unknown>)
      : null;
  const contextEntries = context ? Object.entries(context) : [];
  const objectKeyLabels = useMemo(
    () =>
      CONTEXT_OBJECT_KEYS.map((entry) => ({
        ...entry,
        label: t(entry.labelKey, { defaultValue: entry.defaultLabel })
      })),
    [t]
  );
  const objectEntries = objectKeyLabels
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      value: context?.[entry.key]
    }))
    .filter((entry) => entry.value !== null && entry.value !== undefined && entry.value !== '');

  const excludedContextKeys = new Set([
    ...objectKeyLabels.map((entry) => entry.key),
    'feedback',
    'latest',
    'previous',
    'metricSlug',
    'threshold',
    'lower',
    'upper',
    'changePercent',
    'windowMinutes',
    'sourceName',
    'sourceEndpoint',
    'sourceFunction',
    'sourceDocUrl',
    'sourceField',
    'unit',
    'recordedAt',
    'itemName'
  ]);

  if (selectedEvent?.metricProvider === AlertMetricProvider.EconomicAnomaly) {
    ['observed', 'expected', 'sigma', 'residual', 'score', 'model', 'diagnostics', 'fallback'].forEach((key) =>
      excludedContextKeys.add(key)
    );
  }
  if (selectedEvent?.metricProvider === AlertMetricProvider.EntitySentiment) {
    ['entityName', 'entityType', 'window', 'baseline', 'z', 'minEntityConfidence', 'evidence'].forEach((key) =>
      excludedContextKeys.add(key)
    );
  }
  if (selectedEvent?.metricProvider === AlertMetricProvider.EntityAssociation) {
    ['seed', 'sourceEvent', 'targets', 'minAssociationWeight', 'maxTargets'].forEach((key) =>
      excludedContextKeys.add(key)
    );
  }
  if (selectedEvent?.metricProvider === AlertMetricProvider.RealtimeSignal) {
    [
      'source',
      'stale',
      'latestTimestamp',
      'maxStaleMinutes',
      'countryCodes',
      'militaryCount',
      'disruptions',
      'outages',
      'unrestCount',
      'acledCount',
      'gdeltCount',
      'dedupeReducedBy',
      'defcon',
      'adjustedScore',
      'openLocations',
      'activeSpikes',
      'avgPop',
      'tensions',
      'leads',
      'spikes'
    ].forEach((key) => excludedContextKeys.add(key));
  }

  const additionalContext = contextEntries.filter(([key]) => !excludedContextKeys.has(key));
  const visibleAdditionalContext = expandContext ? additionalContext : additionalContext.slice(0, 6);

  const buildContextSummary = (input: Record<string, unknown> | null) => {
    if (!input) {
      return [];
    }
    return objectKeyLabels
      .map((entry) => ({
        key: entry.key,
        label: entry.label,
        value: input[entry.key]
      }))
      .filter((entry) => entry.value !== null && entry.value !== undefined && entry.value !== '')
      .slice(0, 3);
  };

  const evidenceWindowMinutes = selectedEvent?.changeWindowMin ?? toNumber(context?.windowMinutes);
  const evidenceUnit = toStringValue(context?.unit);
  const evidencePrevious = toNumber(context?.previous);
  const evidenceRecordedAt =
    typeof context?.recordedAt === 'string' || typeof context?.recordedAt === 'number'
      ? context?.recordedAt
      : undefined;
  const evidenceRecordedAtLabel = evidenceRecordedAt
    ? formatDateTime(evidenceRecordedAt, locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
      })
    : '';
  const evidenceSource =
    toStringValue(context?.sourceName) ??
    toStringValue(context?.sourceEndpoint) ??
    toStringValue(context?.sourceFunction) ??
    toStringValue(context?.sourceField) ??
    toStringValue(context?.source) ??
    toStringValue(selectedEvent?.metricSlug);
  const evidenceSourceDoc = toStringValue(context?.sourceDocUrl);

  const feedback =
    context?.feedback && typeof context.feedback === 'object' && !Array.isArray(context.feedback)
      ? (context.feedback as Record<string, unknown>)
      : null;
  const feedbackStatus = toStringValue(feedback?.status);
  const feedbackUpdatedAt =
    typeof feedback?.updatedAt === 'string' || typeof feedback?.updatedAt === 'number'
      ? feedback.updatedAt
      : undefined;
  const feedbackUpdatedAtLabel = feedbackUpdatedAt
    ? formatDateTime(feedbackUpdatedAt, locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
      })
    : '';
  const feedbackUpdatedById = toStringValue(feedback?.updatedById);
  const feedbackStoredNote = typeof feedback?.note === 'string' ? feedback.note : null;

  const reviewStatus =
    feedbackStatus === 'confirmed' || feedbackStatus === 'ignored'
      ? feedbackStatus
      : selectedEvent?.status === 'confirmed' || selectedEvent?.status === 'ignored'
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
    : t('common.notAvailable');

  const metricProviderLabel = (provider: AlertMetricProvider | string | null | undefined) =>
    provider
      ? t(`alerts.metricProviders.${provider}`, { defaultValue: provider })
      : t('common.notAvailable');

  const handleCopyRawContext = async () => {
    if (!context) {
      return;
    }
    try {
      await navigator.clipboard.writeText(safeJsonStringify(context));
      messageApi.success(t('alerts.center.contextCopied', { defaultValue: 'Copied.' }));
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t('alerts.center.contextCopyFailed', { defaultValue: 'Copy failed.' })
      );
    }
  };

  const handleCopyAlertMarkdown = async () => {
    if (!selectedEvent) {
      return;
    }

    const markdownLines = [
      `# ${t('alerts.center.markdown.title', { defaultValue: 'Alert detail' })}`,
      '',
      `- **ID**: ${selectedEvent.id}`,
      `- **${t('alerts.center.detail.triggeredAt', { defaultValue: 'Triggered at' })}**: ${formatDateTime(
        selectedEvent.triggeredAt,
        locale,
        {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short'
        }
      )}`,
      `- **${t('alerts.center.detail.rule', { defaultValue: 'Rule' })}**: ${selectedEvent.ruleName ?? t('common.notAvailable')}`,
      `- **${t('alerts.center.detail.metric', { defaultValue: 'Metric {{metric}}', metric: '' })}**: ${selectedEvent.metricSlug ?? t('common.notAvailable')}`,
      `- **${t('alerts.center.detail.provider', { defaultValue: 'Provider {{provider}}', provider: '' })}**: ${metricProviderLabel(selectedEvent.metricProvider)}`,
      `- **${t('alerts.center.detail.status', { defaultValue: 'Status' })}**: ${selectedEvent.status}`,
      `- **${t('alerts.center.detail.metricValue', { defaultValue: 'Metric value' })}**: ${selectedEvent.metricValue}`,
      `- **${t('alerts.center.detail.threshold', { defaultValue: 'Threshold' })}**: ${thresholdSummary}`,
      '',
      `## ${t('alerts.center.detail.message', { defaultValue: 'Message' })}`,
      selectedEvent.message ?? t('alerts.events.triggered'),
      '',
      `## ${t('alerts.center.detail.context', { defaultValue: 'Context' })}`,
      '```json',
      safeJsonStringify(context ?? {}),
      '```',
      '',
      `## ${t('alerts.center.detail.deliveries', { defaultValue: 'Deliveries' })}`
    ];

    if (selectedEvent.deliveries.length === 0) {
      markdownLines.push(`- ${t('alerts.center.deliveriesEmpty', { defaultValue: 'No delivery records.' })}`);
    } else {
      selectedEvent.deliveries.forEach((delivery) => {
        markdownLines.push(
          `- ${delivery.status} · ${delivery.channelType} · ${delivery.channelName ?? delivery.target ?? t('common.notAvailable')}`
        );
      });
    }

    try {
      await navigator.clipboard.writeText(markdownLines.join('\n'));
      messageApi.success(t('alerts.center.markdown.copied', { defaultValue: 'Copied as Markdown.' }));
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t('alerts.center.contextCopyFailed', { defaultValue: 'Copy failed.' })
      );
    }
  };

  const falsePositivePercent =
    typeof stats.falsePositiveRate === 'number' ? Number((stats.falsePositiveRate * 100).toFixed(1)) : null;

  const detailTabs = selectedEvent
    ? [
        {
          key: 'overview',
          label: t('alerts.center.tabs.overview', { defaultValue: 'Overview' }),
          children: (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <DetailRow label={t('alerts.center.detail.rule', { defaultValue: 'Rule' })}>
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>{selectedEvent.ruleName ?? t('common.notAvailable')}</Typography.Text>
                  <Typography.Text type="secondary">
                    {t('alerts.center.detail.metric', {
                      defaultValue: 'Metric {{metric}}',
                      metric: selectedEvent.metricSlug ?? t('common.notAvailable')
                    })}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {t('alerts.center.detail.provider', {
                      defaultValue: 'Provider {{provider}}',
                      provider: metricProviderLabel(selectedEvent.metricProvider)
                    })}
                  </Typography.Text>
                </Space>
              </DetailRow>
              <DetailRow label={t('alerts.center.detail.threshold', { defaultValue: 'Threshold' })}>
                <Space direction="vertical" size={2}>
                  <Typography.Text>
                    {t('alerts.center.detail.operator', {
                      defaultValue: 'Operator {{operator}}',
                      operator: selectedEvent.operator ?? t('common.notAvailable')
                    })}
                  </Typography.Text>
                  <Typography.Text type="secondary">{thresholdSummary}</Typography.Text>
                  {evidenceWindowMinutes !== null && evidenceWindowMinutes !== undefined ? (
                    <Typography.Text type="secondary">
                      {t('alerts.center.detail.window', {
                        defaultValue: 'Window {{minutes}} min',
                        minutes: evidenceWindowMinutes
                      })}
                    </Typography.Text>
                  ) : null}
                </Space>
              </DetailRow>
              <DetailRow label={t('alerts.center.detail.triggeredAt', { defaultValue: 'Triggered at' })}>
                <Typography.Text>
                  {formatDateTime(selectedEvent.triggeredAt, locale, {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    timeZoneName: 'short'
                  })}
                </Typography.Text>
              </DetailRow>
              <DetailRow label={t('alerts.center.detail.metricValue', { defaultValue: 'Metric value' })}>
                <Space direction="vertical" size={2}>
                  <Space size="small" align="baseline">
                    <Typography.Text strong>{selectedEvent.metricValue}</Typography.Text>
                    {evidenceUnit ? <Typography.Text type="secondary">{evidenceUnit}</Typography.Text> : null}
                    <Typography.Text type="secondary">
                      {t('alerts.center.detail.changePercent', {
                        defaultValue: 'Change {{value}}',
                        value: formatMetricChange(selectedEvent.changePercent, t('common.notAvailable'))
                      })}
                    </Typography.Text>
                  </Space>
                  {evidencePrevious !== undefined ? (
                    <Typography.Text type="secondary">
                      {t('alerts.center.detail.previousValue', {
                        defaultValue: 'Previous {{value}}',
                        value: evidencePrevious
                      })}
                    </Typography.Text>
                  ) : null}
                  {evidenceRecordedAtLabel ? (
                    <Typography.Text type="secondary">
                      {t('alerts.center.detail.recordedAt', {
                        defaultValue: 'Recorded at {{time}}',
                        time: evidenceRecordedAtLabel
                      })}
                    </Typography.Text>
                  ) : null}
                </Space>
              </DetailRow>
              <DetailRow label={t('alerts.center.detail.source', { defaultValue: 'Source' })}>
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
                  <Typography.Text type="secondary">{t('common.notAvailable')}</Typography.Text>
                )}
              </DetailRow>
              <DetailRow label={t('alerts.center.detail.objects', { defaultValue: 'Objects' })}>
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
                    {t('alerts.center.detail.objectsEmpty', { defaultValue: 'No object context.' })}
                  </Typography.Text>
                )}
              </DetailRow>
              <DetailRow label={t('alerts.center.detail.status', { defaultValue: 'Status' })}>
                <Space>
                  <Tag color={severityColor[selectedEvent.severity] ?? 'blue'}>{selectedEvent.severity}</Tag>
                  <Tag>{selectedEvent.status}</Tag>
                </Space>
              </DetailRow>
              <DetailRow label={t('alerts.center.detail.message', { defaultValue: 'Message' })}>
                <Typography.Paragraph
                  style={{ marginBottom: 4 }}
                  ellipsis={expandMessage ? false : { rows: 3 }}
                >
                  {selectedEvent.message ?? t('alerts.events.triggered')}
                </Typography.Paragraph>
                {(selectedEvent.message?.length ?? 0) > 180 ? (
                  <Button type="link" size="small" onClick={() => setExpandMessage((prev) => !prev)}>
                    {expandMessage
                      ? t('alerts.center.actions.collapse', { defaultValue: 'Collapse' })
                      : t('alerts.center.actions.expand', { defaultValue: 'Expand' })}
                  </Button>
                ) : null}
              </DetailRow>
              <DetailRow label={t('alerts.center.detail.context', { defaultValue: 'Context' })}>
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Button size="small" onClick={() => void handleCopyRawContext()} disabled={!context}>
                    {t('alerts.center.detail.copyRawContext', { defaultValue: 'Copy raw' })}
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
                      {t('alerts.center.detail.contextEmpty', { defaultValue: 'No additional context.' })}
                    </Typography.Text>
                  )}
                  {additionalContext.length > 6 ? (
                    <Button type="link" size="small" onClick={() => setExpandContext((prev) => !prev)}>
                      {expandContext
                        ? t('alerts.center.actions.showLessContext', { defaultValue: 'Show less context' })
                        : t('alerts.center.actions.showAllContext', {
                            defaultValue: 'Show all context ({{count}})',
                            count: additionalContext.length
                          })}
                    </Button>
                  ) : null}
                </Space>
              </DetailRow>
            </Space>
          )
        },
        {
          key: 'evidence',
          label: t('alerts.center.tabs.evidence', { defaultValue: 'Evidence' }),
          children: (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <DetailRow label={t('alerts.center.detail.evidence', { defaultValue: 'Evidence' })}>
                {selectedEvent.metricProvider === AlertMetricProvider.EconomicAnomaly ? (
                  <EconomicAnomalyEvidence context={context} locale={locale} t={t} />
                ) : selectedEvent.metricProvider === AlertMetricProvider.EntitySentiment ? (
                  <EntitySentimentEvidence
                    context={context}
                    locale={locale}
                    t={t}
                    colors={{ primary: colors.primary, accent: colors.accent }}
                    fontFamily={fontFamily}
                  />
                ) : selectedEvent.metricProvider === AlertMetricProvider.EntityAssociation ? (
                  <EntityAssociationEvidence
                    context={context}
                    locale={locale}
                    t={t}
                    onOpenEvent={(eventId) => void handleOpenEvent(eventId)}
                  />
                ) : selectedEvent.metricProvider === AlertMetricProvider.RealtimeSignal ? (
                  <RealtimeSignalEvidence context={context} locale={locale} t={t} />
                ) : (
                  <Typography.Text type="secondary">
                    {t('alerts.center.evidence.unsupported', {
                      defaultValue: 'No structured evidence for this provider.'
                    })}
                  </Typography.Text>
                )}
              </DetailRow>

              <Card
                size="small"
                title={t('alerts.center.analysis.similarTitle', { defaultValue: 'Similar alerts' })}
              >
                {similarAlerts.length === 0 ? (
                  <Typography.Text type="secondary">
                    {t('alerts.center.analysis.similarEmpty', {
                      defaultValue: 'No similar alerts in current data window.'
                    })}
                  </Typography.Text>
                ) : (
                  <List
                    size="small"
                    dataSource={similarAlerts}
                    renderItem={(item) => (
                      <List.Item>
                        <Space direction="vertical" size={0} style={{ width: '100%' }}>
                          <Space size="small" wrap>
                            <Button type="link" size="small" onClick={() => handleSelectEvent(item.event.id)}>
                              {item.event.ruleName ?? item.event.id}
                            </Button>
                            <Tag color="blue">
                              {item.reason === 'same_rule'
                                ? t('alerts.center.analysis.sameRule', { defaultValue: 'Same rule' })
                                : t('alerts.center.analysis.sameMetric', { defaultValue: 'Same metric' })}
                            </Tag>
                            <Tag>{item.event.status}</Tag>
                          </Space>
                          <Typography.Text type="secondary">
                            {formatDateTime(item.event.triggeredAt, locale, {
                              year: 'numeric',
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                              timeZoneName: 'short'
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
                title={t('alerts.center.analysis.ruleTrendTitle', {
                  defaultValue: 'Rule frequency and FP trend'
                })}
              >
                <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t('alerts.center.analysis.totalTriggers', { defaultValue: 'Total triggers' })}
                      value={ruleTrendAnalysis.totalTriggers}
                    />
                  </Col>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t('alerts.center.analysis.dailyAverage', { defaultValue: 'Daily average' })}
                      value={Number(ruleTrendAnalysis.averageDailyTriggers.toFixed(2))}
                    />
                  </Col>
                  <Col xs={24} sm={8}>
                    <Statistic
                      title={t('alerts.center.analysis.falsePositiveRate', { defaultValue: 'False positive rate' })}
                      value={
                        typeof ruleTrendAnalysis.falsePositiveRate === 'number'
                          ? Number((ruleTrendAnalysis.falsePositiveRate * 100).toFixed(1))
                          : '--'
                      }
                      suffix={typeof ruleTrendAnalysis.falsePositiveRate === 'number' ? '%' : undefined}
                    />
                  </Col>
                </Row>
                {ruleTrendAnalysis.points.length === 0 ? (
                  <ChartEmptyState
                    className="h-auto py-6"
                    description={t('alerts.center.analysis.ruleTrendEmpty', {
                      defaultValue: 'No rule trend data in current time range.'
                    })}
                  />
                ) : (
                  <DashboardChart option={ruleTrendOption} theme={echartsTheme} height={240} />
                )}
              </Card>
            </Space>
          )
        },
        {
          key: 'replay',
          label: t('alerts.center.tabs.replay', { defaultValue: 'Replay' }),
          children: (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Space size="small" wrap>
                <Button
                  size="small"
                  onClick={() =>
                    selectedEvent
                      ? loadReplay({
                          variables: {
                            eventId: selectedEvent.id,
                            windowDays: 30
                          }
                        })
                      : undefined
                  }
                  loading={replayLoading}
                  disabled={!selectedEvent}
                >
                  {t('alerts.center.detail.openReplay', { defaultValue: 'Open replay' })}
                </Button>
                <Typography.Text type="secondary">
                  {t('alerts.center.detail.replayHint', {
                    defaultValue: 'Shows recent metric history around this alert.'
                  })}
                </Typography.Text>
              </Space>
              {replayLoading ? (
                <div className="flex justify-center py-10">
                  <Spin />
                </div>
              ) : replayError ? (
                <Alert
                  type="error"
                  showIcon
                  message={t('alerts.center.detail.replayError', {
                    defaultValue: 'Failed to load replay.'
                  })}
                  description={replayError.message}
                />
              ) : replay ? (
                replayPoints && replayPoints.length > 0 ? (
                  <DashboardChart option={replayOption} theme={echartsTheme} height={300} />
                ) : (
                  <ChartEmptyState
                    className="h-auto py-8"
                    description={t('alerts.center.detail.replayEmpty', {
                      defaultValue: 'No replay data available for this event.'
                    })}
                  />
                )
              ) : (
                <Alert
                  type="info"
                  showIcon
                  message={t('alerts.center.detail.replayUnsupported', {
                    defaultValue: 'Replay is not available for this provider.'
                  })}
                />
              )}
            </Space>
          )
        },
        {
          key: 'feedback',
          label: t('alerts.center.tabs.feedback', { defaultValue: 'Feedback' }),
          children: (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <DetailRow label={t('alerts.center.detail.feedback', { defaultValue: 'Feedback' })}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space size="small" wrap>
                    {reviewStatus ? (
                      <Tag color={reviewStatus === 'confirmed' ? 'green' : 'default'}>{reviewStatus}</Tag>
                    ) : (
                      <Tag>{t('alerts.center.detail.unreviewed', { defaultValue: 'unreviewed' })}</Tag>
                    )}
                    {feedbackUpdatedAtLabel ? (
                      <Typography.Text type="secondary">
                        {t('alerts.center.detail.feedbackUpdatedAt', {
                          defaultValue: 'Updated {{time}}',
                          time: feedbackUpdatedAtLabel
                        })}
                      </Typography.Text>
                    ) : null}
                    {feedbackUpdatedById ? (
                      <Typography.Text type="secondary">
                        {t('alerts.center.detail.feedbackUpdatedBy', {
                          defaultValue: 'By {{user}}',
                          user: feedbackUpdatedById
                        })}
                      </Typography.Text>
                    ) : null}
                  </Space>

                  {feedbackStoredNote ? (
                    <Typography.Text>{feedbackStoredNote}</Typography.Text>
                  ) : reviewStatus ? (
                    <Typography.Text type="secondary">
                      {t('alerts.center.detail.feedbackEmpty', { defaultValue: 'No feedback note.' })}
                    </Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">
                      {t('alerts.center.detail.feedbackNotReviewed', { defaultValue: 'Not reviewed yet.' })}
                    </Typography.Text>
                  )}

                  {canManageAlerts ? (
                    <>
                      <Input.TextArea
                        id="alerts-feedback-note"
                        name="alertsFeedbackNote"
                        value={feedbackNote}
                        onChange={(event) => setFeedbackNote(event.target.value)}
                        rows={2}
                        placeholder={t('alerts.center.detail.feedbackNotePlaceholder', {
                          defaultValue: 'Optional note (why confirmed/ignored)'
                        })}
                      />
                      <Space wrap>
                        <Button
                          type="primary"
                          size="small"
                          loading={updatingStatus}
                          onClick={() => void handleEventStatusUpdate('confirmed')}
                        >
                          {t('alerts.center.detail.confirm', { defaultValue: 'Confirm' })}
                        </Button>
                        <Button
                          size="small"
                          loading={updatingStatus}
                          onClick={() => void handleEventStatusUpdate('ignored')}
                        >
                          {t('alerts.center.detail.ignore', { defaultValue: 'Ignore' })}
                        </Button>
                        <Button size="small" loading={updatingStatus} onClick={() => void handleQuickConfirm()}>
                          {t('alerts.center.actions.quickConfirm', { defaultValue: 'One-click confirm' })}
                        </Button>
                      </Space>
                    </>
                  ) : (
                    <Typography.Text type="secondary">
                      {t('alerts.center.detail.feedbackAdminOnly', {
                        defaultValue: 'Feedback actions are available to administrators only.'
                      })}
                    </Typography.Text>
                  )}
                </Space>
              </DetailRow>

              <DetailRow label={t('alerts.center.detail.tuning', { defaultValue: 'Tuning suggestion' })}>
                {canManageAlerts ? (
                  tuningLoading ? (
                    <Spin size="small" />
                  ) : tuningError ? (
                    <Typography.Text type="secondary">
                      {t('alerts.center.detail.tuningError', {
                        defaultValue: 'Failed to load tuning suggestion.'
                      })}
                    </Typography.Text>
                  ) : tuningData?.alertRuleTuningSuggestion ? (
                    <Space direction="vertical" size={2}>
                      <Typography.Text type="secondary">
                        {t('alerts.center.detail.tuningStats', {
                          defaultValue:
                            'Reviewed {{reviewed}} · Confirmed {{confirmed}} · Ignored {{ignored}} · FP rate {{rate}}',
                          reviewed: tuningData.alertRuleTuningSuggestion.reviewedEvents,
                          confirmed: tuningData.alertRuleTuningSuggestion.confirmedEvents,
                          ignored: tuningData.alertRuleTuningSuggestion.ignoredEvents,
                          rate:
                            typeof tuningData.alertRuleTuningSuggestion.falsePositiveRate === 'number'
                              ? `${(tuningData.alertRuleTuningSuggestion.falsePositiveRate * 100).toFixed(1)}%`
                              : t('common.notAvailable')
                        })}
                      </Typography.Text>
                      {tuningData.alertRuleTuningSuggestion.message ? (
                        <Typography.Text>{tuningData.alertRuleTuningSuggestion.message}</Typography.Text>
                      ) : (
                        <Typography.Text type="secondary">
                          {t('alerts.center.detail.tuningEmpty', { defaultValue: 'No tuning suggestion.' })}
                        </Typography.Text>
                      )}
                      {typeof tuningData.alertRuleTuningSuggestion.suggestedThresholdValue === 'number' ? (
                        <Typography.Text type="secondary">
                          {t('alerts.center.detail.tuningThreshold', {
                            defaultValue: 'Suggested threshold {{value}}',
                            value: tuningData.alertRuleTuningSuggestion.suggestedThresholdValue
                          })}
                        </Typography.Text>
                      ) : null}
                      {typeof tuningData.alertRuleTuningSuggestion.suggestedThresholdLower === 'number' ||
                      typeof tuningData.alertRuleTuningSuggestion.suggestedThresholdUpper === 'number' ? (
                        <Typography.Text type="secondary">
                          {t('alerts.center.detail.tuningRange', {
                            defaultValue: 'Suggested range {{lower}} - {{upper}}',
                            lower:
                              tuningData.alertRuleTuningSuggestion.suggestedThresholdLower ??
                              t('common.notAvailable'),
                            upper:
                              tuningData.alertRuleTuningSuggestion.suggestedThresholdUpper ??
                              t('common.notAvailable')
                          })}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">{t('common.notAvailable')}</Typography.Text>
                  )
                ) : (
                  <Typography.Text type="secondary">
                    {t('alerts.center.detail.feedbackAdminOnly', {
                      defaultValue: 'Feedback actions are available to administrators only.'
                    })}
                  </Typography.Text>
                )}
              </DetailRow>
            </Space>
          )
        },
        {
          key: 'deliveries',
          label: t('alerts.center.tabs.deliveries', { defaultValue: 'Deliveries' }),
          children: (
            <List
              size="small"
              dataSource={selectedEvent.deliveries}
              locale={{
                emptyText: t('alerts.center.deliveriesEmpty', {
                  defaultValue: 'No delivery records.'
                })
              }}
              renderItem={(delivery) => (
                <List.Item>
                  <Space size="small" wrap>
                    <Tag color={deliveryStatusColor[delivery.status] ?? 'default'}>{delivery.status}</Tag>
                    <Tag>{delivery.channelType}</Tag>
                    {delivery.channelName ? <Typography.Text>{delivery.channelName}</Typography.Text> : null}
                    {!delivery.channelName && delivery.target ? <Typography.Text>{delivery.target}</Typography.Text> : null}
                    {delivery.channelName && delivery.target ? (
                      <Typography.Text type="secondary">{delivery.target}</Typography.Text>
                    ) : null}
                    <Typography.Text type="secondary">
                      {delivery.sentAt
                        ? formatDateTime(delivery.sentAt, locale, {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZoneName: 'short'
                          })
                        : t('common.notAvailable')}
                    </Typography.Text>
                    {delivery.error ? <Typography.Text type="secondary">{delivery.error}</Typography.Text> : null}
                  </Space>
                </List.Item>
              )}
            />
          )
        }
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      {messageContext}

      <Space align="center" size="middle" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t('alerts.center.title', { defaultValue: 'Alert Center' })}
        </Typography.Title>
        <Button size="small" onClick={() => void handleRefresh()}>
          {t('common.refresh')}
        </Button>
      </Space>

      {isLikelySampled ? (
        <Alert
          type="warning"
          showIcon
          message={t('alerts.center.sampleWarning.message', {
            defaultValue:
              'Metrics and trends are based on the latest {{count}} alerts currently loaded.',
            count: eventsLimit
          })}
          description={
            canLoadMoreHistory ? (
              <Button size="small" onClick={() => void handleLoadMoreEvents()} loading={eventsLoading}>
                {t('alerts.center.sampleWarning.loadMore', { defaultValue: 'Load more history' })}
              </Button>
            ) : (
              t('alerts.center.sampleWarning.reachLimit', {
                defaultValue: 'Reached client-side history limit.'
              })
            )
          }
        />
      ) : null}

      <Row gutter={[12, 12]}>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t('alerts.center.stats.total', { defaultValue: 'Total alerts' })}
              value={stats.total}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t('alerts.center.stats.pending', { defaultValue: 'Pending' })}
              value={stats.pending}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t('alerts.center.stats.confirmed', { defaultValue: 'Confirmed' })}
              value={stats.confirmed}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} xl={4}>
          <Card size="small" className="content-card">
            <Statistic
              title={t('alerts.center.stats.ignored', { defaultValue: 'Ignored' })}
              value={stats.ignored}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8} xl={8}>
          <Card size="small" className="content-card">
            <Statistic
              title={t('alerts.center.stats.falsePositiveRate', {
                defaultValue: 'False positive rate'
              })}
              value={falsePositivePercent ?? '--'}
              suffix={falsePositivePercent !== null ? '%' : undefined}
            />
          </Card>
        </Col>
      </Row>

      <Card className="content-card">
        <Collapse
          bordered={false}
          activeKey={openFilterPanelKeys}
          onChange={(keys) => setOpenFilterPanelKeys(Array.isArray(keys) ? keys : keys ? [keys] : [])}
          items={[
            {
              key: 'filters',
              label: t('alerts.center.filters.title', { defaultValue: 'Filters' }),
              children: (
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <Row gutter={[12, 12]}>
                    <Col xs={24} md={12} xl={8}>
                      <Typography.Text type="secondary">
                        {t('alerts.center.filters.severity.label', { defaultValue: 'Severity' })}
                      </Typography.Text>
                      <Select
                        mode="multiple"
                        allowClear
                        style={{ width: '100%' }}
                        value={filterState.severities}
                        onChange={(value) =>
                          setFilterState((prev) => ({
                            ...prev,
                            severities: value
                          }))
                        }
                        options={SEVERITY_OPTIONS.map((severity) => ({
                          value: severity,
                          label: t(`alerts.center.filters.severity.${severity}`, {
                            defaultValue: severity
                          })
                        }))}
                      />
                    </Col>
                    <Col xs={24} md={12} xl={8}>
                      <Typography.Text type="secondary">
                        {t('alerts.center.filters.status.label', { defaultValue: 'Status' })}
                      </Typography.Text>
                      <Select
                        mode="multiple"
                        allowClear
                        style={{ width: '100%' }}
                        value={filterState.statuses}
                        onChange={(value) =>
                          setFilterState((prev) => ({
                            ...prev,
                            statuses: value
                          }))
                        }
                        options={STATUS_OPTIONS.map((status) => ({
                          value: status,
                          label: t(`alerts.center.filters.status.${status}`, {
                            defaultValue: status
                          })
                        }))}
                      />
                    </Col>
                    <Col xs={24} md={12} xl={8}>
                      <Typography.Text type="secondary">
                        {t('alerts.center.filters.provider.label', { defaultValue: 'Metric provider' })}
                      </Typography.Text>
                      <Select
                        mode="multiple"
                        allowClear
                        style={{ width: '100%' }}
                        value={filterState.providers}
                        onChange={(value) =>
                          setFilterState((prev) => ({
                            ...prev,
                            providers: value
                          }))
                        }
                        options={PROVIDER_FILTER_OPTIONS.map((provider) => ({
                          value: provider,
                          label: t(`alerts.metricProviders.${provider}`, {
                            defaultValue: provider
                          })
                        }))}
                      />
                    </Col>
                    <Col xs={24} md={12} xl={12}>
                      <Typography.Text type="secondary">
                        {t('alerts.center.filters.ruleKeyword.label', {
                          defaultValue: 'Rule name search'
                        })}
                      </Typography.Text>
                      <Input
                        allowClear
                        value={filterState.ruleKeyword}
                        onChange={(event) =>
                          setFilterState((prev) => ({
                            ...prev,
                            ruleKeyword: event.target.value
                          }))
                        }
                        placeholder={t('alerts.center.filters.ruleKeyword.placeholder', {
                          defaultValue: 'Search by rule name'
                        })}
                      />
                    </Col>
                    <Col xs={24} md={12} xl={12}>
                      <Typography.Text type="secondary">
                        {t('alerts.center.filters.time.label', { defaultValue: 'Time range' })}
                      </Typography.Text>
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Segmented
                          block
                          options={[
                            {
                              label: t('alerts.center.filters.time.today', { defaultValue: 'Today' }),
                              value: 'today'
                            },
                            {
                              label: t('alerts.center.filters.time.last7Days', {
                                defaultValue: 'Last 7 days'
                              }),
                              value: '7d'
                            },
                            {
                              label: t('alerts.center.filters.time.last30Days', {
                                defaultValue: 'Last 30 days'
                              }),
                              value: '30d'
                            },
                            {
                              label: t('alerts.center.filters.time.custom', { defaultValue: 'Custom' }),
                              value: 'custom'
                            }
                          ]}
                          value={filterState.datePreset}
                          onChange={(value) =>
                            setFilterState((prev) => ({
                              ...prev,
                              datePreset: value as AlertDatePreset,
                              customRangeMs: value === 'custom' ? prev.customRangeMs : null
                            }))
                          }
                        />
                        <DatePicker.RangePicker
                          style={{ width: '100%' }}
                          value={customRangeValue}
                          disabled={filterState.datePreset !== 'custom'}
                          onChange={(values) => {
                            const [start, end] = values ?? [];
                            setFilterState((prev) => ({
                              ...prev,
                              datePreset: 'custom',
                              customRangeMs:
                                start && end ? [start.valueOf(), end.valueOf()] : [null, null]
                            }));
                          }}
                        />
                      </Space>
                    </Col>
                  </Row>

                  <Space wrap>
                    <Button onClick={handleResetFilters}>
                      {t('common.reset', { defaultValue: 'Reset' })}
                    </Button>
                    <Typography.Text type="secondary">
                      {t('alerts.center.filters.resultCount', {
                        defaultValue: '{{count}} / {{total}} alerts',
                        count: filteredEvents.length,
                        total: sortedEvents.length
                      })}
                    </Typography.Text>
                  </Space>
                </Space>
              )
            }
          ]}
        />

        <Divider style={{ margin: '12px 0' }} />

        <Space wrap size={[8, 8]}>
          <Typography.Text type="secondary">
            {t('alerts.center.quickTags.title', { defaultValue: 'Quick filters' })}
          </Typography.Text>
          <CheckableTag
            checked={filterState.providers.includes(AlertMetricProvider.EconomicAnomaly)}
            onChange={(checked) => toggleProviderTag(AlertMetricProvider.EconomicAnomaly, checked)}
          >
            {t('alerts.center.quickTags.economicAnomaly', {
              defaultValue: 'Economic anomaly'
            })}
          </CheckableTag>
          <CheckableTag
            checked={filterState.providers.includes(AlertMetricProvider.EntitySentiment)}
            onChange={(checked) => toggleProviderTag(AlertMetricProvider.EntitySentiment, checked)}
          >
            {t('alerts.center.quickTags.entitySentiment', {
              defaultValue: 'Entity sentiment'
            })}
          </CheckableTag>
          <CheckableTag
            checked={filterState.providers.includes(AlertMetricProvider.EntityAssociation)}
            onChange={(checked) => toggleProviderTag(AlertMetricProvider.EntityAssociation, checked)}
          >
            {t('alerts.center.quickTags.entityAssociation', {
              defaultValue: 'Entity association'
            })}
          </CheckableTag>
          <CheckableTag
            checked={filterState.providers.includes(AlertMetricProvider.RealtimeSignal)}
            onChange={(checked) => toggleProviderTag(AlertMetricProvider.RealtimeSignal, checked)}
          >
            {t('alerts.center.quickTags.realtimeSignal', {
              defaultValue: 'Realtime signal'
            })}
          </CheckableTag>
          <CheckableTag
            checked={filterState.datePreset === '7d'}
            onChange={(checked) => toggleTimeTag('7d', checked)}
          >
            {t('alerts.center.quickTags.last7Days', { defaultValue: 'Last 7 days' })}
          </CheckableTag>
          <CheckableTag
            checked={filterState.datePreset === '30d'}
            onChange={(checked) => toggleTimeTag('30d', checked)}
          >
            {t('alerts.center.quickTags.last30Days', { defaultValue: 'Last 30 days' })}
          </CheckableTag>
        </Space>
      </Card>

      <Card
        className="content-card"
        title={t('alerts.center.trend.title', { defaultValue: 'Alert trend' })}
        extra={<Typography.Text type="secondary">{trendWindowLabel}</Typography.Text>}
      >
        {trendPoints.length === 0 ? (
          <ChartEmptyState
            className="h-auto py-8"
            description={t('alerts.center.trend.empty', {
              defaultValue: 'No trend data in current filter range.'
            })}
          />
        ) : (
          <DashboardChart option={trendOption} theme={echartsTheme} height={280} />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card
            className="content-card"
            title={t('alerts.center.eventsTitle', { defaultValue: 'Trigger History' })}
            extra={
              <Button size="small" onClick={() => void refetchEvents()}>
                {t('common.refresh')}
              </Button>
            }
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <div className="flex w-full flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <Space wrap size={[8, 8]} className="w-full md:w-auto">
                  <Checkbox
                    checked={allVisibleSelected}
                    indeterminate={selectedVisibleCount > 0 && !allVisibleSelected}
                    onChange={(event) => handleSelectAllVisible(event.target.checked)}
                  >
                    {t('alerts.center.batch.selectVisible', { defaultValue: 'Select visible' })}
                  </Checkbox>
                  <Typography.Text type="secondary">
                    {t('alerts.center.batch.selectedCount', {
                      defaultValue: '{{count}} selected',
                      count: selectedEventIds.length
                    })}
                  </Typography.Text>
                  {hiddenSelectedCount > 0 ? (
                    <>
                      <Tag color="gold">
                        {t('alerts.center.batch.hiddenSelected', {
                          defaultValue: '{{count}} selected outside current filters',
                          count: hiddenSelectedCount
                        })}
                      </Tag>
                      <Button
                        type="link"
                        size="small"
                        onClick={() =>
                          setSelectedEventIds((prev) =>
                            prev.filter((id) => filteredEventIdSet.has(id))
                          )
                        }
                      >
                        {t('alerts.center.batch.clearHidden', {
                          defaultValue: 'Clear hidden selection'
                        })}
                      </Button>
                    </>
                  ) : null}
                </Space>

                <Space wrap size={[8, 8]} className="w-full md:w-auto">
                  <Segmented
                    size="small"
                    value={exportScope}
                    onChange={(value) => setExportScope(value as AlertExportScope)}
                    options={[
                      {
                        label: t('alerts.center.export.scopeSelected', {
                          defaultValue: 'Selected alerts'
                        }),
                        value: 'selected'
                      },
                      {
                        label: t('alerts.center.export.scopePage', { defaultValue: 'Current page' }),
                        value: 'page'
                      }
                    ]}
                  />
                  <Typography.Text type="secondary">
                    {t('alerts.center.export.scopeCount', {
                      defaultValue: '{{count}} rows ready',
                      count: exportEvents.length
                    })}
                  </Typography.Text>
                  <Checkbox
                    checked={includeRawExport}
                    onChange={(event) => setIncludeRawExport(event.target.checked)}
                  >
                    {t('alerts.center.export.includeRaw', { defaultValue: 'Include raw context' })}
                  </Checkbox>
                  {canManageAlerts ? (
                    <>
                      <Input
                        size="small"
                        style={{ width: 180 }}
                        value={bulkNote}
                        onChange={(event) => setBulkNote(event.target.value)}
                        placeholder={t('alerts.center.batch.notePlaceholder', {
                          defaultValue: 'Optional batch note'
                        })}
                      />
                      <Button
                        size="small"
                        type="primary"
                        loading={updatingStatus || Boolean(batchProgress)}
                        disabled={selectedEventIds.length === 0}
                        onClick={() => void handleBulkUpdate('confirmed')}
                      >
                        {t('alerts.center.batch.confirm', { defaultValue: 'Batch confirm' })}
                      </Button>
                      <Button
                        size="small"
                        loading={updatingStatus || Boolean(batchProgress)}
                        disabled={selectedEventIds.length === 0}
                        onClick={() => void handleBulkUpdate('ignored')}
                      >
                        {t('alerts.center.batch.ignore', { defaultValue: 'Batch ignore' })}
                      </Button>
                    </>
                  ) : null}

                  <Button size="small" disabled={exportEvents.length === 0} onClick={() => void handleExportCsv()}>
                    {t('alerts.center.export.csv', { defaultValue: 'Export CSV' })}
                  </Button>
                  <Button size="small" disabled={exportEvents.length === 0} onClick={handleExportJson}>
                    {t('alerts.center.export.json', { defaultValue: 'Export JSON' })}
                  </Button>
                </Space>
              </div>

              {batchProgress ? (
                <Progress
                  percent={Math.round((batchProgress.done / Math.max(batchProgress.total, 1)) * 100)}
                  size="small"
                  status="active"
                  format={() =>
                    t('alerts.center.batch.progress', {
                      defaultValue: '{{done}} / {{total}} processed',
                      done: batchProgress.done,
                      total: batchProgress.total
                    })
                  }
                />
              ) : null}

              <List
                loading={eventsLoading}
                dataSource={currentPageEvents}
                locale={{
                  emptyText: (
                    <ChartEmptyState
                      className="h-auto py-6"
                      description={t('alerts.center.emptyEvents', {
                        defaultValue: 'No recent alerts.'
                      })}
                    />
                  )
                }}
                renderItem={(event) => {
                  const isSelected = event.id === selectedEventId;
                  const eventContext =
                    event.context && typeof event.context === 'object'
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
                  const seed = isRecord(eventContext?.seed) ? (eventContext.seed as Record<string, unknown>) : null;

                  const eventEvidenceSource =
                    toStringValue(eventContext?.sourceName) ??
                    toStringValue(eventContext?.sourceEndpoint) ??
                    toStringValue(eventContext?.sourceField) ??
                    toStringValue(eventContext?.sourceFunction) ??
                    toStringValue(eventContext?.source) ??
                    (event.metricProvider === AlertMetricProvider.EconomicAnomaly
                      ? toStringValue(eventContext?.itemName) ?? toStringValue(event.metricSlug)
                      : null) ??
                    (event.metricProvider === AlertMetricProvider.EntitySentiment
                      ? toStringValue(eventContext?.entityName) ?? toStringValue(event.metricSlug)
                      : null) ??
                    (event.metricProvider === AlertMetricProvider.EntityAssociation
                      ? toStringValue(seed?.name) ?? toStringValue(event.metricSlug)
                      : null) ??
                    toStringValue(event.metricSlug);

                  const changeLabel =
                    typeof event.changePercent === 'number'
                      ? `${event.changePercent.toFixed(2)}%`
                      : t('common.notAvailable');

                  const hoverPreview = (
                    <Space direction="vertical" size={4} style={{ maxWidth: 320 }}>
                      <Typography.Text strong>
                        {event.ruleName ?? t('common.notAvailable')}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {t('alerts.events.metrics', {
                          value: event.metricValue,
                          change: changeLabel
                        })}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {t('alerts.events.evidence', {
                          defaultValue: 'Evidence {{source}} · Threshold {{threshold}}',
                          source: eventEvidenceSource ?? t('common.notAvailable'),
                          threshold: eventThresholdSummary
                        })}
                      </Typography.Text>
                    </Space>
                  );

                  return (
                    <List.Item key={event.id}>
                      <div className="flex w-full items-start gap-3">
                        <Checkbox
                          checked={selectedEventIdSet.has(event.id)}
                          onChange={(changeEvent) =>
                            handleToggleEventSelection(event.id, changeEvent.target.checked)
                          }
                          onClick={(changeEvent) => changeEvent.stopPropagation()}
                        />
                        <Popover content={hoverPreview} placement="rightTop">
                          <button
                            type="button"
                            className="w-full text-left"
                            onClick={() => handleSelectEvent(event.id)}
                          >
                            <div
                              className="rounded-lg border p-3 transition-colors"
                              style={{
                                borderColor: isSelected ? '#93c5fd' : '#e2e8f0',
                                background: isSelected ? 'rgba(239,246,255,0.8)' : '#fff'
                              }}
                            >
                              <Space size="small" wrap>
                                <Badge status={eventStatusBadge[event.status] ?? 'default'} />
                                <Tag color={severityColor[event.severity] ?? 'blue'}>{event.severity}</Tag>
                                <Tag>{event.status}</Tag>
                                <Typography.Text>
                                  {formatDateTime(event.triggeredAt, locale, {
                                    year: 'numeric',
                                    month: '2-digit',
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    timeZoneName: 'short'
                                  })}
                                </Typography.Text>
                              </Space>

                              <Space direction="vertical" size={2} style={{ width: '100%', marginTop: 6 }}>
                                <Space size="small" wrap>
                                  <Typography.Text strong>{event.metricValue}</Typography.Text>
                                  <Typography.Text type="secondary">
                                    {t('alerts.events.evidence', {
                                      defaultValue: 'Evidence {{source}} · Threshold {{threshold}}',
                                      source: eventEvidenceSource ?? t('common.notAvailable'),
                                      threshold: eventThresholdSummary
                                    })}
                                  </Typography.Text>
                                </Space>
                                <Typography.Text type="secondary">
                                  {t('alerts.center.eventSummary', {
                                    defaultValue: 'Rule {{rule}} · Metric {{metric}}',
                                    rule: event.ruleName ?? t('common.notAvailable'),
                                    metric: event.metricSlug ?? t('common.notAvailable')
                                  })}
                                </Typography.Text>
                                <Typography.Paragraph
                                  type="secondary"
                                  style={{ marginBottom: 0 }}
                                  ellipsis={{ rows: 2 }}
                                >
                                  {event.message ?? t('alerts.events.triggered')}
                                </Typography.Paragraph>
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
                            </div>
                          </button>
                        </Popover>
                      </div>
                    </List.Item>
                  );
                }}
              />

              {filteredEvents.length > listPageSize ? (
                <Pagination
                  size="small"
                  current={listPage}
                  pageSize={listPageSize}
                  total={filteredEvents.length}
                  showSizeChanger
                  pageSizeOptions={[20, 50, 100]}
                  onChange={(page, pageSize) => {
                    setListPage(page);
                    setListPageSize(pageSize);
                  }}
                  showTotal={(total, range) =>
                    t('alerts.center.batch.pageSummary', {
                      defaultValue: 'Showing {{start}}-{{end}} of {{total}}',
                      start: total === 0 ? 0 : range[0],
                      end: total === 0 ? 0 : range[1],
                      total
                    })
                  }
                />
              ) : null}
            </Space>
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card
            className="content-card"
            title={t('alerts.center.evidenceTitle', { defaultValue: 'Evidence Details' })}
            extra={
              <Space wrap>
                <Button size="small" onClick={() => previousEventId && handleSelectEvent(previousEventId)} disabled={!previousEventId}>
                  {t('alerts.center.actions.previous', { defaultValue: 'Previous' })}
                </Button>
                <Button size="small" onClick={() => nextEventId && handleSelectEvent(nextEventId)} disabled={!nextEventId}>
                  {t('alerts.center.actions.next', { defaultValue: 'Next' })}
                </Button>
                <Button size="small" onClick={() => void handleCopyAlertMarkdown()} disabled={!selectedEvent}>
                  {t('alerts.center.actions.copyMarkdown', { defaultValue: 'Copy Markdown' })}
                </Button>
              </Space>
            }
          >
            {selectedEvent ? (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                {selectedIndexInFiltered === -1 && filteredEvents.length > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={t('alerts.center.actions.filteredOut', {
                      defaultValue: 'Selected event is outside the current filters.'
                    })}
                  />
                ) : null}
                <Tabs activeKey={detailTab} onChange={setDetailTab} items={detailTabs} />
              </Space>
            ) : (
              <ChartEmptyState
                className="h-auto py-6"
                description={t('alerts.center.selectEvent', {
                  defaultValue: 'Select an event to see evidence details.'
                })}
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
