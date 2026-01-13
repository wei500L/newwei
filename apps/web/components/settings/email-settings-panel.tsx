"use client";

import { Alert, Button, Descriptions, Form, Input, Space, Spin, Tag, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

interface EmailVerifyStatus {
  ok: boolean | null;
  checkedAt: string | null;
  error: string | null;
}

interface SmtpConfigResponse {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  pool: boolean;
  maxConnections: number;
  maxMessages: number;
  rateDeltaMs: number;
  rateLimit: number;
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
  tlsRejectUnauthorized: boolean;
}

interface EmailSettingsResponse {
  smtp: SmtpConfigResponse;
  verify: EmailVerifyStatus;
}

interface EmailTestFormValues {
  to?: string;
  subject?: string;
}

interface EmailTestResponse {
  to: string;
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export function EmailSettingsPanel() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<EmailTestFormValues>();
  const [settings, setSettings] = useState<EmailSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.get<EmailSettingsResponse>("system-settings/email");
      const data = response.data ?? null;
      setSettings(data);
      const defaultTo = data?.smtp?.user ?? "";
      form.setFieldsValue({
        to: defaultTo,
        subject: "Test email"
      });
    } catch (error) {
      captureClientError("Failed to load email settings", error);
      setErrorMessage(t("systemSettings.email.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [apiClient, form, t]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSendTest = async (values: EmailTestFormValues) => {
    setSending(true);
    try {
      const payload = {
        ...(values.to?.trim() ? { to: values.to.trim() } : {}),
        ...(values.subject?.trim() ? { subject: values.subject.trim() } : {})
      };
      const response = await apiClient.post<EmailTestResponse>("system-settings/email/test", payload);
      const result = response.data;
      messageApi.success(t("systemSettings.email.messages.sent", { to: result?.to ?? "" }));
      void loadSettings();
    } catch (error) {
      captureClientError("Failed to send test email", error);
      messageApi.error(t("systemSettings.email.errors.sendFailed"));
    } finally {
      setSending(false);
    }
  };

  const verify = settings?.verify;
  const verifyColor =
    verify?.ok === true ? "green" : verify?.ok === false ? "red" : "default";
  const verifyLabel =
    verify?.ok === true
      ? t("systemSettings.email.status.verified")
      : verify?.ok === false
        ? t("systemSettings.email.status.failed")
        : t("systemSettings.email.status.unchecked");

  if (loading && !settings) {
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
        {t("systemSettings.email.description")}
      </Typography.Paragraph>

      {errorMessage ? (
        <Alert type="error" showIcon message={errorMessage} style={{ marginBottom: "1rem" }} />
      ) : null}

      <Space wrap style={{ marginBottom: "1rem" }}>
        <Typography.Text>{t("systemSettings.email.status.label")}</Typography.Text>
        <Tag color={verifyColor}>{verifyLabel}</Tag>
        <Button size="small" onClick={loadSettings} loading={loading}>
          {t("common.refresh")}
        </Button>
      </Space>

      {verify?.checkedAt ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: "0.5rem" }}>
          {t("systemSettings.email.status.checkedAt")} {verify.checkedAt}
        </Typography.Paragraph>
      ) : null}
      {verify?.error ? (
        <Alert
          type="warning"
          showIcon
          message={t("systemSettings.email.status.error")}
          description={verify.error}
          style={{ marginBottom: "1rem" }}
        />
      ) : null}

      {settings?.smtp ? (
        <Descriptions
          bordered
          size="small"
          column={1}
          style={{ marginBottom: "1rem" }}
          title={t("systemSettings.email.config.title")}
        >
          <Descriptions.Item label={t("systemSettings.email.config.fields.host")}>
            {settings.smtp.host}
          </Descriptions.Item>
          <Descriptions.Item label={t("systemSettings.email.config.fields.port")}>
            {settings.smtp.port}
          </Descriptions.Item>
          <Descriptions.Item label={t("systemSettings.email.config.fields.secure")}>
            {settings.smtp.secure ? "true" : "false"}
          </Descriptions.Item>
          <Descriptions.Item label={t("systemSettings.email.config.fields.user")}>
            {settings.smtp.user}
          </Descriptions.Item>
          <Descriptions.Item label={t("systemSettings.email.config.fields.from")}>
            {settings.smtp.from}
          </Descriptions.Item>
          <Descriptions.Item label={t("systemSettings.email.config.fields.pool")}>
            {settings.smtp.pool ? "true" : "false"}
          </Descriptions.Item>
          <Descriptions.Item label={t("systemSettings.email.config.fields.maxConnections")}>
            {settings.smtp.maxConnections}
          </Descriptions.Item>
          <Descriptions.Item label={t("systemSettings.email.config.fields.rateLimit")}>
            {settings.smtp.rateLimit} / {settings.smtp.rateDeltaMs}ms
          </Descriptions.Item>
          <Descriptions.Item label={t("systemSettings.email.config.fields.timeouts")}>
            {settings.smtp.connectionTimeoutMs} / {settings.smtp.greetingTimeoutMs} / {settings.smtp.socketTimeoutMs}
          </Descriptions.Item>
          <Descriptions.Item label={t("systemSettings.email.config.fields.tlsRejectUnauthorized")}>
            {settings.smtp.tlsRejectUnauthorized ? "true" : "false"}
          </Descriptions.Item>
        </Descriptions>
      ) : null}

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        {t("systemSettings.email.test.title")}
      </Typography.Title>

      <Form layout="vertical" form={form} onFinish={handleSendTest}>
        <Form.Item
          label={t("systemSettings.email.test.fields.to")}
          name="to"
          rules={[{ type: "email", message: t("systemSettings.email.test.validation.to") }]}
          extra={
            settings?.smtp?.user
              ? t("systemSettings.email.test.placeholders.to", { defaultEmail: settings.smtp.user })
              : undefined
          }
        >
          <Input placeholder={settings?.smtp?.user ?? ""} />
        </Form.Item>
        <Form.Item
          label={t("systemSettings.email.test.fields.subject")}
          name="subject"
          rules={[{ required: false }]}
        >
          <Input placeholder={t("systemSettings.email.test.placeholders.subject")} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={sending}>
            {t("systemSettings.email.test.actions.send")}
          </Button>
        </Form.Item>
      </Form>
    </>
  );
}
