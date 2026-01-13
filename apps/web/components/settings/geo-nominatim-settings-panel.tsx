"use client";

import { Alert, Button, Form, Input, Space, Spin, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

interface GeoNominatimGeocodeResult {
  lat: number;
  lng: number;
  displayName?: string;
  provider: string;
  query: string;
  countryCodeAlpha2?: string;
}

interface GeoNominatimTestResponse {
  result: GeoNominatimGeocodeResult | null;
}

interface GeoNominatimSettingsResponse {
  userAgent: string | null;
  email: string | null;
  effectiveUserAgent: string;
  effectiveEmail: string | null;
}

interface GeoNominatimSettingsFormValues {
  userAgent?: string;
  email?: string;
}

interface GeoNominatimTestFormValues {
  query: string;
  countryCodeAlpha2?: string;
}

const EMPTY_SETTINGS: GeoNominatimSettingsResponse = {
  userAgent: null,
  email: null,
  effectiveUserAgent: "modular-api",
  effectiveEmail: null
};

export function GeoNominatimSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<GeoNominatimSettingsFormValues>();
  const [testForm] = Form.useForm<GeoNominatimTestFormValues>();
  const [settings, setSettings] = useState<GeoNominatimSettingsResponse>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<GeoNominatimGeocodeResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [testErrorMessage, setTestErrorMessage] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<GeoNominatimSettingsResponse>("system-settings/geo/nominatim");
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      form.setFieldsValue({
        userAgent: data.userAgent ?? "",
        email: data.email ?? ""
      });
    } catch (error) {
      captureClientError("Failed to load Nominatim settings", error);
      setErrorMessage(t("systemSettings.geoNominatim.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSubmit = async (values: GeoNominatimSettingsFormValues) => {
    setSaving(true);
    setErrorMessage(null);
    try {
      const userAgent = values.userAgent?.trim() ? values.userAgent.trim() : null;
      const email = values.email?.trim() ? values.email.trim() : null;
      const response = await apiClient.put<GeoNominatimSettingsResponse>("system-settings/geo/nominatim", {
        userAgent,
        email
      });
      const data = response.data ?? EMPTY_SETTINGS;
      setSettings(data);
      form.setFieldsValue({
        userAgent: data.userAgent ?? "",
        email: data.email ?? ""
      });
      messageApi.success(t("systemSettings.geoNominatim.messages.saved"));
    } catch (error) {
      captureClientError("Failed to save Nominatim settings", error);
      const statusCode =
        typeof error === "object" && error && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (statusCode === 400) {
        messageApi.error(t("systemSettings.geoNominatim.errors.badRequest"));
      } else {
        messageApi.error(t("systemSettings.geoNominatim.errors.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (values: GeoNominatimTestFormValues) => {
    setTesting(true);
    setTestErrorMessage(null);
    setTestResult(null);
    try {
      const response = await apiClient.post<GeoNominatimTestResponse>(
        "system-settings/geo/nominatim/test",
        {
          query: values.query.trim(),
          countryCodeAlpha2: values.countryCodeAlpha2?.trim() ? values.countryCodeAlpha2.trim() : undefined
        }
      );
      const result = response.data?.result ?? null;
      setTestResult(result);
      if (!result) {
        messageApi.info(t("systemSettings.geoNominatim.test.noResult"));
      }
    } catch (error) {
      captureClientError("Failed to test Nominatim geocoding", error);
      setTestErrorMessage(t("systemSettings.geoNominatim.test.errors.failed"));
    } finally {
      setTesting(false);
    }
  };

  const overrideUserAgent = Boolean(settings.userAgent);
  const overrideEmail = Boolean(settings.email);
  const statusTagColor = overrideUserAgent || overrideEmail ? "green" : "default";
  const statusLabel = overrideUserAgent || overrideEmail
    ? t("systemSettings.geoNominatim.status.overridden")
    : t("systemSettings.geoNominatim.status.env");

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
        {t("systemSettings.geoNominatim.description")}
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        message={t("systemSettings.geoNominatim.notice.title")}
        description={t("systemSettings.geoNominatim.notice.body")}
        style={{ marginBottom: "1rem" }}
      />

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} />
      ) : null}

      <Space direction="vertical" size="small" style={{ display: "flex", marginBottom: "1rem" }}>
        <Space wrap>
          <Typography.Text>{t("systemSettings.geoNominatim.status.label")}</Typography.Text>
          <Tag color={statusTagColor}>{statusLabel}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.geoNominatim.status.effectiveUserAgent")}
          </Typography.Text>
          <Tag color="blue">{settings.effectiveUserAgent || "-"}</Tag>
        </Space>
        <Space wrap>
          <Typography.Text type="secondary">
            {t("systemSettings.geoNominatim.status.effectiveEmail")}
          </Typography.Text>
          <Tag color="blue">{settings.effectiveEmail || "-"}</Tag>
        </Space>
      </Space>

      <Form layout="vertical" form={form} onFinish={handleSubmit}>
        <Form.Item
          label={t("systemSettings.geoNominatim.fields.userAgent")}
          name="userAgent"
          rules={[{ required: false }]}
          extra={t("systemSettings.geoNominatim.hints.userAgent")}
        >
          <Input placeholder={t("systemSettings.geoNominatim.placeholders.userAgent")} />
        </Form.Item>
        <Form.Item
          label={t("systemSettings.geoNominatim.fields.email")}
          name="email"
          rules={[{ type: "email", message: t("systemSettings.geoNominatim.validation.email") }]}
          extra={t("systemSettings.geoNominatim.hints.email")}
        >
          <Input placeholder={t("systemSettings.geoNominatim.placeholders.email")} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.saveChanges")}
          </Button>
        </Form.Item>
      </Form>

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        {t("systemSettings.geoNominatim.test.title")}
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: "1rem" }}>
        {t("systemSettings.geoNominatim.test.description")}
      </Typography.Paragraph>

      {testErrorMessage ? (
        <Alert type="error" showIcon message={testErrorMessage} style={{ marginBottom: "1rem" }} />
      ) : null}

      <Form layout="inline" form={testForm} onFinish={handleTest}>
        <Form.Item
          name="query"
          rules={[{ required: true, message: t("systemSettings.geoNominatim.test.validation.query") }]}
        >
          <Input
            style={{ minWidth: 260 }}
            placeholder={t("systemSettings.geoNominatim.test.placeholders.query")}
          />
        </Form.Item>
        <Form.Item
          name="countryCodeAlpha2"
          rules={[
            {
              validator: async (_rule, value: unknown) => {
                if (value === undefined || value === null || value === "") {
                  return;
                }
                if (typeof value !== "string") {
                  throw new Error(t("systemSettings.geoNominatim.test.validation.countryCode"));
                }
                if (!/^[A-Za-z]{2}$/.test(value.trim())) {
                  throw new Error(t("systemSettings.geoNominatim.test.validation.countryCode"));
                }
              }
            }
          ]}
        >
          <Input
            style={{ width: 120 }}
            maxLength={2}
            placeholder={t("systemSettings.geoNominatim.test.placeholders.countryCode")}
          />
        </Form.Item>
        <Form.Item>
          <Button type="default" htmlType="submit" loading={testing}>
            {t("systemSettings.geoNominatim.test.actions.run")}
          </Button>
        </Form.Item>
      </Form>

      {testResult ? (
        <div style={{ marginTop: 16 }}>
          <Space wrap>
            <Tag color="blue">{testResult.provider}</Tag>
            <Tag color="geekblue">{testResult.lat.toFixed(6)}</Tag>
            <Tag color="geekblue">{testResult.lng.toFixed(6)}</Tag>
            {testResult.countryCodeAlpha2 ? <Tag>{testResult.countryCodeAlpha2}</Tag> : null}
          </Space>
          {testResult.displayName ? (
            <Typography.Paragraph style={{ marginTop: 8, marginBottom: 0 }}>
              {testResult.displayName}
            </Typography.Paragraph>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
