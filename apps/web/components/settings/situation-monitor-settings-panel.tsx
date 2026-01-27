"use client";

import { Alert, Button, Form, InputNumber, Modal, Space, Spin, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

type SituationMonitorSettingsSource = "env" | "db";

interface SituationMonitorSettingsResponse {
  source: SituationMonitorSettingsSource;
  translationMaxConcurrency: number;
}

interface SituationMonitorSettingsFormValues {
  translationMaxConcurrency: number;
}

const EMPTY_SETTINGS: SituationMonitorSettingsResponse = {
  source: "env",
  translationMaxConcurrency: 2,
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
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      form.setFieldsValue({
        translationMaxConcurrency: data.translationMaxConcurrency,
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
      const payload = {
        translationMaxConcurrency: values.translationMaxConcurrency,
      };
      const response = await apiClient.put<SituationMonitorSettingsResponse>(
        "system-settings/situation-monitor",
        payload
      );
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      form.setFieldsValue({ translationMaxConcurrency: data.translationMaxConcurrency });
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
          const data = response.data ?? EMPTY_SETTINGS;
          setSettings(data);
          form.setFieldsValue({ translationMaxConcurrency: data.translationMaxConcurrency });
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

      {errorMessage ? <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} /> : null}

      <Space direction="vertical" size="small" style={{ display: "flex", marginBottom: "1rem" }}>
        <Space wrap>
          <Typography.Text>{t("systemSettings.situationMonitor.status.label")}</Typography.Text>
          <Tag color={sourceColor}>{sourceLabel}</Tag>
        </Space>
      </Space>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("systemSettings.situationMonitor.fields.translationMaxConcurrency")}
          name="translationMaxConcurrency"
          rules={[
            { required: true, message: t("systemSettings.situationMonitor.validation.translationMaxConcurrency") },
            { type: "number", min: 1, max: 10, message: t("common.validation.numberRange", { min: 1, max: 10 }) },
          ]}
          extra={t("systemSettings.situationMonitor.hints.translationMaxConcurrency")}
        >
          <InputNumber min={1} max={10} step={1} style={{ width: "100%" }} />
        </Form.Item>

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

