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
import { resolveSafeRedirect } from "@/lib/safe-redirect";
import { env } from "@/lib/env";
import { classifyRequestError } from "@/lib/request-error";
import type {
  BackendLoginResponse,
  BackendMfaChallengeResponse,
  BackendMfaEnrollmentChallengeResponse,
} from "@/lib/auth";

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

type LoginResponse =
  | BackendLoginResponse
  | BackendMfaChallengeResponse
  | BackendMfaEnrollmentChallengeResponse;

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
  const [mfaLocked, setMfaLocked] = useState(false);
  const [mfaForm] = Form.useForm<{ code: string }>();
  const [enrollmentChallengeId, setEnrollmentChallengeId] = useState<
    string | null
  >(null);
  const [enrollmentLoading, setEnrollmentLoading] = useState(false);
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);
  const [enrollmentLocked, setEnrollmentLocked] = useState(false);
  const [enrollmentSetup, setEnrollmentSetup] = useState<{
    secret: string;
    otpauthUri: string;
  } | null>(null);
  const [pendingEnrollmentLogin, setPendingEnrollmentLogin] =
    useState<BackendLoginResponse | null>(null);
  const [pendingRecoveryCodes, setPendingRecoveryCodes] = useState<
    string[] | null
  >(null);
  const [enrollmentForm] = Form.useForm<{ code: string }>();
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

  useEffect(() => {
    if (!enrollmentChallengeId) {
      return;
    }

    let active = true;
    setEnrollmentLoading(true);
    setEnrollmentError(null);
    setEnrollmentSetup(null);
    enrollmentForm.resetFields();

    void apiClient
      .post<{ secret: string; otpauthUri: string }>(
        "auth/mfa/enrollment/start",
        {
          challengeId: enrollmentChallengeId,
        },
      )
      .then((response) => {
        if (!active) {
          return;
        }
        setEnrollmentSetup(response.data);
      })
      .catch((error) => {
        captureClientError("MFA enrollment start failed", error);
        if (!active) {
          return;
        }
        setEnrollmentError("Unable to start MFA enrollment");
      })
      .finally(() => {
        if (active) {
          setEnrollmentLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [apiClient, enrollmentChallengeId, enrollmentForm]);

  const redirectAfterLogin = () => {
    // Sanitize callbackUrl to a same-origin path to prevent open redirect (CWE-601):
    // signIn uses redirect:false, so NextAuth's own callbackUrl validation is bypassed.
    router.push(resolveSafeRedirect(searchParams.get("callbackUrl"), "/welcome"));
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
      setEnrollmentChallengeId(null);
      setEnrollmentSetup(null);
      setMfaError(null);
      setMfaLocked(false);
      setEnrollmentLocked(false);
      return;
    }

    if ("mfaEnrollmentRequired" in response && response.mfaEnrollmentRequired) {
      setEnrollmentChallengeId(response.enrollmentChallengeId);
      setPendingEnrollmentLogin(null);
      setPendingRecoveryCodes(null);
      setMfaChallengeId(null);
      setEnrollmentError(null);
      setEnrollmentLocked(false);
      setMfaLocked(false);
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
      const response = await apiClient.post<LoginResponse>(
        "auth/login-with-code",
        {
          email: payload.email,
          code: payload.code,
          ...(payload.orgId ? { orgId: payload.orgId } : {}),
        },
      );
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
      if (classifyRequestError(error).kind === "rateLimit") {
        setMfaLocked(true);
        setMfaError(t("auth.login.error.tooManyMfaAttempts"));
      } else {
        setMfaError(t("auth.login.error.invalidCode"));
      }
    } finally {
      setMfaLoading(false);
    }
  };

  const onVerifyEnrollment = async (values: { code: string }) => {
    if (!enrollmentChallengeId) {
      return;
    }

    try {
      setEnrollmentLoading(true);
      setEnrollmentError(null);
      const response = await apiClient.post<BackendLoginResponse>(
        "auth/mfa/enrollment/complete",
        {
          challengeId: enrollmentChallengeId,
          code: values.code,
        },
      );
      if (response.data.recoveryCodes?.length) {
        setPendingEnrollmentLogin(response.data);
        setPendingRecoveryCodes(response.data.recoveryCodes);
        return;
      }
      await signInWithHandoff(response.data);
    } catch (error) {
      captureClientError("MFA enrollment verification failed", error);
      if (classifyRequestError(error).kind === "rateLimit") {
        setEnrollmentLocked(true);
        setEnrollmentError(t("auth.login.error.tooManyMfaAttempts"));
      } else {
        setEnrollmentError("Invalid MFA verification code");
      }
    } finally {
      setEnrollmentLoading(false);
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
        <Button
          type="link"
          onClick={() => router.push("/register")}
          style={{ paddingInline: 0 }}
        >
          Register
        </Button>
        <Button
          type="link"
          onClick={() => router.push("/forgot-password")}
          style={{ paddingInline: 0, marginLeft: 12 }}
        >
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
              <Input size="large" disabled={mfaLocked} />
            </Form.Item>
            {mfaError ? (
              <Form.Item>
                <Alert type="error" showIcon message={mfaError} />
              </Form.Item>
            ) : null}
            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                block
                loading={mfaLoading}
                disabled={mfaLocked}
              >
                Verify and continue
              </Button>
            </Form.Item>
          </Form>
        </div>
      ) : null}
      {enrollmentChallengeId ? (
        <div style={{ marginTop: "1rem" }}>
          <Alert
            type="info"
            showIcon
            message="Multi-factor authentication setup required"
            description="Scan or copy this secret into your authenticator app, then enter the generated code to finish signing in."
            style={{ marginBottom: "0.75rem" }}
          />
          {enrollmentLoading && !enrollmentSetup ? (
            <Text type="secondary">Preparing authenticator setup...</Text>
          ) : null}
          {enrollmentSetup ? (
            <>
              <Typography.Paragraph copyable>
                {enrollmentSetup.secret}
              </Typography.Paragraph>
              <Typography.Paragraph copyable>
                {enrollmentSetup.otpauthUri}
              </Typography.Paragraph>
            </>
          ) : null}
          {enrollmentError ? (
            <Alert
              type="error"
              showIcon
              message={enrollmentError}
              style={{ marginBottom: "0.75rem" }}
            />
          ) : null}
          {pendingRecoveryCodes && pendingEnrollmentLogin ? (
            <div>
              <Alert
                type="success"
                showIcon
                message="Save these recovery codes before continuing"
                style={{ marginBottom: "0.75rem" }}
              />
              <Typography.Paragraph copyable>
                {pendingRecoveryCodes.join(", ")}
              </Typography.Paragraph>
              <Button
                type="primary"
                block
                onClick={() => void signInWithHandoff(pendingEnrollmentLogin)}
              >
                Continue
              </Button>
            </div>
          ) : (
            <Form
              form={enrollmentForm}
              layout="vertical"
              onFinish={onVerifyEnrollment}
            >
              <Form.Item
                label="Authenticator code"
                name="code"
                rules={[
                  { required: true, message: "Enter your authenticator code" },
                ]}
              >
                <Input size="large" disabled={enrollmentLocked} />
              </Form.Item>
              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={enrollmentLoading}
                  disabled={enrollmentLocked}
                >
                  Verify and continue
                </Button>
              </Form.Item>
            </Form>
          )}
        </div>
      ) : null}
    </div>
  );
}
