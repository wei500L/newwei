"use client";

import { Alert, Card, Empty, List, Space, Spin, Typography } from "antd";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";

interface OpsLink {
  key: string;
  title: string;
  description: string;
  href: string;
  permission: "crawl.read" | "crawl.write";
}

export function OpsContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canViewOps = permissions.includes("crawl.read") || permissions.includes("crawl.write");

  const opsLinks: OpsLink[] = [
    {
      key: "crawl-tasks",
      title: t("ops.links.crawlTasks.title", { defaultValue: "Crawl Tasks" }),
      description: t("ops.links.crawlTasks.description", {
        defaultValue: "Manage crawl jobs and task execution"
      }),
      href: "/admin/ops/crawl-tasks",
      permission: "crawl.read"
    },
    {
      key: "crawl-monitor",
      title: t("ops.links.crawlMonitor.title", { defaultValue: "Crawl4AI Monitor" }),
      description: t("ops.links.crawlMonitor.description", {
        defaultValue: "Real-time dashboard for system metrics and browser pool"
      }),
      href: "/admin/ops/crawl-monitor",
      permission: "crawl.read"
    },
    {
      key: "crawl-templates",
      title: t("ops.links.crawlTemplates.title", { defaultValue: "Crawl Templates" }),
      description: t("ops.links.crawlTemplates.description", {
        defaultValue: "Manage reusable Crawl4ai configuration templates"
      }),
      href: "/admin/ops/crawl-templates",
      permission: "crawl.read"
    },
    {
      key: "crawl-frontier",
      title: t("ops.links.crawlFrontier.title", {
        defaultValue: "Crawl Frontier",
      }),
      description: t("ops.links.crawlFrontier.description", {
        defaultValue:
          "Manage crawl site profiles, frontier runs, and layered/native execution.",
      }),
      href: "/admin/ops/crawl-frontier",
      permission: "crawl.read",
    },
    {
      key: "news-sources",
      title: t("ops.links.newsSources.title", { defaultValue: "News Sources" }),
      description: t("ops.links.newsSources.description", {
        defaultValue: "Manage source scheduling and crawl configs"
      }),
      href: "/admin/ops/news-sources",
      permission: "crawl.write"
    }
  ];

  const visibleLinks = opsLinks.filter((link) => {
    if (permissions.includes(link.permission)) {
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

  if (!canViewOps) {
    return (
      <Card className="content-card" title={t("ops.title", { defaultValue: "Operations" })}>
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
          {t("ops.title", { defaultValue: "Operations" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("ops.subtitle", { defaultValue: "Manage crawl pipelines and source schedules." })}
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
