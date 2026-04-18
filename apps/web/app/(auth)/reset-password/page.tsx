"use client";

import { Alert, Button, Form, Input, Typography, message } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { createApiClient } from "@/lib/api-client";

export default function ResetPasswordPage() {
  const apiClient = createApiClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  return (
    <div className="auth-card">
      {contextHolder}
      <Typography.Title level={3}>Reset password</Typography.Title>
      {!token ? <Alert type="error" showIcon message="Missing reset token" /> : null}
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
            messageApi.success("Password updated");
            router.push("/login");
          } catch {
            messageApi.error("Failed to reset password");
          } finally {
            setLoading(false);
          }
        }}
      >
        <Form.Item
          label="New password"
          name="password"
          rules={[{ required: true }, { min: 8 }]}
        >
          <Input.Password size="large" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading} disabled={!token}>
            Reset password
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}
