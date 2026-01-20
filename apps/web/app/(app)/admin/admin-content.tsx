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
    permissions.includes("knowledgegraph.review") ||
    permissions.includes("org.write") ||
    permissions.includes("users.write") ||
    permissions.includes("crawl.read") ||
    permissions.includes("crawl.write") ||
    permissions.includes("dashboards.write") ||
    permissions.includes("alerts.manage");

  const adminLinks = [
    {
      key: "ops",
      title: t("adminConsole.links.ops.title", { defaultValue: "Operations" }),
      description: t("adminConsole.links.ops.description", {
        defaultValue: "Manage crawl tasks and source scheduling"
      }),
      href: "/admin/ops",
      permission: "crawl.read"
    },
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
      key: "dashboards",
      title: t("adminConsole.links.dashboards.title", { defaultValue: "Dashboard Config" }),
      description: t("adminConsole.links.dashboards.description", {
        defaultValue: "Edit dashboard layouts and metrics"
      }),
      href: "/admin/dashboards",
      permission: "dashboards.write"
    },
    {
      key: "alerts",
      title: t("adminConsole.links.alerts.title", { defaultValue: "Alert Rules" }),
      description: t("adminConsole.links.alerts.description", {
        defaultValue: "Configure alert rules and channels"
      }),
      href: "/admin/alerts",
      permission: "alerts.manage"
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
      key: "quality",
      title: t("adminConsole.links.quality.title", { defaultValue: "Data Quality" }),
      description: t("adminConsole.links.quality.description", {
        defaultValue: "Monitor pipeline success, latency, and source reliability"
      }),
      href: "/admin/quality",
      permission: "settings.manage"
    },
    {
      key: "knowledgeGraphReview",
      title: t("adminConsole.links.knowledgeGraphReview.title", { defaultValue: "Knowledge Graph Review" }),
      description: t("adminConsole.links.knowledgeGraphReview.description", {
        defaultValue: "Review low-confidence knowledge graph relations and record human feedback"
      }),
      href: "/admin/system?tab=knowledgeGraphReview",
      permission: "knowledgegraph.review"
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
    },
    {
      key: "settings",
      title: t("adminConsole.links.settings.title", { defaultValue: "Access Settings" }),
      description: t("adminConsole.links.settings.description", {
        defaultValue: "Manage roles, permissions, and memberships"
      }),
      href: "/admin/settings",
      permission: "settings.manage"
    },
    {
      key: "system",
      title: t("adminConsole.links.system.title", { defaultValue: "System Settings" }),
      description: t("adminConsole.links.system.description", {
        defaultValue: "Tune cache, rate limits, and crawl defaults"
      }),
      href: "/admin/system",
      permission: "settings.manage"
    }
  ];

  const visibleLinks = adminLinks.filter((link) => {
    if (!link.permission) {
      return true;
    }
    if (permissions.includes(link.permission)) {
      return true;
    }
    if (link.permission === "knowledgegraph.review" && permissions.includes("settings.manage")) {
      return true;
    }
    return link.permission === "crawl.read" && permissions.includes("crawl.write");
  });

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
            defaultValue: "Manage operations, organizations, dashboards, alerts, and system settings."
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
