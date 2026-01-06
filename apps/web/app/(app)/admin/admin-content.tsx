"use client";

import { Alert, Card, Empty, List, Space, Spin, Typography } from "antd";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";

export function AdminContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canViewAdmin =
    permissions.includes("settings.manage") ||
    permissions.includes("org.write") ||
    permissions.includes("users.write");

  const adminLinks = [
    {
      key: "orgs",
      title: t("adminConsole.links.orgs.title", { defaultValue: "Organizations" }),
      description: t("adminConsole.links.orgs.description", {
        defaultValue: "Manage orgs and memberships"
      }),
      href: "/admin/orgs",
      permission: "org.write"
    },
    {
      key: "errors",
      title: t("adminConsole.links.errors.title", { defaultValue: "Error Events" }),
      description: t("adminConsole.links.errors.description", {
        defaultValue: "Inspect recent system errors"
      }),
      href: "/admin/errors",
      permission: "settings.manage"
    },
    {
      key: "storage",
      title: t("adminConsole.links.storage.title", { defaultValue: "Storage Settings" }),
      description: t("adminConsole.links.storage.description", {
        defaultValue: "Configure storage backends"
      }),
      href: "/admin/storage",
      permission: "settings.manage"
    },
    {
      key: "audit",
      title: t("adminConsole.links.audit.title", { defaultValue: "Audit Logs" }),
      description: t("adminConsole.links.audit.description", {
        defaultValue: "Review configuration and access events"
      }),
      href: "/admin/audit-logs",
      permission: "settings.manage"
    }
  ];

  const visibleLinks = adminLinks.filter((link) =>
    link.permission ? permissions.includes(link.permission) : true
  );

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canViewAdmin) {
    return (
      <Card className="content-card" title={t("adminConsole.title", { defaultValue: "Admin Console" })}>
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("adminConsole.title", { defaultValue: "Admin Console" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("adminConsole.subtitle", {
            defaultValue: "Manage organizations, storage, system errors, and audit logs."
          })}
        </Typography.Text>
      </Space>
      <Card className="content-card">
        {visibleLinks.length ? (
          <List
            dataSource={visibleLinks}
            renderItem={(item) => (
              <List.Item>
                <List.Item.Meta
                  title={<Link href={item.href}>{item.title}</Link>}
                  description={item.description}
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty description={t("common.empty")} />
        )}
      </Card>
    </div>
  );
}
