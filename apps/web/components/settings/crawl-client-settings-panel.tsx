"use client";

import {
  Button,
  Form,
  InputNumber,
  Spin,
  Switch,
  Typography,
  message,
} from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { NumberRangeExtra } from "@/components/settings/form-field-feedback";
import { UnitInputNumber } from "@/components/settings/unit-input-number";
import {
  useCrawlClientSettingsQuery,
  useUpdateCrawlClientSettingsMutation,
} from "@/graphql/generated";
import type { UpdateCrawlClientSettingsMutationVariables } from "@/graphql/generated";
import { captureClientError } from "@/lib/client-telemetry";

export function CrawlClientSettingsPanel() {
  const { t } = useTranslation();
  const [form] =
    Form.useForm<UpdateCrawlClientSettingsMutationVariables["input"]>();
  const { data, loading, refetch } = useCrawlClientSettingsQuery();
  const [updateSettings, { loading: saving }] =
    useUpdateCrawlClientSettingsMutation();
  const [messageApi, contextHolder] = message.useMessage();
  const conditionalRequestEnabled =
    Form.useWatch("conditionalRequestEnabled", form) ??
    data?.crawlClientSettings?.conditionalRequestEnabled ??
    true;
  const adaptiveConcurrencyEnabled =
    Form.useWatch("adaptiveConcurrencyEnabled", form) ??
    data?.crawlClientSettings?.adaptiveConcurrencyEnabled ??
    false;

  useEffect(() => {
    if (data?.crawlClientSettings) {
      form.setFieldsValue(data.crawlClientSettings);
    }
  }, [data?.crawlClientSettings, form]);

  const handleSubmit = async (
    values: UpdateCrawlClientSettingsMutationVariables["input"],
  ) => {
    try {
      await updateSettings({ variables: { input: values } });
      await refetch();
      messageApi.success(t("settings.crawlClient.saved"));
    } catch (error) {
      captureClientError("Failed to save crawl client settings", error);
      messageApi.error(t("settings.crawlClient.saveFailed"));
    }
  };

  if (loading && !data?.crawlClientSettings) {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}
      >
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1.5rem" }}>
        {t("settings.crawlClient.description")}
      </Typography.Paragraph>
      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.crawlClient.fields.healthCheckTtl")}
          name="healthCheckTtlMs"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.healthCheckTtl"),
            },
            {
              type: "number",
              min: 5_000,
              max: 900_000,
              message: t("common.validation.numberRange", {
                min: 5_000,
                max: 900_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="healthCheckTtlMs"
              min={5_000}
              max={900_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={5_000}
            max={900_000}
            step={1_000}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.requestTimeoutHot", {
            defaultValue: "Hot request timeout",
          })}
          name="requestTimeoutHotMs"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.requestTimeoutHot", {
                defaultValue: "Please enter hot request timeout.",
              }),
            },
            {
              type: "number",
              min: 5_000,
              max: 900_000,
              message: t("common.validation.numberRange", {
                min: 5_000,
                max: 900_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="requestTimeoutHotMs"
              min={5_000}
              max={900_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={5_000}
            max={900_000}
            step={1_000}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.requestTimeoutNormal", {
            defaultValue: "Normal request timeout",
          })}
          name="requestTimeoutNormalMs"
          rules={[
            {
              required: true,
              message: t(
                "settings.crawlClient.validation.requestTimeoutNormal",
                {
                  defaultValue: "Please enter normal request timeout.",
                },
              ),
            },
            {
              type: "number",
              min: 5_000,
              max: 900_000,
              message: t("common.validation.numberRange", {
                min: 5_000,
                max: 900_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="requestTimeoutNormalMs"
              min={5_000}
              max={900_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={5_000}
            max={900_000}
            step={1_000}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.conditionalRequestEnabled", {
            defaultValue: "Enable HTTP conditional requests",
          })}
          name="conditionalRequestEnabled"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.conditionalRequestTimeoutMs", {
            defaultValue: "Conditional request timeout",
          })}
          name="conditionalRequestTimeoutMs"
          rules={[
            {
              required: true,
              message: t(
                "settings.crawlClient.validation.conditionalRequestTimeoutMs",
                {
                  defaultValue: "Please enter conditional request timeout.",
                },
              ),
            },
            {
              type: "number",
              min: 500,
              max: 60_000,
              message: t("common.validation.numberRange", {
                min: 500,
                max: 60_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="conditionalRequestTimeoutMs"
              min={500}
              max={60_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={500}
            max={60_000}
            step={100}
            unit="ms"
            disabled={!conditionalRequestEnabled}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.conditionalRequestMaxRetries", {
            defaultValue: "Conditional request retries",
          })}
          name="conditionalRequestMaxRetries"
          rules={[
            {
              required: true,
              message: t(
                "settings.crawlClient.validation.conditionalRequestMaxRetries",
                {
                  defaultValue: "Please enter conditional request retries.",
                },
              ),
            },
            {
              type: "number",
              min: 0,
              max: 5,
              message: t("common.validation.numberRange", {
                min: 0,
                max: 5,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="conditionalRequestMaxRetries"
              min={0}
              max={5}
            />
          }
        >
          <InputNumber
            min={0}
            max={5}
            step={1}
            disabled={!conditionalRequestEnabled}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "settings.crawlClient.fields.detailPublishSignalHeadFetchTimeout",
            {
              defaultValue: "Detail publish-signal head fetch timeout",
            },
          )}
          name="detailPublishSignalHeadFetchTimeoutMs"
          rules={[
            {
              required: true,
              message: t(
                "settings.crawlClient.validation.detailPublishSignalHeadFetchTimeout",
                {
                  defaultValue:
                    "Please enter detail publish-signal head fetch timeout.",
                },
              ),
            },
            {
              type: "number",
              min: 500,
              max: 10_000,
              message: t("common.validation.numberRange", {
                min: 500,
                max: 10_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="detailPublishSignalHeadFetchTimeoutMs"
              min={500}
              max={10_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={500}
            max={10_000}
            step={100}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t(
            "settings.crawlClient.fields.detailPublishSignalHeadFetchConcurrency",
            {
              defaultValue: "Detail publish-signal head fetch concurrency",
            },
          )}
          name="detailPublishSignalHeadFetchConcurrency"
          rules={[
            {
              required: true,
              message: t(
                "settings.crawlClient.validation.detailPublishSignalHeadFetchConcurrency",
                {
                  defaultValue:
                    "Please enter detail publish-signal head fetch concurrency.",
                },
              ),
            },
            {
              type: "number",
              min: 1,
              max: 8,
              message: t("common.validation.numberRange", {
                min: 1,
                max: 8,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="detailPublishSignalHeadFetchConcurrency"
              min={1}
              max={8}
            />
          }
        >
          <InputNumber min={1} max={8} step={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t(
            "settings.crawlClient.fields.detailPublishSignalHeadFetchMaxReadBytes",
            {
              defaultValue: "Detail publish-signal head fetch max read bytes",
            },
          )}
          name="detailPublishSignalHeadFetchMaxReadBytes"
          rules={[
            {
              required: true,
              message: t(
                "settings.crawlClient.validation.detailPublishSignalHeadFetchMaxReadBytes",
                {
                  defaultValue:
                    "Please enter detail publish-signal head fetch max read bytes.",
                },
              ),
            },
            {
              type: "number",
              min: 1_048_576,
              max: 64_000_000,
              message: t("common.validation.numberRange", {
                min: 1_048_576,
                max: 64_000_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="detailPublishSignalHeadFetchMaxReadBytes"
              min={1_048_576}
              max={64_000_000}
              unit="B"
            />
          }
        >
          <UnitInputNumber
            min={1_048_576}
            max={64_000_000}
            step={262_144}
            unit="B"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.maxAttempts")}
          name="maxRetries"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.maxAttempts"),
            },
            {
              type: "number",
              min: 1,
              max: 10,
              message: t("common.validation.numberRange", { min: 1, max: 10 }),
            },
          ]}
          extra={<NumberRangeExtra name="maxRetries" min={1} max={10} />}
        >
          <InputNumber min={1} max={10} step={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.retryBackoff")}
          name="retryBackoffMs"
          rules={[
            {
              required: true,
              message: t("settings.crawlClient.validation.retryBackoff"),
            },
            {
              type: "number",
              min: 500,
              max: 600_000,
              message: t("common.validation.numberRange", {
                min: 500,
                max: 600_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="retryBackoffMs"
              min={500}
              max={600_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={500}
            max={600_000}
            step={500}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.queueOverloadCooldown", {
            defaultValue: "Queue overload cooldown",
          })}
          name="queueOverloadCooldownMs"
          rules={[
            {
              required: true,
              message: t(
                "settings.crawlClient.validation.queueOverloadCooldown",
                {
                  defaultValue: "Please enter queue overload cooldown.",
                },
              ),
            },
            {
              type: "number",
              min: 5_000,
              max: 600_000,
              message: t("common.validation.numberRange", {
                min: 5_000,
                max: 600_000,
              }),
            },
          ]}
          extra={
            <NumberRangeExtra
              name="queueOverloadCooldownMs"
              min={5_000}
              max={600_000}
              unit="ms"
            />
          }
        >
          <UnitInputNumber
            min={5_000}
            max={600_000}
            step={1_000}
            unit="ms"
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item
          label={t("settings.crawlClient.fields.adaptiveConcurrency", {
            defaultValue: "Adaptive concurrency",
          })}
          name="adaptiveConcurrencyEnabled"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
          {adaptiveConcurrencyEnabled
            ? t("settings.crawlClient.hints.adaptiveEnabled", {
                defaultValue:
                  "Adaptive mode is enabled. Window and threshold fields below are active.",
              })
            : t("settings.crawlClient.hints.adaptiveDisabled", {
                defaultValue:
                  "Adaptive mode is disabled. Enable it to configure window and threshold fields.",
              })}
        </Typography.Paragraph>
        {adaptiveConcurrencyEnabled ? (
          <>
            <Form.Item
              label={t("settings.crawlClient.fields.adaptiveWindowMinutes", {
                defaultValue: "Adaptive window",
              })}
              name="adaptiveWindowMinutes"
              rules={[
                {
                  required: true,
                  message: t(
                    "settings.crawlClient.validation.adaptiveWindowMinutes",
                    {
                      defaultValue: "Please enter adaptive window in minutes.",
                    },
                  ),
                },
                {
                  type: "number",
                  min: 1,
                  max: 180,
                  message: t("common.validation.numberRange", {
                    min: 1,
                    max: 180,
                  }),
                },
              ]}
              extra={
                <NumberRangeExtra
                  name="adaptiveWindowMinutes"
                  min={1}
                  max={180}
                  unit="min"
                />
              }
            >
              <UnitInputNumber
                min={1}
                max={180}
                step={1}
                unit="min"
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t("settings.crawlClient.fields.adaptiveCooldownMinutes", {
                defaultValue: "Adaptive cooldown",
              })}
              name="adaptiveCooldownMinutes"
              rules={[
                {
                  required: true,
                  message: t(
                    "settings.crawlClient.validation.adaptiveCooldownMinutes",
                    {
                      defaultValue:
                        "Please enter adaptive cooldown in minutes.",
                    },
                  ),
                },
                {
                  type: "number",
                  min: 1,
                  max: 60,
                  message: t("common.validation.numberRange", {
                    min: 1,
                    max: 60,
                  }),
                },
              ]}
              extra={
                <NumberRangeExtra
                  name="adaptiveCooldownMinutes"
                  min={1}
                  max={60}
                  unit="min"
                />
              }
            >
              <UnitInputNumber
                min={1}
                max={60}
                step={1}
                unit="min"
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t(
                "settings.crawlClient.fields.adaptiveLatencyThresholdRatio",
                {
                  defaultValue: "Adaptive latency threshold",
                },
              )}
              name="adaptiveLatencyThresholdRatio"
              rules={[
                {
                  required: true,
                  message: t(
                    "settings.crawlClient.validation.adaptiveLatencyThresholdRatio",
                    {
                      defaultValue:
                        "Please enter adaptive latency threshold ratio.",
                    },
                  ),
                },
                {
                  type: "number",
                  min: 0.01,
                  max: 0.99,
                  message: t("common.validation.numberRange", {
                    min: 0.01,
                    max: 0.99,
                  }),
                },
              ]}
            >
              <InputNumber
                min={0.01}
                max={0.99}
                step={0.01}
                precision={2}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t(
                "settings.crawlClient.fields.adaptiveErrorRateThreshold",
                {
                  defaultValue: "Adaptive error-rate threshold",
                },
              )}
              name="adaptiveErrorRateThreshold"
              rules={[
                {
                  required: true,
                  message: t(
                    "settings.crawlClient.validation.adaptiveErrorRateThreshold",
                    {
                      defaultValue:
                        "Please enter adaptive error-rate threshold ratio.",
                    },
                  ),
                },
                {
                  type: "number",
                  min: 0.01,
                  max: 0.99,
                  message: t("common.validation.numberRange", {
                    min: 0.01,
                    max: 0.99,
                  }),
                },
              ]}
            >
              <InputNumber
                min={0.01}
                max={0.99}
                step={0.01}
                precision={2}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              label={t(
                "settings.crawlClient.fields.adaptiveMemoryHeadroomThreshold",
                {
                  defaultValue: "Adaptive memory headroom threshold",
                },
              )}
              name="adaptiveMemoryHeadroomThreshold"
              rules={[
                {
                  required: true,
                  message: t(
                    "settings.crawlClient.validation.adaptiveMemoryHeadroomThreshold",
                    {
                      defaultValue:
                        "Please enter adaptive memory headroom threshold ratio.",
                    },
                  ),
                },
                {
                  type: "number",
                  min: 0.01,
                  max: 0.99,
                  message: t("common.validation.numberRange", {
                    min: 0.01,
                    max: 0.99,
                  }),
                },
              ]}
            >
              <InputNumber
                min={0.01}
                max={0.99}
                step={0.01}
                precision={2}
                style={{ width: "100%" }}
              />
            </Form.Item>
          </>
        ) : null}
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}
