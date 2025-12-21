"use client";

import { Alert, Button, Form, Input, Typography } from "antd";
import type { TFunction } from "i18next";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { captureClientError } from "@/lib/client-telemetry";

const { Title, Text } = Typography;

const buildLoginSchema = (t: TFunction) =>
  z.object({
    email: z
      .string({ required_error: t("auth.login.validation.emailRequired") })
      .email(t("auth.login.validation.emailInvalid")),
    password: z
      .string({ required_error: t("auth.login.validation.passwordRequired") })
      .min(8, t("auth.login.validation.passwordMin", { count: 8 })),
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
  const { t } = useTranslation();
  const [form] = Form.useForm<LoginFormValues>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionExpired = searchParams.get("sessionExpired") === "1";

  const onFinish = async (values: LoginFormValues) => {
    const parsed = buildLoginSchema(t).safeParse(values);
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
        ...(payload.orgId ? { orgId: payload.orgId } : {}),
        redirect: false,
      });

      if (result?.error) {
        setError(
          process.env.NODE_ENV === "production"
            ? t("auth.login.error.invalidCredentials")
            : t("auth.login.error.invalidCredentialsWithReason", {
                reason: result.error,
              })
        );
        return;
      }

      const redirectTo = searchParams.get("callbackUrl") ?? "/dashboard";
      router.push(redirectTo);
    } catch (err) {
      captureClientError("Login failed", err);
      setError(t("common.error.unexpected"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-card">
      <Title level={3} style={{ marginBottom: "0.5rem" }}>
        {t("auth.login.title")}
      </Title>
      <Text type="secondary">{t("auth.login.subtitle")}</Text>
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: "1.5rem" }}
        onFinish={onFinish}
      >
        {sessionExpired && (
          <Form.Item>
            <Alert type="warning" message={t("auth.login.sessionExpired")} showIcon />
          </Form.Item>
        )}
        <Form.Item
          label={t("auth.login.fields.email.label")}
          name="email"
          rules={[{ required: true, message: t("auth.login.fields.email.required") }]}
        >
          <Input
            placeholder={t("auth.login.fields.email.placeholder")}
            autoComplete="email"
            size="large"
          />
        </Form.Item>
        <Form.Item
          label={t("auth.login.fields.password.label")}
          name="password"
          rules={[{ required: true, message: t("auth.login.fields.password.required") }]}
        >
          <Input.Password
            placeholder={t("auth.login.fields.password.placeholder")}
            autoComplete="current-password"
            size="large"
          />
        </Form.Item>
        <Form.Item
          label={t("auth.login.fields.organization.label")}
          name="orgId"
          tooltip={t("auth.login.fields.organization.tooltip")}
        >
          <Input
            placeholder={t("auth.login.fields.organization.placeholder")}
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
            {t("auth.login.submit")}
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}
