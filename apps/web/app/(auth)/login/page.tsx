"use client";

import { Alert, Button, Form, Input, Tabs, Typography, message } from "antd";
import type { FormInstance } from "antd";
import type { TFunction } from "i18next";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { createApiClient, syncApiSessionCache } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { env } from "@/lib/env";
import type { BackendLoginResponse, BackendMfaChallengeResponse } from "@/lib/auth";

const { Title, Text } = Typography;
const DEFAULT_SEND_CODE_COOLDOWN_SECONDS = 90;

const buildPasswordLoginSchema = (t: TFunction) =>
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

const buildCodeLoginSchema = (t: TFunction) =>
  z.object({
    email: z
      .string({ required_error: t("auth.login.validation.emailRequired") })
      .email(t("auth.login.validation.emailInvalid")),
    code: z
      .string({ required_error: t("auth.login.validation.codeRequired") })
      .regex(/^\d{8}$/, t("auth.login.validation.codeInvalid")),
    orgId: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value ? value : undefined)),
  });

const buildSendCodeSchema = (t: TFunction) =>
  z.object({
    email: z
      .string({ required_error: t("auth.login.validation.emailRequired") })
      .email(t("auth.login.validation.emailInvalid")),
  });

interface PasswordLoginFormValues {
  email: string;
  password: string;
  orgId?: string;
}

interface CodeLoginFormValues {
  email: string;
  code: string;
  orgId?: string;
}

interface SendLoginCodeResponse {
  ok: boolean;
  cooldownSeconds?: number;
}

type LoginResponse = BackendLoginResponse | BackendMfaChallengeResponse;

function applyFormFieldErrors<T extends object>(
  form: FormInstance<T>,
  fieldErrors: Record<string, string[] | undefined>,
  allowed: readonly string[],
) {
  for (const [name, messages] of Object.entries(fieldErrors)) {
    if (!allowed.includes(name)) {
      continue;
    }
    form.setFields([
      {
        name: name as any,
        errors: messages ?? [],
      },
    ]);
  }
}

