"use client";

import { Alert, Button, Card, Form, Input, Spin, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

interface StorageSettingsResponse {
  region: string;
  bucket: string;
  endpoint?: string;
  publicBaseUrl: string;
}

interface StorageConnectionTestResponse {
  ok: boolean;
  error?: string;
}

interface StorageSettingsFormValues {
  region: string;
  bucket: string;
  endpoint?: string;
  publicBaseUrl: string;
}

export function StorageSettingsContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm<StorageSettingsFormValues>();
  const canView = session?.permissions?.includes("settings.manage") ?? false;

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<StorageSettingsResponse>("admin/settings/storage");
      form.setFieldsValue({
        region: response.data.region,
        bucket: response.data.bucket,
        endpoint: response.data.endpoint,
        publicBaseUrl: response.data.publicBaseUrl
      });
    } catch (err) {
      captureClientError("Failed to load storage settings", err);
      setError(t("storageSettings.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, t]);

  useEffect(() => {
    if (canView) {
      void loadSettings();
    }
  }, [canView, loadSettings]);

  const handleSave = async (values: StorageSettingsFormValues) => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        region: values.region.trim(),
        bucket: values.bucket.trim(),
        endpoint: values.endpoint?.trim() ? values.endpoint.trim() : null,
        publicBaseUrl: values.publicBaseUrl.trim()
      };
      await apiClient.patch("admin/settings/storage", payload);
      messageApi.success(t("storageSettings.saved"));
    } catch (err) {
      captureClientError("Failed to update storage settings", err);
      messageApi.error(t("storageSettings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = useCallback(async () => {
    setTesting(true);
    setError(null);
    try {
      const response = await apiClient.post<StorageConnectionTestResponse>(
        "admin/settings/storage/test"
      );
      if (response.data.ok) {
        messageApi.success(t("storageSettings.testSuccess"));
        return;
      }
      messageApi.error(response.data.error ?? t("storageSettings.testFailed"));
    } catch (err) {
      captureClientError("Failed to test storage connection", err);
      messageApi.error(t("storageSettings.testFailed"));
    } finally {
      setTesting(false);
    }
  }, [apiClient, messageApi, t]);

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card" title={t("storageSettings.title")}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  return (
    <Card
      className="content-card"
      title={t("storageSettings.title")}
      extra={
        <div style={{ display: "flex", gap: 8 }}>
          <Button onClick={() => void handleTestConnection()} loading={testing}>
            {t("storageSettings.test")}
          </Button>
          <Button onClick={() => void loadSettings()} loading={loading}>
            {t("common.refresh")}
          </Button>
        </div>
      }
    >
      {contextHolder}
      <Typography.Paragraph type="secondary">
        {t("storageSettings.description")}
      </Typography.Paragraph>
      {error ? (
        <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />
      ) : null}
      <Form form={form} layout="vertical" onFinish={handleSave}>
        <Form.Item
          label={t("storageSettings.fields.endpoint")}
          name="endpoint"
          rules={[{ type: "url", message: t("storageSettings.validation.endpoint") }]}
        >
          <Input placeholder={t("storageSettings.placeholders.endpoint")} allowClear />
        </Form.Item>
        <Form.Item
          label={t("storageSettings.fields.region")}
          name="region"
          rules={[{ required: true, message: t("storageSettings.validation.region") }]}
        >
          <Input placeholder={t("storageSettings.placeholders.region")} />
        </Form.Item>
        <Form.Item
          label={t("storageSettings.fields.bucket")}
          name="bucket"
          rules={[{ required: true, message: t("storageSettings.validation.bucket") }]}
        >
          <Input placeholder={t("storageSettings.placeholders.bucket")} />
        </Form.Item>
        <Form.Item
          label={t("storageSettings.fields.publicBaseUrl")}
          name="publicBaseUrl"
          rules={[
            { required: true, message: t("storageSettings.validation.publicBaseUrl") },
            { type: "url", message: t("storageSettings.validation.endpoint") }
          ]}
        >
          <Input placeholder={t("storageSettings.placeholders.publicBaseUrl")} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.save")}
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}
