"use client";

import { Alert, Button, Form, Input, Spin, Typography } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";

import { createApiClient, syncApiSessionCache } from "@/lib/api-client";
import type { BackendLoginResponse } from "@/lib/auth";

export default function SsoCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const handoffToken = searchParams.get("handoffToken");
  const challengeId = searchParams.get("challengeId");
  const enrollmentChallengeId = searchParams.get("enrollmentChallengeId");
  const error = searchParams.get("error");
  const apiClient = useMemo(() => createApiClient(), []);
  const [loading, setLoading] = useState(Boolean(handoffToken));
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [enrollmentLoading, setEnrollmentLoading] = useState(false);
  const [enrollmentSetup, setEnrollmentSetup] = useState<{
    secret: string;
    otpauthUri: string;
  } | null>(null);
  const [pendingEnrollmentLogin, setPendingEnrollmentLogin] =
    useState<BackendLoginResponse | null>(null);
  const [pendingRecoveryCodes, setPendingRecoveryCodes] = useState<
    string[] | null
  >(null);

  const signInWithPayload = async (payload: BackendLoginResponse) => {
    const result = await signIn("handoff", {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresIn: String(payload.expiresIn),
      userJson: JSON.stringify(payload.user),
      organizationsJson: JSON.stringify(payload.organizations ?? []),
      redirect: false,
    });
    if (result?.error) {
      setChallengeError(result.error);
      return;
    }
    await syncApiSessionCache().catch(() => null);
    router.replace("/dashboard");
  };

  useEffect(() => {
    if (!handoffToken) {
      return;
    }

    let active = true;
    void (async () => {
      const result = await signIn("handoff", {
        handoffToken,
        redirect: false,
      });
      if (!active) {
        return;
      }
      setLoading(false);
      if (result?.error) {
        setChallengeError(result.error);
        return;
      }
      await syncApiSessionCache().catch(() => null);
      router.replace("/dashboard");
    })();

    return () => {
      active = false;
    };
  }, [handoffToken, router]);

  useEffect(() => {
    if (!enrollmentChallengeId) {
      return;
    }

    let active = true;
    setEnrollmentLoading(true);
    setChallengeError(null);
    setEnrollmentSetup(null);

    void apiClient
      .post<{ secret: string; otpauthUri: string }>(
        "auth/mfa/enrollment/start",
        {
          challengeId: enrollmentChallengeId,
        },
      )
      .then((response) => {
        if (active) {
          setEnrollmentSetup(response.data);
        }
      })
      .catch(() => {
        if (active) {
          setChallengeError("Unable to start MFA enrollment");
        }
      })
      .finally(() => {
        if (active) {
          setEnrollmentLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [apiClient, enrollmentChallengeId]);

  const onVerify = async (values: { code: string }) => {
    if (!challengeId) {
      return;
    }

    const response = await apiClient.post<BackendLoginResponse>(
      "auth/mfa/verify-login",
      {
        challengeId,
        code: values.code,
      },
    );
    await signInWithPayload(response.data);
  };

  const onVerifyEnrollment = async (values: { code: string }) => {
    if (!enrollmentChallengeId) {
      return;
    }

    setEnrollmentLoading(true);
    setChallengeError(null);
    try {
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
      await signInWithPayload(response.data);
    } catch {
      setChallengeError("Invalid MFA verification code");
    } finally {
      setEnrollmentLoading(false);
    }
  };

  return (
    <div className="auth-card">
      <Typography.Title level={3}>Single sign-on</Typography.Title>
      {loading ? <Spin /> : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {challengeError ? (
        <Alert
          type="error"
          showIcon
          message={challengeError}
          style={{ marginTop: "1rem" }}
        />
      ) : null}
      {challengeId ? (
        <Form
          layout="vertical"
          onFinish={onVerify}
          style={{ marginTop: "1rem" }}
        >
          <Form.Item
            label="Authenticator code or recovery code"
            name="code"
            rules={[{ required: true, message: "Enter your MFA code" }]}
          >
            <Input size="large" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block>
              Verify and continue
            </Button>
          </Form.Item>
        </Form>
      ) : null}
      {enrollmentChallengeId ? (
        <div style={{ marginTop: "1rem" }}>
          <Alert
            type="info"
            showIcon
            message="Authenticator setup required"
            description="Set up your authenticator app, then verify the generated code to finish signing in."
            style={{ marginBottom: "1rem" }}
          />
          {enrollmentLoading && !enrollmentSetup ? <Spin /> : null}
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
                onClick={() => void signInWithPayload(pendingEnrollmentLogin)}
              >
                Continue
              </Button>
            </div>
          ) : (
            <Form layout="vertical" onFinish={onVerifyEnrollment}>
              <Form.Item
                label="Authenticator code"
                name="code"
                rules={[
                  { required: true, message: "Enter your authenticator code" },
                ]}
              >
                <Input size="large" />
              </Form.Item>
              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={enrollmentLoading}
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
