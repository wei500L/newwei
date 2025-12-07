"use client";

import { Alert, Button, Form, Input, Typography } from "antd";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { captureClientError } from "@/lib/client-telemetry";

const { Title, Text } = Typography;

const loginSchema = z.object({
  email: z
    .string({ required_error: "Email is required" })
    .email("Invalid email"),
  password: z
    .string({ required_error: "Password is required" })
    .min(8, "Password must be at least 8 characters"),
  orgId: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
});

interface LoginFormValues {
  email: string;
  password: string;
  orgId?: string;
}

export default function LoginPage() {
  const [form] = Form.useForm<LoginFormValues>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionExpired = searchParams.get("sessionExpired") === "1";

  const onFinish = async (values: LoginFormValues) => {
    const parsed = loginSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors = parsed.error.formErrors.fieldErrors;
      Object.entries(fieldErrors).forEach(([name, messages]) => {
        form.setFields([
          {
            name: name as any,
            errors: messages,
          },
        ]);
      });
      return;
    }

    const payload = parsed.data;

    try {
      setLoading(true);
      setError(null);
      const result = await signIn("credentials", {
        email: payload.email,
        password: payload.password,
        orgId: payload.orgId,
        redirect: false,
      });

      if (result?.error) {
        setError("Unable to sign in with provided credentials");
        return;
      }

      const redirectTo = searchParams.get("callbackUrl") ?? "/dashboard";
      router.push(redirectTo);
    } catch (err) {
      captureClientError("Login failed", err);
      setError("Unexpected error. Please try again later.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-card">
      <Title level={3} style={{ marginBottom: "0.5rem" }}>
        Welcome Back
      </Title>
      <Text type="secondary">Sign in to access the operator console.</Text>
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: "1.5rem" }}
        onFinish={onFinish}
      >
        {sessionExpired && (
          <Form.Item>
            <Alert type="warning" message="Session expired. Please sign in again." showIcon />
          </Form.Item>
        )}
        <Form.Item
          label="Email"
          name="email"
          rules={[{ required: true, message: "Please enter your email" }]}
        >
          <Input
            placeholder="admin@example.com"
            autoComplete="email"
            size="large"
          />
        </Form.Item>
        <Form.Item
          label="Password"
          name="password"
          rules={[{ required: true, message: "Please enter your password" }]}
        >
          <Input.Password
            placeholder="********"
            autoComplete="current-password"
            size="large"
          />
        </Form.Item>
        <Form.Item
          label="Organization"
          name="orgId"
          tooltip="Optional. Leave blank to use your default organization"
        >
          <Input
            placeholder="org-123 or slug"
            autoComplete="organization"
            size="large"
          />
        </Form.Item>
        {error && (
          <Form.Item>
            <Alert type="error" message={error} showIcon />
          </Form.Item>
        )}
        <Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={loading}
          >
            Sign In
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}
