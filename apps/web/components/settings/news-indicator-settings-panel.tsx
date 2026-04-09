"use client";

import { gql, useMutation, useQuery } from "@apollo/client";
import { NEWS_INDICATOR_RECOMMENDED_SLUGS } from "@modular/utils";
import { Alert, Button, Form, InputNumber, Select, Space, Spin, Switch, Typography, message } from "antd";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { captureClientError } from "@/lib/client-telemetry";

interface NewsIndicatorSettingsModel {
  enabled: boolean;
  ingestionEnabled: boolean;
  windowDays: number;
  maxLagDays: number;
  minSampleSize: number;
  minAbsCorrelation: number;
  maxPValue: number;
  topEntities: number;
  topTopics: number;
  maxAssociationsPerIndicator: number;
  indicatorSlugs: string[];
  backtestTriggerZScore: number;
  backtestBaselineDays: number;
  backtestHoldoutDays: number;
  cacheTtlSeconds: number;
}

interface QueryData {
  newsIndicatorSettings: NewsIndicatorSettingsModel;
}

interface MutationData {
  updateNewsIndicatorSettings: NewsIndicatorSettingsModel;
}

interface FormValues {
  enabled: boolean;
  ingestionEnabled: boolean;
  windowDays: number;
  maxLagDays: number;
  minSampleSize: number;
  minAbsCorrelation: number;
  maxPValue: number;
  topEntities: number;
  topTopics: number;
  maxAssociationsPerIndicator: number;
  indicatorSlugs: string[];
  backtestTriggerZScore: number;
  backtestBaselineDays: number;
  backtestHoldoutDays: number;
  cacheTtlSeconds: number;
}

const NEWS_INDICATOR_SETTINGS_QUERY = gql`
  query NewsIndicatorSettings {
    newsIndicatorSettings {
      enabled
      ingestionEnabled
      windowDays
      maxLagDays
      minSampleSize
      minAbsCorrelation
      maxPValue
      topEntities
      topTopics
      maxAssociationsPerIndicator
      indicatorSlugs
      backtestTriggerZScore
      backtestBaselineDays
      backtestHoldoutDays
      cacheTtlSeconds
    }
  }
`;

const UPDATE_NEWS_INDICATOR_SETTINGS_MUTATION = gql`
  mutation UpdateNewsIndicatorSettings($input: UpdateNewsIndicatorSettingsInput!) {
    updateNewsIndicatorSettings(input: $input) {
      enabled
      ingestionEnabled
      windowDays
      maxLagDays
      minSampleSize
      minAbsCorrelation
      maxPValue
      topEntities
      topTopics
      maxAssociationsPerIndicator
      indicatorSlugs
      backtestTriggerZScore
      backtestBaselineDays
      backtestHoldoutDays
      cacheTtlSeconds
    }
  }
`;

function normalizeIndicatorSlugs(values: string[]) {
  const trimmed = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(trimmed)).slice(0, 50);
}

