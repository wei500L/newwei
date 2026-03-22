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
        t("systemSettings.taskLogs.errors.loadFailed", {
          defaultValue: "Failed to load task log settings.",
        }),
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
        t("systemSettings.taskLogs.messages.saved", {
          defaultValue: "Task log retention settings saved.",
        }),
      );
    } catch (error) {
      captureClientError("Failed to save task log settings", error);
      messageApi.error(
        extractApiError(error).message ||
          t("systemSettings.taskLogs.errors.saveFailed", {
            defaultValue: "Failed to save task log settings.",
          }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    Modal.confirm({
      title: t("systemSettings.taskLogs.modal.resetTitle", {
        defaultValue: "Reset task log retention?",
      }),
      content: t("systemSettings.taskLogs.modal.resetBody", {
        defaultValue:
          "This restores the default task-log retention window and reapplies the MongoDB TTL index.",
      }),
      okText: t("common.reset", { defaultValue: "Reset" }),
      cancelText: t("common.cancel", { defaultValue: "Cancel" }),
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
            t("systemSettings.taskLogs.messages.reset", {
              defaultValue: "Task log retention settings reset.",
            }),
          );
        } catch (error) {
          captureClientError("Failed to reset task log settings", error);
          messageApi.error(
            t("systemSettings.taskLogs.errors.resetFailed", {
              defaultValue: "Failed to reset task log settings.",
            }),
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
        {t("systemSettings.taskLogs.description", {
          defaultValue:
            "Control how long task logs remain in MongoDB. Hot-path task logs now retain summary and terminal events instead of dense process noise.",
        })}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: "1rem" }}
        message={t("systemSettings.taskLogs.notice.title", {
          defaultValue: "Summary-first retention",
        })}
        description={t("systemSettings.taskLogs.notice.body", {
          defaultValue:
            "Retention is enforced by a MongoDB TTL index. Crawl task detail, queue recovery, and admin logs keep terminal and summary records; transient retry and batch noise is not retained as separate writes.",
        })}
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
          {t("systemSettings.taskLogs.status.label", {
            defaultValue: "Current source",
          })}
          :{" "}
        </Typography.Text>
        <Tag color={settings.source === "db" ? "blue" : "default"}>
          {settings.source === "db"
            ? t("systemSettings.taskLogs.status.db", {
                defaultValue: "Database override",
              })
            : t("systemSettings.taskLogs.status.default", {
                defaultValue: "Environment default",
              })}
        </Tag>
        <Typography.Text>
          {t("systemSettings.taskLogs.status.currentDays", {
            defaultValue: "Current retention: {{days}} days",
            days: settings.retentionDays,
          })}
        </Typography.Text>
      </Space>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("systemSettings.taskLogs.fields.retentionDays", {
            defaultValue: "Retention days",
          })}
          name="retentionDays"
          rules={[
            {
              required: true,
              message: t("systemSettings.taskLogs.validation.retentionRequired", {
                defaultValue: "Retention days is required.",
              }),
            },
            {
              type: "number",
              min: 1,
              max: 3650,
              message: t("systemSettings.taskLogs.validation.retentionRange", {
                defaultValue: "Retention must be between 1 and 3650 days.",
              }),
            },
          ]}
          extra={
            <NumberRangeExtra name="retentionDays" min={1} max={3650} />
          }
        >
          <InputNumber min={1} max={3650} />
        </Form.Item>

        <Typography.Paragraph type="secondary" style={{ marginTop: "-0.5rem" }}>
          {t("systemSettings.taskLogs.hints.retentionDays", {
            defaultValue:
              "Applied to the MongoDB TTL index immediately after save and on server startup.",
          })}
        </Typography.Paragraph>

        <Form.Item style={{ marginBottom: 0 }}>
          <Space wrap>
            <Button type="primary" htmlType="submit" loading={saving}>
              {t("common.saveChanges", { defaultValue: "Save changes" })}
            </Button>
            <Button danger onClick={handleReset} loading={resetting}>
              {t("common.reset", { defaultValue: "Reset" })}
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </>
  );
}
