"use client";

import { Alert, Button, Form, Input, Tabs, Typography, message } from "antd";
import { useState } from "react";

import { createApiClient } from "@/lib/api-client";

export default function RegisterPage() {
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
      messageApi.success("Application submitted");
    } catch {
      messageApi.error("Failed to submit application");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-card">
      {contextHolder}
      <Typography.Title level={3}>Register</Typography.Title>
      <Typography.Paragraph type="secondary">
        Submit an application to create a new organization or join an existing one.
      </Typography.Paragraph>
      <Tabs
        items={[
          {
            key: "new-org",
            label: "Create organization",
            children: (
              <Form
                layout="vertical"
                onFinish={(values) =>
                  void submit("auth/register/applications", values as Record<string, string>)
                }
              >
                <Form.Item label="Email" name="email" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label="First name" name="firstName" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label="Last name" name="lastName" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label="Organization name" name="orgName" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label="Organization slug" name="orgSlug" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label="Description" name="description">
                  <Input.TextArea rows={3} />
                </Form.Item>
                <Form.Item>
                  <Button type="primary" htmlType="submit" block loading={loading}>
                    Submit new organization request
                  </Button>
                </Form.Item>
              </Form>
            ),
          },
          {
            key: "join-org",
            label: "Join organization",
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
                  message="Use the organization slug provided by your administrator."
                />
                <Form.Item label="Email" name="email" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label="First name" name="firstName" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label="Last name" name="lastName" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item label="Organization slug" name="orgSlug" rules={[{ required: true }]}>
                  <Input size="large" />
                </Form.Item>
                <Form.Item>
                  <Button type="primary" htmlType="submit" block loading={loading}>
                    Submit join request
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
