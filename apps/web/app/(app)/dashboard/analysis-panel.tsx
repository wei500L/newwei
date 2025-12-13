"use client";

import { useMemo, useState } from "react";
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
import {
  useAnalysisResultsQuery,
  useRequestAnomalyMutation,
  useRequestCorrelationMutation,
  useAnalysisEventsSubscription,
  type AnalysisResultsQuery,
  type AnalysisEventsSubscription,
} from "@/graphql/generated";
export function AnalysisPanel() {
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
      <Card title="Correlation Analysis">
        <CorrelationForm
          loading={savingCorr}
          onSubmit={async (values) => {
            await requestCorrelation({ variables: { input: values } });
            message.success("Correlation analysis submitted");
            await refetch();
          }}
        />
      </Card>
      <Card title="Anomaly Explanation">
        <AnomalyForm
          loading={savingAnomaly}
          onSubmit={async (values) => {
            await requestAnomaly({ variables: { input: values } });
            message.success("Anomaly explanation submitted");
            await refetch();
          }}
        />
      </Card>
      <Card title="Recent Analysis Results">
        <List<AnalysisResultsQuery["analysisResults"][number]>
          dataSource={results}
          renderItem={(result) => (
            <List.Item>
              <List.Item.Meta
                title={
                  <Space>
                    <Typography.Text strong>{result.type}</Typography.Text>
                    <Typography.Text type="secondary">
                      {dayjs(result.createdAt).format("YYYY-MM-DD HH:mm")}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {result.status}
                    </Typography.Text>
                  </Space>
                }
                description={
                  <Typography.Paragraph ellipsis={{ rows: 3 }}>
                    {result.summary ??
                      (result.status === "running" ? "Generating..." : "Pending")}
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

function CorrelationForm({
  onSubmit,
  loading,
}: {
  onSubmit: (values: any) => Promise<void>;
  loading?: boolean;
}) {
  const [form] = Form.useForm();
  return (
    <Form
      layout="inline"
      form={form}
      initialValues={{
        indicatorName: "CPI",
        changePercent: 0,
        value: 0,
        startDate: dayjs().subtract(30, "day").format("YYYY-MM-DD"),
        endDate: dayjs().format("YYYY-MM-DD"),
        newsSummaries: [],
      }}
      onFinish={onSubmit}
    >
      <Form.Item name="indicatorName" rules={[{ required: true }]}>
        <Input placeholder="Indicator" />
      </Form.Item>
      <Form.Item name="value" rules={[{ required: true }]}>
        <InputNumber placeholder="Value" />
      </Form.Item>
      <Form.Item name="changePercent" rules={[{ required: true }]}>
        <InputNumber placeholder="Change %" />
      </Form.Item>
      <Form.Item name="startDate" rules={[{ required: true }]}>
        <Input placeholder="Start date" />
      </Form.Item>
      <Form.Item name="endDate" rules={[{ required: true }]}>
        <Input placeholder="End date" />
      </Form.Item>
      <Form.Item name="newsSummaries">
        <Input
          placeholder="News summaries (comma separated)"
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
          Submit
        </Button>
      </Form.Item>
    </Form>
  );
}

function AnomalyForm({
  onSubmit,
  loading,
}: {
  onSubmit: (values: any) => Promise<void>;
  loading?: boolean;
}) {
  const [form] = Form.useForm();
  const parseSeriesJson = (raw?: string) => {
    if (!raw || !raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        message.error("Series must be a JSON array");
        return null;
      }
      const normalized = parsed
        .map((item) => {
          if (!item) return null;
          const timestamp = (item as any).timestamp ?? (item as any).time ?? (item as any).date;
          const value = Number((item as any).value);
          if (!timestamp || Number.isNaN(value)) return null;
          return { timestamp: String(timestamp), value };
        })
        .filter(
          (point): point is { timestamp: string; value: number } =>
            !!point,
        );
      if (!normalized.length) {
        message.warning("No valid series points parsed");
      }
      return normalized;
    } catch (error) {
      message.error("Series JSON is invalid");
      return null;
    }
  };

  return (
    <Form
      layout="inline"
      form={form}
      initialValues={{
        metric: "指数",
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
        const payload = {
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
        <Input placeholder="Metric" />
      </Form.Item>
      <Form.Item name="timestamp" rules={[{ required: true }]}>
        <Input placeholder="Timestamp ISO" />
      </Form.Item>
      <Form.Item name="value" rules={[{ required: true }]}>
        <InputNumber placeholder="Value" />
      </Form.Item>
      <Form.Item name="deviationPercent" rules={[{ required: true }]}>
        <InputNumber placeholder="Deviation %" />
      </Form.Item>
      <Form.Item name="newsList">
        <Input
          placeholder="News list comma separated"
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
          placeholder="Policy list comma separated"
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
          placeholder='Series JSON e.g. [{"timestamp":"2024-06-01","value":123}]'
          autoSize={{ minRows: 2, maxRows: 4 }}
        />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          Submit
        </Button>
      </Form.Item>
    </Form>
  );
}