export default function LoginPage() {
  const { t } = useTranslation();
  const [passwordForm] = Form.useForm<PasswordLoginFormValues>();
  const [codeForm] = Form.useForm<CodeLoginFormValues>();
  const [messageApi, contextHolder] = message.useMessage();
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [codeLoginLoading, setCodeLoginLoading] = useState(false);
  const [sendCodeLoading, setSendCodeLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaForm] = Form.useForm<{ code: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionExpired = searchParams.get("sessionExpired") === "1";
  const logoutFailed = searchParams.get("logoutFailed") === "1";

  const apiClient = useMemo(() => createApiClient(), []);

  useEffect(() => {
    if (codeCooldown <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      setCodeCooldown((current) => (current <= 1 ? 0 : current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [codeCooldown]);

  const redirectAfterLogin = () => {
    const redirectTo = searchParams.get("callbackUrl") ?? "/dashboard";
    router.push(redirectTo);
  };

  const signInWithHandoff = async (payload: BackendLoginResponse) => {
    const result = await signIn("handoff", {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresIn: String(payload.expiresIn),
      userJson: JSON.stringify(payload.user),
      organizationsJson: JSON.stringify(payload.organizations ?? []),
      redirect: false,
    });

    if (result?.error) {
      throw new Error(result.error);
    }

    await syncApiSessionCache().catch(() => null);
    redirectAfterLogin();
  };

  const handleLoginResponse = async (response: LoginResponse) => {
    if ("mfaRequired" in response && response.mfaRequired) {
      setMfaChallengeId(response.authChallengeId);
      setMfaError(null);
      return;
    }

    await signInWithHandoff(response as BackendLoginResponse);
  };

  const onPasswordLogin = async (values: PasswordLoginFormValues) => {
    const parsed = buildPasswordLoginSchema(t).safeParse(values);
    if (!parsed.success) {
      applyFormFieldErrors(passwordForm, parsed.error.formErrors.fieldErrors, [
        "email",
        "password",
        "orgId",
      ]);
      return;
    }

    const payload = parsed.data;
    try {
      setPasswordLoading(true);
      setPasswordError(null);
      const response = await apiClient.post<LoginResponse>("auth/login", {
        email: payload.email,
        password: payload.password,
        ...(payload.orgId ? { orgId: payload.orgId } : {}),
      });
      await handleLoginResponse(response.data);
    } catch (error) {
      captureClientError("Password login failed", error);
      setPasswordError(t("common.error.unexpected"));
    } finally {
      setPasswordLoading(false);
    }
  };

  const onCodeLogin = async (values: CodeLoginFormValues) => {
    const parsed = buildCodeLoginSchema(t).safeParse(values);
    if (!parsed.success) {
      applyFormFieldErrors(codeForm, parsed.error.formErrors.fieldErrors, [
        "email",
        "code",
        "orgId",
      ]);
      return;
    }

    const payload = parsed.data;
    try {
      setCodeLoginLoading(true);
      setCodeError(null);
      const response = await apiClient.post<LoginResponse>("auth/login-with-code", {
        email: payload.email,
        code: payload.code,
        ...(payload.orgId ? { orgId: payload.orgId } : {}),
      });
      await handleLoginResponse(response.data);
    } catch (error) {
      captureClientError("Code login failed", error);
      setCodeError(t("common.error.unexpected"));
    } finally {
      setCodeLoginLoading(false);
    }
  };

  const onSendCode = async () => {
    const parsed = buildSendCodeSchema(t).safeParse(
      codeForm.getFieldsValue(["email"]),
    );
    if (!parsed.success) {
      applyFormFieldErrors(codeForm, parsed.error.formErrors.fieldErrors, [
        "email",
      ]);
      return;
    }

    try {
      setSendCodeLoading(true);
      const response = await apiClient.post<SendLoginCodeResponse>(
        "auth/send-login-code",
        {
          email: parsed.data.email,
        },
      );
      setCodeCooldown(
        response.data.cooldownSeconds ?? DEFAULT_SEND_CODE_COOLDOWN_SECONDS,
      );
      messageApi.success(t("auth.login.codeLogin.sendSuccess"));
    } catch (error) {
      captureClientError("Send login code failed", error);
      messageApi.error(t("auth.login.codeLogin.sendFailed"));
    } finally {
      setSendCodeLoading(false);
    }
  };

  const onVerifyMfa = async (values: { code: string }) => {
    if (!mfaChallengeId) {
      return;
    }

    try {
      setMfaLoading(true);
      setMfaError(null);
      const response = await apiClient.post<BackendLoginResponse>(
        "auth/mfa/verify-login",
        {
          challengeId: mfaChallengeId,
          code: values.code,
        },
      );
      await signInWithHandoff(response.data);
    } catch (error) {
      captureClientError("MFA verification failed", error);
      setMfaError(t("auth.login.error.invalidCode"));
    } finally {
      setMfaLoading(false);
    }
  };

  const handleSsoLogin = () => {
    const orgId =
      passwordForm.getFieldValue("orgId") ?? codeForm.getFieldValue("orgId");
    if (!orgId || !String(orgId).trim()) {
      messageApi.error("Organization is required for SSO");
      return;
    }
    window.location.assign(
      `${env.apiBaseUrl}/auth/sso/oidc/start?org=${encodeURIComponent(
        String(orgId).trim(),
      )}`,
    );
  };

  return (
    <div className="auth-card">
      {contextHolder}
      <Title level={3} style={{ marginBottom: "0.5rem" }}>
        {t("auth.login.title")}
      </Title>
      <Text type="secondary">{t("auth.login.subtitle")}</Text>
      <div style={{ marginTop: "0.5rem" }}>
        <Button type="link" onClick={() => router.push("/register")} style={{ paddingInline: 0 }}>
          Register
        </Button>
        <Button type="link" onClick={() => router.push("/forgot-password")} style={{ paddingInline: 0, marginLeft: 12 }}>
          Forgot password?
        </Button>
      </div>
      <div style={{ marginTop: "1.5rem" }}>
        {sessionExpired ? (
          <Alert
            type="warning"
            message={t("auth.login.sessionExpired")}
            showIcon
          />
        ) : null}
        {logoutFailed ? (
          <Alert
            type="warning"
            message={t("auth.logoutFailed")}
            showIcon
            style={{ marginTop: "0.75rem" }}
          />
        ) : null}
      </div>
      <Tabs
        style={{ marginTop: "1rem" }}
        items={[
          {
            key: "password",
            label: t("auth.login.tabs.password"),
            children: (
              <Form
                form={passwordForm}
                layout="vertical"
                onFinish={onPasswordLogin}
              >
                <Form.Item
                  label={t("auth.login.fields.email.label")}
                  name="email"
                  rules={[
                    {
                      required: true,
                      message: t("auth.login.fields.email.required"),
                    },
                  ]}
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
                  rules={[
                    {
                      required: true,
                      message: t("auth.login.fields.password.required"),
                    },
                  ]}
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
                    placeholder={t(
                      "auth.login.fields.organization.placeholder",
                    )}
                    autoComplete="organization"
                    size="large"
                  />
                </Form.Item>
                {passwordError ? (
                  <Form.Item>
                    <Alert type="error" message={passwordError} showIcon />
                  </Form.Item>
                ) : null}
                <Form.Item>
                  <Button
                    type="primary"
                    htmlType="submit"
                    size="large"
                    block
                    loading={passwordLoading}
                  >
                    {t("auth.login.submit")}
                  </Button>
                </Form.Item>
              </Form>
            ),
          },
          {
            key: "code",
            label: t("auth.login.tabs.code"),
            children: (
              <Form form={codeForm} layout="vertical" onFinish={onCodeLogin}>
                <Form.Item
                  label={t("auth.login.fields.email.label")}
                  name="email"
                  rules={[
                    {
                      required: true,
                      message: t("auth.login.fields.email.required"),
                    },
                  ]}
                >
                  <Input
                    placeholder={t("auth.login.fields.email.placeholder")}
                    autoComplete="email"
                    size="large"
                  />
                </Form.Item>
                <Form.Item>
                  <Button
                    onClick={onSendCode}
                    disabled={sendCodeLoading || codeCooldown > 0}
                    loading={sendCodeLoading}
                    block
                  >
                    {codeCooldown > 0
                      ? t("auth.login.codeLogin.sendCooldown", {
                          seconds: codeCooldown,
                        })
                      : t("auth.login.codeLogin.send")}
                  </Button>
                </Form.Item>
                <Form.Item
                  label={t("auth.login.fields.code.label")}
                  name="code"
                  rules={[
                    {
                      required: true,
                      message: t("auth.login.fields.code.required"),
                    },
                  ]}
                >
                  <Input
                    placeholder={t("auth.login.fields.code.placeholder")}
                    inputMode="numeric"
                    maxLength={8}
                    size="large"
                  />
                </Form.Item>
                <Form.Item
                  label={t("auth.login.fields.organization.label")}
                  name="orgId"
                  tooltip={t("auth.login.fields.organization.tooltip")}
                >
                  <Input
                    placeholder={t(
                      "auth.login.fields.organization.placeholder",
                    )}
                    autoComplete="organization"
                    size="large"
                  />
                </Form.Item>
                {codeError ? (
                  <Form.Item>
                    <Alert type="error" message={codeError} showIcon />
                  </Form.Item>
                ) : null}
                <Form.Item>
                  <Button
                    type="primary"
                    htmlType="submit"
                    size="large"
                    block
                    loading={codeLoginLoading}
                  >
                    {t("auth.login.codeLogin.submit")}
                  </Button>
                </Form.Item>
              </Form>
            ),
          },
        ]}
      />
      <Button block style={{ marginTop: "0.75rem" }} onClick={handleSsoLogin}>
        Continue with SSO
      </Button>
      {mfaChallengeId ? (
        <div style={{ marginTop: "1rem" }}>
          <Alert
            type="info"
            showIcon
            message="Multi-factor authentication required"
            style={{ marginBottom: "0.75rem" }}
          />
          <Form form={mfaForm} layout="vertical" onFinish={onVerifyMfa}>
            <Form.Item
              label="Authenticator code or recovery code"
              name="code"
              rules={[{ required: true, message: "Enter your MFA code" }]}
            >
              <Input size="large" />
            </Form.Item>
            {mfaError ? (
              <Form.Item>
                <Alert type="error" showIcon message={mfaError} />
              </Form.Item>
            ) : null}
            <Form.Item>
              <Button type="primary" htmlType="submit" block loading={mfaLoading}>
                Verify and continue
              </Button>
            </Form.Item>
          </Form>
        </div>
      ) : null}
    </div>
  );
}
