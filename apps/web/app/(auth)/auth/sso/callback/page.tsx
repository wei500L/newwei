"use client";

import { Alert, Button, Form, Input, Spin, Typography } from "antd";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";

import { createApiClient, syncApiSessionCache } from "@/lib/api-client";
import type { BackendLoginResponse } from "@/lib/auth";
import { classifyRequestError } from "@/lib/request-error";

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
  const [mfaLocked, setMfaLocked] = useState(false);
  const [enrollmentLoading, setEnrollmentLoading] = useState(false);
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
      try {
        const result = await signIn("handoff", {
          handoffToken,
          redirect: false,
        });
        if (!active) {
          return;
        }
        if (result?.error) {
          setChallengeError(result.error);
          return;
        }
        await syncApiSessionCache().catch(() => null);
        router.replace("/dashboard");
      } catch (error) {
        // The handoff token is single-use and already consumed server-side;
        // a network failure here cannot be retried via this page, so surface
        // an actionable error instead of spinning forever.
        if (active) {
          setChallengeError(
            classifyRequestError(error).kind === "network"
              ? "Connection lost while completing sign-in. Please return to the login page and try again."
              : "Sign-in could not be completed. Please return to the login page and try again.",
          );
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
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
    if (!challengeId || mfaLocked) {
      return;
    }

    setChallengeError(null);
    try {
      const response = await apiClient.post<BackendLoginResponse>(
        "auth/mfa/verify-login",
        {
          challengeId,
          code: values.code,
        },
      );
      await signInWithPayload(response.data);
    } catch (error) {
      if (classifyRequestError(error).kind === "rateLimit") {
        setMfaLocked(true);
        setChallengeError(
          "Too many MFA verification attempts. Please sign in again.",
        );
        return;
      }
      setChallengeError("Invalid MFA verification code");
    }
  };

  const onVerifyEnrollment = async (values: { code: string }) => {
    if (!enrollmentChallengeId || enrollmentLocked) {
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
    } catch (error) {
      if (classifyRequestError(error).kind === "rateLimit") {
        setEnrollmentLocked(true);
        setChallengeError(
          "Too many MFA verification attempts. Please sign in again.",
        );
      } else {
        setChallengeError("Invalid MFA verification code");
      }
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
      {challengeError && !challengeId && !enrollmentChallengeId ? (
        <Button
          type="primary"
          block
          style={{ marginTop: "1rem" }}
          href="/login"
        >
          Back to login
        </Button>
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
            <Input size="large" disabled={mfaLocked} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block disabled={mfaLocked}>
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
