"use client";

import { Alert, Button, Form, Input, InputNumber, Modal, Space, Spin, Switch, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

type VectorServiceSettingsSource = "env" | "db";
type VectorServiceTokenSource = "stored" | "env" | "none";

interface VectorServiceSettingsResponse {
  source: VectorServiceSettingsSource;
  enabled: boolean;
  fallbackToMongo: boolean;
  baseUrl: string | null;
  timeoutMs: number;
  maxRetries: number;
  hasToken: boolean;
  tokenSource: VectorServiceTokenSource;
}

interface VectorServiceSettingsFormValues {
  enabled: boolean;
  fallbackToMongo: boolean;
  baseUrl?: string;
  token?: string;
  clearToken?: boolean;
  timeoutMs: number;
  maxRetries: number;
}

const EMPTY_SETTINGS: VectorServiceSettingsResponse = {
  source: "env",
  enabled: false,
  fallbackToMongo: true,
  baseUrl: null,
  timeoutMs: 5_000,
  maxRetries: 2,
  hasToken: false,
  tokenSource: "none"
};

export function VectorServiceSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<VectorServiceSettingsFormValues>();
  const [settings, setSettings] = useState<VectorServiceSettingsResponse>(EMPTY_SETTINGS);
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
      const response = await apiClient.get<VectorServiceSettingsResponse>("system-settings/vector-service");
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      form.setFieldsValue({
        enabled: data.enabled,
        fallbackToMongo: data.fallbackToMongo,
        baseUrl: data.baseUrl ?? "",
        token: "",
        clearToken: false,
        timeoutMs: data.timeoutMs,
        maxRetries: data.maxRetries
      });
    } catch (error) {
      captureClientError("Failed to load vector service settings", error);
      setErrorMessage(t("systemSettings.vectorService.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSubmit = async (values: VectorServiceSettingsFormValues) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const payload: Record<string, unknown> = {
        enabled: values.enabled,
        fallbackToMongo: values.fallbackToMongo,
        baseUrl: values.baseUrl?.trim() ? values.baseUrl.trim() : null,
        timeoutMs: values.timeoutMs,
        maxRetries: values.maxRetries
      };

      if (values.clearToken) {
        payload.token = null;
      } else if (values.token?.trim()) {
        payload.token = values.token.trim();
      }

      const response = await apiClient.put<VectorServiceSettingsResponse>(
        "system-settings/vector-service",
        payload
      );
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      form.setFieldsValue({
        enabled: data.enabled,
        fallbackToMongo: data.fallbackToMongo,
        baseUrl: data.baseUrl ?? "",
        token: "",
        clearToken: false,
        timeoutMs: data.timeoutMs,
        maxRetries: data.maxRetries
      });
      messageApi.success(t("systemSettings.vectorService.messages.saved"));
    } catch (error) {
      captureClientError("Failed to save vector service settings", error);
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(t("systemSettings.vectorService.errors.badRequest"));
      } else {
        messageApi.error(t("systemSettings.vectorService.errors.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    Modal.confirm({
      title: t("systemSettings.vectorService.modal.resetTitle"),
      content: t("systemSettings.vectorService.modal.resetContent"),
      okText: t("systemSettings.vectorService.modal.confirm"),
      cancelText: t("systemSettings.vectorService.modal.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResetting(true);
        setErrorMessage(null);
        try {
          const response = await apiClient.delete<VectorServiceSettingsResponse>(
            "system-settings/vector-service"
          );
          const data = response.data ?? EMPTY_SETTINGS;
          setSettings(data);
          form.setFieldsValue({
            enabled: data.enabled,
            fallbackToMongo: data.fallbackToMongo,
            baseUrl: data.baseUrl ?? "",
            token: "",
            clearToken: false,
            timeoutMs: data.timeoutMs,
            maxRetries: data.maxRetries
          });
          messageApi.success(t("systemSettings.vectorService.messages.reset"));
        } catch (error) {
          captureClientError("Failed to reset vector service settings", error);
          messageApi.error(t("systemSettings.vectorService.errors.resetFailed"));
        } finally {
          setResetting(false);
        }
      }
    });
  };

  const sourceColor = settings.source === "db" ? "green" : "default";
  const sourceLabel =
    settings.source === "db"
      ? t("systemSettings.vectorService.status.saved")
      : t("systemSettings.vectorService.status.env");

  const enabledColor = settings.enabled ? "green" : "default";
  const enabledLabel = settings.enabled
    ? t("systemSettings.vectorService.status.enabled")
    : t("systemSettings.vectorService.status.disabled");

  const tokenSourceLabel = t(`systemSettings.vectorService.status.tokenSources.${settings.tokenSource}`, {
    defaultValue: settings.tokenSource
  });
  const tokenColor = settings.hasToken ? "blue" : "default";

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
        {t("systemSettings.vectorService.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.vectorService.notice.title")}
        description={t("systemSettings.vectorService.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} />
      ) : null}

      <Space direction="vertical" size="small" style={{ display: "flex", marginBottom: "1rem" }}>
        <Space wrap>
          <Typography.Text>{t("systemSettings.vectorService.status.label")}</Typography.Text>
          <Tag color={sourceColor}>{sourceLabel}</Tag>
          <Tag color={enabledColor}>{enabledLabel}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">{t("systemSettings.vectorService.status.tokenSource")}</Typography.Text>
          <Tag color={tokenColor}>{tokenSourceLabel}</Tag>
          {settings.baseUrl ? <Tag color="geekblue">{settings.baseUrl}</Tag> : <Tag>-</Tag>}
        </Space>
      </Space>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item name="enabled" valuePropName="checked" label={t("systemSettings.vectorService.fields.enabled")}>
          <Switch />
        </Form.Item>

        <Form.Item
          name="fallbackToMongo"
          valuePropName="checked"
          label={t("systemSettings.vectorService.fields.fallbackToMongo")}
          extra={t("systemSettings.vectorService.hints.fallbackToMongo")}
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.vectorService.fields.baseUrl")}
          name="baseUrl"
          extra={t("systemSettings.vectorService.hints.baseUrl")}
        >
          <Input placeholder={t("systemSettings.vectorService.placeholders.baseUrl")} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.vectorService.fields.token")}
          name="token"
          extra={t("systemSettings.vectorService.hints.token")}
        >
          <Input.Password placeholder={t("systemSettings.vectorService.placeholders.token")} />
        </Form.Item>

        <Form.Item name="clearToken" valuePropName="checked">
          <Switch
            checkedChildren={t("systemSettings.vectorService.actions.clearToken")}
            unCheckedChildren={t("systemSettings.vectorService.actions.keepToken")}
          />
        </Form.Item>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("systemSettings.vectorService.fields.timeoutMs")}
            name="timeoutMs"
            rules={[{ required: true, message: t("systemSettings.vectorService.validation.timeoutRequired") }]}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber min={100} max={120_000} step={100} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.vectorService.fields.maxRetries")}
            name="maxRetries"
            rules={[{ required: true, message: t("systemSettings.vectorService.validation.maxRetriesRequired") }]}
            style={{ minWidth: 200, flex: 1 }}
          >
            <InputNumber min={0} max={10} step={1} style={{ width: "100%" }} />
          </Form.Item>
        </Space>

        <Space wrap>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
          <Button danger onClick={handleReset} loading={resetting} disabled={saving}>
            {t("systemSettings.vectorService.actions.reset")}
          </Button>
        </Space>
      </Form>
    </>
  );
}

