"use client";

import { Alert, Button, Form, Input, Spin, Typography, message } from "antd";
import { useParams, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";

interface InvitePayload {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  org: { id: string; name: string; slug: string };
  primaryRole: { id: string; name: string };
  expiresAt: string;
}

export default function InvitePage() {
  const { t } = useTranslation();
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
        messageApi.error(t("auth.invite.loadFailed"));
      } finally {
        setLoading(false);
      }
    })();
  }, [apiClient, messageApi, t, token]);

  if (loading) {
    return (
      <div className="auth-card flex min-h-[200px] items-center justify-center">
        <Spin />
      </div>
    );
  }

  return (
    <div className="auth-card">
      {contextHolder}
      <Typography.Title level={3} className="!mb-2 font-serif">{t("auth.invite.title")}</Typography.Title>
      {invite ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: "1rem" }}
          message={t("auth.invite.joinAs", { org: invite.org.name, role: invite.primaryRole.name })}
        />
      ) : (
        <Alert type="error" showIcon message={t("auth.invite.unavailable")} />
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
              messageApi.success(t("auth.invite.acceptedSignInAgain"));
              router.push("/login");
            } catch {
              messageApi.error(t("auth.invite.acceptFailed"));
            } finally {
              setAccepting(false);
            }
          }}
        >
          {t("auth.invite.acceptWithCurrent")}
        </Button>
      ) : invite ? (
        <>
          {session?.user?.email && session.user.email !== invite.email ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: "1rem" }}
              message={t("auth.invite.signedInAs", {
                currentEmail: session.user.email,
                email: invite.email,
              })}
              action={
                <Button
                  size="small"
                  onClick={() => void signOut({ callbackUrl: `/invite/${token}` })}
                >
                  {t("auth.invite.signOut")}
                </Button>
              }
            />
          ) : null}
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
                messageApi.success(t("auth.invite.accepted"));
                router.push("/login");
              } catch (error) {
                const info = extractApiError(error);
                messageApi.error(info.message || t("auth.invite.acceptFailed"));
              } finally {
                setAccepting(false);
              }
            }}
          >
            <Form.Item
              label={t("auth.invite.firstName")}
              name="firstName"
              rules={[{ required: true, message: t("auth.invite.required") }]}
            >
              <Input size="large" />
            </Form.Item>
            <Form.Item
              label={t("auth.invite.lastName")}
              name="lastName"
              rules={[{ required: true, message: t("auth.invite.required") }]}
            >
              <Input size="large" />
            </Form.Item>
            <Form.Item
              label={t("auth.invite.password")}
              name="password"
              rules={[{ required: true, message: t("auth.invite.required") }, { min: 8 }]}
            >
              <Input.Password size="large" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" block loading={accepting}>
                {t("auth.invite.accept")}
              </Button>
            </Form.Item>
          </Form>
        </>
      ) : null}
    </div>
  );
}
