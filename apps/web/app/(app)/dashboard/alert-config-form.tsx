"use client";

import {
  Button,
  DatePicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Typography,
  message,
} from "antd";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertMetricProvider,
  AlertOperator,
  AlertSeverity,
  AlertStatus,
  useAlertChannelsQuery,
  useAlertRulesQuery,
  useCreateAlertChannelMutation,
  useUpsertAlertRuleMutation,
} from "@/graphql/generated";
import dayjs, { toUtcIsoString } from "@/lib/dayjs";

const parseDateValue = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed : null;
};

const safeParseJsonObject = (value: unknown): { value: Record<string, unknown> } | { error: string } => {
  if (typeof value !== "string") {
    return { value: {} };
  }
  const raw = value.trim();
  if (!raw) {
    return { value: {} };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Metadata must be a JSON object" };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

const operatorOptions = Object.values(AlertOperator).map((op) => ({
  labelKey: `alerts.operators.${op}`,
  value: op,
}));
const severityOptions = Object.values(AlertSeverity).map((s) => ({
  labelKey: `alerts.severity.${s}`,
  value: s,
}));
const statusOptions = Object.values(AlertStatus).map((s) => ({
  labelKey: `alerts.status.${s}`,
  value: s,
}));
const metricProviderOptions = Object.values(AlertMetricProvider).map(
  (provider) => ({ labelKey: `alerts.metricProviders.${provider}`, value: provider }),
);
const pipelineStatusOptions = [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "delayed",
].map((status) => ({
  label: status,
  value: status,
}));
const crawlStatusOptions = [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "paused",
].map((status) => ({
  label: status,
  value: status,
}));
const systemMetricSlugs = [
  "system.memory.usage_pct",
  "system.load.1m",
  "system.uptime.seconds",
  "custom.manual",
].map((slug) => ({ label: slug, value: slug }));

export function AlertConfigForm() {
  const { t } = useTranslation();
  const { data, refetch } = useAlertRulesQuery();
  const { data: channelsData, refetch: refetchChannels } =
    useAlertChannelsQuery();
  const [upsertRule, { loading: savingRule }] = useUpsertAlertRuleMutation();
  const [createChannel, { loading: creatingChannel }] =
    useCreateAlertChannelMutation();

  const existingRule = useMemo(() => data?.alertRules?.[0], [data]);
  const [form] = Form.useForm();
  const [channelForm] = Form.useForm();

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="large">
      <div>
        <Typography.Title level={5}>{t("alerts.config.title")}</Typography.Title>
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            id: existingRule?.id,
            name: existingRule?.name ?? t("alerts.config.defaults.name"),
            metricProvider:
              existingRule?.metricProvider ?? AlertMetricProvider.EconomicData,
            metricSlug:
              existingRule?.metricSlug ??
              (existingRule?.metricProvider === AlertMetricProvider.SystemMetric
                ? "system.memory.usage_pct"
                : existingRule?.metricProvider ===
                    AlertMetricProvider.PipelineJob
                  ? "pipeline_job"
                  : existingRule?.metricProvider ===
                      AlertMetricProvider.CrawlTask
                    ? "crawl_task"
                    : "usd_index_history"),
            pipelineStatuses: existingRule?.metadata?.statuses ?? ["failed"],
            pipelineQueueName: existingRule?.metadata?.queueName,
            pipelineSourceId: existingRule?.metadata?.sourceId,
            crawlStatuses: existingRule?.metadata?.statuses ?? ["failed"],
            crawlCreatedById: existingRule?.metadata?.createdById,
            systemCurrentValue: existingRule?.metadata?.currentValue,
            muteUntil: parseDateValue(existingRule?.metadata?.muteUntil),
            notifyAllMembers: existingRule?.metadata?.notifyAllMembers ?? false,
            metadataJson: existingRule?.metadata
              ? JSON.stringify(existingRule.metadata, null, 2)
              : "",
            operator: existingRule?.operator ?? AlertOperator.Gt,
            thresholdValue: existingRule?.thresholdValue ?? 100,
            thresholdLower: existingRule?.thresholdLower ?? undefined,
            thresholdUpper: existingRule?.thresholdUpper ?? undefined,
            severity: existingRule?.severity ?? AlertSeverity.Medium,
            status: existingRule?.status ?? AlertStatus.Active,
            cooldownSeconds: existingRule?.cooldownSeconds ?? 3600,
            checkIntervalSec: existingRule?.checkIntervalSec ?? 300,
            channelIds: existingRule?.channels?.map((c) => c.id) ?? [],
          }}
          onFinish={async (values) => {
            const parsedMetadata = safeParseJsonObject(values.metadataJson);
            if ("error" in parsedMetadata) {
              message.error(parsedMetadata.error);
              return;
            }
            if (
              values.metricProvider === AlertMetricProvider.PipelineJob &&
              (!values.pipelineStatuses || !values.pipelineStatuses.length)
            ) {
              message.error(t("alerts.config.errors.pipelineStatus"));
              return;
            }
            if (
              values.metricProvider === AlertMetricProvider.CrawlTask &&
              (!values.crawlStatuses || !values.crawlStatuses.length)
            ) {
              message.error(t("alerts.config.errors.crawlStatus"));
              return;
            }
            if (
              values.metricProvider === AlertMetricProvider.SystemMetric &&
              !values.metricSlug
            ) {
              message.error(t("alerts.config.errors.systemMetricSlug"));
              return;
            }
            const baseMetadata: Record<string, unknown> = {};
            if (values.muteUntil) {
              baseMetadata.muteUntil = toUtcIsoString(values.muteUntil);
            }
            if (values.notifyAllMembers) {
              baseMetadata.notifyAllMembers = true;
            }
            const providerMetadata =
              values.metricProvider === AlertMetricProvider.PipelineJob
                ? {
                    statuses: values.pipelineStatuses,
                    queueName: values.pipelineQueueName,
                    sourceId: values.pipelineSourceId,
                  }
                : values.metricProvider === AlertMetricProvider.CrawlTask
                  ? {
                      statuses: values.crawlStatuses,
                      createdById: values.crawlCreatedById,
                    }
                  : values.metricProvider === AlertMetricProvider.SystemMetric
                    ? {
                        currentValue: values.systemCurrentValue,
                      }
                    : {};
            const mergedMetadata = {
              ...parsedMetadata.value,
              ...providerMetadata,
              ...baseMetadata
            };
            const metadata = Object.keys(mergedMetadata).length ? mergedMetadata : undefined;
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
                  metadata,
                  channelIds: values.channelIds,
                },
              },
            });
            await Promise.all([refetch(), refetchChannels()]);
            message.success(t("alerts.config.saved"));
          }}
        >
          <Form.Item name="id" hidden>
            <Input />
          </Form.Item>
          <Form.Item label={t("alerts.config.fields.name")} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            label={t("alerts.config.fields.metricProvider")}
            name="metricProvider"
            rules={[{ required: true }]}
          >
            <Select
              options={metricProviderOptions.map((option) => ({
                value: option.value,
                label: t(option.labelKey, { defaultValue: option.value })
              }))}
              onChange={(provider) => {
                const currentMetadataJson = form.getFieldValue("metadataJson") as string | undefined;
                const metadataUnset = typeof currentMetadataJson !== "string" || currentMetadataJson.trim().length === 0;
                if (provider === AlertMetricProvider.EconomicData) {
                  form.setFieldsValue({ metricSlug: "usd_index_history" });
                } else if (provider === AlertMetricProvider.PipelineJob) {
                  form.setFieldsValue({
                    metricSlug: "pipeline_job",
                    pipelineStatuses: ["failed"],
                    pipelineQueueName: null,
                  });
                } else if (provider === AlertMetricProvider.CrawlTask) {
                  form.setFieldsValue({
                    metricSlug: "crawl_task",
                    crawlStatuses: ["failed"],
                    crawlCreatedById: null,
                  });
                } else if (provider === AlertMetricProvider.SystemMetric) {
                  form.setFieldsValue({
                    metricSlug: "system.memory.usage_pct",
                    systemCurrentValue: undefined,
                  });
                } else if (provider === AlertMetricProvider.EconomicAnomaly) {
                  form.setFieldsValue({
                    metricSlug: "usd_index_history",
                    operator: AlertOperator.Gte,
                    thresholdValue: 3
                  });
                  if (metadataUnset) {
                    form.setFieldsValue({
                      metadataJson: JSON.stringify(
                        { modelKind: "arima", lookbackDays: 365, confidenceLevel: 0.95, cacheTtlSeconds: 300 },
                        null,
                        2
                      )
                    });
                  }
                } else if (provider === AlertMetricProvider.EntitySentiment) {
                  form.setFieldsValue({
                    metricSlug: "",
                    operator: AlertOperator.Gte,
                    thresholdValue: 2
                  });
                  if (metadataUnset) {
                    form.setFieldsValue({
                      metadataJson: JSON.stringify(
                        {
                          windowMinutes: 60,
                          baselineWindowMin: 7 * 24 * 60,
                          minDocsInWindow: 5,
                          minEntityConfidence: 0.5
                        },
                        null,
                        2
                      )
                    });
                  }
                } else if (provider === AlertMetricProvider.EntityAssociation) {
                  form.setFieldsValue({
                    metricSlug: "",
                    operator: AlertOperator.Gte,
                    thresholdValue: 1.5
                  });
                  if (metadataUnset) {
                    form.setFieldsValue({
                      metadataJson: JSON.stringify(
                        { sourceWindowMinutes: 180, minAssociationWeight: 0.3, maxTargets: 10 },
                        null,
                        2
                      )
                    });
                  }
                }
              }}
            />
          </Form.Item>
          <Form.Item
            label={t("alerts.config.fields.metricSlug")}
            name="metricSlug"
            rules={[{ required: true }]}
            tooltip={t("alerts.config.fields.metricSlugHint")}
          >
            <Input placeholder={t("alerts.config.fields.metricSlugPlaceholder")} />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, next) =>
              prev.metricProvider !== next.metricProvider
            }
          >
            {({ getFieldValue }) => {
              const provider = getFieldValue("metricProvider");
              if (provider === AlertMetricProvider.PipelineJob) {
                return (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>{t("alerts.config.pipeline.title")}</Typography.Text>
                    <Form.Item label={t("alerts.config.pipeline.statuses")} name="pipelineStatuses">
                      <Select
                        mode="multiple"
                        options={pipelineStatusOptions}
                        placeholder={t("alerts.config.pipeline.defaultsToFailed")}
                      />
                    </Form.Item>
                    <Form.Item label={t("alerts.config.pipeline.queueName")} name="pipelineQueueName">
                      <Input placeholder={t("alerts.config.pipeline.queueNamePlaceholder")} />
                    </Form.Item>
                    <Form.Item label={t("alerts.config.pipeline.sourceId")} name="pipelineSourceId">
                      <Input placeholder={t("alerts.config.pipeline.sourceIdPlaceholder")} />
                    </Form.Item>
                  </Space>
                );
              }
              if (provider === AlertMetricProvider.CrawlTask) {
                return (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>{t("alerts.config.crawl.title")}</Typography.Text>
                    <Form.Item label={t("alerts.config.crawl.statuses")} name="crawlStatuses">
                      <Select
                        mode="multiple"
                        options={crawlStatusOptions}
                        placeholder={t("alerts.config.crawl.defaultsToFailed")}
                      />
                    </Form.Item>
                    <Form.Item
                      label={t("alerts.config.crawl.createdBy")}
                      name="crawlCreatedById"
                    >
                      <Input placeholder={t("alerts.config.crawl.createdByPlaceholder")} />
                    </Form.Item>
                  </Space>
                );
              }
              if (provider === AlertMetricProvider.SystemMetric) {
                return (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>
                      {t("alerts.config.system.title")}
                    </Typography.Text>
                    <Form.Item label={t("alerts.config.system.presetMetric")}>
                      <Select
                        options={systemMetricSlugs}
                        placeholder={t("alerts.config.system.presetPlaceholder")}
                        value={getFieldValue("metricSlug")}
                        onChange={(value) => {
                          form.setFieldsValue({ metricSlug: value });
                        }}
                      />
                    </Form.Item>
                    <Form.Item
                      label={t("alerts.config.system.override")}
                      name="systemCurrentValue"
                      tooltip={t("alerts.config.system.overrideHint")}
                    >
                      <InputNumber
                        style={{ width: "100%" }}
                        placeholder={t("alerts.config.system.overridePlaceholder")}
                      />
                    </Form.Item>
                  </Space>
                );
              }
              return null;
            }}
          </Form.Item>
          <Form.Item
            label={t("alerts.config.fields.operator")}
            name="operator"
            rules={[{ required: true }]}
          >
            <Select
              options={operatorOptions.map((option) => ({
                value: option.value,
                label: t(option.labelKey, { defaultValue: option.value })
              }))}
            />
          </Form.Item>
          <Form.Item label={t("alerts.config.fields.thresholdValue")} name="thresholdValue">
            <InputNumber style={{ width: "100%" }} />
          </Form.Item>
          <Space>
            <Form.Item label={t("alerts.config.fields.thresholdLower")} name="thresholdLower">
              <InputNumber />
            </Form.Item>
            <Form.Item label={t("alerts.config.fields.thresholdUpper")} name="thresholdUpper">
              <InputNumber />
            </Form.Item>
          </Space>
          <Space>
            <Form.Item
              label={t("alerts.config.fields.severity")}
              name="severity"
              rules={[{ required: true }]}
            >
              <Select
                options={severityOptions.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey, { defaultValue: option.value })
                }))}
                style={{ width: 160 }}
              />
            </Form.Item>
            <Form.Item
              label={t("alerts.config.fields.status")}
              name="status"
              rules={[{ required: true }]}
            >
              <Select
                options={statusOptions.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey, { defaultValue: option.value })
                }))}
                style={{ width: 160 }}
              />
            </Form.Item>
          </Space>
          <Space>
            <Form.Item
              label={t("alerts.config.fields.cooldown")}
              name="cooldownSeconds"
              rules={[{ required: true }]}
            >
              <InputNumber />
            </Form.Item>
            <Form.Item
              label={t("alerts.config.fields.checkInterval")}
              name="checkIntervalSec"
              rules={[{ required: true }]}
            >
              <InputNumber />
            </Form.Item>
          </Space>
          <Space size="large" align="start">
            <Form.Item label={t("alerts.config.fields.muteUntil")} name="muteUntil">
              <DatePicker showTime allowClear />
            </Form.Item>
            <Form.Item
              label={t("alerts.config.fields.notifyAllMembers")}
              name="notifyAllMembers"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item
            label={t("alerts.config.fields.metadataJson", { defaultValue: "Metadata (JSON)" })}
            name="metadataJson"
            tooltip={t("alerts.config.fields.metadataJsonHint", { defaultValue: "Optional JSON object merged into rule metadata." })}
          >
            <Input.TextArea autoSize={{ minRows: 6, maxRows: 16 }} placeholder='{"key":"value"}' />
          </Form.Item>
          <Form.Item label={t("alerts.config.fields.channels")} name="channelIds">
            <Select
              mode="multiple"
              placeholder={t("alerts.config.fields.channelsPlaceholder")}
              options={
                channelsData?.alertChannels?.map((c) => ({
                  label: c.name,
                  value: c.id,
                })) ?? []
              }
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={savingRule}>
              {t("common.save")}
            </Button>
          </Form.Item>
        </Form>
      </div>
      <Divider />
      <div>
        <Typography.Title level={5}>
          {t("alerts.channels.title")}
        </Typography.Title>
        <Form
          form={channelForm}
          layout="inline"
          initialValues={{ type: "webhook" }}
          onFinish={async (values) => {
            await createChannel({
              variables: {
                input: {
                  type: values.type,
                  name: values.name,
                  target: values.target,
                },
              },
            });
            await Promise.all([refetch(), refetchChannels()]);
            message.success(t("alerts.channels.created"));
            channelForm.resetFields();
          }}
        >
          <Form.Item name="name" rules={[{ required: true }]} label={t("alerts.channels.fields.name")}>
            <Input placeholder={t("alerts.channels.fields.namePlaceholder")} />
          </Form.Item>
          <Form.Item name="type" rules={[{ required: true }]} label={t("alerts.channels.fields.type")}>
            <Select
              style={{ width: 120 }}
              options={[
                { label: t("alerts.channels.types.webhook"), value: "webhook" },
                { label: t("alerts.channels.types.email"), value: "email" },
              ]}
            />
          </Form.Item>
          <Form.Item name="target" rules={[{ required: true }]} label={t("alerts.channels.fields.target")}>
            <Input placeholder={t("alerts.channels.fields.targetPlaceholder")} />
          </Form.Item>
          <Form.Item>
            <Button type="dashed" htmlType="submit" loading={creatingChannel}>
              {t("alerts.channels.add")}
            </Button>
          </Form.Item>
        </Form>
      </div>
    </Space>
  );
}
