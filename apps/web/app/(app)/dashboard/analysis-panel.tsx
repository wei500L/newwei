"use client";

import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  List,
  Space,
  Typography,
  message,
} from "antd";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type AnomalyAnalysisInput,
  type CorrelationAnalysisInput,
  type SeriesPointInput,
  useAnalysisResultsQuery,
  useRequestAnomalyMutation,
  useRequestCorrelationMutation,
  useAnalysisEventsSubscription,
  type AnalysisResultsQuery,
  type AnalysisEventsSubscription,
} from "@/graphql/generated";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

export function AnalysisPanel() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data, refetch } = useAnalysisResultsQuery({
    variables: { limit: 10 },
  });
  const [liveUpdates, setLiveUpdates] = useState<
    Record<string, AnalysisEventsSubscription["analysisEvents"] & { summaryText: string }>
  >({});
  const [requestCorrelation, { loading: savingCorr }] =
    useRequestCorrelationMutation();
  const [requestAnomaly, { loading: savingAnomaly }] =
    useRequestAnomalyMutation();
  useAnalysisEventsSubscription({
    onData: ({ data }) => {
      const event = data.data?.analysisEvents;
      if (!event) return;
      setLiveUpdates((prev) => {
        const existing = prev[event.id];
        const previousText = existing?.summaryText ?? "";
        const delta = typeof event.summary === "string" ? event.summary : "";
        const summaryText =
          event.status === "running" ? previousText + delta : delta || previousText;
        return {
          ...prev,
          [event.id]: {
            ...event,
            summaryText,
          },
        };
      });
    },
    onError: (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      message.error(t("analysis.streamError", { error: errorMessage }));
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

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title={t("analysis.correlation.title")}>
        <CorrelationForm
          loading={savingCorr}
          onSubmit={async (values) => {
            await requestCorrelation({ variables: { input: values } });
            message.success(t("analysis.correlation.submitted"));
            await refetch();
          }}
        />
      </Card>
      <Card title={t("analysis.anomaly.title")}>
        <AnomalyForm
          loading={savingAnomaly}
          onSubmit={async (values) => {
            await requestAnomaly({ variables: { input: values } });
            message.success(t("analysis.anomaly.submitted"));
            await refetch();
          }}
        />
      </Card>
      <Card title={t("analysis.results.title")}>
        <List<AnalysisResultsQuery["analysisResults"][number]>
          dataSource={results}
          renderItem={(result) => (
            <List.Item>
              <List.Item.Meta
                title={
                  <Space>
                    <Typography.Text strong>{result.type}</Typography.Text>
                    <Typography.Text type="secondary">
                      {formatDateTime(result.createdAt, locale, {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {result.status}
                    </Typography.Text>
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
      </Card>
    </Space>
  );
}

interface CorrelationFormProps {
  onSubmit: (values: CorrelationAnalysisInput) => Promise<void>;
  loading?: boolean;
}

function CorrelationForm({ onSubmit, loading }: CorrelationFormProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm<CorrelationAnalysisInput>();
  return (
    <Form<CorrelationAnalysisInput>
      layout="inline"
      form={form}
      initialValues={{
        indicatorName: t("analysis.correlation.defaults.indicator"),
        changePercent: 0,
        value: 0,
        startDate: dayjs().subtract(30, "day").format("YYYY-MM-DD"),
        endDate: dayjs().format("YYYY-MM-DD"),
        newsSummaries: [],
      }}
      onFinish={onSubmit}
    >
      <Form.Item name="indicatorName" rules={[{ required: true }]}>
        <Input placeholder={t("analysis.correlation.fields.indicator")} />
      </Form.Item>
      <Form.Item name="value" rules={[{ required: true }]}>
        <InputNumber placeholder={t("analysis.correlation.fields.value")} />
      </Form.Item>
      <Form.Item name="changePercent" rules={[{ required: true }]}>
        <InputNumber placeholder={t("analysis.correlation.fields.changePercent")} />
      </Form.Item>
      <Form.Item name="startDate" rules={[{ required: true }]}>
        <Input placeholder={t("analysis.correlation.fields.startDate")} />
      </Form.Item>
      <Form.Item name="endDate" rules={[{ required: true }]}>
        <Input placeholder={t("analysis.correlation.fields.endDate")} />
      </Form.Item>
      <Form.Item name="newsSummaries">
        <Input
          placeholder={t("analysis.correlation.fields.newsSummaries")}
          onChange={(e) =>
            form.setFieldValue(
              "newsSummaries",
              e.target.value
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean),
            )
          }
        />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          {t("common.submit")}
        </Button>
      </Form.Item>
    </Form>
  );
}

interface AnomalyFormValues extends AnomalyAnalysisInput {
  seriesJson: string;
}

interface AnomalyFormProps {
  onSubmit: (values: AnomalyAnalysisInput) => Promise<void>;
  loading?: boolean;
}

function AnomalyForm({ onSubmit, loading }: AnomalyFormProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm<AnomalyFormValues>();
  const parseSeriesJson = (raw?: string) => {
    if (!raw || !raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        message.error(t("analysis.anomaly.errors.seriesArray"));
        return null;
      }
      const normalized = parsed
        .map((item) => {
          if (!item) return null;
          if (typeof item !== "object") {
            return null;
          }
          const record = item as Record<string, unknown>;
          const timestamp = record.timestamp ?? record.time ?? record.date;
          if (timestamp === undefined || timestamp === null) {
            return null;
          }
          const value = typeof record.value === "number" ? record.value : Number(record.value);
          if (!timestamp || Number.isNaN(value)) return null;
          return { timestamp: String(timestamp), value } satisfies SeriesPointInput;
        })
        .filter(
          (point): point is SeriesPointInput =>
            !!point,
        );
      if (!normalized.length) {
        message.warning(t("analysis.anomaly.errors.seriesEmpty"));
      }
      return normalized;
    } catch {
      message.error(t("analysis.anomaly.errors.seriesInvalid"));
      return null;
    }
  };

  return (
    <Form<AnomalyFormValues>
      layout="inline"
      form={form}
      initialValues={{
        metric: t("analysis.anomaly.defaults.metric"),
        timestamp: dayjs().toISOString(),
        value: 0,
        deviationPercent: 0,
        newsList: [],
        policyList: [],
        seriesJson: "",
      }}
      onFinish={async (values) => {
        const series = parseSeriesJson(values.seriesJson);
        if (series === null) return;
        const payload: AnomalyAnalysisInput = {
          metric: values.metric,
          timestamp: values.timestamp,
          value: values.value,
          deviationPercent: values.deviationPercent,
          newsList: values.newsList ?? [],
          policyList: values.policyList ?? [],
          series: series.length ? series : undefined,
        };
        await onSubmit(payload);
      }}
    >
      <Form.Item name="metric" rules={[{ required: true }]}>
        <Input placeholder={t("analysis.anomaly.fields.metric")} />
      </Form.Item>
      <Form.Item name="timestamp" rules={[{ required: true }]}>
        <Input placeholder={t("analysis.anomaly.fields.timestamp")} />
      </Form.Item>
      <Form.Item name="value" rules={[{ required: true }]}>
        <InputNumber placeholder={t("analysis.anomaly.fields.value")} />
      </Form.Item>
      <Form.Item name="deviationPercent" rules={[{ required: true }]}>
        <InputNumber placeholder={t("analysis.anomaly.fields.deviationPercent")} />
      </Form.Item>
      <Form.Item name="newsList">
        <Input
          placeholder={t("analysis.anomaly.fields.newsList")}
          onChange={(e) =>
            form.setFieldValue(
              "newsList",
              e.target.value
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean),
            )
          }
        />
      </Form.Item>
      <Form.Item name="policyList">
        <Input
          placeholder={t("analysis.anomaly.fields.policyList")}
          onChange={(e) =>
            form.setFieldValue(
              "policyList",
              e.target.value
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean),
            )
          }
        />
      </Form.Item>
      <Form.Item name="seriesJson">
        <Input.TextArea
          placeholder={t("analysis.anomaly.fields.seriesJson")}
          autoSize={{ minRows: 2, maxRows: 4 }}
        />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          {t("common.submit")}
        </Button>
      </Form.Item>
    </Form>
  );
}
