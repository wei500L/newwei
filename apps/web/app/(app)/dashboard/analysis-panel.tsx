"use client";

import { Button, Card, Form, Input, InputNumber, List, Space, Typography, message } from "antd";
import dayjs from "dayjs";
import {
  useAnalysisResultsQuery,
  useRequestAnomalyMutation,
  useRequestCorrelationMutation,
  AnalysisEventsDocument,
  AnalysisEventsSubscription
} from "@/graphql/generated";
import { useEffect } from "react";
import { useApolloClient } from "@apollo/client";

export function AnalysisPanel() {
  const { data, refetch } = useAnalysisResultsQuery({ variables: { limit: 10 } });
  const [requestCorrelation, { loading: savingCorr }] = useRequestCorrelationMutation();
  const [requestAnomaly, { loading: savingAnomaly }] = useRequestAnomalyMutation();
  const client = useApolloClient();

  useEffect(() => {
    const sub = client.subscribe<AnalysisEventsSubscription>({ query: AnalysisEventsDocument }).subscribe({
      next: () => {
        void refetch();
      }
    });
    return () => sub.unsubscribe();
  }, [client, refetch]);

  const results = data?.analysisResults ?? [];

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
        <List
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
                    <Typography.Text type="secondary">{result.status}</Typography.Text>
                  </Space>
                }
                description={<Typography.Paragraph ellipsis={{ rows: 3 }}>{result.summary ?? "Pending"}</Typography.Paragraph>}
              />
            </List.Item>
          )}
        />
      </Card>
    </Space>
  );
}

function CorrelationForm({ onSubmit, loading }: { onSubmit: (values: any) => Promise<void>; loading?: boolean }) {
  const [form] = Form.useForm();
  return (
    <Form
      layout="inline"
      form={form}
      initialValues={{ indicatorName: "CPI", changePercent: 0, value: 0, startDate: dayjs().subtract(30, "day").format("YYYY-MM-DD"), endDate: dayjs().format("YYYY-MM-DD"), newsSummaries: [] }}
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
        <Input placeholder="News summaries (comma separated)" onChange={(e) => form.setFieldValue("newsSummaries", e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean))} />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          Submit
        </Button>
      </Form.Item>
    </Form>
  );
}

function AnomalyForm({ onSubmit, loading }: { onSubmit: (values: any) => Promise<void>; loading?: boolean }) {
  const [form] = Form.useForm();
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
        policyList: []
      }}
      onFinish={onSubmit}
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
        <Input placeholder="News list comma separated" onChange={(e) => form.setFieldValue("newsList", e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean))} />
      </Form.Item>
      <Form.Item name="policyList">
        <Input placeholder="Policy list comma separated" onChange={(e) => form.setFieldValue("policyList", e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean))} />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>
          Submit
        </Button>
      </Form.Item>
    </Form>
  );
}
