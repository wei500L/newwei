"use client";

import { MinusCircleOutlined, PlusOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import {
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  List,
  Select,
  Space,
  Skeleton,
  Tooltip,
  Typography,
} from "antd";
import { useSession } from "next-auth/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import {
  AnalysisType,
  type AnomalyAnalysisInput,
  type CorrelationAnalysisInput,
  useAnalysisResultsQuery,
  useRequestAnomalyMutation,
  useRequestCorrelationMutation,
  useAnalysisEventsSubscription,
  type AnalysisResultsQuery,
  type AnalysisEventsSubscription,
} from "@/graphql/generated";
import { usePendingAction } from "@/hooks/use-pending-action";
import { dashboardNow } from "@/lib/dashboard-time";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { useTimedValueDeduper } from "@/lib/use-realtime-helpers";

const { RangePicker } = DatePicker;
const MAX_TAG_ITEMS = 50;
const MAX_SERIES_POINTS = 200;
const LIVE_UPDATES_LIMIT = 50;
const LIVE_SUMMARY_LIMIT = 4000;
const STREAM_ERROR_TOAST_WINDOW_MS = 30_000;

function getAnalysisTypeLabel(type: AnalysisType): string {
  switch (type) {
    case AnalysisType.Anomaly:
      return "Anomaly";
    case AnalysisType.GeoTransport:
      return "Geo Transport";
    case AnalysisType.Correlation:
    default:
      return "Correlation";
  }
}

function normalizeTags(values?: string[]): string[] {
  return Array.from(
    new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  ).slice(0, MAX_TAG_ITEMS);
}

function normalizeSeries(values?: SeriesRowForm[]): SeriesRowForm[] {
  return (values ?? [])
    .filter(
      (point): point is SeriesRowForm =>
        !!point &&
        typeof point.value === "number" &&
        !Number.isNaN(point.value) &&
        point.timestamp?.isValid?.(),
    )
    .sort((a, b) => a.timestamp.valueOf() - b.timestamp.valueOf())
    .slice(0, MAX_SERIES_POINTS);
}

