"use client";

import { Alert, Button, Form, Input, Typography, message } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";

export default function ResetPasswordPage() {
  const { t } = useTranslation();
  const apiClient = createApiClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  return (
    <div className="auth-card">
      {contextHolder}
      <Typography.Title level={3}>{t("auth.reset.title")}</Typography.Title>
      {!token ? <Alert type="error" showIcon message={t("auth.reset.missingToken")} /> : null}
      <Form
        layout="vertical"
        onFinish={async (values: { password: string }) => {
          if (!token) {
            return;
          }
          setLoading(true);
          try {
            await apiClient.post("auth/password/reset", {
              token,
              password: values.password,
            });
            messageApi.success(t("auth.reset.success"));
            router.push("/login");
          } catch {
            messageApi.error(t("auth.reset.failed"));
          } finally {
            setLoading(false);
          }
        }}
      >
        <Form.Item
          label={t("auth.reset.fields.password")}
          name="password"
          rules={[{ required: true }, { min: 8 }]}
        >
          <Input.Password size="large" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading} disabled={!token}>
            {t("auth.reset.submit")}
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}
