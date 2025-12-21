"use client";

import { SwapOutlined } from "@ant-design/icons";
import { AutoComplete, Button, Space, Tooltip, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BackendLoginResponse, OrganizationOption } from "@/lib/auth";
import { captureClientError } from "@/lib/client-telemetry";
import { createTraceHeaders } from "@/lib/trace";

export function OrganizationSwitcher() {
  const { t } = useTranslation();
  const { data: session, status, update } = useSession();
  const [orgId, setOrgId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const availableOrganizations = useMemo(() => {
    const options = new Map<string, OrganizationOption>();
    (session?.organizations ?? session?.user?.organizations ?? []).forEach((org) => {
      options.set(org.id, org);
    });
    if (session?.orgId && !options.has(session.orgId)) {
      options.set(session.orgId, { id: session.orgId });
    }
    return Array.from(options.values());
  }, [session?.orgId, session?.organizations, session?.user?.organizations]);

  useEffect(() => {
    setOrgId(session?.orgId ?? "");
  }, [session?.orgId]);

  const handleSwitch = async () => {
    if (!orgId) {
      setError(t("orgSwitcher.error.selectOrganization"));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/organizations/switch", {
        method: "POST",
        headers: createTraceHeaders({
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({ orgId })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: string };
        const errorMessage = payload.error ?? t("orgSwitcher.error.switchFailed");
        setError(errorMessage);
        messageApi.error(payload.details ?? errorMessage);
        return;
      }

      const data = (await response.json()) as BackendLoginResponse;
      await update({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        accessTokenExpires: Date.now() + data.expiresIn * 1000,
        user: data.user,
        orgId: data.user.orgId,
        permissions: data.user.permissions,
        organizations: data.organizations ?? availableOrganizations
      });
      messageApi.success(t("orgSwitcher.success", { orgId: data.user.orgId }));
    } catch (err) {
      captureClientError("Organization switch failed", err);
      setError(t("orgSwitcher.error.unexpected"));
      messageApi.error(t("orgSwitcher.error.unexpected"));
    } finally {
      setLoading(false);
    }
  };

  if (status !== "authenticated") {
    return null;
  }

  const options = availableOrganizations.map((org) => ({
    value: org.id,
    label: org.name ? `${org.name} (${org.id})` : org.id
  }));

  return (
    <>
      {contextHolder}
      <Space.Compact>
        <Tooltip title={t("orgSwitcher.tooltip")}>
          <AutoComplete
            allowClear
            placeholder={t("orgSwitcher.placeholder")}
            style={{ minWidth: 220 }}
            value={orgId}
            onChange={(value) => setOrgId(value ?? "")}
            options={options}
            filterOption={(inputValue, option) =>
              (option?.label as string)?.toLowerCase().includes(inputValue.toLowerCase()) ?? false
            }
            notFoundContent={<Typography.Text type="secondary">{t("orgSwitcher.notFound")}</Typography.Text>}
          />
        </Tooltip>
        <Button
          type="default"
          icon={<SwapOutlined />}
          loading={loading}
          disabled={!orgId}
          onClick={handleSwitch}
        >
          {t("orgSwitcher.switch")}
        </Button>
      </Space.Compact>
      {error ? (
        <Typography.Text type="danger" style={{ display: "block", textAlign: "right" }}>
          {error}
        </Typography.Text>
      ) : null}
    </>
  );
}
