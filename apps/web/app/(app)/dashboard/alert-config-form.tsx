"use client";

import {
  Alert,
  App,
  Button,
  ConfigProvider,
  DatePicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Typography,
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
const REALTIME_SIGNAL_PROVIDER = AlertMetricProvider.RealtimeSignal;
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
const crawlMetricSlugs = [
  {
    label: "crawl_task",
    value: "crawl_task",
  },
  {
    label: "crawl_quality.preflight_failure_rate",
    value: "crawl_quality.preflight_failure_rate",
  },
  {
    label: "crawl_quality.http_304_hit_rate",
    value: "crawl_quality.http_304_hit_rate",
  },
  {
    label: "crawl_quality.org_hash_dedupe_hit_rate",
    value: "crawl_quality.org_hash_dedupe_hit_rate",
  },
];
type CrawlQualityMetricSlug =
  | "crawl_quality.preflight_failure_rate"
  | "crawl_quality.http_304_hit_rate"
  | "crawl_quality.org_hash_dedupe_hit_rate";

const crawlQualityMetricPresetConfig: Record<
  CrawlQualityMetricSlug,
  {
    operator: AlertOperator;
    thresholdValue: number;
    defaultName: string;
    defaultDescription: string;
  }
> = {
  "crawl_quality.preflight_failure_rate": {
    operator: AlertOperator.Gte,
    thresholdValue: 0.15,
    defaultName: "Crawl Quality: Preflight Failure Rate High",
    defaultDescription: "Alert when preflight failure rate remains too high.",
  },
  "crawl_quality.http_304_hit_rate": {
    operator: AlertOperator.Lte,
    thresholdValue: 0.05,
    defaultName: "Crawl Quality: HTTP 304 Hit Rate Low",
    defaultDescription:
      "Alert when HTTP 304 hit rate drops below expected baseline.",
  },
  "crawl_quality.org_hash_dedupe_hit_rate": {
    operator: AlertOperator.Gte,
    thresholdValue: 0.3,
    defaultName: "Crawl Quality: Org Hash Dedupe Hit Rate High",
    defaultDescription:
      "Alert when org-level content hash dedupe hit rate spikes.",
  },
};

const isCrawlQualityMetricSlug = (
  value: string | undefined,
): value is CrawlQualityMetricSlug =>
  value === "crawl_quality.preflight_failure_rate" ||
  value === "crawl_quality.http_304_hit_rate" ||
  value === "crawl_quality.org_hash_dedupe_hit_rate";

const systemMetricSlugs = [
  "system.memory.usage_pct",
  "system.load.1m",
  "system.uptime.seconds",
  "custom.manual",
].map((slug) => ({ label: slug, value: slug }));

type RealtimeMetricSlug =
  | "realtime.opensky.military_flights"
  | "realtime.ais.disruptions"
  | "realtime.unrest.events"
  | "realtime.outages.internet"
  | "realtime.keyword_spike.count"
  | "realtime.pizzint.defcon"
  | "realtime.gdelt_tension.max_score"
  | "realtime.polymarket_leads.count";

const realtimeMetricOptions: {
  value: RealtimeMetricSlug;
  labelKey: string;
  fallbackLabel: string;
}[] = [
  {
    value: "realtime.opensky.military_flights",
    labelKey: "alerts.config.realtime.metrics.opensky",
    fallbackLabel: "OpenSky military flights",
  },
  {
    value: "realtime.ais.disruptions",
    labelKey: "alerts.config.realtime.metrics.ais",
    fallbackLabel: "AIS disruptions",
  },
  {
    value: "realtime.unrest.events",
    labelKey: "alerts.config.realtime.metrics.unrest",
    fallbackLabel: "Unrest events",
  },
  {
    value: "realtime.outages.internet",
    labelKey: "alerts.config.realtime.metrics.outages",
    fallbackLabel: "Internet outages",
  },
  {
    value: "realtime.keyword_spike.count",
    labelKey: "alerts.config.realtime.metrics.keywordSpike",
    fallbackLabel: "Keyword spike count",
  },
  {
    value: "realtime.pizzint.defcon",
    labelKey: "alerts.config.realtime.metrics.pizzint",
    fallbackLabel: "PizzINT DEFCON",
  },
  {
    value: "realtime.gdelt_tension.max_score",
    labelKey: "alerts.config.realtime.metrics.gdeltTension",
    fallbackLabel: "GDELT tension max score",
  },
  {
    value: "realtime.polymarket_leads.count",
    labelKey: "alerts.config.realtime.metrics.polymarketLeads",
    fallbackLabel: "Polymarket leads count",
  },
];

const realtimeMetricPresetConfig: Record<
  RealtimeMetricSlug,
  {
    operator: AlertOperator;
    thresholdValue: number;
    defaultName: string;
    defaultDescription: string;
  }
> = {
  "realtime.opensky.military_flights": {
    operator: AlertOperator.Gte,
    thresholdValue: 50,
    defaultName: "Realtime Signal: Military Flight Activity Surge",
    defaultDescription:
      "Alert when detected military flight count exceeds baseline threshold.",
  },
  "realtime.ais.disruptions": {
    operator: AlertOperator.Gte,
    thresholdValue: 5,
    defaultName: "Realtime Signal: Maritime Disruptions Elevated",
    defaultDescription: "Alert when AIS disruptions count crosses the threshold.",
  },
  "realtime.unrest.events": {
    operator: AlertOperator.Gte,
    thresholdValue: 20,
    defaultName: "Realtime Signal: Unrest Event Spike",
    defaultDescription:
      "Alert when protest/unrest events rise above the configured threshold.",
  },
  "realtime.outages.internet": {
    operator: AlertOperator.Gte,
    thresholdValue: 3,
    defaultName: "Realtime Signal: Internet Outages Detected",
    defaultDescription:
      "Alert when internet outage annotations increase materially.",
  },
  "realtime.keyword_spike.count": {
    operator: AlertOperator.Gte,
    thresholdValue: 1,
    defaultName: "Realtime Signal: Keyword Spike",
    defaultDescription:
      "Alert when cross-source keyword spikes are detected in near realtime.",
  },
  "realtime.pizzint.defcon": {
    operator: AlertOperator.Lte,
    thresholdValue: 2,
    defaultName: "Realtime Signal: PizzINT DEFCON Escalation",
    defaultDescription:
      "Alert when PizzINT DEFCON reaches elevated threat levels.",
  },
  "realtime.gdelt_tension.max_score": {
    operator: AlertOperator.Gte,
    thresholdValue: 70,
    defaultName: "Realtime Signal: GDELT Tension Escalation",
    defaultDescription:
      "Alert when bilateral tension score exceeds the configured threshold.",
  },
  "realtime.polymarket_leads.count": {
    operator: AlertOperator.Gte,
    thresholdValue: 1,
    defaultName: "Realtime Signal: Prediction Leads News",
    defaultDescription:
      "Alert when prediction market movement leads low-coverage news topics.",
  },
};
const DEFAULT_REALTIME_METRIC_SLUG: RealtimeMetricSlug =
  "realtime.opensky.military_flights";
const realtimePresetDefaultNames = new Set(
  Object.values(realtimeMetricPresetConfig).map((preset) => preset.defaultName),
);
const realtimePresetDefaultDescriptions = new Set(
  Object.values(realtimeMetricPresetConfig).map(
    (preset) => preset.defaultDescription,
  ),
);

const isRealtimeMetricSlug = (
  value: string | undefined,
): value is RealtimeMetricSlug =>
  value === "realtime.opensky.military_flights" ||
  value === "realtime.ais.disruptions" ||
  value === "realtime.unrest.events" ||
  value === "realtime.outages.internet" ||
  value === "realtime.keyword_spike.count" ||
  value === "realtime.pizzint.defcon" ||
  value === "realtime.gdelt_tension.max_score" ||
  value === "realtime.polymarket_leads.count";

export function AlertConfigForm() {
  const { t } = useTranslation();
  const { message } = App.useApp();
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
    <ConfigProvider input={{ autoComplete: "off" }} textArea={{ autoComplete: "off" }}>
      <Space direction="vertical" style={{ width: "100%" }} size="large">
      <div>
        <Typography.Title level={5}>{t("alerts.config.title")}</Typography.Title>
        <Form
          form={form}
          autoComplete="off"
          layout="vertical"
          initialValues={{
            id: existingRule?.id,
            name: existingRule?.name ?? t("alerts.config.defaults.name"),
            description: existingRule?.description ?? undefined,
            metricProvider:
              existingRule?.metricProvider ?? AlertMetricProvider.EconomicData,
            metricSlug:
              existingRule?.metricSlug ??
              (existingRule?.metricProvider === AlertMetricProvider.SystemMetric
                ? "system.memory.usage_pct"
                : existingRule?.metricProvider ===
                    AlertMetricProvider.PipelineJob
                  ? "pipeline_job"
                  : existingRule?.metricProvider === REALTIME_SIGNAL_PROVIDER
                    ? "realtime.opensky.military_flights"
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
            const description =
              typeof values.description === "string" &&
              values.description.trim().length > 0
                ? values.description.trim()
                : undefined;
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
              values.metricSlug === "crawl_task" &&
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
                  ? values.metricSlug === "crawl_task"
                    ? {
                        statuses: values.crawlStatuses,
                        createdById: values.crawlCreatedById,
                      }
                    : {}
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
            try {
              await upsertRule({
                variables: {
                  input: {
                    id: values.id ?? undefined,
                    name: values.name,
                    description,
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
            } catch (error) {
              message.error(
                error instanceof Error
                  ? error.message
                  : t("alerts.config.saveFailed", { defaultValue: "Failed to save." })
              );
            }
          }}
        >
          <Form.Item name="id" hidden>
            <Input type="hidden" />
          </Form.Item>
          <Form.Item label={t("alerts.config.fields.name")} name="name" rules={[{ required: true }]}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            label={t("alerts.config.fields.description", {
              defaultValue: "Description",
            })}
            name="description"
          >
            <Input.TextArea
              autoComplete="off"
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
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
                } else if (provider === REALTIME_SIGNAL_PROVIDER) {
                  const defaultPreset =
                    realtimeMetricPresetConfig[DEFAULT_REALTIME_METRIC_SLUG];
                  const currentName = form.getFieldValue("name") as
                    | string
                    | undefined;
                  const currentDescription = form.getFieldValue(
                    "description",
                  ) as string | undefined;
                  const normalizedName =
                    typeof currentName === "string" ? currentName.trim() : "";
                  const normalizedDescription =
                    typeof currentDescription === "string"
                      ? currentDescription.trim()
                      : "";
                  const defaultName = t("alerts.config.defaults.name");
                  const nextValues: Record<string, unknown> = {
                    metricSlug: DEFAULT_REALTIME_METRIC_SLUG,
                    operator: defaultPreset.operator,
                    thresholdValue: defaultPreset.thresholdValue,
                  };
                  const shouldAutoFillName =
                    normalizedName.length === 0 ||
                    normalizedName === defaultName ||
                    realtimePresetDefaultNames.has(normalizedName);
                  const shouldAutoFillDescription =
                    normalizedDescription.length === 0 ||
                    realtimePresetDefaultDescriptions.has(normalizedDescription);
                  if (shouldAutoFillName) {
                    nextValues.name = defaultPreset.defaultName;
                  }
                  if (shouldAutoFillDescription) {
                    nextValues.description = defaultPreset.defaultDescription;
                  }
                  form.setFieldsValue(nextValues);
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
              prev.metricProvider !== next.metricProvider ||
              prev.metricSlug !== next.metricSlug
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
                const selectedCrawlMetricSlug = getFieldValue("metricSlug") as
                  | string
                  | undefined;
                const isTaskCountMetric = selectedCrawlMetricSlug === "crawl_task";
                return (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>{t("alerts.config.crawl.title")}</Typography.Text>
                    <Form.Item
                      label={t("alerts.config.crawl.metricPreset", {
                        defaultValue: "Crawl metric"
                      })}
                    >
                      <Select
                        options={crawlMetricSlugs}
                        value={getFieldValue("metricSlug")}
                        onChange={(value) => {
                          const currentMetricSlug = getFieldValue("metricSlug") as
                            | string
                            | undefined;
                          const currentName = getFieldValue("name") as
                            | string
                            | undefined;
                          const currentDescription = getFieldValue(
                            "description",
                          ) as string | undefined;
                          const previousPreset = isCrawlQualityMetricSlug(
                            currentMetricSlug,
                          )
                            ? crawlQualityMetricPresetConfig[currentMetricSlug]
                            : null;
                          const nextPreset = isCrawlQualityMetricSlug(value)
                            ? crawlQualityMetricPresetConfig[value]
                            : null;
                          const nextValues: Record<string, unknown> = {
                            metricSlug: value
                          };
                          if (nextPreset) {
                            nextValues.operator = nextPreset.operator;
                            nextValues.thresholdValue = nextPreset.thresholdValue;
                            const normalizedName =
                              typeof currentName === "string"
                                ? currentName.trim()
                                : "";
                            const normalizedDescription =
                              typeof currentDescription === "string"
                                ? currentDescription.trim()
                                : "";
                            const defaultName = t("alerts.config.defaults.name");
                            const shouldAutoFillName =
                              normalizedName.length === 0 ||
                              normalizedName === defaultName ||
                              (previousPreset
                                ? normalizedName === previousPreset.defaultName
                                : false);
                            const shouldAutoFillDescription =
                              normalizedDescription.length === 0 ||
                              (previousPreset
                                ? normalizedDescription ===
                                  previousPreset.defaultDescription
                                : false);
                            if (shouldAutoFillName) {
                              nextValues.name = nextPreset.defaultName;
                            }
                            if (shouldAutoFillDescription) {
                              nextValues.description = nextPreset.defaultDescription;
                            }
                          }
                          form.setFieldsValue(nextValues);
                        }}
                      />
                    </Form.Item>
                    {isTaskCountMetric ? (
                      <>
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
                      </>
                    ) : (
                      <Typography.Text type="secondary">
                        {t("alerts.config.crawl.metricPresetHint", {
                          defaultValue:
                            "This quality metric uses pipeline logs; crawl status filters are not applied.",
                        })}
                      </Typography.Text>
                    )}
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
              if (provider === REALTIME_SIGNAL_PROVIDER) {
                const selectedRealtimeMetricSlug = getFieldValue("metricSlug") as
                  | string
                  | undefined;
                const selectedRealtimePreset = isRealtimeMetricSlug(
                  selectedRealtimeMetricSlug,
                )
                  ? realtimeMetricPresetConfig[selectedRealtimeMetricSlug]
                  : null;
                const realtimePresetOptions: { value: string; label: string }[] =
                  realtimeMetricOptions.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey, {
                      defaultValue: option.fallbackLabel,
                    }),
                  }));
                if (
                  selectedRealtimeMetricSlug &&
                  !realtimeMetricOptions.some(
                    (option) => option.value === selectedRealtimeMetricSlug,
                  )
                ) {
                  realtimePresetOptions.unshift({
                    value: selectedRealtimeMetricSlug,
                    label: t("alerts.config.realtime.metrics.custom", {
                      defaultValue: "Custom: {{slug}}",
                      slug: selectedRealtimeMetricSlug,
                    }),
                  });
                }
                return (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text strong>
                      {t("alerts.config.realtime.title", {
                        defaultValue: "Realtime signals",
                      })}
                    </Typography.Text>
                    <Form.Item
                      label={t("alerts.config.realtime.metricPreset", {
                        defaultValue: "Realtime metric",
                      })}
                    >
                      <Select
                        options={realtimePresetOptions}
                        showSearch
                        optionFilterProp="label"
                        value={getFieldValue("metricSlug")}
                        onChange={(value) => {
                          const currentMetricSlug = getFieldValue("metricSlug") as
                            | string
                            | undefined;
                          const currentName = getFieldValue("name") as
                            | string
                            | undefined;
                          const currentDescription = getFieldValue(
                            "description",
                          ) as string | undefined;
                          const previousPreset = isRealtimeMetricSlug(
                            currentMetricSlug,
                          )
                            ? realtimeMetricPresetConfig[currentMetricSlug]
                            : null;
                          const nextPreset = isRealtimeMetricSlug(value)
                            ? realtimeMetricPresetConfig[value]
                            : null;
                          const nextValues: Record<string, unknown> = {
                            metricSlug: value,
                          };
                          if (nextPreset) {
                            nextValues.operator = nextPreset.operator;
                            nextValues.thresholdValue = nextPreset.thresholdValue;
                            const normalizedName =
                              typeof currentName === "string"
                                ? currentName.trim()
                                : "";
                            const normalizedDescription =
                              typeof currentDescription === "string"
                                ? currentDescription.trim()
                                : "";
                            const defaultName = t("alerts.config.defaults.name");
                            const shouldAutoFillName =
                              normalizedName.length === 0 ||
                              normalizedName === defaultName ||
                              (previousPreset
                                ? normalizedName === previousPreset.defaultName
                                : false);
                            const shouldAutoFillDescription =
                              normalizedDescription.length === 0 ||
                              (previousPreset
                                ? normalizedDescription ===
                                  previousPreset.defaultDescription
                                : false);
                            if (shouldAutoFillName) {
                              nextValues.name = nextPreset.defaultName;
                            }
                            if (shouldAutoFillDescription) {
                              nextValues.description = nextPreset.defaultDescription;
                            }
                          }
                          form.setFieldsValue(nextValues);
                        }}
                      />
                    </Form.Item>
                    {selectedRealtimePreset ? (
                      <Alert
                        type="info"
                        showIcon
                        message={t("alerts.config.realtime.presetDefaults", {
                          defaultValue:
                            "Default trigger: {{operator}} {{threshold}}",
                          operator: t(
                            `alerts.operators.${selectedRealtimePreset.operator}`,
                            { defaultValue: selectedRealtimePreset.operator },
                          ),
                          threshold: selectedRealtimePreset.thresholdValue,
                        })}
                        description={selectedRealtimePreset.defaultDescription}
                      />
                    ) : null}
                    <Typography.Text type="secondary">
                      {t("alerts.config.realtime.metricPresetHint", {
                        defaultValue:
                          "Pick one of the canonical realtime signal slugs to align with scheduler snapshots.",
                      })}
                    </Typography.Text>
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
          autoComplete="off"
          layout="inline"
          initialValues={{ type: "webhook" }}
          onFinish={async (values) => {
            try {
              await createChannel({
                variables: {
                  input: {
                    type: values.type,
                    name: values.channelName,
                    target: values.target,
                  },
                },
              });
              await Promise.all([refetch(), refetchChannels()]);
              message.success(t("alerts.channels.created"));
              channelForm.resetFields();
            } catch (error) {
              message.error(
                error instanceof Error
                  ? error.message
                  : t("alerts.channels.createFailed", { defaultValue: "Failed to create channel." })
              );
            }
          }}
        >
          <Form.Item name="channelName" rules={[{ required: true }]} label={t("alerts.channels.fields.name")}>
            <Input autoComplete="off" placeholder={t("alerts.channels.fields.namePlaceholder")} />
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
    </ConfigProvider>
  );
}