export function AnalysisPanel() {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const { data: session, status } = useSession();
  const authenticated = status === "authenticated";
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadAnalysis = permissions.includes("analysis.read");
  const canRunAnalysis = permissions.includes("analysis.run");
  const locale = resolveLocale(i18n.language);
  const { data, loading, error, refetch } = useAnalysisResultsQuery({
    variables: { limit: 10 },
    notifyOnNetworkStatusChange: true,
    skip: !authenticated || !canReadAnalysis,
  });
  const [liveUpdates, setLiveUpdates] = useState<
    Record<string, AnalysisEventsSubscription["analysisEvents"] & { summaryText: string }>
  >({});
  const shouldShowStreamError = useTimedValueDeduper(STREAM_ERROR_TOAST_WINDOW_MS);
  const [requestCorrelation, { loading: savingCorr }] =
    useRequestCorrelationMutation();
  const [requestAnomaly, { loading: savingAnomaly }] =
    useRequestAnomalyMutation();
  const { pending: refreshingResults, run: refreshResults } = usePendingAction(
    () => refetch(),
  );
  useAnalysisEventsSubscription({
    skip: !authenticated || !canReadAnalysis,
    onData: ({ data }) => {
      const event = data.data?.analysisEvents;
      if (!event) return;
      setLiveUpdates((prev) => {
        const existing = prev[event.id];
        const previousText = existing?.summaryText ?? "";
        const delta = typeof event.summary === "string" ? event.summary : "";
        const summaryTextRaw =
          event.status === "running" ? previousText + delta : delta || previousText;
        const summaryText =
          summaryTextRaw.length > LIVE_SUMMARY_LIMIT
            ? summaryTextRaw.slice(-LIVE_SUMMARY_LIMIT)
            : summaryTextRaw;
        const nextRecord = {
          ...event,
          summaryText,
        };
        if (
          existing &&
          existing.status === nextRecord.status &&
          existing.type === nextRecord.type &&
          existing.summaryText === nextRecord.summaryText &&
          existing.createdAt === nextRecord.createdAt
        ) {
          return prev;
        }
        const next = {
          ...prev,
          [event.id]: nextRecord,
        };
        const ids = Object.keys(next);
        if (ids.length <= LIVE_UPDATES_LIMIT) {
          return next;
        }
        const keptIds = ids
          .map((id) => ({
            id,
            sortAt: dayjs(next[id]?.createdAt).valueOf() || 0,
          }))
          .sort((a, b) => b.sortAt - a.sortAt)
          .slice(0, LIVE_UPDATES_LIMIT)
          .map((entry) => entry.id);
        return keptIds.reduce<typeof next>((acc, id) => {
          const value = next[id];
          if (value) {
            acc[id] = value;
          }
          return acc;
        }, {});
      });
    },
    onError: (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const toastMessage = t("analysis.streamError", { error: errorMessage });
      if (!shouldShowStreamError(toastMessage)) {
        return;
      }
      message.error(toastMessage);
    },
  });

  const results = useMemo(() => {
    const base = data?.analysisResults ?? [];
    const merged = base.map((result) => {
      const live = liveUpdates[result.id];
      if (!live) return result;
      return {
        ...result,
        status: live.status,
        type: live.type,
        createdAt: live.createdAt,
        summary: live.summaryText,
      };
    });
    const missing = Object.values(liveUpdates)
      .filter((live) => !base.some((result) => result.id === live.id))
      .map((live) => ({
        id: live.id,
        type: live.type,
        status: live.status,
        createdAt: live.createdAt,
        summary: live.summaryText,
      }));
    return [...missing, ...merged].sort(
      (a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf(),
    );
  }, [data?.analysisResults, liveUpdates]);

  if (status === "loading") {
    return <Skeleton active paragraph={{ rows: 4 }} />;
  }

  if (authenticated && !canReadAnalysis) {
    return (
      <ChartEmptyState
        variant="permission"
        title={t("common.accessDenied", { defaultValue: "Access denied" })}
        description={t("common.accessDeniedDescription", {
          defaultValue:
            "You don't have permission to view this data. Contact an administrator if you need access."
        })}
      />
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {authenticated && !canRunAnalysis ? (
        <ChartEmptyState
          presentation="banner"
          variant="permission"
          title={t("common.accessDenied", { defaultValue: "Access denied" })}
          description={t("analysis.runPermissionRequired", {
            defaultValue: "You can view results, but you don't have permission to run new analyses.",
          })}
        />
      ) : null}
      <Card title={t("analysis.correlation.title")}>
        <CorrelationForm
          disabled={!canRunAnalysis}
          loading={savingCorr}
          onSubmit={async (values) => {
            if (!canRunAnalysis) {
              message.warning(t("common.accessDenied", { defaultValue: "Access denied" }));
              return;
            }
            try {
              await requestCorrelation({ variables: { input: values } });
              message.success(t("analysis.correlation.submitted"));
              await refetch();
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              message.error(
                t("analysis.correlation.submitFailed", {
                  defaultValue: "Failed to submit correlation analysis: {{error}}",
                  error: errorMessage,
                }),
              );
            }
          }}
        />
      </Card>
      <Card title={t("analysis.anomaly.title")}>
        <AnomalyForm
          disabled={!canRunAnalysis}
          loading={savingAnomaly}
          onSubmit={async (values) => {
            if (!canRunAnalysis) {
              message.warning(t("common.accessDenied", { defaultValue: "Access denied" }));
              return;
            }
            try {
              await requestAnomaly({ variables: { input: values } });
              message.success(t("analysis.anomaly.submitted"));
              await refetch();
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              message.error(
                t("analysis.anomaly.submitFailed", {
                  defaultValue: "Failed to submit anomaly analysis: {{error}}",
                  error: errorMessage,
                }),
              );
            }
          }}
        />
      </Card>
      <Card title={t("analysis.results.title")}>
        {error ? (
          <ChartEmptyState
            presentation="banner"
            variant="error"
            className="mb-3"
            title={t("analysis.results.loadFailedTitle", { defaultValue: "Failed to load analysis results" })}
            description={error instanceof Error ? error.message : String(error)}
            actionLabel={t("dashboard.actions.retryFetch", {
              defaultValue: "Retry fetch"
            })}
            actionLoading={refreshingResults}
            onAction={() => {
              void refreshResults();
            }}
          />
        ) : null}

        {loading && results.length === 0 ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : results.length === 0 ? (
          <ChartEmptyState
            className="h-auto py-6"
            title={t("analysis.results.emptyTitle", { defaultValue: "No analysis yet" })}
            description={t("analysis.results.emptyDescription", {
              defaultValue:
                "Run a correlation, anomaly, or geo transport analysis to generate results.",
            })}
          />
        ) : (
          <List<AnalysisResultsQuery["analysisResults"][number]>
            rowKey="id"
            loading={loading}
            dataSource={results}
            renderItem={(result) => (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Space>
                      <Typography.Text strong>
                        {getAnalysisTypeLabel(result.type)}
                      </Typography.Text>
                      <Typography.Text type="secondary">
                        {formatDateTime(result.createdAt, locale, {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </Typography.Text>
                      <Typography.Text type="secondary">{result.status}</Typography.Text>
                    </Space>
                  }
                  description={
                    <Typography.Paragraph ellipsis={{ rows: 3 }}>
                      {result.summary ??
                        (result.status === "running"
                          ? t("analysis.results.generating")
                          : t("analysis.results.pending"))}
                    </Typography.Paragraph>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>
    </Space>
  );
}

interface CorrelationFormProps {
  onSubmit: (values: CorrelationAnalysisInput) => Promise<void>;
  loading?: boolean;
  disabled?: boolean;
}

interface CorrelationFormValues {
  indicatorName: string;
  value: number;
  changePercent: number;
  dateRange?: [dayjs.Dayjs, dayjs.Dayjs] | null;
  newsSummaries?: string[];
}

function CorrelationForm({ onSubmit, loading, disabled }: CorrelationFormProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm<CorrelationFormValues>();

  const handleFinish = async (values: CorrelationFormValues) => {
    const [start, end] = values.dateRange ?? [];
    if (!start || !end) {
      form.setFields([
        {
          name: "dateRange",
          errors: [t("analysis.correlation.errors.dateRangeRequired")],
        },
      ]);
      return;
    }
    const payload: CorrelationAnalysisInput = {
      indicatorName: values.indicatorName.trim(),
      value: values.value,
      changePercent: values.changePercent,
      startDate: start.format("YYYY-MM-DD"),
      endDate: end.format("YYYY-MM-DD"),
      newsSummaries: normalizeTags(values.newsSummaries),
    };
    await onSubmit(payload);
  };

  return (
    <Form<CorrelationFormValues>
      layout="vertical"
      form={form}
      disabled={disabled}
      initialValues={{
        changePercent: 0,
        value: 0,
        dateRange: [dashboardNow().subtract(30, "day"), dashboardNow()],
        newsSummaries: [],
      }}
      onFinish={handleFinish}
    >
      <Form.Item
        label={t("analysis.correlation.fields.indicator")}
        name="indicatorName"
        rules={[{ required: true }]}
      >
        <Input placeholder={t("analysis.correlation.defaults.indicator")} />
      </Form.Item>
      <Space style={{ display: "flex" }} align="baseline">
        <Form.Item
          label={t("analysis.correlation.fields.value")}
          name="value"
          rules={[{ required: true }]}
        >
          <InputNumber style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={
            <Space size="small">
              {t("analysis.correlation.fields.changePercent")}
              <Tooltip title={t("analysis.correlation.help.changePercent")}>
                <QuestionCircleOutlined className="text-gray-400 cursor-help" />
              </Tooltip>
            </Space>
          }
          name="changePercent"
          rules={[{ required: true }]}
        >
          <InputNumber style={{ width: "100%" }} />
        </Form.Item>
      </Space>
      <Form.Item
        label={t("analysis.correlation.fields.dateRange")}
        name="dateRange"
        rules={[
          {
            validator: (_, value) =>
              value?.[0] && value?.[1]
                ? Promise.resolve()
                : Promise.reject(
                    new Error(t("analysis.correlation.errors.dateRangeRequired")),
                  ),
          },
        ]}
      >
        <RangePicker style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item
        label={t("analysis.correlation.fields.newsSummaries")}
        name="newsSummaries"
      >
        <Select
          mode="tags"
          style={{ width: "100%" }}
          placeholder={t("analysis.correlation.placeholders.newsSummaries")}
        />
      </Form.Item>
      <Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          loading={loading}
          disabled={disabled}
          block
        >
          {t("common.submit")}
        </Button>
      </Form.Item>
    </Form>
  );
}

interface SeriesRowForm {
  timestamp: dayjs.Dayjs;
  value: number;
}

interface AnomalyFormValues {
  metric: string;
  timestamp: dayjs.Dayjs;
  value: number;
  deviationPercent: number;
  newsList?: string[];
  policyList?: string[];
  series?: SeriesRowForm[];
}

interface AnomalyFormProps {
  onSubmit: (values: AnomalyAnalysisInput) => Promise<void>;
  loading?: boolean;
  disabled?: boolean;
}

function AnomalyForm({ onSubmit, loading, disabled }: AnomalyFormProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm<AnomalyFormValues>();

  const handleFinish = async (values: AnomalyFormValues) => {
    if (!values.timestamp?.isValid?.()) {
      form.setFields([
        {
          name: "timestamp",
          errors: [t("analysis.anomaly.errors.timestampInvalid")],
        },
      ]);
      return;
    }

    const normalizedSeries = normalizeSeries(values.series).map((point) => ({
      timestamp: point.timestamp.toISOString(),
      value: point.value,
    }));

    const payload: AnomalyAnalysisInput = {
      metric: values.metric.trim(),
      timestamp: values.timestamp.toISOString(),
      value: values.value,
      deviationPercent: values.deviationPercent,
      newsList: normalizeTags(values.newsList),
      policyList: normalizeTags(values.policyList),
      series: normalizedSeries.length ? normalizedSeries : undefined,
    };
    await onSubmit(payload);
  };

  return (
    <Form<AnomalyFormValues>
      layout="vertical"
      form={form}
      disabled={disabled}
      initialValues={{
        timestamp: dashboardNow(),
        value: 0,
        deviationPercent: 0,
        newsList: [],
        policyList: [],
        series: [],
      }}
      onFinish={handleFinish}
    >
      <Form.Item
        label={
          <Space size="small">
            {t("analysis.anomaly.fields.metric")}
            <Tooltip title={t("analysis.anomaly.help.metric")}>
              <QuestionCircleOutlined className="text-gray-400 cursor-help" />
            </Tooltip>
          </Space>
        }
        name="metric"
        rules={[{ required: true }]}
      >
        <Input placeholder={t("analysis.anomaly.defaults.metric")} />
      </Form.Item>
      <Space style={{ display: "flex" }} align="baseline">
        <Form.Item
          label={t("analysis.anomaly.fields.timestamp")}
          name="timestamp"
          rules={[{ required: true }]}
        >
          <DatePicker showTime style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("analysis.anomaly.fields.value")}
          name="value"
          rules={[{ required: true }]}
        >
          <InputNumber style={{ width: "100%" }} />
        </Form.Item>
      </Space>
      <Form.Item
        label={
          <Space size="small">
            {t("analysis.anomaly.fields.deviationPercent")}
            <Tooltip title={t("analysis.anomaly.help.deviationPercent")}>
              <QuestionCircleOutlined className="text-gray-400 cursor-help" />
            </Tooltip>
          </Space>
        }
        name="deviationPercent"
        rules={[{ required: true }]}
      >
        <InputNumber style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item
        label={
          <Space size="small">
            {t("analysis.anomaly.fields.newsList")}
            <Tooltip title={t("analysis.anomaly.help.newsList")}>
              <QuestionCircleOutlined className="text-gray-400 cursor-help" />
            </Tooltip>
          </Space>
        }
        name="newsList"
      >
        <Select
          mode="tags"
          style={{ width: "100%" }}
          placeholder={t("analysis.anomaly.placeholders.newsList")}
        />
      </Form.Item>
      <Form.Item
        label={
          <Space size="small">
            {t("analysis.anomaly.fields.policyList")}
            <Tooltip title={t("analysis.anomaly.help.policyList")}>
              <QuestionCircleOutlined className="text-gray-400 cursor-help" />
            </Tooltip>
          </Space>
        }
        name="policyList"
      >
        <Select
          mode="tags"
          style={{ width: "100%" }}
          placeholder={t("analysis.anomaly.placeholders.policyList")}
        />
      </Form.Item>
      <Form.Item
        label={
          <Space size="small">
            {t("analysis.anomaly.fields.series")}
            <Tooltip title={t("analysis.anomaly.help.series")}>
              <QuestionCircleOutlined className="text-gray-400 cursor-help" />
            </Tooltip>
          </Space>
        }
      >
        <Form.List name="series">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }) => (
                <Space
                  key={key}
                  style={{ display: "flex", marginBottom: 8 }}
                  align="baseline"
                >
                  <Form.Item
                    {...restField}
                    name={[name, "timestamp"]}
                    rules={[{ required: true }]}
                    style={{ marginBottom: 0 }}
                  >
                    <DatePicker
                      showTime
                      placeholder={t("analysis.anomaly.placeholders.timestamp")}
                      size="small"
                    />
                  </Form.Item>
                  <Form.Item
                    {...restField}
                    name={[name, "value"]}
                    rules={[{ required: true }]}
                    style={{ marginBottom: 0 }}
                  >
                    <InputNumber
                      placeholder={t("analysis.anomaly.placeholders.value")}
                      size="small"
                    />
                  </Form.Item>
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<MinusCircleOutlined />}
                    onClick={() => remove(name)}
                    aria-label={t("common.remove")}
                  />
                </Space>
              ))}
              <Button
                type="dashed"
                onClick={() => add()}
                block
                icon={<PlusOutlined />}
              >
                {t("analysis.anomaly.actions.addSeriesPoint")}
              </Button>
            </>
          )}
        </Form.List>
      </Form.Item>
      <Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          loading={loading}
          disabled={disabled}
          block
        >
          {t("common.submit")}
        </Button>
      </Form.Item>
    </Form>
  );
}
