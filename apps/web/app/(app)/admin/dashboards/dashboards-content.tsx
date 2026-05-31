"use client";

import { Alert, App, Button, Card, Select, Space, Spin, Typography } from "antd";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardEditor } from "@/app/(app)/dashboard/dashboard-editor";
import {
  useDashboardsQuery,
  useDeleteDashboardMutation,
  useUpsertDashboardMutation,
  type UpsertDashboardInput
} from "@/graphql/generated";

export function DashboardsContent() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageDashboards = permissions.includes("dashboards.write");

  const { data, loading, refetch } = useDashboardsQuery({
    skip: !canManageDashboards
  });
  const [upsertDashboard, { loading: saving }] = useUpsertDashboardMutation();
  const [deleteDashboard, { loading: deleting }] = useDeleteDashboardMutation();

  const dashboards = data?.dashboards ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (dashboards.length > 0 && !activeId) {
      setActiveId(dashboards[0]?.id ?? null);
    }
  }, [dashboards, activeId]);

  const activeDashboard = useMemo(
    () => dashboards.find((dashboard) => dashboard.id === activeId),
    [dashboards, activeId]
  );

  const handleSave = async (input: UpsertDashboardInput) => {
    try {
      const result = await upsertDashboard({ variables: { input } });
      const savedId = result.data?.upsertDashboard.id ?? null;
      await refetch();
      if (savedId) {
        setActiveId(savedId);
      }
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("dashboard.editor.saveFailed")
      );
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteDashboard({ variables: { id } });
      await refetch();
      setActiveId(null);
      message.success(t("dashboard.editor.deleted"));
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("dashboard.editor.deleteFailed")
      );
    }
  };

  if (status === "loading" || loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canManageDashboards) {
    return (
      <Card className="content-card" title={t("dashboard.admin.title")}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  const options = dashboards.map((dashboard) => ({
    label: dashboard.name,
    value: dashboard.id
  }));

  return (
    <div className="flex flex-col gap-6">
      <Space align="center" size="middle">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("dashboard.admin.title")}
        </Typography.Title>
        <Button size="small" onClick={() => void refetch()}>
          {t("common.refresh")}
        </Button>
        <Button
          size="small"
          onClick={() => {
            setActiveId(null);
          }}
        >
          {t("dashboard.admin.new")}
        </Button>
        <Select
          style={{ minWidth: 220 }}
          placeholder={t("dashboard.admin.select")}
          value={activeId ?? undefined}
          options={options}
          onChange={(value) => setActiveId(value)}
          allowClear
        />
      </Space>

      <DashboardEditor
        dashboard={activeDashboard}
        saving={saving || deleting}
        onSave={handleSave}
        onDelete={handleDelete}
      />
    </div>
  );
}
