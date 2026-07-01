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
  realtimeSignalsOrgConcurrency: number;
  newsEventsTimelineOrgConcurrency: number;
  newsEventsIngestionOrgConcurrency: number;
  knowledgeGraphIngestionOrgConcurrency: number;
  sentimentSnapshotOrgConcurrency: number;
  newsnowHottestAnalysisOrgConcurrency: number;
  classificationQualityAlertOrgConcurrency: number;
  newsIndicatorAssociationOrgConcurrency: number;
  crawlQualityTaskSnapshotOrgConcurrency: number;
  situationMonitorOrefDefaultRuleOrgConcurrency: number;
  userDigestDeliveryOrgConcurrency: number;
}

interface MultiTenantSchedulerSettingsFormValues {
  realtimeSignalsOrgConcurrency: number;
  newsEventsTimelineOrgConcurrency: number;
  newsEventsIngestionOrgConcurrency: number;
  knowledgeGraphIngestionOrgConcurrency: number;
  sentimentSnapshotOrgConcurrency: number;
  newsnowHottestAnalysisOrgConcurrency: number;
  classificationQualityAlertOrgConcurrency: number;
  newsIndicatorAssociationOrgConcurrency: number;
  crawlQualityTaskSnapshotOrgConcurrency: number;
  situationMonitorOrefDefaultRuleOrgConcurrency: number;
  userDigestDeliveryOrgConcurrency: number;
}

const DEFAULT_SETTINGS: MultiTenantSchedulerSettingsResponse = {
  source: "default",
  realtimeSignalsOrgConcurrency: 4,
  newsEventsTimelineOrgConcurrency: 2,
  newsEventsIngestionOrgConcurrency: 4,
  knowledgeGraphIngestionOrgConcurrency: 4,
  sentimentSnapshotOrgConcurrency: 2,
  newsnowHottestAnalysisOrgConcurrency: 6,
  classificationQualityAlertOrgConcurrency: 4,
  newsIndicatorAssociationOrgConcurrency: 2,
  crawlQualityTaskSnapshotOrgConcurrency: 2,
  situationMonitorOrefDefaultRuleOrgConcurrency: 16,
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
        realtimeSignalsOrgConcurrency: next.realtimeSignalsOrgConcurrency,
        newsEventsTimelineOrgConcurrency: next.newsEventsTimelineOrgConcurrency,
        newsEventsIngestionOrgConcurrency:
          next.newsEventsIngestionOrgConcurrency,
        knowledgeGraphIngestionOrgConcurrency:
          next.knowledgeGraphIngestionOrgConcurrency,
        sentimentSnapshotOrgConcurrency: next.sentimentSnapshotOrgConcurrency,
        newsnowHottestAnalysisOrgConcurrency:
          next.newsnowHottestAnalysisOrgConcurrency,
        classificationQualityAlertOrgConcurrency:
          next.classificationQualityAlertOrgConcurrency,
        newsIndicatorAssociationOrgConcurrency:
          next.newsIndicatorAssociationOrgConcurrency,
        crawlQualityTaskSnapshotOrgConcurrency:
          next.crawlQualityTaskSnapshotOrgConcurrency,
        situationMonitorOrefDefaultRuleOrgConcurrency:
          next.situationMonitorOrefDefaultRuleOrgConcurrency,
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
        t("systemSettings.multiTenantSchedulers.errors.loadFailed");
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
        t("systemSettings.multiTenantSchedulers.messages.saved"),
      );
    } catch (error) {
      captureClientError(
        "Failed to save multi-tenant scheduler settings",
        error,
      );
      const messageText =
        extractApiError(error).message ||
        t("systemSettings.multiTenantSchedulers.errors.saveFailed");
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
      ? t("systemSettings.multiTenantSchedulers.status.saved")
      : t("systemSettings.multiTenantSchedulers.status.default");

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("systemSettings.multiTenantSchedulers.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.multiTenantSchedulers.notice.title")}
        description={t("systemSettings.multiTenantSchedulers.notice.body")}
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
          {t("systemSettings.multiTenantSchedulers.status.label")}
        </Typography.Text>
        <Tag color={sourceColor}>{sourceLabel}</Tag>
      </Space>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          name="realtimeSignalsOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.realtimeSignalsOrgConcurrency",
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.realtimeSignalsOrgConcurrency",
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="newsEventsTimelineOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.newsEventsTimelineOrgConcurrency",
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.newsEventsTimelineOrgConcurrency",
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="newsEventsIngestionOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.newsEventsIngestionOrgConcurrency",
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.newsEventsIngestionOrgConcurrency",
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="knowledgeGraphIngestionOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.knowledgeGraphIngestionOrgConcurrency",
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.knowledgeGraphIngestionOrgConcurrency",
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="sentimentSnapshotOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.sentimentSnapshotOrgConcurrency",
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.sentimentSnapshotOrgConcurrency",
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="newsnowHottestAnalysisOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.newsnowHottestAnalysisOrgConcurrency",
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.newsnowHottestAnalysisOrgConcurrency",
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="classificationQualityAlertOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.classificationQualityAlertOrgConcurrency",
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.classificationQualityAlertOrgConcurrency",
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="newsIndicatorAssociationOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.newsIndicatorAssociationOrgConcurrency",
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.newsIndicatorAssociationOrgConcurrency",
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="crawlQualityTaskSnapshotOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.crawlQualityTaskSnapshotOrgConcurrency",
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.crawlQualityTaskSnapshotOrgConcurrency",
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="situationMonitorOrefDefaultRuleOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.situationMonitorOrefDefaultRuleOrgConcurrency",
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.situationMonitorOrefDefaultRuleOrgConcurrency",
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item
          name="userDigestDeliveryOrgConcurrency"
          label={t(
            "systemSettings.multiTenantSchedulers.fields.userDigestDeliveryOrgConcurrency",
          )}
          extra={t(
            "systemSettings.multiTenantSchedulers.hints.userDigestDeliveryOrgConcurrency",
          )}
        >
          <InputNumber min={1} max={16} style={{ width: "100%" }} />
        </Form.Item>

        <Button type="primary" htmlType="submit" loading={saving}>
          {t("common.saveChanges")}
        </Button>
      </Form>
    </>
  );
}
