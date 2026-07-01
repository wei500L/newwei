"use client";

import { SwapOutlined } from "@ant-design/icons";
import { AutoComplete, Button, Space, Tooltip, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getApolloClient } from "@/lib/apollo-client";
import type { BackendLoginResponse, OrganizationOption } from "@/lib/auth";
import { setBrowserAuthSession, type BrowserAuthSession } from "@/lib/browser-auth-session";
import { captureClientError } from "@/lib/client-telemetry";
import { createTraceHeaders } from "@/lib/trace";

type OrganizationSwitcherMode = "full" | "compact";

interface OrganizationSwitcherProps {
  mode?: OrganizationSwitcherMode;
  showErrorText?: boolean;
}

export function OrganizationSwitcher({
  mode = "full",
  showErrorText = true,
}: OrganizationSwitcherProps) {
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
      setError(t("orgSwitcher.error.disabledOrganization"));
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

      const sessionPatch = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        accessTokenExpires: Date.now() + data.expiresIn * 1000,
        user: data.user,
        orgId: data.user.orgId,
        permissions: data.user.permissions,
        organizations: data.organizations ?? availableOrganizations
      };
      const updatedSession = await update(sessionPatch);
      setBrowserAuthSession(
        (updatedSession ?? { ...(session ?? {}), ...sessionPatch }) as BrowserAuthSession
      );
      // Invalidate the Apollo cache so cache-first queries don't serve the previous
      // org's data after switching tenants. resetStore also refetches active queries
      // under the new org; a refetch failure must not fail the switch itself.
      await getApolloClient()
        .resetStore()
        .catch((resetError) => {
          captureClientError("Apollo resetStore after org switch failed", resetError);
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

  const inputWidthClassName =
    mode === "compact"
      ? "w-[104px] xl:w-[124px] 2xl:w-[140px]"
      : "w-[150px] xl:w-[180px] 2xl:w-[220px]";
  const showSwitchLabel = mode === "full";

  return (
    <>
      {contextHolder}
      <Space.Compact>
        <Tooltip title={t("orgSwitcher.tooltip")}>
          <AutoComplete
            allowClear
            id="topnav-organization"
            placeholder={t("orgSwitcher.placeholder")}
            className={inputWidthClassName}
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
          aria-label={t("orgSwitcher.switch")}
          className={showSwitchLabel ? "!px-2 2xl:!px-3" : "!px-2"}
        >
          {showSwitchLabel ? (
            <span className="hidden 2xl:inline">{t("orgSwitcher.switch")}</span>
          ) : null}
        </Button>
      </Space.Compact>
      {showErrorText && error ? (
        <Typography.Text type="danger" style={{ display: "block", textAlign: "right" }}>
          {error}
        </Typography.Text>
      ) : null}
    </>
  );
}
