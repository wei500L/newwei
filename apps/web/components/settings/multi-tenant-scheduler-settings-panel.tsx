"use client";

import {
  Alert,
  Button,
  Form,
  InputNumber,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";

type MultiTenantSchedulerSettingsSource = "default" | "db";

interface MultiTenantSchedulerSettingsResponse {
  source: MultiTenantSchedulerSettingsSource;
  newsEventsIngestionOrgConcurrency: number;
  knowledgeGraphIngestionOrgConcurrency: number;
  sentimentSnapshotOrgConcurrency: number;
  newsnowHottestAnalysisOrgConcurrency: number;
  classificationQualityAlertOrgConcurrency: number;
  userDigestDeliveryOrgConcurrency: number;
}

interface MultiTenantSchedulerSettingsFormValues {
  newsEventsIngestionOrgConcurrency: number;
  knowledgeGraphIngestionOrgConcurrency: number;
  sentimentSnapshotOrgConcurrency: number;
  newsnowHottestAnalysisOrgConcurrency: number;
  classificationQualityAlertOrgConcurrency: number;
  userDigestDeliveryOrgConcurrency: number;
}

const DEFAULT_SETTINGS: MultiTenantSchedulerSettingsResponse = {
  source: "default",
  newsEventsIngestionOrgConcurrency: 4,
  knowledgeGraphIngestionOrgConcurrency: 4,
  sentimentSnapshotOrgConcurrency: 2,
  newsnowHottestAnalysisOrgConcurrency: 6,
  classificationQualityAlertOrgConcurrency: 4,
  userDigestDeliveryOrgConcurrency: 4,
};

export function MultiTenantSchedulerSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<MultiTenantSchedulerSettingsFormValues>();
  const [settings, setSettings] =
    useState<MultiTenantSchedulerSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const applySettings = useCallback(
    (data?: MultiTenantSchedulerSettingsResponse | null) => {
      const next = {
        ...DEFAULT_SETTINGS,
        ...(data ?? {}),
      };
      setSettings(next);
      form.setFieldsValue({
        newsEventsIngestionOrgConcurrency:
          next.newsEventsIngestionOrgConcurrency,
        knowledgeGraphIngestionOrgConcurrency:
          next.knowledgeGraphIngestionOrgConcurrency,
        sentimentSnapshotOrgConcurrency: next.sentimentSnapshotOrgConcurrency,
        newsnowHottestAnalysisOrgConcurrency:
          next.newsnowHottestAnalysisOrgConcurrency,
        classificationQualityAlertOrgConcurrency:
          next.classificationQualityAlertOrgConcurrency,
        userDigestDeliveryOrgConcurrency: next.userDigestDeliveryOrgConcurrency,
      });
    },
    [form],
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response =
        await apiClient.get<MultiTenantSchedulerSettingsResponse>(
          "system-settings/multi-tenant-schedulers",
        );
      applySettings(response.data);
    } catch (error) {
      captureClientError(
        "Failed to load multi-tenant scheduler settings",
        error,
      );
      const messageText =
        extractApiError(error).message ||
        t("systemSettings.multiTenantSchedulers.errors.loadFailed", {
          defaultValue: "Failed to load multi-tenant scheduler settings.",
        });
      setErrorMessage(messageText);
      applySettings(DEFAULT_SETTINGS);
    } finally {
      setLoading(false);
    }
  }, [apiClient, applySettings, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSubmit = async (
    values: MultiTenantSchedulerSettingsFormValues,
  ) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const response =
        await apiClient.put<MultiTenantSchedulerSettingsResponse>(
          "system-settings/multi-tenant-schedulers",
          values,
        );
      applySettings(response.data);
      messageApi.success(
        t("systemSettings.multiTenantSchedulers.messages.saved", {
          defaultValue: "Multi-tenant scheduler settings saved.",
        }),
      );
    } catch (error) {
      captureClientError(
        "Failed to save multi-tenant scheduler settings",
        error,
      );
      const messageText =
        extractApiError(error).message ||
        t("systemSettings.multiTenantSchedulers.errors.saveFailed", {
          defaultValue: "Failed to save multi-tenant scheduler settings.",
        });
      setErrorMessage(messageText);
      messageApi.error(messageText);
    } finally {
      setSaving(false);
    }
  };

  if (loading && settings === null) {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "2rem" }}
      >
        <Spin />
      </div>
    );
  }

  const sourceColor = settings?.source === "db" ? "green" : "default";
  const sourceLabel =
    settings?.source === "db"
      ? t("systemSettings.multiTenantSchedulers.status.saved", {
          defaultValue: "Saved override",
        })
      : t("systemSettings.multiTenantSchedulers.status.default", {
          defaultValue: "Default",
        });

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("systemSettings.multiTenantSchedulers.description", {
          defaultValue:
            "Control how many organizations each background cron can process in parallel. Org-level locks still keep single-flight execution per tenant.",
        })}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.multiTenantSchedulers.notice.title", {
          defaultValue: "Scheduler fan-out policy",
        })}
        description={t("systemSettings.multiTenantSchedulers.notice.body", {
          defaultValue:
            "These limits apply per cron tick. Higher values reduce end-to-end tick latency, but also increase concurrent load on Redis, MySQL, MongoDB, and downstream services.",
        })}
        style={{ marginBottom: "1rem" }}
      />

      {errorMessage ? (
        <Alert
          type="error"
          showIcon
          message={errorMessage}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      <Space wrap style={{ display: "flex", marginBottom: "1rem" }}>
        <Typography.Text>
          {t("systemSettings.multiTenantSchedulers.status.label", {
            defaultValue: "Settings source",
          })}
        </Typography.Text>
        <Tag color={sourceColor}>{sourceLabel}</Tag>
      </Space>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          name="newsEventsIngestionOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.newsEventsIngestionOrgConcurrency",
            {
              defaultValue: "News events ingestion org concurrency",
            },
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.newsEventsIngestionOrgConcurrency",
            {
              defaultValue:
                "How many orgs the news-events ingestion cron may process at once.",
            },
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="knowledgeGraphIngestionOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.knowledgeGraphIngestionOrgConcurrency",
            {
              defaultValue: "Knowledge graph ingestion org concurrency",
            },
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.knowledgeGraphIngestionOrgConcurrency",
            {
              defaultValue:
                "How many orgs the knowledge-graph ingestion cron may process at once.",
            },
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="sentimentSnapshotOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.sentimentSnapshotOrgConcurrency",
            {
              defaultValue: "Sentiment snapshot org concurrency",
            },
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.sentimentSnapshotOrgConcurrency",
            {
              defaultValue:
                "How many orgs the sentiment snapshot rebuild cron may process at once.",
            },
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="newsnowHottestAnalysisOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.newsnowHottestAnalysisOrgConcurrency",
            {
              defaultValue: "NewsNow hottest analysis org concurrency",
            },
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.newsnowHottestAnalysisOrgConcurrency",
            {
              defaultValue:
                "How many orgs the NewsNow hottest-analysis scheduler may refresh at once after the shared global snapshot is prepared.",
            },
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="classificationQualityAlertOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.classificationQualityAlertOrgConcurrency",
            {
              defaultValue: "Classification quality alert org concurrency",
            },
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.classificationQualityAlertOrgConcurrency",
            {
              defaultValue:
                "How many orgs the classification quality alert scheduler may evaluate at once.",
            },
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="userDigestDeliveryOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.userDigestDeliveryOrgConcurrency",
            {
              defaultValue: "User digest delivery org concurrency",
            },
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.userDigestDeliveryOrgConcurrency",
            {
              defaultValue:
                "How many orgs the user digest email scheduler may process at once.",
            },
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Button type="primary" htmlType="submit" loading={saving}>
          {t("common.saveChanges", { defaultValue: "Save changes" })}
        </Button>
      </Form>
    </>
  );
}
