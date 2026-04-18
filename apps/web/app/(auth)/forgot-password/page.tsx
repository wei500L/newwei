"use client";

import { Button, Form, Input, Typography, message } from "antd";
import { useState } from "react";

import { createApiClient } from "@/lib/api-client";

export default function ForgotPasswordPage() {
  const apiClient = createApiClient();
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  return (
    <div className="auth-card">
      {contextHolder}
      <Typography.Title level={3}>Forgot password</Typography.Title>
      <Typography.Paragraph type="secondary">
        If the email exists, a reset link will be sent.
      </Typography.Paragraph>
      <Form
        layout="vertical"
        onFinish={async (values: { email: string }) => {
          setLoading(true);
          try {
            await apiClient.post("auth/password/forgot", values);
            messageApi.success("If the account exists, a reset link has been sent.");
          } catch {
            messageApi.error("Failed to request password reset");
          } finally {
            setLoading(false);
          }
        }}
      >
        <Form.Item label="Email" name="email" rules={[{ required: true }]}>
          <Input size="large" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            Send reset link
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}
