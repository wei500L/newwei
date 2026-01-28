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
  const [orgIdOrSlug, setOrgIdOrSlug] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const availableOrganizations = useMemo(() => {
    const options = new Map<string, OrganizationOption>();
    (session?.organizations ?? session?.user?.organizations ?? []).forEach((org) => {
      options.set(org.id, org);
    });
    if (session?.orgId && !options.has(session.orgId)) {
      options.set(session.orgId, { id: session.orgId, isActive: true });
    }
    return Array.from(options.values());
  }, [session?.orgId, session?.organizations, session?.user?.organizations]);

  const selectedOrganization = useMemo(() => {
    const input = orgIdOrSlug.trim().toLowerCase();
    if (!input) {
      return null;
    }
    return (
      availableOrganizations.find((org) => org.id.toLowerCase() === input) ??
      availableOrganizations.find((org) => (org.slug ?? "").toLowerCase() === input) ??
      null
    );
  }, [availableOrganizations, orgIdOrSlug]);

  const isSelectedDisabled = selectedOrganization?.isActive === false;

  useEffect(() => {
    const currentOrgId = session?.orgId ?? "";
    const current = availableOrganizations.find((org) => org.id === currentOrgId);
    setOrgIdOrSlug(current?.slug ?? currentOrgId);
  }, [availableOrganizations, session?.orgId]);

  const handleSwitch = async () => {
    if (!orgIdOrSlug) {
      setError(t("orgSwitcher.error.selectOrganization"));
      return;
    }

    if (isSelectedDisabled) {
      setError(t("orgSwitcher.error.disabledOrganization", { defaultValue: "Organization is disabled" }));
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
        body: JSON.stringify({ orgId: orgIdOrSlug })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: string };
        const errorMessage = payload.error ?? t("orgSwitcher.error.switchFailed");
        setError(errorMessage);
        messageApi.error(payload.details ?? errorMessage);
        return;
      }

      const data = (await response.json()) as BackendLoginResponse;
      const switchedOrg = (data.organizations ?? availableOrganizations).find(
        (org) => org.id === data.user.orgId
      );
      const switchedLabel =
        switchedOrg?.name ?? switchedOrg?.slug ?? data.user.orgId;

      await update({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        accessTokenExpires: Date.now() + data.expiresIn * 1000,
        user: data.user,
        orgId: data.user.orgId,
        permissions: data.user.permissions,
        organizations: data.organizations ?? availableOrganizations
      });
      messageApi.success(t("orgSwitcher.success", { org: switchedLabel }));
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
    value: org.slug ?? org.id,
    label: org.name
      ? `${org.name} (${org.slug ?? org.id})${org.isActive === false ? ` · ${t("common.disabled")}` : ""}`
      : `${org.slug ?? org.id}${org.isActive === false ? ` · ${t("common.disabled")}` : ""}`,
    disabled: org.isActive === false
  }));

  return (
    <>
      {contextHolder}
      <Space.Compact>
        <Tooltip title={t("orgSwitcher.tooltip")}>
          <AutoComplete
            allowClear
            id="topnav-organization"
            placeholder={t("orgSwitcher.placeholder")}
            style={{ minWidth: 220 }}
            value={orgIdOrSlug}
            onChange={(value) => setOrgIdOrSlug(value ?? "")}
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
          disabled={!orgIdOrSlug || isSelectedDisabled}
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
