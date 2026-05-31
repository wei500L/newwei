"use client";

import { Button, Form, Input, Typography, message } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { classifyRequestError } from "@/lib/request-error";

export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  const apiClient = createApiClient();
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  return (
    <div className="auth-card">
      {contextHolder}
      <Typography.Title level={3}>{t("auth.forgot.title")}</Typography.Title>
      <Typography.Paragraph type="secondary">
        {t("auth.forgot.subtitle")}
      </Typography.Paragraph>
      <Form
        layout="vertical"
        onFinish={async (values: { email: string }) => {
          setLoading(true);
          try {
            await apiClient.post("auth/password/forgot", values);
            messageApi.success(t("auth.forgot.success"));
          } catch (error) {
            if (classifyRequestError(error).kind === "rateLimit") {
              messageApi.error(t("auth.forgot.rateLimited"));
            } else {
              messageApi.error(t("auth.forgot.failed"));
            }
          } finally {
            setLoading(false);
          }
        }}
      >
        <Form.Item label={t("auth.login.fields.email.label")} name="email" rules={[{ required: true }]}>
          <Input size="large" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            {t("auth.forgot.submit")}
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}
