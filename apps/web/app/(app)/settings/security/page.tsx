"use client";

import { Alert, Button, Card, Form, Input, Spin, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";

import { createApiClient } from "@/lib/api-client";

interface MfaStatusResponse {
  enabled: boolean;
  enrolledAt?: string | null;
  verifiedAt?: string | null;
  lastUsedAt?: string | null;
  recoveryCodesRemaining: number;
}

export default function SecuritySettingsPage() {
  const { data: session, status } = useSession();
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const [statusPayload, setStatusPayload] = useState<MfaStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const load = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get<MfaStatusResponse>("auth/mfa");
      setStatusPayload(response.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (status === "authenticated") {
      void load();
    }
  }, [status, apiClient]);

  if (status === "loading" || loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin />
      </div>
    );
  }

  if (!session) {
    return (
      <Card className="content-card" title="Security settings">
        <Alert type="warning" showIcon message="Sign in to manage your security settings." />
      </Card>
    );
  }

  return (
    <Card className="content-card" title="Security settings">
      {contextHolder}
      <Typography.Paragraph type="secondary">
        Manage your authenticator app and recovery codes.
      </Typography.Paragraph>
      <Alert
        type={statusPayload?.enabled ? "success" : "info"}
        showIcon
        style={{ marginBottom: "1rem" }}
        message={
          statusPayload?.enabled
            ? `MFA enabled. Recovery codes remaining: ${statusPayload.recoveryCodesRemaining}`
            : "MFA is not enabled"
        }
      />
      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <Button
          onClick={async () => {
            const response = await apiClient.post<{ secret: string; otpauthUri: string }>(
              "auth/mfa/enroll",
            );
            setEnrollment(response.data);
          }}
        >
          {statusPayload?.enabled ? "Re-enroll authenticator" : "Set up authenticator"}
        </Button>
        {statusPayload?.enabled ? (
          <Button
            onClick={async () => {
              const code = window.prompt("Enter current authenticator code");
              if (!code) {
                return;
              }
              await apiClient.post("auth/mfa/recovery/rotate", { code });
              messageApi.success("Recovery codes rotated");
              await load();
            }}
          >
            Rotate recovery codes
          </Button>
        ) : null}
      </div>
      {enrollment ? (
        <Card size="small" title="Authenticator setup" style={{ marginBottom: "1rem" }}>
          <Typography.Paragraph copyable>{enrollment.secret}</Typography.Paragraph>
          <Typography.Paragraph copyable>{enrollment.otpauthUri}</Typography.Paragraph>
          <Form
            layout="vertical"
            onFinish={async (values: { code: string }) => {
              const response = await apiClient.post<{ recoveryCodes: string[] }>(
                "auth/mfa/verify-enroll",
                values,
              );
              messageApi.success(
                `MFA enabled. Recovery codes: ${response.data.recoveryCodes.join(", ")}`,
              );
              setEnrollment(null);
              await load();
            }}
          >
            <Form.Item label="Verification code" name="code" rules={[{ required: true }]}>
              <Input size="large" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit">
                Verify authenticator
              </Button>
            </Form.Item>
          </Form>
        </Card>
      ) : null}
    </Card>
  );
}
