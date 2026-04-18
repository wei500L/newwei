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
  const error = searchParams.get("error");
  const apiClient = useMemo(() => createApiClient(), []);
  const [loading, setLoading] = useState(Boolean(handoffToken));
  const [challengeError, setChallengeError] = useState<string | null>(null);

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

  const onVerify = async (values: { code: string }) => {
    if (!challengeId) {
      return;
    }

    const response = await apiClient.post<BackendLoginResponse>("auth/mfa/verify-login", {
      challengeId,
      code: values.code,
    });
    const result = await signIn("handoff", {
      accessToken: response.data.accessToken,
      refreshToken: response.data.refreshToken,
      expiresIn: String(response.data.expiresIn),
      userJson: JSON.stringify(response.data.user),
      organizationsJson: JSON.stringify(response.data.organizations ?? []),
      redirect: false,
    });
    if (result?.error) {
      setChallengeError(result.error);
      return;
    }
    await syncApiSessionCache().catch(() => null);
    router.replace("/dashboard");
  };

  return (
    <div className="auth-card">
      <Typography.Title level={3}>Single sign-on</Typography.Title>
      {loading ? <Spin /> : null}
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {challengeError ? (
        <Alert type="error" showIcon message={challengeError} style={{ marginTop: "1rem" }} />
      ) : null}
      {challengeId ? (
        <Form layout="vertical" onFinish={onVerify} style={{ marginTop: "1rem" }}>
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
    </div>
  );
}
