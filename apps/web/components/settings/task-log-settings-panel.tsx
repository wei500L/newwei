"use client";

import { Alert, Button, Form, InputNumber, Modal, Space, Spin, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { NumberRangeExtra } from "@/components/settings/form-field-feedback";
import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

interface TaskLogSettingsResponse {
  source: "default" | "db";
  retentionDays: number;
}

interface TaskLogSettingsFormValues {
  retentionDays: number;
}

const EMPTY_SETTINGS: TaskLogSettingsResponse = {
  source: "default",
  retentionDays: 14,
};

export function TaskLogSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<TaskLogSettingsFormValues>();
  const [settings, setSettings] = useState<TaskLogSettingsResponse>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const applySettings = useCallback(
    (data: TaskLogSettingsResponse | null | undefined) => {
      const next = data ?? EMPTY_SETTINGS;
      setSettings(next);
      form.setFieldsValue({ retentionDays: next.retentionDays });
    },
    [form],
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<TaskLogSettingsResponse>(
        "system-settings/task-logs",
      );
      applySettings(response.data);
    } catch (error) {
      captureClientError("Failed to load task log settings", error);
      setErrorMessage(
        t("systemSettings.taskLogs.errors.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, applySettings, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSubmit = async (values: TaskLogSettingsFormValues) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.put<TaskLogSettingsResponse>(
        "system-settings/task-logs",
        values,
      );
      applySettings(response.data);
      messageApi.success(
        t("systemSettings.taskLogs.messages.saved"),
      );
    } catch (error) {
      captureClientError("Failed to save task log settings", error);
      messageApi.error(
        extractApiError(error).message ||
          t("systemSettings.taskLogs.errors.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    Modal.confirm({
      title: t("systemSettings.taskLogs.modal.resetTitle"),
      content: t("systemSettings.taskLogs.modal.resetBody"),
      okText: t("common.reset"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResetting(true);
        setErrorMessage(null);
        try {
          const response = await apiClient.delete<TaskLogSettingsResponse>(
            "system-settings/task-logs",
          );
          applySettings(response.data);
          messageApi.success(
            t("systemSettings.taskLogs.messages.reset"),
          );
        } catch (error) {
          captureClientError("Failed to reset task log settings", error);
          messageApi.error(
            t("systemSettings.taskLogs.errors.resetFailed"),
          );
        } finally {
          setResetting(false);
        }
      },
    });
  };

  if (loading) {
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
        {t("systemSettings.taskLogs.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: "1rem" }}
        message={t("systemSettings.taskLogs.notice.title")}
        description={t("systemSettings.taskLogs.notice.body")}
      />

      {errorMessage ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: "1rem" }}
          message={errorMessage}
        />
      ) : null}

      <Space
        size="middle"
        style={{ display: "flex", marginBottom: "1rem", flexWrap: "wrap" }}
      >
        <Typography.Text strong>
          {t("systemSettings.taskLogs.status.label")}
          :{" "}
        </Typography.Text>
        <Tag color={settings.source === "db" ? "blue" : "default"}>
          {settings.source === "db"
            ? t("systemSettings.taskLogs.status.db")
            : t("systemSettings.taskLogs.status.default")}
        </Tag>
        <Typography.Text>
          {t("systemSettings.taskLogs.status.currentDays", {
            days: settings.retentionDays,
          })}
        </Typography.Text>
      </Space>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("systemSettings.taskLogs.fields.retentionDays")}
          name="retentionDays"
          rules={[
            {
              required: true,
              message: t("systemSettings.taskLogs.validation.retentionRequired"),
            },
            {
              type: "number",
              min: 1,
              max: 3650,
              message: t("systemSettings.taskLogs.validation.retentionRange"),
            },
          ]}
          extra={
            <NumberRangeExtra name="retentionDays" min={1} max={3650} />
          }
        >
          <InputNumber min={1} max={3650} />
        </Form.Item>

        <Typography.Paragraph type="secondary" style={{ marginTop: "-0.5rem" }}>
          {t("systemSettings.taskLogs.hints.retentionDays")}
        </Typography.Paragraph>

        <Form.Item style={{ marginBottom: 0 }}>
          <Space wrap>
            <Button type="primary" htmlType="submit" loading={saving}>
              {t("common.saveChanges")}
            </Button>
            <Button danger onClick={handleReset} loading={resetting}>
              {t("common.reset")}
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </>
  );
}
