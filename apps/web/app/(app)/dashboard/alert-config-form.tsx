"use client";

import {
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
            metricSlug: existingRule?.metricSlug ?? "usd_index_history",
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
            await upsertRule({
              variables: {
                input: {
                  id: values.id ?? undefined,
                  name: values.name,
                  metricSlug: values.metricSlug,
                  operator: values.operator,
                  thresholdValue: values.thresholdValue ?? undefined,
                  thresholdLower: values.thresholdLower ?? undefined,
                  thresholdUpper: values.thresholdUpper ?? undefined,
                  severity: values.severity,
                  status: values.status,
                  cooldownSeconds: values.cooldownSeconds,
                  checkIntervalSec: values.checkIntervalSec,
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
          <Form.Item label="Metric slug" name="metricSlug" rules={[{ required: true }]}>
            <Input placeholder="e.g. usd_index_history" />
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
