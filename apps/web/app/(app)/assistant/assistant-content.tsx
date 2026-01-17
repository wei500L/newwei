"use client";

import { CloseCircleOutlined, RobotOutlined } from "@ant-design/icons";
import { gql, useMutation, useQuery, useSubscription } from "@apollo/client";
import { Alert, Button, Card, Descriptions, Divider, Drawer, Form, Input, InputNumber, List, Select, Space, Tabs, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

type AssistantRunType = "query" | "report" | "forecast";
type AssistantRunStatus = "pending" | "running" | "completed" | "failed";

interface AssistantRun {
  id: string;
  type: AssistantRunType;
  status: AssistantRunStatus;
  summary?: string | null;
  error?: string | null;
  createdAt: string;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
}

interface AssistantRunsQueryData {
  assistantRuns: AssistantRun[];
}

interface AssistantRunsQueryVariables {
  limit?: number | null;
}

interface RequestAssistantQueryData {
  requestAssistantQuery: Pick<AssistantRun, "id" | "type" | "status" | "createdAt">;
}

interface RequestAssistantQueryVariables {
  input: { message: string };
}

interface RequestAssistantReportData {
  requestAssistantReport: Pick<AssistantRun, "id" | "type" | "status" | "createdAt">;
}

interface RequestAssistantReportVariables {
  input: { period: "daily" | "weekly"; topic?: string | null; limit?: number | null };
}

interface RequestAssistantForecastData {
  requestAssistantForecast: Pick<AssistantRun, "id" | "type" | "status" | "createdAt">;
}

interface RequestAssistantForecastVariables {
  input: {
    series: string;
    lookbackDays?: number | null;
    sourceField?: string | null;
    modelKind?: "ets" | "arima" | null;
    seasonalPeriod?: number | null;
    confidenceLevel?: number | null;
  };
}

interface AssistantEventsSubscriptionData {
  assistantEvents: Pick<AssistantRun, "id" | "type" | "status" | "summary" | "error" | "createdAt">;
}

const ASSISTANT_RUNS_QUERY = gql`
  query AssistantRuns($limit: Int) {
    assistantRuns(limit: $limit) {
      id
      type
      status
      summary
      error
      input
      output
      createdAt
    }
  }
`;

const ASSISTANT_EVENTS_SUBSCRIPTION = gql`
  subscription AssistantEvents {
    assistantEvents {
      id
      type
      status
      summary
      error
      createdAt
    }
  }
`;

const REQUEST_ASSISTANT_QUERY_MUTATION = gql`
  mutation RequestAssistantQuery($input: AssistantQueryInput!) {
    requestAssistantQuery(input: $input) {
      id
      type
      status
      createdAt
    }
  }
`;

const REQUEST_ASSISTANT_REPORT_MUTATION = gql`
  mutation RequestAssistantReport($input: AssistantReportInput!) {
    requestAssistantReport(input: $input) {
      id
      type
      status
      createdAt
    }
  }
`;

const REQUEST_ASSISTANT_FORECAST_MUTATION = gql`
  mutation RequestAssistantForecast($input: AssistantForecastInput!) {
    requestAssistantForecast(input: $input) {
      id
      type
      status
      createdAt
    }
  }
`;

const statusColor = (status: AssistantRunStatus): string => {
  switch (status) {
    case "pending":
      return "default";
    case "running":
      return "processing";
    case "completed":
      return "success";
    case "failed":
      return "error";
    default:
      return "default";
  }
};

export function AssistantContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { status } = useSession();
  const authenticated = status === "authenticated";

  const [queryForm] = Form.useForm<{ message: string }>();
  const [reportForm] = Form.useForm<{ period: "daily" | "weekly"; topic?: string; limit?: number }>();
  const [forecastForm] = Form.useForm<{
    series: string;
    lookbackDays?: number;
    sourceField?: string;
    modelKind?: "ets" | "arima";
    seasonalPeriod?: number;
    confidenceLevel?: number;
  }>();

  const completedRunsRef = useRef<Set<string>>(new Set());
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const { data, loading, refetch, error } = useQuery<AssistantRunsQueryData, AssistantRunsQueryVariables>(
    ASSISTANT_RUNS_QUERY,
    {
      variables: { limit: 20 },
      skip: !authenticated,
    }
  );

  const [liveUpdates, setLiveUpdates] = useState<
    Record<string, AssistantEventsSubscriptionData["assistantEvents"] & { summaryText: string }>
  >({});

  useSubscription<AssistantEventsSubscriptionData>(ASSISTANT_EVENTS_SUBSCRIPTION, {
    skip: !authenticated,
    onData: ({ data: subscription }) => {
      const event = subscription.data?.assistantEvents;
      if (!event) return;
      if (event.status === "completed" || event.status === "failed") {
        const seen = completedRunsRef.current;
        if (!seen.has(event.id)) {
          seen.add(event.id);
          void refetch();
        }
      }
      setLiveUpdates((prev) => {
        const existing = prev[event.id];
        const previousText = existing?.summaryText ?? "";
        const delta = typeof event.summary === "string" ? event.summary : "";
        const summaryText = event.status === "running" ? previousText + delta : delta || previousText;
        return {
          ...prev,
          [event.id]: {
            ...event,
            summaryText,
          },
        };
      });
    },
    onError: (err) => {
      const errMessage = err instanceof Error ? err.message : String(err);
      message.error(t("assistant.streamError", { defaultValue: "Assistant stream error: {{error}}", error: errMessage }));
    },
  });

  const [requestAssistantQuery, { loading: querySaving }] = useMutation<
    RequestAssistantQueryData,
    RequestAssistantQueryVariables
  >(REQUEST_ASSISTANT_QUERY_MUTATION);

  const [requestAssistantReport, { loading: reportSaving }] = useMutation<
    RequestAssistantReportData,
    RequestAssistantReportVariables
  >(REQUEST_ASSISTANT_REPORT_MUTATION);

  const [requestAssistantForecast, { loading: forecastSaving }] = useMutation<
    RequestAssistantForecastData,
    RequestAssistantForecastVariables
  >(REQUEST_ASSISTANT_FORECAST_MUTATION);

  const runs = useMemo(() => {
    const base = data?.assistantRuns ?? [];
    const merged = base.map((run) => {
      const live = liveUpdates[run.id];
      if (!live) return run;
      return {
        ...run,
        status: live.status,
        type: live.type,
        createdAt: live.createdAt,
        summary: live.summaryText,
        error: live.error ?? run.error,
      };
    });

    const missing = Object.values(liveUpdates)
      .filter((live) => !base.some((run) => run.id === live.id))
      .map((live) => ({
        id: live.id,
        type: live.type,
        status: live.status,
        createdAt: live.createdAt,
        summary: live.summaryText,
        error: live.error ?? null,
        input: null,
        output: null
      }));

    return [...missing, ...merged].sort(
      (a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf(),
    );
  }, [data?.assistantRuns, liveUpdates]);

  const activeRun = useMemo(() => {
    if (!activeRunId) return null;
    return runs.find((run) => run.id === activeRunId) ?? null;
  }, [activeRunId, runs]);

  const title = t("pages.assistant.title", { defaultValue: "AI Assistant" });
  const subtitle = t("pages.assistant.subtitle", {
    defaultValue: "Natural language analysis powered by your data pipeline."
  });
  const placeholder = t("pages.assistant.placeholder", {
    defaultValue: "Ask a question like: Recent negative news about new energy; or correlation between gold and USD index."
  });

  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  };

  const formatNumber = (value: unknown, maximumFractionDigits = 6): string => {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
  };

  const renderOutputPreview = (run: AssistantRun) => {
    const output = asRecord(run.output);
    if (!output) return null;

    if (run.type === "forecast") {
      const series = asRecord(output.series);
      const model = asRecord(output.model);
      const forecast = asRecord(output.forecast);
      const actual = asRecord(output.actual);
      const errors = asRecord(output.errors);

      const displayName = typeof series?.displayName === "string" ? series.displayName : null;
      const slug = typeof series?.slug === "string" ? series.slug : null;
      const field = typeof series?.field === "string" ? series.field : null;
      const docUrl = typeof series?.docUrl === "string" ? series.docUrl : null;

      const modelKind = typeof model?.kind === "string" ? model.kind : null;
      const modelServiceUsed = typeof output.modelServiceUsed === "boolean" ? output.modelServiceUsed : null;

      const expected = typeof forecast?.expected === "number" ? forecast.expected : null;
      const lower = typeof forecast?.lower === "number" ? forecast.lower : null;
      const upper = typeof forecast?.upper === "number" ? forecast.upper : null;
      const sigma = typeof forecast?.sigma === "number" ? forecast.sigma : null;

      const actualValue = typeof actual?.value === "number" ? actual.value : null;
      const actualTimestamp = typeof actual?.timestamp === "string" ? actual.timestamp : null;

      const err = typeof errors?.error === "number" ? errors.error : null;
      const absErr = typeof errors?.absError === "number" ? errors.absError : null;
      const pctErr = typeof errors?.pctError === "number" ? errors.pctError : null;

      return (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label={t("assistant.preview.series", { defaultValue: "Series" })}>
              {displayName || slug ? (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{displayName ?? slug}</Typography.Text>
                  {slug ? <Typography.Text type="secondary">slug: {slug}</Typography.Text> : null}
                  {field ? <Typography.Text type="secondary">field: {field}</Typography.Text> : null}
                </Space>
              ) : (
                "-"
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.model", { defaultValue: "Model" })}>
              {modelKind ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.modelService", { defaultValue: "Model service" })}>
              {modelServiceUsed === null ? "-" : modelServiceUsed ? "used" : "not used"}
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.actual", { defaultValue: "Actual" })}>
              {actualValue === null ? "-" : formatNumber(actualValue)}
              {actualTimestamp ? <Typography.Text type="secondary"> @ {actualTimestamp}</Typography.Text> : null}
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.forecast", { defaultValue: "Forecast" })}>
              {expected === null ? "-" : formatNumber(expected)}
              {lower !== null && upper !== null ? (
                <Typography.Text type="secondary">
                  {" "}
                  [{formatNumber(lower)}, {formatNumber(upper)}]
                </Typography.Text>
              ) : null}
              {sigma !== null ? <Typography.Text type="secondary"> sigma={formatNumber(sigma)}</Typography.Text> : null}
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.error", { defaultValue: "Error" })}>
              {err === null ? "-" : formatNumber(err)}
              {absErr !== null ? <Typography.Text type="secondary"> abs={formatNumber(absErr)}</Typography.Text> : null}
              {pctErr !== null ? <Typography.Text type="secondary"> pct={(pctErr * 100).toFixed(2)}%</Typography.Text> : null}
            </Descriptions.Item>
          </Descriptions>

          {docUrl ? (
            <Typography.Link href={docUrl} target="_blank" rel="noreferrer">
              {t("assistant.preview.docUrl", { defaultValue: "Source doc" })}
            </Typography.Link>
          ) : null}
        </Space>
      );
    }

    if (run.type === "report") {
      const period = typeof output.period === "string" ? output.period : null;
      const timeWindow = asRecord(output.timeWindow);
      const startDate = typeof timeWindow?.startDate === "string" ? timeWindow.startDate : null;
      const endDate = typeof timeWindow?.endDate === "string" ? timeWindow.endDate : null;
      const stats = asRecord(output.stats);

      const statEntries = stats
        ? Object.entries(stats)
            .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
            .sort((a, b) => (b[1] as number) - (a[1] as number))
        : [];

      return (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label={t("assistant.preview.period", { defaultValue: "Period" })}>
              {period ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.window", { defaultValue: "Time window" })}>
              {startDate && endDate ? `${startDate} ~ ${endDate}` : "-"}
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.stats", { defaultValue: "Stats" })}>
              {statEntries.length > 0 ? (
                <Space wrap size={8}>
                  {statEntries.map(([key, value]) => (
                    <Tag key={key}>
                      {key}:{formatNumber(value, 0)}
                    </Tag>
                  ))}
                </Space>
              ) : (
                "-"
              )}
            </Descriptions.Item>
          </Descriptions>
        </Space>
      );
    }

    if (run.type === "query") {
      const plan = asRecord(output.plan);
      const kind = typeof plan?.kind === "string" ? plan.kind : null;
      const transform = typeof plan?.transform === "string" ? plan.transform : null;
      const lookbackDays = typeof plan?.lookbackDays === "number" ? plan.lookbackDays : null;

      const stats = asRecord(output.stats);
      const n = typeof stats?.n === "number" ? stats.n : null;
      const pearson = typeof stats?.pearson === "number" ? stats.pearson : null;

      if (kind === "correlation_two_series") {
        const seriesA = asRecord(plan?.seriesA);
        const seriesB = asRecord(plan?.seriesB);

        const seriesAInput = typeof seriesA?.input === "string" ? seriesA.input : null;
        const seriesASlug = typeof seriesA?.slug === "string" ? seriesA.slug : null;
        const seriesAField = typeof seriesA?.field === "string" ? seriesA.field : null;

        const seriesBInput = typeof seriesB?.input === "string" ? seriesB.input : null;
        const seriesBSlug = typeof seriesB?.slug === "string" ? seriesB.slug : null;
        const seriesBField = typeof seriesB?.field === "string" ? seriesB.field : null;

        return (
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label={t("assistant.preview.seriesA", { defaultValue: "Series A" })}>
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{seriesASlug ?? seriesAInput ?? "-"}</Typography.Text>
                {seriesAField ? <Typography.Text type="secondary">field: {seriesAField}</Typography.Text> : null}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.seriesB", { defaultValue: "Series B" })}>
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{seriesBSlug ?? seriesBInput ?? "-"}</Typography.Text>
                {seriesBField ? <Typography.Text type="secondary">field: {seriesBField}</Typography.Text> : null}
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.transform", { defaultValue: "Transform" })}>
              {transform ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.lookbackDays", { defaultValue: "Lookback days" })}>
              {lookbackDays === null ? "-" : formatNumber(lookbackDays, 0)}
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.n", { defaultValue: "Data points" })}>
              {n === null ? "-" : formatNumber(n, 0)}
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.pearson", { defaultValue: "Pearson" })}>
              {pearson === null ? "-" : formatNumber(pearson, 4)}
            </Descriptions.Item>
          </Descriptions>
        );
      }

      if (n !== null || pearson !== null) {
        return (
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label={t("assistant.preview.n", { defaultValue: "Data points" })}>
              {n === null ? "-" : formatNumber(n, 0)}
            </Descriptions.Item>
            <Descriptions.Item label={t("assistant.preview.pearson", { defaultValue: "Pearson" })}>
              {pearson === null ? "-" : formatNumber(pearson, 4)}
            </Descriptions.Item>
          </Descriptions>
        );
      }
    }

    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Typography.Text type="secondary">{subtitle}</Typography.Text>
      </Space>

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("common.unexpectedError", { defaultValue: "Unexpected error" })}
          description={error instanceof Error ? error.message : String(error)}
        />
      ) : null}

      <Card>
        <Tabs
          defaultActiveKey="query"
          items={[
            {
              key: "query",
              label: t("assistant.tabs.query", { defaultValue: "Query" }),
              children: (
                <Form
                  form={queryForm}
                  layout="vertical"
                  initialValues={{ message: "" }}
                  onFinish={async (values) => {
                    const messageRaw = values.message ?? "";
                    const messageValue = messageRaw.trim();
                    if (!messageValue) {
                      message.warning(t("assistant.messageRequired", { defaultValue: "Please enter a question." }));
                      return;
                    }

                    try {
                      const res = await requestAssistantQuery({ variables: { input: { message: messageValue } } });
                      const id = res.data?.requestAssistantQuery.id;
                      if (id) {
                        setActiveRunId(id);
                        setDrawerOpen(true);
                      }
                      queryForm.resetFields();
                      await refetch();
                    } catch (err) {
                      const errMessage = err instanceof Error ? err.message : String(err);
                      message.error(
                        t("assistant.requestFailed", { defaultValue: "Request failed: {{error}}", error: errMessage })
                      );
                    }
                  }}
                >
                  <Form.Item
                    name="message"
                    label={
                      <Space size={8}>
                        <RobotOutlined />
                        <span>{t("assistant.askLabel", { defaultValue: "Ask" })}</span>
                      </Space>
                    }
                    rules={[{ required: true }]}
                  >
                    <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} placeholder={placeholder} />
                  </Form.Item>
                  <Form.Item>
                    <Button type="primary" htmlType="submit" loading={querySaving}>
                      {t("assistant.submit", { defaultValue: "Run" })}
                    </Button>
                  </Form.Item>
                </Form>
              ),
            },
            {
              key: "report",
              label: t("assistant.tabs.report", { defaultValue: "Report" }),
              children: (
                <Form
                  form={reportForm}
                  layout="vertical"
                  initialValues={{ period: "daily", topic: "", limit: 40 }}
                  onFinish={async (values) => {
                    const period = values.period === "weekly" ? "weekly" : "daily";
                    const topic = typeof values.topic === "string" ? values.topic.trim() : "";
                    const limit = typeof values.limit === "number" && Number.isFinite(values.limit) ? values.limit : null;

                    try {
                      const res = await requestAssistantReport({
                        variables: { input: { period, topic: topic || null, limit } },
                      });
                      const id = res.data?.requestAssistantReport.id;
                      if (id) {
                        setActiveRunId(id);
                        setDrawerOpen(true);
                      }
                      reportForm.resetFields();
                      reportForm.setFieldsValue({ period: "daily", topic: "", limit: 40 });
                      await refetch();
                    } catch (err) {
                      const errMessage = err instanceof Error ? err.message : String(err);
                      message.error(
                        t("assistant.requestFailed", { defaultValue: "Request failed: {{error}}", error: errMessage })
                      );
                    }
                  }}
                >
                  <Form.Item
                    name="period"
                    label={t("assistant.report.period", { defaultValue: "Period" })}
                    rules={[{ required: true }]}
                  >
                    <Select
                      options={[
                        { value: "daily", label: t("assistant.report.daily", { defaultValue: "Daily" }) },
                        { value: "weekly", label: t("assistant.report.weekly", { defaultValue: "Weekly" }) },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="topic" label={t("assistant.report.topic", { defaultValue: "Topic filter (optional)" })}>
                    <Input placeholder={t("assistant.report.topicPlaceholder", { defaultValue: "e.g. new energy" })} />
                  </Form.Item>
                  <Form.Item name="limit" label={t("assistant.report.limit", { defaultValue: "Max items" })}>
                    <InputNumber min={1} max={100} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item>
                    <Button type="primary" htmlType="submit" loading={reportSaving}>
                      {t("assistant.submit", { defaultValue: "Run" })}
                    </Button>
                  </Form.Item>
                </Form>
              ),
            },
            {
              key: "forecast",
              label: t("assistant.tabs.forecast", { defaultValue: "Forecast" }),
              children: (
                <Form
                  form={forecastForm}
                  layout="vertical"
                  initialValues={{
                    series: "",
                    lookbackDays: 365,
                    sourceField: "",
                    modelKind: "ets",
                    seasonalPeriod: 0,
                    confidenceLevel: 0.95,
                  }}
                  onFinish={async (values) => {
                    const series = typeof values.series === "string" ? values.series.trim() : "";
                    if (!series) {
                      message.warning(t("assistant.forecast.seriesRequired", { defaultValue: "Please enter a series." }));
                      return;
                    }

                    const lookbackDays =
                      typeof values.lookbackDays === "number" && Number.isFinite(values.lookbackDays)
                        ? values.lookbackDays
                        : null;
                    const seasonalPeriod =
                      typeof values.seasonalPeriod === "number" && Number.isFinite(values.seasonalPeriod)
                        ? values.seasonalPeriod
                        : null;
                    const confidenceLevel =
                      typeof values.confidenceLevel === "number" && Number.isFinite(values.confidenceLevel)
                        ? values.confidenceLevel
                        : null;
                    const modelKind = values.modelKind === "arima" ? "arima" : values.modelKind === "ets" ? "ets" : null;
                    const sourceField = typeof values.sourceField === "string" ? values.sourceField.trim() : "";

                    try {
                      const res = await requestAssistantForecast({
                        variables: {
                          input: {
                            series,
                            lookbackDays,
                            sourceField: sourceField || null,
                            modelKind,
                            seasonalPeriod,
                            confidenceLevel,
                          },
                        },
                      });
                      const id = res.data?.requestAssistantForecast.id;
                      if (id) {
                        setActiveRunId(id);
                        setDrawerOpen(true);
                      }
                      forecastForm.resetFields();
                      forecastForm.setFieldsValue({
                        series: "",
                        lookbackDays: 365,
                        sourceField: "",
                        modelKind: "ets",
                        seasonalPeriod: 0,
                        confidenceLevel: 0.95,
                      });
                      await refetch();
                    } catch (err) {
                      const errMessage = err instanceof Error ? err.message : String(err);
                      message.error(
                        t("assistant.requestFailed", { defaultValue: "Request failed: {{error}}", error: errMessage })
                      );
                    }
                  }}
                >
                  <Form.Item
                    name="series"
                    label={t("assistant.forecast.series", { defaultValue: "Economic series (slug or name)" })}
                    rules={[{ required: true }]}
                  >
                    <Input
                      placeholder={t("assistant.forecast.seriesPlaceholder", {
                        defaultValue: "e.g. usd_index_history or economic:usd_index_history:latest",
                      })}
                    />
                  </Form.Item>
                  <Form.Item name="lookbackDays" label={t("assistant.forecast.lookbackDays", { defaultValue: "Lookback days" })}>
                    <InputNumber min={7} max={3650} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item name="modelKind" label={t("assistant.forecast.modelKind", { defaultValue: "Model" })}>
                    <Select
                      options={[
                        { value: "ets", label: t("assistant.forecast.model.ets", { defaultValue: "ETS" }) },
                        { value: "arima", label: t("assistant.forecast.model.arima", { defaultValue: "ARIMA" }) },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="seasonalPeriod" label={t("assistant.forecast.seasonalPeriod", { defaultValue: "Seasonal period" })}>
                    <InputNumber min={0} max={366} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item name="confidenceLevel" label={t("assistant.forecast.confidenceLevel", { defaultValue: "Confidence level" })}>
                    <InputNumber min={0.5} max={0.999} step={0.01} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item name="sourceField" label={t("assistant.forecast.sourceField", { defaultValue: "Source field (optional)" })}>
                    <Input placeholder={t("assistant.forecast.sourceFieldPlaceholder", { defaultValue: "e.g. close or last" })} />
                  </Form.Item>
                  <Form.Item>
                    <Button type="primary" htmlType="submit" loading={forecastSaving}>
                      {t("assistant.submit", { defaultValue: "Run" })}
                    </Button>
                  </Form.Item>
                </Form>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title={t("assistant.historyTitle", { defaultValue: "History" })}
        extra={
          <Button onClick={() => refetch()} loading={loading}>
            {t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
        }
      >
        <List<AssistantRun>
          dataSource={runs}
          locale={{ emptyText: t("assistant.empty", { defaultValue: "No assistant runs yet." }) }}
          renderItem={(run) => (
            <List.Item
              className="cursor-pointer"
              onClick={() => {
                setActiveRunId(run.id);
                setDrawerOpen(true);
              }}
            >
              <List.Item.Meta
                title={
                  <Space size={10} wrap>
                    <Typography.Text strong>{run.type}</Typography.Text>
                    <Tag color={statusColor(run.status)}>{run.status}</Tag>
                    <Typography.Text type="secondary">
                      {formatDateTime(new Date(run.createdAt), locale, {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </Typography.Text>
                  </Space>
                }
                description={
                  run.error ? (
                    <Space direction="vertical" size={4}>
                      <Typography.Text type="danger">
                        <CloseCircleOutlined /> {run.error}
                      </Typography.Text>
                      {run.summary ? (
                        <Typography.Paragraph ellipsis={{ rows: 3 }}>
                          {run.summary}
                        </Typography.Paragraph>
                      ) : null}
                    </Space>
                  ) : (
                    <Typography.Paragraph ellipsis={{ rows: 3 }}>
                      {run.summary ??
                        (run.status === "running"
                          ? t("assistant.generating", { defaultValue: "Generating..." })
                          : t("assistant.pending", { defaultValue: "Pending..." }))}
                    </Typography.Paragraph>
                  )
                }
              />
            </List.Item>
          )}
        />
      </Card>

      <Drawer
        title={t("assistant.detailTitle", { defaultValue: "Run Detail" })}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={720}
      >
        {activeRun ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Space size={10} wrap>
              <Typography.Text strong>{activeRun.type}</Typography.Text>
              <Tag color={statusColor(activeRun.status)}>{activeRun.status}</Tag>
              <Typography.Text type="secondary">
                {formatDateTime(new Date(activeRun.createdAt), locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit"
                })}
              </Typography.Text>
            </Space>

            {activeRun.error ? (
              <Alert type="error" showIcon message={activeRun.error} />
            ) : null}

            <Card size="small" title={t("assistant.detail.summary", { defaultValue: "Summary" })}>
              <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>
                {activeRun.summary ??
                  (activeRun.status === "running"
                    ? t("assistant.generating", { defaultValue: "Generating..." })
                    : t("assistant.pending", { defaultValue: "Pending..." }))}
              </Typography.Paragraph>
            </Card>

            <Card size="small" title={t("assistant.detail.input", { defaultValue: "Input" })}>
              <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(activeRun.input ?? null, null, 2)}</pre>
            </Card>

            <Card size="small" title={t("assistant.detail.output", { defaultValue: "Output" })}>
              {(() => {
                const preview = renderOutputPreview(activeRun);
                if (!preview) {
                  return <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(activeRun.output ?? null, null, 2)}</pre>;
                }
                return (
                  <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                    {preview}
                    <Divider style={{ margin: "12px 0" }} />
                    <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(activeRun.output ?? null, null, 2)}</pre>
                  </Space>
                );
              })()}
            </Card>
          </Space>
        ) : (
          <Typography.Text type="secondary">
            {t("assistant.detail.empty", { defaultValue: "Select a run from the list." })}
          </Typography.Text>
        )}
      </Drawer>
    </div>
  );
}
