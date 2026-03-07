"use client";

import { Alert, Button, Card, Form, InputNumber, Modal, Space, Spin, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

interface ArchivePreparationSettingsResponse {
  source: "default" | "db";
  jobBatchSize: number;
  embeddingBatchSize: number;
  embeddingMaxConcurrency: number;
  rerankMaxConcurrency: number;
}

interface ArchivePreparationFormValues {
  jobBatchSize: number;
  embeddingBatchSize: number;
  embeddingMaxConcurrency: number;
  rerankMaxConcurrency: number;
}

interface ArchivePreparationOperationalStatusResponse {
  updatedAt: string;
  pending: number;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  recentStatuses: Array<{
    scope: "digest" | "calendar";
    scopeValue: string;
    state: "IDLE" | "QUEUED" | "PROCESSING" | "PARTIAL" | "READY" | "FAILED";
    updatedAt: string;
    errorMessage?: string | null;
  }>;
}

const EMPTY_SETTINGS: ArchivePreparationSettingsResponse = {
  source: "default",
  jobBatchSize: 20,
  embeddingBatchSize: 20,
  embeddingMaxConcurrency: 1,
  rerankMaxConcurrency: 1,
};

export function ArchivePreparationSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<ArchivePreparationFormValues>();
  const [settings, setSettings] = useState<ArchivePreparationSettingsResponse>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [opsStatus, setOpsStatus] =
    useState<ArchivePreparationOperationalStatusResponse | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const applySettings = useCallback(
    (data: ArchivePreparationSettingsResponse) => {
      setSettings(data);
      form.setFieldsValue({
        jobBatchSize: data.jobBatchSize,
        embeddingBatchSize: data.embeddingBatchSize,
        embeddingMaxConcurrency: data.embeddingMaxConcurrency,
        rerankMaxConcurrency: data.rerankMaxConcurrency,
      });
    },
    [form],
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<ArchivePreparationSettingsResponse>(
        "system-settings/archive-preparation",
      );
      applySettings(response.data ?? EMPTY_SETTINGS);
    } catch (error) {
      captureClientError("Failed to load archive preparation settings", error);
      setErrorMessage(
        t("systemSettings.archivePreparation.errors.loadFailed", {
          defaultValue: "Failed to load archive preparation settings.",
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [apiClient, applySettings, t]);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const response = await apiClient.get<ArchivePreparationOperationalStatusResponse>(
        "admin/archive-preparation/status",
      );
      setOpsStatus(response.data ?? null);
    } catch (error) {
      captureClientError("Failed to load archive preparation operational status", error);
    } finally {
      setStatusLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    void loadSettings();
    void loadStatus();
  }, [loadSettings, loadStatus]);

  const handleSubmit = async (values: ArchivePreparationFormValues) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.put<ArchivePreparationSettingsResponse>(
        "system-settings/archive-preparation",
        values,
      );
      applySettings(response.data ?? EMPTY_SETTINGS);
      messageApi.success(
        t("systemSettings.archivePreparation.messages.saved", {
          defaultValue: "Archive preparation settings saved.",
        }),
      );
    } catch (error) {
      captureClientError("Failed to save archive preparation settings", error);
      messageApi.error(
        extractApiError(error).message ||
          t("systemSettings.archivePreparation.errors.saveFailed", {
            defaultValue: "Failed to save archive preparation settings.",
          }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    Modal.confirm({
      title: t("systemSettings.archivePreparation.modal.resetTitle", {
        defaultValue: "Reset archive preparation settings?",
      }),
      content: t("systemSettings.archivePreparation.modal.resetBody", {
        defaultValue: "This restores the default low-memory batch and concurrency limits.",
      }),
      okText: t("common.reset", { defaultValue: "Reset" }),
      cancelText: t("common.cancel", { defaultValue: "Cancel" }),
      okButtonProps: { danger: true },
      onOk: async () => {
        setResetting(true);
        setErrorMessage(null);
        try {
          const response = await apiClient.delete<ArchivePreparationSettingsResponse>(
            "system-settings/archive-preparation",
          );
          applySettings(response.data ?? EMPTY_SETTINGS);
          messageApi.success(
            t("systemSettings.archivePreparation.messages.reset", {
              defaultValue: "Archive preparation settings reset.",
            }),
          );
        } catch (error) {
          captureClientError("Failed to reset archive preparation settings", error);
          messageApi.error(
            t("systemSettings.archivePreparation.errors.resetFailed", {
              defaultValue: "Failed to reset archive preparation settings.",
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
        {t("systemSettings.archivePreparation.description", {
          defaultValue:
            "Control archive background preparation batch sizes and embedding/rerank concurrency. Lower values reduce memory and rate-limit pressure.",
        })}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: "1rem" }}
        message={t("systemSettings.archivePreparation.notice.title", {
          defaultValue: "Background-only preparation",
        })}
        description={t("systemSettings.archivePreparation.notice.body", {
          defaultValue:
            "These limits apply only to archive preparation workers. Model selection still follows the active LLM gateway embedding/rerank profiles.",
        })}
      />

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} />
      ) : null}

      <Card
        title={t("systemSettings.archivePreparation.cardTitle", {
          defaultValue: "Archive preparation settings",
        })}
        extra={
          <Space>
            <Typography.Text type="secondary">
              {t(`systemSettings.archivePreparation.source.${settings.source}`, {
                defaultValue: settings.source === "db" ? "Saved in DB" : "Using defaults",
              })}
            </Typography.Text>
            <Button danger onClick={handleReset} loading={resetting}>
              {t("common.reset", { defaultValue: "Reset" })}
            </Button>
            <Button onClick={() => void loadStatus()} loading={statusLoading}>
              {t("systemSettings.archivePreparation.actions.refreshStatus", {
                defaultValue: "Refresh status",
              })}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} initialValues={EMPTY_SETTINGS}>
          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("systemSettings.archivePreparation.fields.jobBatchSize", {
                defaultValue: "Job batch size",
              })}
              name="jobBatchSize"
              rules={[{ required: true }]}
              style={{ minWidth: 220, flex: 1 }}
            >
              <InputNumber min={1} max={100} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("systemSettings.archivePreparation.fields.embeddingBatchSize", {
                defaultValue: "Embedding batch size",
              })}
              name="embeddingBatchSize"
              rules={[{ required: true }]}
              style={{ minWidth: 220, flex: 1 }}
            >
              <InputNumber min={1} max={100} style={{ width: "100%" }} />
            </Form.Item>
          </Space>

          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("systemSettings.archivePreparation.fields.embeddingMaxConcurrency", {
                defaultValue: "Embedding max concurrency",
              })}
              name="embeddingMaxConcurrency"
              rules={[{ required: true }]}
              style={{ minWidth: 220, flex: 1 }}
            >
              <InputNumber min={1} max={8} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("systemSettings.archivePreparation.fields.rerankMaxConcurrency", {
                defaultValue: "Rerank max concurrency",
              })}
              name="rerankMaxConcurrency"
              rules={[{ required: true }]}
              style={{ minWidth: 220, flex: 1 }}
            >
              <InputNumber min={1} max={8} style={{ width: "100%" }} />
            </Form.Item>
          </Space>

          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: "1rem" }}
            message={t("systemSettings.archivePreparation.hint.title", {
              defaultValue: "Recommended starting point",
            })}
            description={t("systemSettings.archivePreparation.hint.body", {
              defaultValue:
                "Start with batch size 20 and concurrency 1/1. Increase gradually only after confirming the rerank RPM budget is stable.",
            })}
          />

          <Space>
            <Button type="primary" htmlType="submit" loading={saving}>
              {t("common.save", { defaultValue: "Save" })}
            </Button>
            <Button onClick={() => void loadSettings()}>
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
          </Space>
        </Form>
      </Card>

      <Card
        title={t("systemSettings.archivePreparation.ops.title", {
          defaultValue: "Operational visibility",
        })}
        style={{ marginTop: "1rem" }}
        extra={
          opsStatus ? (
            <Typography.Text type="secondary">
              {t("systemSettings.archivePreparation.ops.updatedAt", {
                defaultValue: "Updated {{value}}",
                value: new Date(opsStatus.updatedAt).toLocaleString(),
              })}
            </Typography.Text>
          ) : null
        }
      >
        <Space wrap size={[8, 8]} style={{ marginBottom: "1rem" }}>
          <Tag color={opsStatus && opsStatus.pending > 0 ? "processing" : "green"}>
            {t("systemSettings.archivePreparation.ops.pending", {
              defaultValue: "Pending: {{count}}",
              count: opsStatus?.pending ?? 0,
            })}
          </Tag>
          <Tag>
            {t("systemSettings.archivePreparation.ops.active", {
              defaultValue: "Active: {{count}}",
              count: opsStatus?.counts.active ?? 0,
            })}
          </Tag>
          <Tag>
            {t("systemSettings.archivePreparation.ops.waiting", {
              defaultValue: "Waiting: {{count}}",
              count: opsStatus?.counts.waiting ?? 0,
            })}
          </Tag>
          <Tag color={(opsStatus?.counts.failed ?? 0) > 0 ? "volcano" : "default"}>
            {t("systemSettings.archivePreparation.ops.failed", {
              defaultValue: "Failed: {{count}}",
              count: opsStatus?.counts.failed ?? 0,
            })}
          </Tag>
          <Tag>
            {t("systemSettings.archivePreparation.ops.completed", {
              defaultValue: "Completed: {{count}}",
              count: opsStatus?.counts.completed ?? 0,
            })}
          </Tag>
        </Space>

        {opsStatus?.recentStatuses.find((item) => item.state === "FAILED")?.errorMessage ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: "1rem" }}
            message={t("systemSettings.archivePreparation.ops.latestFailure", {
              defaultValue: "Latest failure",
            })}
            description={opsStatus.recentStatuses.find((item) => item.state === "FAILED")?.errorMessage}
          />
        ) : null}

        <div className="flex flex-col gap-3">
          {(opsStatus?.recentStatuses ?? []).length === 0 ? (
            <Typography.Text type="secondary">
              {t("systemSettings.archivePreparation.ops.empty", {
                defaultValue: "No recent archive preparation activity.",
              })}
            </Typography.Text>
          ) : (
            opsStatus?.recentStatuses.map((item) => (
              <div
                key={`${item.scope}:${item.scopeValue}:${item.updatedAt}`}
                className="rounded-lg border border-slate-200/80 px-3 py-2 dark:border-slate-700/80"
              >
                <div className="flex items-center justify-between gap-3">
                  <Space wrap size={[8, 8]}>
                    <Tag color={item.state === "FAILED" ? "volcano" : item.state === "READY" ? "green" : "processing"}>
                      {item.state}
                    </Tag>
                    <Typography.Text strong>
                      {item.scope === "digest"
                        ? t("systemSettings.archivePreparation.ops.scopeDigest", {
                            defaultValue: "Digest {{value}}",
                            value: item.scopeValue,
                          })
                        : t("systemSettings.archivePreparation.ops.scopeCalendar", {
                            defaultValue: "Calendar {{value}}",
                            value: item.scopeValue,
                          })}
                    </Typography.Text>
                  </Space>
                  <Typography.Text type="secondary">
                    {new Date(item.updatedAt).toLocaleString()}
                  </Typography.Text>
                </div>
                {item.errorMessage ? (
                  <Typography.Paragraph type="secondary" style={{ margin: "0.5rem 0 0" }}>
                    {item.errorMessage}
                  </Typography.Paragraph>
                ) : null}
              </div>
            ))
          )}
        </div>
      </Card>
    </>
  );
}
