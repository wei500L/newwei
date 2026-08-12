"use client";

import { Alert, Button, Form, Input, Tabs, Typography, message } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";

export default function RegisterPage() {
  const { t } = useTranslation();
  const apiClient = createApiClient();
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  const submit = async (
    endpoint: "auth/register/applications" | "auth/register/join-applications",
    values: Record<string, string>,
  ) => {
    setLoading(true);
    try {
      await apiClient.post(endpoint, values);
      messageApi.success(t("auth.register.submitted"));
    } catch (error) {
      const info = extractApiError(error);
      messageApi.error(info.message || t("auth.register.submitFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-card">
      {contextHolder}
      <Typography.Title level={3}>{t("auth.register.title")}</Typography.Title>
      <Typography.Paragraph type="secondary">
        {t("auth.register.subtitle")}
      </Typography.Paragraph>
      <Tabs
        items={[
          {
            key: "new-org",
            label: t("auth.register.tabs.createOrg"),
            children: (
              <Form
                layout="vertical"
                onFinish={(values) =>
                  void submit("auth/register/applications", values as Record<string, string>)
                }
              >
                <Form.Item label={t("auth.login.fields.email.label")} name="email" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label={t("auth.register.fields.firstName")} name="firstName" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label={t("auth.register.fields.lastName")} name="lastName" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label={t("auth.register.fields.orgName")} name="orgName" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label={t("auth.register.fields.orgSlug")} name="orgSlug" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label={t("auth.register.fields.description")} name="description">
                  <Input.TextArea rows={3} />
                </Form.Item>
                <Form.Item>
                  <Button type="primary" htmlType="submit" block loading={loading}>
                    {t("auth.register.submitCreateOrg")}
                  </Button>
                </Form.Item>
              </Form>
            ),
          },
          {
            key: "join-org",
            label: t("auth.register.tabs.joinOrg"),
            children: (
              <Form
                layout="vertical"
                onFinish={(values) =>
                  void submit("auth/register/join-applications", values as Record<string, string>)
                }
              >
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: "1rem" }}
                  message={t("auth.register.joinHint")}
                />
                <Form.Item label={t("auth.login.fields.email.label")} name="email" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label={t("auth.register.fields.firstName")} name="firstName" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label={t("auth.register.fields.lastName")} name="lastName" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label={t("auth.register.fields.orgSlug")} name="orgSlug" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item>
                  <Button type="primary" htmlType="submit" block loading={loading}>
                    {t("auth.register.submitJoin")}
                  </Button>
                </Form.Item>
              </Form>
            ),
          },
        ]}
      />
    </div>
  );
}
