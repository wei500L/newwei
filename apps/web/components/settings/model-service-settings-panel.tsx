"use client";

import { Alert, Button, Form, Input, InputNumber, Modal, Space, Spin, Switch, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

type ModelServiceSettingsSource = "env" | "db";
type ModelServiceTokenSource = "stored" | "env" | "none";

interface ModelServiceSettingsResponse {
  source: ModelServiceSettingsSource;
  enabled: boolean;
  baseUrl: string | null;
  timeoutMs: number;
  maxRetries: number;
  hasToken: boolean;
  tokenSource: ModelServiceTokenSource;
}

interface ModelServiceSettingsFormValues {
  enabled: boolean;
  baseUrl?: string;
  internalToken?: string;
  clearToken?: boolean;
  timeoutMs: number;
  maxRetries: number;
}

const EMPTY_SETTINGS: ModelServiceSettingsResponse = {
  source: "env",
  enabled: false,
  baseUrl: null,
  timeoutMs: 15_000,
  maxRetries: 2,
  hasToken: false,
  tokenSource: "none"
};

export function ModelServiceSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<ModelServiceSettingsFormValues>();
  const [settings, setSettings] = useState<ModelServiceSettingsResponse>(EMPTY_SETTINGS);
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
      const response = await apiClient.get<ModelServiceSettingsResponse>("system-settings/model-service");
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      form.setFieldsValue({
        enabled: data.enabled,
        baseUrl: data.baseUrl ?? "",
        internalToken: "",
        clearToken: false,
        timeoutMs: data.timeoutMs,
        maxRetries: data.maxRetries
      });
    } catch (error) {
      captureClientError("Failed to load model service settings", error);
      setErrorMessage(t("systemSettings.modelService.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSubmit = async (values: ModelServiceSettingsFormValues) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const payload: Record<string, unknown> = {
        enabled: values.enabled,
        baseUrl: values.baseUrl?.trim() ? values.baseUrl.trim() : null,
        timeoutMs: values.timeoutMs,
        maxRetries: values.maxRetries
      };

      if (values.clearToken) {
        payload.internalToken = null;
      } else if (values.internalToken?.trim()) {
        payload.internalToken = values.internalToken.trim();
      }

      const response = await apiClient.put<ModelServiceSettingsResponse>("system-settings/model-service", payload);
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      form.setFieldsValue({
        enabled: data.enabled,
        baseUrl: data.baseUrl ?? "",
        internalToken: "",
        clearToken: false,
        timeoutMs: data.timeoutMs,
        maxRetries: data.maxRetries
      });
      messageApi.success(t("systemSettings.modelService.messages.saved"));
    } catch (error) {
      captureClientError("Failed to save model service settings", error);
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(extractApiError(error).message ?? t("systemSettings.modelService.errors.badRequest"));
      } else {
        messageApi.error(t("systemSettings.modelService.errors.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    Modal.confirm({
      title: t("systemSettings.modelService.modal.resetTitle"),
      content: t("systemSettings.modelService.modal.resetContent"),
      okText: t("systemSettings.modelService.modal.confirm"),
      cancelText: t("systemSettings.modelService.modal.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResetting(true);
        setErrorMessage(null);
        try {
          const response = await apiClient.delete<ModelServiceSettingsResponse>("system-settings/model-service");
          const data = response.data ?? EMPTY_SETTINGS;
          setSettings(data);
          form.setFieldsValue({
            enabled: data.enabled,
            baseUrl: data.baseUrl ?? "",
            internalToken: "",
            clearToken: false,
            timeoutMs: data.timeoutMs,
            maxRetries: data.maxRetries
          });
          messageApi.success(t("systemSettings.modelService.messages.reset"));
        } catch (error) {
          captureClientError("Failed to reset model service settings", error);
          messageApi.error(t("systemSettings.modelService.errors.resetFailed"));
        } finally {
          setResetting(false);
        }
      }
    });
  };

  const sourceColor = settings.source === "db" ? "green" : "default";
  const sourceLabel =
    settings.source === "db"
      ? t("systemSettings.modelService.status.saved")
      : t("systemSettings.modelService.status.env");

  const enabledColor = settings.enabled ? "green" : "default";
  const enabledLabel = settings.enabled
    ? t("systemSettings.modelService.status.enabled")
    : t("systemSettings.modelService.status.disabled");

  const tokenSourceLabel = t(`systemSettings.modelService.status.tokenSources.${settings.tokenSource}`, {
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
        {t("systemSettings.modelService.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.modelService.notice.title")}
        description={t("systemSettings.modelService.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} />
      ) : null}

      <Space direction="vertical" size="small" style={{ display: "flex", marginBottom: "1rem" }}>
        <Space wrap>
          <Typography.Text>{t("systemSettings.modelService.status.label")}</Typography.Text>
          <Tag color={sourceColor}>{sourceLabel}</Tag>
          <Tag color={enabledColor}>{enabledLabel}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">{t("systemSettings.modelService.status.tokenSource")}</Typography.Text>
          <Tag color={tokenColor}>{tokenSourceLabel}</Tag>
          {settings.baseUrl ? <Tag color="geekblue">{settings.baseUrl}</Tag> : <Tag>-</Tag>}
        </Space>
      </Space>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item name="enabled" valuePropName="checked" label={t("systemSettings.modelService.fields.enabled")}>
          <Switch />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.modelService.fields.baseUrl")}
          name="baseUrl"
          extra={t("systemSettings.modelService.hints.baseUrl")}
        >
          <Input placeholder={t("systemSettings.modelService.placeholders.baseUrl")} />
        </Form.Item>

        <Form.Item
          label={t("systemSettings.modelService.fields.internalToken")}
          name="internalToken"
          extra={t("systemSettings.modelService.hints.internalToken")}
        >
          <Input.Password placeholder={t("systemSettings.modelService.placeholders.internalToken")} />
        </Form.Item>

        <Form.Item name="clearToken" valuePropName="checked">
          <Switch
            checkedChildren={t("systemSettings.modelService.actions.clearToken")}
            unCheckedChildren={t("systemSettings.modelService.actions.keepToken")}
          />
        </Form.Item>

        <Space wrap style={{ display: "flex" }}>
          <Form.Item
            label={t("systemSettings.modelService.fields.timeoutMs")}
            name="timeoutMs"
            rules={[{ required: true, message: t("systemSettings.modelService.validation.timeoutRequired") }]}
            style={{ minWidth: 220, flex: 1 }}
          >
            <InputNumber min={100} max={120_000} step={100} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={t("systemSettings.modelService.fields.maxRetries")}
            name="maxRetries"
            rules={[{ required: true, message: t("systemSettings.modelService.validation.maxRetriesRequired") }]}
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
            {t("systemSettings.modelService.actions.reset")}
          </Button>
        </Space>
      </Form>
    </>
  );
}
