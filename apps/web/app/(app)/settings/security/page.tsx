"use client";

import { Alert, App, Button, Card, Form, Input, Modal, Spin, Typography } from "antd";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/page-header";
import { SectionHeader } from "@/components/section-header";
import { createApiClient } from "@/lib/api-client";

interface MfaStatusResponse {
  enabled: boolean;
  enrolledAt?: string | null;
  verifiedAt?: string | null;
  lastUsedAt?: string | null;
  recoveryCodesRemaining: number;
}

export default function SecuritySettingsPage() {
  const { t } = useTranslation();
  const { message: messageApi } = App.useApp();
  const { data: session, status } = useSession();
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );
  const [statusPayload, setStatusPayload] = useState<MfaStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptValue, setPromptValue] = useState("");

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
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spin />
      </div>
    );
  }

  if (!session) {
    return (
      <Card className="content-card" title={t("settings.security.title")}>
        <Alert type="warning" showIcon message={t("settings.security.signInRequired")} />
      </Card>
    );
  }

  const handleRotateRecoveryCodes = async () => {
    const code = promptValue.trim();
    if (!code) {
      return;
    }
    await apiClient.post("auth/mfa/recovery/rotate", { code });
    messageApi.success(t("settings.security.recoveryCodesRotated"));
    setPromptOpen(false);
    setPromptValue("");
    await load();
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t("nav.groups.workspace")}
        title={t("settings.security.title")}
        description={t("settings.security.description")}
      />
      <Card className="content-card">
        <div className="flex flex-col gap-4">
          <Alert
            type={statusPayload?.enabled ? "success" : "info"}
            showIcon
            message={
              statusPayload?.enabled
                ? t("settings.security.mfaEnabledWithCodes", {
                    count: statusPayload.recoveryCodesRemaining,
                  })
                : t("settings.security.mfaNotEnabled")
            }
          />
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={async () => {
                const response = await apiClient.post<{ secret: string; otpauthUri: string }>(
                  "auth/mfa/enroll",
                );
                setEnrollment(response.data);
              }}
            >
              {statusPayload?.enabled
                ? t("settings.security.reEnroll")
                : t("settings.security.setUpAuthenticator")}
            </Button>
            {statusPayload?.enabled ? (
              <Button onClick={() => setPromptOpen(true)}>
                {t("settings.security.rotateRecoveryCodes")}
              </Button>
            ) : null}
          </div>
          {enrollment ? (
            <div className="surface-inset flex flex-col gap-4">
              <SectionHeader title={t("settings.security.authenticatorSetup")} />
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
                    t("settings.security.mfaEnabledWithRecoveryCodes", {
                      codes: response.data.recoveryCodes.join(", "),
                    }),
                  );
                  setEnrollment(null);
                  await load();
                }}
              >
                <Form.Item
                  label={t("settings.security.verificationCode")}
                  name="code"
                  rules={[{ required: true }]}
                >
                  <Input size="large" />
                </Form.Item>
                <Form.Item>
                  <Button type="primary" htmlType="submit">
                    {t("settings.security.verifyAuthenticator")}
                  </Button>
                </Form.Item>
              </Form>
            </div>
          ) : null}
        </div>
      </Card>
      <Modal
        title={t("settings.security.rotatePromptTitle")}
        open={promptOpen}
        onOk={() => void handleRotateRecoveryCodes()}
        onCancel={() => {
          setPromptOpen(false);
          setPromptValue("");
        }}
        okText={t("common.confirm")}
        cancelText={t("common.cancel")}
      >
        <Input
          value={promptValue}
          onChange={(event) => setPromptValue(event.target.value)}
          placeholder={t("settings.security.rotatePromptPlaceholder")}
          onPressEnter={() => void handleRotateRecoveryCodes()}
          aria-label={t("settings.security.rotatePromptPlaceholder")}
        />
      </Modal>
    </div>
  );
}
