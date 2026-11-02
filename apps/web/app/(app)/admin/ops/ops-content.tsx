"use client";

import { Alert, Card, Empty, List, Spin } from "antd";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/page-header";

import { canViewQueueOps } from "./queue-ops/queue-ops-access";

interface OpsVisibilityContext {
  permissions: readonly string[];
  globalRoles: readonly string[];
}

interface OpsLink {
  key: string;
  title: string;
  description: string;
  href: string;
  permission?: "crawl.read" | "crawl.write";
  /** 自定义可见性判定（优先于 permission 字段）。 */
  isVisible?: (context: OpsVisibilityContext) => boolean;
}

export function OpsContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const globalRoles = session?.user?.globalRoles ?? [];
  const canViewOps =
    permissions.includes("crawl.read") ||
    permissions.includes("crawl.write") ||
    canViewQueueOps({ permissions, globalRoles });

  const opsLinks: OpsLink[] = [
    {
      key: "crawl-tasks",
      title: t("ops.links.crawlTasks.title"),
      description: t("ops.links.crawlTasks.description"),
      href: "/admin/ops/crawl-tasks",
      permission: "crawl.read"
    },
    {
      key: "crawl-monitor",
      title: t("ops.links.crawlMonitor.title"),
      description: t("ops.links.crawlMonitor.description"),
      href: "/admin/ops/crawl-monitor",
      permission: "crawl.read"
    },
    {
      key: "crawl-templates",
      title: t("ops.links.crawlTemplates.title"),
      description: t("ops.links.crawlTemplates.description"),
      href: "/admin/ops/crawl-templates",
      permission: "crawl.read"
    },
    {
      key: "crawl-frontier",
      title: t("ops.links.crawlFrontier.title"),
      description: t("ops.links.crawlFrontier.description"),
      href: "/admin/ops/crawl-frontier",
      permission: "crawl.read",
    },
    {
      key: "news-sources",
      title: t("ops.links.newsSources.title"),
      description: t("ops.links.newsSources.description"),
      href: "/admin/ops/news-sources",
      permission: "crawl.write"
    },
    {
      key: "queue-ops",
      title: t("ops.links.queueOps.title"),
      description: t("ops.links.queueOps.description"),
      href: "/admin/ops/queue-ops",
      isVisible: canViewQueueOps
    }
  ];

  const visibleLinks = opsLinks.filter((link) => {
    if (link.isVisible) {
      return link.isVisible({ permissions, globalRoles });
    }
    if (!link.permission) {
      return canViewOps;
    }
    if (permissions.includes(link.permission)) {
      return true;
    }
    return link.permission === "crawl.read" && permissions.includes("crawl.write");
  });

  if (status === "loading") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spin size="large" />
      </div>
    );
  }

  if (!canViewOps) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader kicker={t("nav.groups.admin")} title={t("ops.title")} />
        <Alert
          type="warning"
          showIcon
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        kicker={t("nav.groups.admin")}
        title={t("ops.title")}
        description={t("ops.subtitle")}
      />
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