export function NewsIndicatorSettingsPanel() {
  const { t } = useTranslation();
  const [form] = Form.useForm<FormValues>();
  const [messageApi, contextHolder] = message.useMessage();

  const { data, loading, refetch, error } = useQuery<QueryData>(NEWS_INDICATOR_SETTINGS_QUERY, {
    fetchPolicy: "cache-and-network"
  });

  const [updateSettings, { loading: saving }] = useMutation<MutationData>(UPDATE_NEWS_INDICATOR_SETTINGS_MUTATION);

  useEffect(() => {
    if (data?.newsIndicatorSettings) {
      form.setFieldsValue(data.newsIndicatorSettings);
    }
  }, [data?.newsIndicatorSettings, form]);

  const indicatorSlugs = Form.useWatch("indicatorSlugs", form);
  const indicatorOptions = useMemo(
    () =>
      normalizeIndicatorSlugs([
        ...(Array.isArray(indicatorSlugs) ? indicatorSlugs : []),
        ...NEWS_INDICATOR_RECOMMENDED_SLUGS
      ]).map((slug) => ({
        label: slug,
        value: slug
      })),
    [indicatorSlugs]
  );

  const handleSubmit = async (values: FormValues) => {
    try {
      const payload: FormValues = { ...values, indicatorSlugs: normalizeIndicatorSlugs(values.indicatorSlugs ?? []) };
      await updateSettings({ variables: { input: payload } });
      await refetch();
      messageApi.success(t("settings.newsIndicator.messages.saved", { defaultValue: "Saved" }));
    } catch (err) {
      captureClientError("Failed to save news indicator settings", err);
      messageApi.error(t("settings.newsIndicator.messages.saveFailed", { defaultValue: "Failed to save" }));
    }
  };

  if (loading && !data?.newsIndicatorSettings) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("settings.newsIndicator.description", {
          defaultValue: "Discover lead-lag relationships between news signals and economic indicators with backtests."
        })}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("settings.newsIndicator.notice.title", { defaultValue: "Guardrails" })}
        description={t("settings.newsIndicator.notice.body", {
          defaultValue: "Only enable after economic data and sentiment snapshots are available."
        })}
        style={{ marginBottom: "1rem" }}
      />

      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("settings.newsIndicator.messages.loadFailed", { defaultValue: "Failed to load settings" })}
          description={error.message}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("settings.newsIndicator.fields.enabled", { defaultValue: "Enabled" })}
          name="enabled"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.newsIndicator.fields.ingestionEnabled", { defaultValue: "Ingestion enabled" })}
          name="ingestionEnabled"
          valuePropName="checked"
          extra={t("settings.newsIndicator.hints.ingestionEnabled", {
            defaultValue: "Controls scheduled refresh jobs."
          })}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("settings.newsIndicator.fields.indicatorSlugs", { defaultValue: "Indicator slugs" })}
          name="indicatorSlugs"
          extra={
            <Space direction="vertical" size={4}>
              <Typography.Text type="secondary">
                {t("settings.newsIndicator.hints.indicatorSlugs", {
                  defaultValue: "Use EconomicDataItem.slug values; max 50."
                })}
              </Typography.Text>
              <div>
                <Button
                  size="small"
                  onClick={() => {
                    const merged = normalizeIndicatorSlugs([
                      ...(Array.isArray(indicatorSlugs) ? indicatorSlugs : []),
                      ...NEWS_INDICATOR_RECOMMENDED_SLUGS
                    ]);
                    form.setFieldsValue({ indicatorSlugs: merged });
                  }}
                >
                  {t("settings.newsIndicator.actions.applyRecommended", {
                    defaultValue: "Add recommended key-monitor indicators"
                  })}
                </Button>
              </div>
            </Space>
          }
        >
          <Select
            mode="tags"
            tokenSeparators={[",", " ", "\n", "\t"]}
            options={indicatorOptions}
            placeholder={t("settings.newsIndicator.placeholders.indicatorSlugs", {
              defaultValue: "Enter indicator slugs"
            })}
          />
        </Form.Item>

        <Space style={{ width: "100%" }} size="middle" direction="vertical">
          <Form.Item
          label={t("settings.newsIndicator.fields.windowDays", { defaultValue: "Window days" })}
          name="windowDays"
          rules={[{ required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={7} max={3650} style={{ width: "100%" }} />
        </Form.Item>

          <Form.Item
          label={t("settings.newsIndicator.fields.maxLagDays", { defaultValue: "Max lag days" })}
          name="maxLagDays"
          rules={[{ required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={0} max={30} style={{ width: "100%" }} />
        </Form.Item>
        </Space>

        <Space style={{ width: "100%" }} size="middle" direction="vertical">
          <Form.Item
          label={t("settings.newsIndicator.fields.minSampleSize", { defaultValue: "Min sample size" })}
          name="minSampleSize"
          extra={t("settings.newsIndicator.hints.minSampleSize", {
            defaultValue:
              "Minimum number of days with overlapping sentiment snapshots and indicator points; roughly equals minimum news-days needed."
          })}
          rules={[{ required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={10} max={2000} style={{ width: "100%" }} />
        </Form.Item>

          <Form.Item
          label={t("settings.newsIndicator.fields.minAbsCorrelation", { defaultValue: "Min abs correlation" })}
          name="minAbsCorrelation"
          rules={[{ required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>

          <Form.Item
          label={t("settings.newsIndicator.fields.maxPValue", { defaultValue: "Max p-value" })}
          name="maxPValue"
          rules={[{ required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: "100%" }} />
        </Form.Item>
        </Space>

        <Space style={{ width: "100%" }} size="middle" direction="vertical">
          <Form.Item
          label={t("settings.newsIndicator.fields.topEntities", { defaultValue: "Top entities" })}
          name="topEntities"
          rules={[{ required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={0} max={500} style={{ width: "100%" }} />
        </Form.Item>

          <Form.Item
          label={t("settings.newsIndicator.fields.topTopics", { defaultValue: "Top topics" })}
          name="topTopics"
          rules={[{ required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={0} max={500} style={{ width: "100%" }} />
        </Form.Item>

          <Form.Item
            label={t("settings.newsIndicator.fields.maxAssociationsPerIndicator", {
              defaultValue: "Max associations per indicator"
            })}
            name="maxAssociationsPerIndicator"
            rules={[
              { required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }
            ]}
          >
            <InputNumber min={1} max={200} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Typography.Title level={5} style={{ marginTop: "1.5rem" }}>
          {t("settings.newsIndicator.sections.backtest", { defaultValue: "Backtest" })}
        </Typography.Title>

        <Space style={{ width: "100%" }} size="middle" direction="vertical">
          <Form.Item
          label={t("settings.newsIndicator.fields.backtestTriggerZScore", { defaultValue: "Trigger z-score" })}
          name="backtestTriggerZScore"
          rules={[{ required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={0} max={10} step={0.1} style={{ width: "100%" }} />
        </Form.Item>

          <Form.Item
          label={t("settings.newsIndicator.fields.backtestBaselineDays", { defaultValue: "Baseline days" })}
          name="backtestBaselineDays"
          rules={[{ required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={5} max={365} style={{ width: "100%" }} />
        </Form.Item>

          <Form.Item
          label={t("settings.newsIndicator.fields.backtestHoldoutDays", { defaultValue: "Holdout days" })}
          name="backtestHoldoutDays"
          rules={[{ required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={0} max={365} style={{ width: "100%" }} />
        </Form.Item>
        </Space>

        <Form.Item
          label={t("settings.newsIndicator.fields.cacheTtlSeconds", { defaultValue: "Cache TTL (seconds)" })}
          name="cacheTtlSeconds"
          rules={[{ required: true, message: t("settings.newsIndicator.validation.required", { defaultValue: "Required" }) }]}
        >
          <InputNumber min={0} max={3600} step={10} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} disabled={loading}>
            {t("common.saveChanges", { defaultValue: "Save changes" })}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}
