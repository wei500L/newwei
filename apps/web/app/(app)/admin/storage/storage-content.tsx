"use client";

import { Alert, Button, Card, Form, Input, Select, Spin, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

interface StorageSettingsResponse {
  crawlImageStorage: "mysql" | "s3";
  region: string;
  bucket: string;
  endpoint?: string;
  publicBaseUrl: string;
}

interface StorageConnectionTestResponse {
  ok: boolean;
  mode?: "mysql" | "s3";
  error?: string;
  bucket?: string;
  region?: string;
  endpoint?: string;
  publicBaseUrl?: string;
  forcePathStyle?: boolean;
  presignedUrlTtlSeconds?: number;
  checks?: {
    mysql?: {
      ok: boolean;
      error?: string;
    };
    headBucket?: {
      ok: boolean;
      error?: string;
      httpStatusCode?: number;
      requestId?: string;
    };
    putObject?: {
      ok: boolean;
      error?: string;
      httpStatusCode?: number;
      requestId?: string;
    };
    deleteObject?: {
      ok: boolean;
      error?: string;
      httpStatusCode?: number;
      requestId?: string;
    };
  };
}

interface StorageSettingsFormValues {
  crawlImageStorage: "mysql" | "s3";
  region?: string;
  bucket?: string;
  endpoint?: string;
  publicBaseUrl?: string;
}

export function StorageSettingsContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionResult, setConnectionResult] =
    useState<StorageConnectionTestResponse | null>(null);
  const [form] = Form.useForm<StorageSettingsFormValues>();
  const crawlImageStorage = Form.useWatch("crawlImageStorage", form) ?? "mysql";
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
        crawlImageStorage: response.data.crawlImageStorage ?? "mysql",
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
        crawlImageStorage: values.crawlImageStorage,
        region: values.region?.trim() ? values.region.trim() : undefined,
        bucket: values.bucket?.trim() ? values.bucket.trim() : undefined,
        endpoint: values.endpoint?.trim() ? values.endpoint.trim() : null,
        publicBaseUrl: values.publicBaseUrl?.trim()
          ? values.publicBaseUrl.trim()
          : undefined
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
    setConnectionResult(null);
    try {
      const response = await apiClient.post<StorageConnectionTestResponse>(
        "admin/settings/storage/test"
      );
      setConnectionResult(response.data);
      if (response.data.ok) {
        messageApi.success(t("storageSettings.testSuccess"));
        return;
      }
      messageApi.error(response.data.error ?? t("storageSettings.testFailed"));
    } catch (err) {
      captureClientError("Failed to test storage connection", err);
      setConnectionResult(null);
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
      {connectionResult ? (
        <Alert
          type={connectionResult.ok ? "success" : "error"}
          showIcon
          message={
            connectionResult.ok
              ? t("storageSettings.testResult.ok")
              : t("storageSettings.testResult.failed")
          }
          description={
            <div>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                {connectionResult.error
                  ? connectionResult.error
                  : t("storageSettings.testResult.noError")}
              </Typography.Paragraph>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {JSON.stringify(connectionResult, null, 2)}
              </pre>
            </div>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Form form={form} layout="vertical" onFinish={handleSave}>
        <Form.Item
          label={t("storageSettings.fields.crawlImageStorage")}
          name="crawlImageStorage"
          initialValue="mysql"
          rules={[{ required: true }]}
        >
          <Select
            options={[
              {
                value: "mysql",
                label: t("storageSettings.options.crawlImageStorage.mysql")
              },
              {
                value: "s3",
                label: t("storageSettings.options.crawlImageStorage.s3")
              }
            ]}
          />
        </Form.Item>
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
          rules={
            crawlImageStorage === "s3"
              ? [{ required: true, message: t("storageSettings.validation.region") }]
              : []
          }
        >
          <Input placeholder={t("storageSettings.placeholders.region")} />
        </Form.Item>
        <Form.Item
          label={t("storageSettings.fields.bucket")}
          name="bucket"
          rules={
            crawlImageStorage === "s3"
              ? [{ required: true, message: t("storageSettings.validation.bucket") }]
              : []
          }
        >
          <Input placeholder={t("storageSettings.placeholders.bucket")} />
        </Form.Item>
        <Form.Item
          label={t("storageSettings.fields.publicBaseUrl")}
          name="publicBaseUrl"
          rules={[
            ...(crawlImageStorage === "s3"
              ? [{ required: true, message: t("storageSettings.validation.publicBaseUrl") }]
              : []),
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
