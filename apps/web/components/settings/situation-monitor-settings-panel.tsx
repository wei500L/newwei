"use client";

import { Alert, Button, Form, Input, InputNumber, Modal, Space, Spin, Switch, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

type SituationMonitorSettingsSource = "env" | "db";
type SituationMonitorTranslationProvider = "deeplx";
type SituationMonitorTranslationApiKeySource = "stored" | "env" | "none";
type SituationMonitorExternalApiKeySource = "stored" | "env" | "none";

interface SituationMonitorSettingsResponse {
  source: SituationMonitorSettingsSource;
  translationMaxConcurrency: number;
  translationProvider: SituationMonitorTranslationProvider;
  translationApiEnabled: boolean;
  translationApiBaseUrl: string;
  translationFallbackApiEnabled: boolean;
  translationFallbackApiBaseUrl: string;
  translationApiTimeoutMs: number;
  translationApiMaxRetries: number;
  hasTranslationApiKey: boolean;
  translationApiKeySource: SituationMonitorTranslationApiKeySource;
  hasFinnhubApiKey: boolean;
  finnhubApiKeySource: SituationMonitorExternalApiKeySource;
  hasFredApiKey: boolean;
  fredApiKeySource: SituationMonitorExternalApiKeySource;
}

interface SituationMonitorSettingsFormValues {
  translationMaxConcurrency: number;
  translationApiEnabled: boolean;
  translationApiBaseUrl?: string;
  translationApiKey?: string;
  translationFallbackApiEnabled: boolean;
  translationFallbackApiBaseUrl?: string;
  finnhubApiKey?: string;
  fredApiKey?: string;
  translationApiTimeoutMs: number;
  translationApiMaxRetries: number;
}

const EMPTY_SETTINGS: SituationMonitorSettingsResponse = {
  source: "env",
  translationMaxConcurrency: 2,
  translationProvider: "deeplx",
  translationApiEnabled: true,
  translationApiBaseUrl: "https://api.deeplx.org",
  translationFallbackApiEnabled: false,
  translationFallbackApiBaseUrl: "",
  translationApiTimeoutMs: 15_000,
  translationApiMaxRetries: 2,
  hasTranslationApiKey: false,
  translationApiKeySource: "none",
  hasFinnhubApiKey: false,
  finnhubApiKeySource: "none",
  hasFredApiKey: false,
  fredApiKeySource: "none",
};

export function SituationMonitorSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<SituationMonitorSettingsFormValues>();
  const [settings, setSettings] = useState<SituationMonitorSettingsResponse>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<SituationMonitorSettingsResponse>("system-settings/situation-monitor");
      const data: SituationMonitorSettingsResponse = {
        ...EMPTY_SETTINGS,
        ...(response.data ?? {}),
      };
      setSettings(data);
      form.setFieldsValue({
        translationMaxConcurrency: data.translationMaxConcurrency,
        translationApiEnabled: data.translationApiEnabled,
        translationApiBaseUrl: data.translationApiBaseUrl ?? "",
        translationApiKey: "",
        translationFallbackApiEnabled: data.translationFallbackApiEnabled,
        translationFallbackApiBaseUrl: data.translationFallbackApiBaseUrl ?? "",
        finnhubApiKey: "",
        fredApiKey: "",
        translationApiTimeoutMs: data.translationApiTimeoutMs,
        translationApiMaxRetries: data.translationApiMaxRetries,
      });
    } catch (error) {
      captureClientError("Failed to load situation monitor settings", error);
      setErrorMessage(t("systemSettings.situationMonitor.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSubmit = async (values: SituationMonitorSettingsFormValues) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const payload: Record<string, unknown> = {
        translationMaxConcurrency: values.translationMaxConcurrency,
        translationApiEnabled: values.translationApiEnabled,
        translationApiBaseUrl: values.translationApiBaseUrl?.trim() ? values.translationApiBaseUrl.trim() : null,
        translationFallbackApiEnabled: values.translationFallbackApiEnabled,
        translationFallbackApiBaseUrl: values.translationFallbackApiBaseUrl?.trim()
          ? values.translationFallbackApiBaseUrl.trim()
          : null,
        translationApiTimeoutMs: values.translationApiTimeoutMs,
        translationApiMaxRetries: values.translationApiMaxRetries,
      };

      if (values.translationApiKey?.trim()) {
        payload.translationApiKey = values.translationApiKey.trim();
      }
      if (values.finnhubApiKey?.trim()) {
        payload.finnhubApiKey = values.finnhubApiKey.trim();
      }
      if (values.fredApiKey?.trim()) {
        payload.fredApiKey = values.fredApiKey.trim();
      }

      const response = await apiClient.put<SituationMonitorSettingsResponse>(
        "system-settings/situation-monitor",
        payload
      );
      const data: SituationMonitorSettingsResponse = {
        ...EMPTY_SETTINGS,
        ...(response.data ?? {}),
      };
      setSettings(data);
      form.setFieldsValue({
        translationMaxConcurrency: data.translationMaxConcurrency,
        translationApiEnabled: data.translationApiEnabled,
        translationApiBaseUrl: data.translationApiBaseUrl ?? "",
        translationApiKey: "",
        translationFallbackApiEnabled: data.translationFallbackApiEnabled,
        translationFallbackApiBaseUrl: data.translationFallbackApiBaseUrl ?? "",
        finnhubApiKey: "",
        fredApiKey: "",
        translationApiTimeoutMs: data.translationApiTimeoutMs,
        translationApiMaxRetries: data.translationApiMaxRetries,
      });
      messageApi.success(t("systemSettings.situationMonitor.messages.saved"));
    } catch (error) {
      captureClientError("Failed to save situation monitor settings", error);
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(extractApiError(error).message ?? t("systemSettings.situationMonitor.errors.badRequest"));
      } else {
        messageApi.error(t("systemSettings.situationMonitor.errors.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    Modal.confirm({
      title: t("systemSettings.situationMonitor.modal.resetTitle"),
      content: t("systemSettings.situationMonitor.modal.resetContent"),
      okText: t("systemSettings.situationMonitor.modal.confirm"),
      cancelText: t("systemSettings.situationMonitor.modal.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResetting(true);
        setErrorMessage(null);
        try {
          const response = await apiClient.delete<SituationMonitorSettingsResponse>(
            "system-settings/situation-monitor"
          );
          const data: SituationMonitorSettingsResponse = {
            ...EMPTY_SETTINGS,
            ...(response.data ?? {}),
          };
          setSettings(data);
          form.setFieldsValue({
            translationMaxConcurrency: data.translationMaxConcurrency,
            translationApiEnabled: data.translationApiEnabled,
            translationApiBaseUrl: data.translationApiBaseUrl ?? "",
            translationApiKey: "",
            translationFallbackApiEnabled: data.translationFallbackApiEnabled,
            translationFallbackApiBaseUrl: data.translationFallbackApiBaseUrl ?? "",
            finnhubApiKey: "",
            fredApiKey: "",
            translationApiTimeoutMs: data.translationApiTimeoutMs,
            translationApiMaxRetries: data.translationApiMaxRetries,
          });
          messageApi.success(t("systemSettings.situationMonitor.messages.reset"));
        } catch (error) {
          captureClientError("Failed to reset situation monitor settings", error);
          messageApi.error(t("systemSettings.situationMonitor.errors.resetFailed"));
        } finally {
          setResetting(false);
        }
      },
    });
  };

  const sourceColor = settings.source === "db" ? "green" : "default";
  const sourceLabel =
    settings.source === "db"
      ? t("systemSettings.situationMonitor.status.saved")
      : t("systemSettings.situationMonitor.status.env");
  const enabledColor = settings.translationApiEnabled ? "green" : "default";
  const enabledLabel = settings.translationApiEnabled
    ? t("systemSettings.situationMonitor.status.enabled")
    : t("systemSettings.situationMonitor.status.disabled");
  const fallbackEnabledColor = settings.translationFallbackApiEnabled ? "green" : "default";
  const fallbackEnabledLabel = settings.translationFallbackApiEnabled
    ? t("systemSettings.situationMonitor.status.enabled")
    : t("systemSettings.situationMonitor.status.disabled");
  const providerLabel = settings.translationProvider.toUpperCase();
  const translationKeySourceLabel = t(
    `systemSettings.situationMonitor.status.apiKeySources.${settings.translationApiKeySource}`,
    { defaultValue: settings.translationApiKeySource }
  );
  const translationKeyTagColor = settings.hasTranslationApiKey ? "blue" : "default";
  const finnhubKeySourceLabel = t(
    `systemSettings.situationMonitor.status.apiKeySources.${settings.finnhubApiKeySource}`,
    { defaultValue: settings.finnhubApiKeySource }
  );
  const finnhubKeyTagColor = settings.hasFinnhubApiKey ? "blue" : "default";
  const fredKeySourceLabel = t(
    `systemSettings.situationMonitor.status.apiKeySources.${settings.fredApiKeySource}`,
    { defaultValue: settings.fredApiKeySource }
  );
  const fredKeyTagColor = settings.hasFredApiKey ? "blue" : "default";

  if (loading && settings === EMPTY_SETTINGS) {
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
        {t("systemSettings.situationMonitor.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.situationMonitor.notice.title")}
        description={t("systemSettings.situationMonitor.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {errorMessage ? <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} /> : null}

      <Space direction="vertical" size="small" style={{ display: "flex", marginBottom: "1rem" }}>
        <Space wrap>
          <Typography.Text>{t("systemSettings.situationMonitor.status.label")}</Typography.Text>
          <Tag color={sourceColor}>{sourceLabel}</Tag>
          <Tag color={enabledColor}>{enabledLabel}</Tag>
          <Tag>{providerLabel}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.situationMonitor.status.translationApiKeySource")}
          </Typography.Text>
          <Tag color={translationKeyTagColor}>{translationKeySourceLabel}</Tag>
          <Tag color="geekblue">{settings.translationApiBaseUrl}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.situationMonitor.status.translationFallbackApi")}
          </Typography.Text>
          <Tag color={fallbackEnabledColor}>{fallbackEnabledLabel}</Tag>
          <Tag color="geekblue">
            {settings.translationFallbackApiBaseUrl || t("systemSettings.situationMonitor.status.notConfigured")}
          </Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.situationMonitor.status.finnhubApiKeySource")}
          </Typography.Text>
          <Tag color={finnhubKeyTagColor}>{finnhubKeySourceLabel}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">{t("systemSettings.situationMonitor.status.fredApiKeySource")}</Typography.Text>
          <Tag color={fredKeyTagColor}>{fredKeySourceLabel}</Tag>
        </Space>
      </Space>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("systemSettings.situationMonitor.fields.translationMaxConcurrency")}
          name="translationMaxConcurrency"
          rules={[
            { required: true, message: t("systemSettings.situationMonitor.validation.translationMaxConcurrency") },
            {
              type: "number",
              min: 1,
              max: 5_000,
              message: t("common.validation.numberRange", { min: 1, max: 5_000 }),
            },
          ]}
          extra={t("systemSettings.situationMonitor.hints.translationMaxConcurrency")}
        >
          <InputNumber min={1} max={5_000} step={1} style={{ width: "100%" }} />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>
          {t("systemSettings.situationMonitor.sections.translationApi")}
        </Typography.Title>

        <Form.Item
          name="translationApiEnabled"
          valuePropName="checked"
          label={t("systemSettings.situationMonitor.fields.translationApiEnabled")}
          extra={t("systemSettings.situationMonitor.hints.translationApiEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.translationApiBaseUrl")}
          name="translationApiBaseUrl"
          extra={t("systemSettings.situationMonitor.hints.translationApiBaseUrl")}
        >
          <Input placeholder={t("systemSettings.situationMonitor.placeholders.translationApiBaseUrl")} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.translationApiKey")}
          name="translationApiKey"
          extra={t("systemSettings.situationMonitor.hints.translationApiKey")}
        >
          <Input.Password placeholder={t("systemSettings.situationMonitor.placeholders.translationApiKey")} />
        </Form.Item>

        <Form.Item
          name="translationFallbackApiEnabled"
          valuePropName="checked"
          label={t("systemSettings.situationMonitor.fields.translationFallbackApiEnabled")}
          extra={t("systemSettings.situationMonitor.hints.translationFallbackApiEnabled")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.translationFallbackApiBaseUrl")}
          name="translationFallbackApiBaseUrl"
          extra={t("systemSettings.situationMonitor.hints.translationFallbackApiBaseUrl")}
        >
          <Input placeholder={t("systemSettings.situationMonitor.placeholders.translationFallbackApiBaseUrl")} />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>
          {t("systemSettings.situationMonitor.sections.externalApis")}
        </Typography.Title>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.finnhubApiKey")}
          name="finnhubApiKey"
          extra={t("systemSettings.situationMonitor.hints.finnhubApiKey")}
        >
          <Input.Password placeholder={t("systemSettings.situationMonitor.placeholders.finnhubApiKey")} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.situationMonitor.fields.fredApiKey")}
          name="fredApiKey"
          extra={t("systemSettings.situationMonitor.hints.fredApiKey")}
        >
          <Input.Password placeholder={t("systemSettings.situationMonitor.placeholders.fredApiKey")} />
        </Form.Item>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("systemSettings.situationMonitor.fields.translationApiTimeoutMs")}
            name="translationApiTimeoutMs"
            rules={[
              { required: true, message: t("systemSettings.situationMonitor.validation.translationApiTimeoutMs") },
              {
                type: "number",
                min: 1_000,
                max: 120_000,
                message: t("common.validation.numberRange", { min: 1_000, max: 120_000 }),
              },
            ]}
            extra={t("systemSettings.situationMonitor.hints.translationApiTimeoutMs")}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber min={1_000} max={120_000} step={1_000} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.situationMonitor.fields.translationApiMaxRetries")}
            name="translationApiMaxRetries"
            rules={[
              {
                required: true,
                message: t("systemSettings.situationMonitor.validation.translationApiMaxRetries"),
              },
              { type: "number", min: 0, max: 5, message: t("common.validation.numberRange", { min: 0, max: 5 }) },
            ]}
            extra={t("systemSettings.situationMonitor.hints.translationApiMaxRetries")}
            style={{ minWidth: 200, flex: 1 }}
          >
            <InputNumber min={0} max={5} step={1} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Space wrap>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
          <Button danger onClick={handleReset} loading={resetting} disabled={saving || resetting}>
            {t("systemSettings.situationMonitor.actions.reset")}
          </Button>
        </Space>
      </Form>
    </>
  );
}
