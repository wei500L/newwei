"use client";

import { Alert, Button, Form, InputNumber, Space, Spin, Switch, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

type NewsSourceSchedulerSettingsSource = "default" | "db";

interface NewsSourceSchedulerSettingsResponse {
  source: NewsSourceSchedulerSettingsSource;
  seedFreshnessWindowDays: number;
  seedCacheTtlSecondsSitemapRss: number;
  seedCacheTtlSecondsListDeep: number;
  seedCacheTtlForceGlobal: boolean;
}

interface NewsSourceSchedulerSettingsFormValues {
  seedFreshnessWindowDays: number;
  seedCacheTtlSecondsSitemapRss: number;
  seedCacheTtlSecondsListDeep: number;
  seedCacheTtlForceGlobal: boolean;
}

const DEFAULT_SETTINGS: NewsSourceSchedulerSettingsResponse = {
  source: "default",
  seedFreshnessWindowDays: 365,
  seedCacheTtlSecondsSitemapRss: 60,
  seedCacheTtlSecondsListDeep: 180,
  seedCacheTtlForceGlobal: false,
};

const ERROR_CODE_I18N_KEY: Record<string, string> = {
  NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID:
    "systemSettings.newsSourceScheduler.errors.codes.NEWS_SOURCE_SCHEDULER_SETTINGS_INVALID",
};

function formatApiError(
  error: unknown,
  fallback: string,
  t: (key: string, options?: { defaultValue?: string }) => string,
): string {
  const parsed = extractApiError(error);
  const normalizedCode = parsed.code?.trim();
  const key = normalizedCode ? ERROR_CODE_I18N_KEY[normalizedCode] : undefined;
  const message =
    key !== undefined
      ? t(key, { defaultValue: parsed.message?.trim() || fallback })
      : parsed.message?.trim() || fallback;
  const detail = parsed.detail?.trim();
  if (!detail || detail === message) {
    return message;
  }
  return `${message} (${detail})`;
}

export function NewsSourceSchedulerSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<NewsSourceSchedulerSettingsFormValues>();
  const [settings, setSettings] = useState<NewsSourceSchedulerSettingsResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const watchedSeedCacheTtlForceGlobal = Form.useWatch(
    "seedCacheTtlForceGlobal",
    form,
  );
  const watchedSeedCacheTtlSecondsSitemapRss = Form.useWatch(
    "seedCacheTtlSecondsSitemapRss",
    form,
  );
  const watchedSeedCacheTtlSecondsListDeep = Form.useWatch(
    "seedCacheTtlSecondsListDeep",
    form,
  );

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<NewsSourceSchedulerSettingsResponse>(
        "system-settings/news-source-scheduler",
      );
      const data: NewsSourceSchedulerSettingsResponse = {
        ...DEFAULT_SETTINGS,
        ...(response.data ?? {}),
      };
      setSettings(data);
      form.setFieldsValue({
        seedFreshnessWindowDays: data.seedFreshnessWindowDays,
        seedCacheTtlSecondsSitemapRss: data.seedCacheTtlSecondsSitemapRss,
        seedCacheTtlSecondsListDeep: data.seedCacheTtlSecondsListDeep,
        seedCacheTtlForceGlobal: data.seedCacheTtlForceGlobal,
      });
    } catch (error) {
      captureClientError("Failed to load news source scheduler settings", error);
      const detail = formatApiError(
        error,
        t("systemSettings.newsSourceScheduler.errors.loadFailed"),
        t,
      );
      setErrorMessage(detail);
      setSettings(null);
      form.setFieldsValue({
        seedFreshnessWindowDays: DEFAULT_SETTINGS.seedFreshnessWindowDays,
        seedCacheTtlSecondsSitemapRss:
          DEFAULT_SETTINGS.seedCacheTtlSecondsSitemapRss,
        seedCacheTtlSecondsListDeep: DEFAULT_SETTINGS.seedCacheTtlSecondsListDeep,
        seedCacheTtlForceGlobal: DEFAULT_SETTINGS.seedCacheTtlForceGlobal,
      });
      messageApi.error(detail);
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, messageApi, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSubmit = async (
    values: NewsSourceSchedulerSettingsFormValues,
  ) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const payload = {
        seedFreshnessWindowDays: values.seedFreshnessWindowDays,
        seedCacheTtlSecondsSitemapRss: values.seedCacheTtlSecondsSitemapRss,
        seedCacheTtlSecondsListDeep: values.seedCacheTtlSecondsListDeep,
        seedCacheTtlForceGlobal: values.seedCacheTtlForceGlobal,
      };
      const response = await apiClient.put<NewsSourceSchedulerSettingsResponse>(
        "system-settings/news-source-scheduler",
        payload,
      );
      const data: NewsSourceSchedulerSettingsResponse = {
        ...DEFAULT_SETTINGS,
        ...(response.data ?? {}),
      };
      setSettings(data);
      form.setFieldsValue({
        seedFreshnessWindowDays: data.seedFreshnessWindowDays,
        seedCacheTtlSecondsSitemapRss: data.seedCacheTtlSecondsSitemapRss,
        seedCacheTtlSecondsListDeep: data.seedCacheTtlSecondsListDeep,
        seedCacheTtlForceGlobal: data.seedCacheTtlForceGlobal,
      });
      messageApi.success(t("systemSettings.newsSourceScheduler.messages.saved"));
    } catch (error) {
      captureClientError("Failed to save news source scheduler settings", error);
      const detail = formatApiError(
        error,
        t("systemSettings.newsSourceScheduler.errors.saveFailed"),
        t,
      );
      setErrorMessage(detail);
      messageApi.error(detail);
    } finally {
      setSaving(false);
    }
  };

  if (loading && settings === null) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}>
        <Spin />
      </div>
    );
  }

  const sourceColor = settings?.source === "db" ? "green" : "default";
  const sourceLabel =
    settings?.source === "db"
      ? t("systemSettings.newsSourceScheduler.status.saved")
      : settings?.source === "default"
        ? t("systemSettings.newsSourceScheduler.status.default")
        : t("systemSettings.newsSourceScheduler.status.unavailable");
  const isGlobalForced =
    typeof watchedSeedCacheTtlForceGlobal === "boolean"
      ? watchedSeedCacheTtlForceGlobal
      : (settings?.seedCacheTtlForceGlobal ?? false);
  const previewSeedCacheTtlSecondsSitemapRss =
    typeof watchedSeedCacheTtlSecondsSitemapRss === "number"
      ? watchedSeedCacheTtlSecondsSitemapRss
      : (settings?.seedCacheTtlSecondsSitemapRss ??
        DEFAULT_SETTINGS.seedCacheTtlSecondsSitemapRss);
  const previewSeedCacheTtlSecondsListDeep =
    typeof watchedSeedCacheTtlSecondsListDeep === "number"
      ? watchedSeedCacheTtlSecondsListDeep
      : (settings?.seedCacheTtlSecondsListDeep ??
        DEFAULT_SETTINGS.seedCacheTtlSecondsListDeep);

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("systemSettings.newsSourceScheduler.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.newsSourceScheduler.notice.title")}
        description={t("systemSettings.newsSourceScheduler.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} />
      ) : null}

      <Space direction="vertical" size="small" style={{ display: "flex", marginBottom: "1rem" }}>
        <Space wrap>
          <Typography.Text>{t("systemSettings.newsSourceScheduler.status.label")}</Typography.Text>
          <Tag color={sourceColor}>{sourceLabel}</Tag>
          <Tag color={isGlobalForced ? "gold" : "blue"}>
            {isGlobalForced
              ? t("systemSettings.newsSourceScheduler.policyPreview.globalForcedTag")
              : t("systemSettings.newsSourceScheduler.policyPreview.sourceAwareTag")}
          </Tag>
        </Space>
      </Space>

      <Alert
        type={isGlobalForced ? "warning" : "info"}
        showIcon
        message={
          isGlobalForced
            ? t("systemSettings.newsSourceScheduler.policyPreview.globalForcedTitle")
            : t("systemSettings.newsSourceScheduler.policyPreview.sourceAwareTitle")
        }
        description={
          isGlobalForced
            ? t("systemSettings.newsSourceScheduler.policyPreview.globalForcedDescription", {
                sitemapRss: previewSeedCacheTtlSecondsSitemapRss,
                listDeep: previewSeedCacheTtlSecondsListDeep,
              })
            : t("systemSettings.newsSourceScheduler.policyPreview.sourceAwareDescription", {
                sitemapRss: previewSeedCacheTtlSecondsSitemapRss,
                listDeep: previewSeedCacheTtlSecondsListDeep,
              })
        }
        style={{ marginBottom: "1rem" }}
      />

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("systemSettings.newsSourceScheduler.fields.seedFreshnessWindowDays")}
          name="seedFreshnessWindowDays"
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedFreshnessWindowDaysRequired",
              ),
            },
            {
              type: "number",
              min: 1,
              max: 3_650,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedFreshnessWindowDaysRange",
              ),
            },
          ]}
          extra={t("systemSettings.newsSourceScheduler.hints.seedFreshnessWindowDays")}
        >
          <InputNumber min={1} max={3_650} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.newsSourceScheduler.fields.seedCacheTtlSecondsSitemapRss")}
          name="seedCacheTtlSecondsSitemapRss"
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedCacheTtlSecondsSitemapRssRequired",
              ),
            },
            {
              type: "number",
              min: 10,
              max: 3_600,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedCacheTtlSecondsSitemapRssRange",
              ),
            },
          ]}
          extra={t("systemSettings.newsSourceScheduler.hints.seedCacheTtlSecondsSitemapRss")}
        >
          <InputNumber min={10} max={3_600} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.newsSourceScheduler.fields.seedCacheTtlSecondsListDeep")}
          name="seedCacheTtlSecondsListDeep"
          rules={[
            {
              required: true,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedCacheTtlSecondsListDeepRequired",
              ),
            },
            {
              type: "number",
              min: 10,
              max: 3_600,
              message: t(
                "systemSettings.newsSourceScheduler.validation.seedCacheTtlSecondsListDeepRange",
              ),
            },
          ]}
          extra={t("systemSettings.newsSourceScheduler.hints.seedCacheTtlSecondsListDeep")}
        >
          <InputNumber min={10} max={3_600} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.newsSourceScheduler.fields.seedCacheTtlForceGlobal")}
          name="seedCacheTtlForceGlobal"
          valuePropName="checked"
          extra={t("systemSettings.newsSourceScheduler.hints.seedCacheTtlForceGlobal")}
        >
          <Switch />
        </Form.Item>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}
