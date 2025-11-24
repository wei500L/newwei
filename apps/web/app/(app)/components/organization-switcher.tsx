"use client";

import { SwapOutlined } from "@ant-design/icons";
import { AutoComplete, Button, Space, Tooltip, Typography, message } from "antd";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";

import type { BackendLoginResponse, OrganizationOption } from "@/lib/auth";

export function OrganizationSwitcher() {
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
      setError("Select an organization to switch into");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/organizations/switch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ orgId })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: string };
        const errorMessage = payload.error ?? "Failed to switch organization";
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
      messageApi.success(`Switched to ${data.user.orgId}`);
    } catch (err) {
      console.error("Organization switch failed", err);
      setError("Unexpected error while switching organization");
      messageApi.error("Unexpected error while switching organization");
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
        <Tooltip title="Switch the active organization for this session">
          <AutoComplete
            allowClear
            placeholder="Organization"
            style={{ minWidth: 220 }}
            value={orgId}
            onChange={(value) => setOrgId(value ?? "")}
            options={options}
            filterOption={(inputValue, option) =>
              (option?.label as string)?.toLowerCase().includes(inputValue.toLowerCase()) ?? false
            }
            notFoundContent={<Typography.Text type="secondary">Type an organization id</Typography.Text>}
          />
        </Tooltip>
        <Button
          type="default"
          icon={<SwapOutlined />}
          loading={loading}
          disabled={!orgId}
          onClick={handleSwitch}
        >
          Switch
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
