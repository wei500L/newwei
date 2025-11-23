"use client";

import {
  AlertMetricProvider,
  AlertOperator,
  AlertSeverity,
  AlertStatus,
  useAlertChannelsQuery,
  useAlertRulesQuery,
  useCreateAlertChannelMutation,
  useUpsertAlertRuleMutation
} from "@/graphql/generated";
import { Button, Divider, Form, Input, InputNumber, Select, Space, Typography, message } from "antd";
import { useMemo } from "react";

const operatorOptions = Object.values(AlertOperator).map((op) => ({ label: op, value: op }));
const severityOptions = Object.values(AlertSeverity).map((s) => ({ label: s, value: s }));
const statusOptions = Object.values(AlertStatus).map((s) => ({ label: s, value: s }));
const metricProviderOptions = Object.values(AlertMetricProvider).map((provider) => ({ label: provider, value: provider }));
const pipelineStatusOptions = ["pending", "queued", "running", "completed", "failed", "delayed"].map((status) => ({
  label: status,
  value: status
}));
const crawlStatusOptions = ["pending", "queued", "running", "completed", "failed", "paused"].map((status) => ({
  label: status,
  value: status
}));
const systemMetricSlugs = [
  "system.memory.usage_pct",
  "system.load.1m",
  "system.uptime.seconds",
  "custom.manual"
].map((slug) => ({ label: slug, value: slug }));

