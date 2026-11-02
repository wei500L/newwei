"use client";

import { Alert, Button, Form, InputNumber, Modal, Space, Spin, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SectionHeader } from "@/components/section-header";
import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";
import { formatTimestamp, resolveLocale } from "@/lib/i18n";

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
  recentStatuses: {
    scope: "digest" | "calendar";
    scopeValue: string;
    state: "IDLE" | "QUEUED" | "PROCESSING" | "PARTIAL" | "READY" | "FAILED";
    updatedAt: string;
    errorMessage?: string | null;
  }[];
}

const EMPTY_SETTINGS: ArchivePreparationSettingsResponse = {
  source: "default",
  jobBatchSize: 20,
  embeddingBatchSize: 20,
  embeddingMaxConcurrency: 1,
  rerankMaxConcurrency: 1,
};

export function ArchivePreparationSettingsPanel() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
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
        t("systemSettings.archivePreparation.errors.loadFailed"),
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
        t("systemSettings.archivePreparation.messages.saved"),
      );
    } catch (error) {
      captureClientError("Failed to save archive preparation settings", error);
      messageApi.error(
        extractApiError(error).message ||
          t("systemSettings.archivePreparation.errors.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    Modal.confirm({
      title: t("systemSettings.archivePreparation.modal.resetTitle"),
      content: t("systemSettings.archivePreparation.modal.resetBody"),
      okText: t("common.reset"),
      cancelText: t("common.cancel"),
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
            t("systemSettings.archivePreparation.messages.reset"),
          );
        } catch (error) {
          captureClientError("Failed to reset archive preparation settings", error);
          messageApi.error(
            t("systemSettings.archivePreparation.errors.resetFailed"),
          );
        } finally {
          setResetting(false);
        }
      },
    });
  };

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Spin />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {contextHolder}
      <Typography.Paragraph type="secondary" className="m-0">
        {t("systemSettings.archivePreparation.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.archivePreparation.notice.title")}
        description={t("systemSettings.archivePreparation.notice.body")}
      />

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} />
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionHeader
          title={t("systemSettings.archivePreparation.cardTitle")}
          rule
          extra={
          <Space>
            <Typography.Text type="secondary">
              {t(`systemSettings.archivePreparation.source.${settings.source}`, {
                defaultValue: settings.source === "db" ? "Saved in DB" : "Using defaults",
              })}
            </Typography.Text>
            <Button danger onClick={handleReset} loading={resetting}>
              {t("common.reset")}
            </Button>
            <Button onClick={() => void loadStatus()} loading={statusLoading}>
              {t("systemSettings.archivePreparation.actions.refreshStatus")}
            </Button>
          </Space>
        }
        />
        <Form form={form} layout="vertical" onFinish={handleSubmit} initialValues={EMPTY_SETTINGS}>
          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("systemSettings.archivePreparation.fields.jobBatchSize")}
              name="jobBatchSize"
              rules={[{ required: true }]}
              style={{ minWidth: 220, flex: 1 }}
            >
              <InputNumber min={1} max={100} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("systemSettings.archivePreparation.fields.embeddingBatchSize")}
              name="embeddingBatchSize"
              rules={[{ required: true }]}
              style={{ minWidth: 220, flex: 1 }}
            >
              <InputNumber min={1} max={100} style={{ width: "100%" }} />
            </Form.Item>
          </Space>

          <Space wrap style={{ display: "flex" }}>
            <Form.Item
              label={t("systemSettings.archivePreparation.fields.embeddingMaxConcurrency")}
              name="embeddingMaxConcurrency"
              rules={[{ required: true }]}
              style={{ minWidth: 220, flex: 1 }}
            >
              <InputNumber min={1} max={8} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label={t("systemSettings.archivePreparation.fields.rerankMaxConcurrency")}
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
            className="!mb-4"
            message={t("systemSettings.archivePreparation.hint.title")}
            description={t("systemSettings.archivePreparation.hint.body")}
          />

          <Space>
            <Button type="primary" htmlType="submit" loading={saving}>
              {t("common.save")}
            </Button>
            <Button onClick={() => void loadSettings()}>
              {t("common.refresh")}
            </Button>
          </Space>
        </Form>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader
          title={t("systemSettings.archivePreparation.ops.title")}
          rule
          extra={
          opsStatus ? (
            <Typography.Text type="secondary">
              {t("systemSettings.archivePreparation.ops.updatedAt", {
                value: formatTimestamp(new Date(opsStatus.updatedAt), locale),
              })}
            </Typography.Text>
          ) : null
        }
        />
        <Space wrap size={[8, 8]}>
          <Tag color={opsStatus && opsStatus.pending > 0 ? "processing" : "success"}>
            {t("systemSettings.archivePreparation.ops.pending", {
              count: opsStatus?.pending ?? 0,
            })}
          </Tag>
          <Tag>
            {t("systemSettings.archivePreparation.ops.active", {
              count: opsStatus?.counts.active ?? 0,
            })}
          </Tag>
          <Tag>
            {t("systemSettings.archivePreparation.ops.waiting", {
              count: opsStatus?.counts.waiting ?? 0,
            })}
          </Tag>
          <Tag color={(opsStatus?.counts.failed ?? 0) > 0 ? "error" : "default"}>
            {t("systemSettings.archivePreparation.ops.failed", {
              count: opsStatus?.counts.failed ?? 0,
            })}
          </Tag>
          <Tag>
            {t("systemSettings.archivePreparation.ops.completed", {
              count: opsStatus?.counts.completed ?? 0,
            })}
          </Tag>
        </Space>

        {opsStatus?.recentStatuses.find((item) => item.state === "FAILED")?.errorMessage ? (
          <Alert
            type="warning"
            showIcon
            message={t("systemSettings.archivePreparation.ops.latestFailure")}
            description={opsStatus.recentStatuses.find((item) => item.state === "FAILED")?.errorMessage}
          />
        ) : null}

        <div className="flex flex-col gap-3">
          {(opsStatus?.recentStatuses ?? []).length === 0 ? (
            <Typography.Text type="secondary">
              {t("systemSettings.archivePreparation.ops.empty")}
            </Typography.Text>
          ) : (
            opsStatus?.recentStatuses.map((item) => (
              <div
                key={`${item.scope}:${item.scopeValue}:${item.updatedAt}`}
                className="rounded-lg border border-[var(--border)] px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <Space wrap size={[8, 8]}>
                    <Tag color={item.state === "FAILED" ? "error" : item.state === "READY" ? "success" : "processing"}>
                      {item.state}
                    </Tag>
                    <Typography.Text strong>
                      {item.scope === "digest"
                        ? t("systemSettings.archivePreparation.ops.scopeDigest", {
                            value: item.scopeValue,
                          })
                        : t("systemSettings.archivePreparation.ops.scopeCalendar", {
                            value: item.scopeValue,
                          })}
                    </Typography.Text>
                  </Space>
                  <Typography.Text type="secondary">
                    {formatTimestamp(new Date(item.updatedAt), locale)}
                  </Typography.Text>
                </div>
                {item.errorMessage ? (
                  <Typography.Paragraph type="secondary" className="!mt-2">
                    {item.errorMessage}
                  </Typography.Paragraph>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
