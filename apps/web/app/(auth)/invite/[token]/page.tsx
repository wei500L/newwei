"use client";

import { Alert, Button, Form, Input, Spin, Typography, message } from "antd";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";

import { createApiClient } from "@/lib/api-client";

interface InvitePayload {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  org: { id: string; name: string; slug: string };
  primaryRole: { id: string; name: string };
  expiresAt: string;
}

export default function InvitePage() {
  const params = useParams<{ token: string }>();
  const token = Array.isArray(params?.token) ? params.token[0] : params?.token;
  const apiClient = useMemo(() => createApiClient(), []);
  const router = useRouter();
  const { data: session } = useSession();
  const [invite, setInvite] = useState<InvitePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (!token) {
      return;
    }
    void (async () => {
      try {
        const response = await apiClient.get<InvitePayload>(`auth/invitations/${token}`);
        setInvite(response.data);
      } catch {
        messageApi.error("Failed to load invite");
      } finally {
        setLoading(false);
      }
    })();
  }, [apiClient, messageApi, token]);

  if (loading) {
    return (
      <div className="auth-card">
        <Spin />
      </div>
    );
  }

  return (
    <div className="auth-card">
      {contextHolder}
      <Typography.Title level={3}>Accept invitation</Typography.Title>
      {invite ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: "1rem" }}
          message={`Join ${invite.org.name} as ${invite.primaryRole.name}`}
        />
      ) : (
        <Alert type="error" showIcon message="Invite is unavailable" />
      )}
      {invite && session?.user?.email === invite.email ? (
        <Button
          type="primary"
          block
          loading={accepting}
          onClick={async () => {
            setAccepting(true);
            try {
              await apiClient.post(`auth/invitations/${token}/accept-authenticated`);
              messageApi.success("Invitation accepted. Please sign in again to refresh your organizations.");
              router.push("/login");
            } catch {
              messageApi.error("Failed to accept invitation");
            } finally {
              setAccepting(false);
            }
          }}
        >
          Accept with current account
        </Button>
      ) : invite ? (
        <Form
          layout="vertical"
          initialValues={{
            firstName: invite.firstName ?? "",
            lastName: invite.lastName ?? "",
          }}
          onFinish={async (values: { firstName: string; lastName: string; password: string }) => {
            setAccepting(true);
            try {
              await apiClient.post(`auth/invitations/${token}/accept`, values);
              messageApi.success("Invitation accepted. You can sign in now.");
              router.push("/login");
            } catch {
              messageApi.error("Failed to accept invitation");
            } finally {
              setAccepting(false);
            }
          }}
        >
          <Form.Item label="First name" name="firstName" rules={[{ required: true }]}>
            <Input size="large" />
          </Form.Item>
          <Form.Item label="Last name" name="lastName" rules={[{ required: true }]}>
            <Input size="large" />
          </Form.Item>
          <Form.Item label="Password" name="password" rules={[{ required: true }, { min: 8 }]}>
            <Input.Password size="large" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={accepting}>
              Accept invitation
            </Button>
          </Form.Item>
        </Form>
      ) : null}
    </div>
  );
}