export function AlertConfigForm() {
  const { data, refetch } = useAlertRulesQuery();
  const { data: channelsData, refetch: refetchChannels } = useAlertChannelsQuery();
  const [upsertRule, { loading: savingRule }] = useUpsertAlertRuleMutation();
  const [createChannel, { loading: creatingChannel }] = useCreateAlertChannelMutation();

  const existingRule = useMemo(() => data?.alertRules?.[0], [data]);
  const [form] = Form.useForm();
  const [channelForm] = Form.useForm();

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="large">
      <div>
        <Typography.Title level={5}>Alert Rule Configuration</Typography.Title>
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            id: existingRule?.id,
            name: existingRule?.name ?? "Price spike",
            metricProvider: existingRule?.metricProvider ?? AlertMetricProvider.EconomicData,
            metricSlug:
              existingRule?.metricSlug ??
              (existingRule?.metricProvider === AlertMetricProvider.SystemMetric
                ? "system.memory.usage_pct"
                : existingRule?.metricProvider === AlertMetricProvider.PipelineJob
                  ? "pipeline_job"
                  : existingRule?.metricProvider === AlertMetricProvider.CrawlTask
                    ? "crawl_task"
                    : "usd_index_history"),
            pipelineStatuses: existingRule?.metadata?.statuses ?? ["failed"],
            pipelineQueueName: existingRule?.metadata?.queueName,
            pipelineSourceId: existingRule?.metadata?.sourceId,
            crawlStatuses: existingRule?.metadata?.statuses ?? ["failed"],
            crawlCreatedById: existingRule?.metadata?.createdById,
            systemCurrentValue: existingRule?.metadata?.currentValue,
            operator: existingRule?.operator ?? AlertOperator.Gt,
            thresholdValue: existingRule?.thresholdValue ?? 100,
            thresholdLower: existingRule?.thresholdLower ?? undefined,
            thresholdUpper: existingRule?.thresholdUpper ?? undefined,
            severity: existingRule?.severity ?? AlertSeverity.Medium,
            status: existingRule?.status ?? AlertStatus.Active,
            cooldownSeconds: existingRule?.cooldownSeconds ?? 3600,
            checkIntervalSec: existingRule?.checkIntervalSec ?? 300,
            channelIds: existingRule?.channels?.map((c) => c.id) ?? []
          }}
          onFinish={async (values) => {
            if (values.metricProvider === AlertMetricProvider.PipelineJob && (!values.pipelineStatuses || !values.pipelineStatuses.length)) {
              message.error("Select at least one pipeline job status");
              return;
            }
            if (values.metricProvider === AlertMetricProvider.CrawlTask && (!values.crawlStatuses || !values.crawlStatuses.length)) {
              message.error("Select at least one crawl task status");
              return;
            }
            if (values.metricProvider === AlertMetricProvider.SystemMetric && !values.metricSlug) {
              message.error("Choose a system metric slug");
              return;
            }
            await upsertRule({
              variables: {
                input: {
                    id: values.id ?? undefined,
                    name: values.name,
                    metricProvider: values.metricProvider,
                    metricSlug: values.metricSlug,
                    operator: values.operator,
                    thresholdValue: values.thresholdValue ?? undefined,
                    thresholdLower: values.thresholdLower ?? undefined,
                    thresholdUpper: values.thresholdUpper ?? undefined,
                    severity: values.severity,
                    status: values.status,
                    cooldownSeconds: values.cooldownSeconds,
                    checkIntervalSec: values.checkIntervalSec,
                    metadata:
                      values.metricProvider === AlertMetricProvider.PipelineJob
                        ? {
                            statuses: values.pipelineStatuses,
                            queueName: values.pipelineQueueName,
                            sourceId: values.pipelineSourceId
                          }
                        : values.metricProvider === AlertMetricProvider.CrawlTask
                          ? {
                              statuses: values.crawlStatuses,
                              createdById: values.crawlCreatedById
                            }
                          : values.metricProvider === AlertMetricProvider.SystemMetric
                            ? {
                                currentValue: values.systemCurrentValue
                              }
                            : undefined,
                    channelIds: values.channelIds
                  }
                }
              });
            await Promise.all([refetch(), refetchChannels()]);
            message.success("Alert rule saved");
          }}
        >
          <Form.Item name="id" hidden>
            <Input />
          </Form.Item>
          <Form.Item label="Name" name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Metric provider" name="metricProvider" rules={[{ required: true }]}>
            <Select
              options={metricProviderOptions}
              onChange={(provider) => {
                if (provider === AlertMetricProvider.EconomicData) {
                  form.setFieldsValue({ metricSlug: "usd_index_history" });
                } else if (provider === AlertMetricProvider.PipelineJob) {
                  form.setFieldsValue({ metricSlug: "pipeline_job", pipelineStatuses: ["failed"], pipelineQueueName: null });
                } else if (provider === AlertMetricProvider.CrawlTask) {
                  form.setFieldsValue({ metricSlug: "crawl_task", crawlStatuses: ["failed"], crawlCreatedById: null });
                } else if (provider === AlertMetricProvider.SystemMetric) {
                  form.setFieldsValue({ metricSlug: "system.memory.usage_pct", systemCurrentValue: undefined });
                }
              }}
            />
          </Form.Item>
          <Form.Item
            label="Metric slug"
            name="metricSlug"
            rules={[{ required: true }]}
            tooltip="Slug meaning depends on provider (e.g. economic data slug, system metric slug, or free-form filter key)."
          >
            <Input placeholder="e.g. usd_index_history or system.memory.usage_pct" />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.metricProvider !== next.metricProvider}>
            {({ getFieldValue }) => {
              const provider = getFieldValue("metricProvider");
              if (provider === AlertMetricProvider.PipelineJob) {
                return (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>Pipeline filters</Typography.Text>
                    <Form.Item label="Statuses" name="pipelineStatuses">
                      <Select mode="multiple" options={pipelineStatusOptions} placeholder="defaults to failed" />
                    </Form.Item>
                    <Form.Item label="Queue name" name="pipelineQueueName">
                      <Input placeholder="optional queueName filter" />
                    </Form.Item>
                    <Form.Item label="Source ID" name="pipelineSourceId">
                      <Input placeholder="optional sourceId filter" />
                    </Form.Item>
                  </Space>
                );
              }
              if (provider === AlertMetricProvider.CrawlTask) {
                return (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>Crawl task filters</Typography.Text>
                    <Form.Item label="Statuses" name="crawlStatuses">
                      <Select mode="multiple" options={crawlStatusOptions} placeholder="defaults to failed" />
                    </Form.Item>
                    <Form.Item label="Created by user ID" name="crawlCreatedById">
                      <Input placeholder="optional createdById filter" />
                    </Form.Item>
                  </Space>
                );
              }
              if (provider === AlertMetricProvider.SystemMetric) {
                return (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>System metric options</Typography.Text>
                    <Form.Item label="Preset metric">
                      <Select
                        options={systemMetricSlugs}
                        placeholder="system metric slug"
                        value={getFieldValue("metricSlug")}
                        onChange={(value) => {
                          form.setFieldsValue({ metricSlug: value });
                        }}
                      />
                    </Form.Item>
                    <Form.Item
                      label="Manual override value"
                      name="systemCurrentValue"
                      tooltip="Optional: provide a value directly instead of using the measured system metric"
                    >
                      <InputNumber style={{ width: "100%" }} placeholder="overrides measured value" />
                    </Form.Item>
                  </Space>
                );
              }
              return null;
            }}
          </Form.Item>
          <Form.Item label="Operator" name="operator" rules={[{ required: true }]}>
            <Select options={operatorOptions} />
          </Form.Item>
          <Form.Item label="Threshold value" name="thresholdValue">
            <InputNumber style={{ width: "100%" }} />
          </Form.Item>
          <Space>
            <Form.Item label="Lower bound" name="thresholdLower">
              <InputNumber />
            </Form.Item>
            <Form.Item label="Upper bound" name="thresholdUpper">
              <InputNumber />
            </Form.Item>
          </Space>
          <Space>
            <Form.Item label="Severity" name="severity" rules={[{ required: true }]}>
              <Select options={severityOptions} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item label="Status" name="status" rules={[{ required: true }]}>
              <Select options={statusOptions} style={{ width: 160 }} />
            </Form.Item>
          </Space>
          <Space>
            <Form.Item label="Cooldown (seconds)" name="cooldownSeconds" rules={[{ required: true }]}>
              <InputNumber />
            </Form.Item>
            <Form.Item label="Check interval (seconds)" name="checkIntervalSec" rules={[{ required: true }]}>
              <InputNumber />
            </Form.Item>
          </Space>
          <Form.Item label="Channels" name="channelIds">
            <Select
              mode="multiple"
              placeholder="Select notification channels"
              options={channelsData?.alertChannels?.map((c) => ({ label: c.name, value: c.id })) ?? []}
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={savingRule}>
              Save rule
            </Button>
          </Form.Item>
        </Form>
      </div>
      <Divider />
      <div>
        <Typography.Title level={5}>Create Notification Channel</Typography.Title>
        <Form
          form={channelForm}
          layout="inline"
          initialValues={{ type: "webhook" }}
          onFinish={async (values) => {
            await createChannel({ variables: { input: { type: values.type, name: values.name, target: values.target } } });
            await Promise.all([refetch(), refetchChannels()]);
            message.success("Channel created");
            channelForm.resetFields();
          }}
        >
          <Form.Item name="name" rules={[{ required: true }]} label="Name">
            <Input placeholder="Ops webhook" />
          </Form.Item>
          <Form.Item name="type" rules={[{ required: true }]} label="Type">
            <Select
              style={{ width: 120 }}
              options={[
                { label: "Webhook", value: "webhook" },
                { label: "Email", value: "email" }
              ]}
            />
          </Form.Item>
          <Form.Item name="target" rules={[{ required: true }]} label="Target">
            <Input placeholder="https://..." />
          </Form.Item>
          <Form.Item>
            <Button type="dashed" htmlType="submit" loading={creatingChannel}>
              Add channel
            </Button>
          </Form.Item>
        </Form>
      </div>
    </Space>
  );
}
