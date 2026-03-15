"use client";

import {
  AlertOutlined,
  AppstoreOutlined,
  ClusterOutlined,
  DashboardOutlined,
  ExclamationCircleOutlined,
  LineChartOutlined,
  RightOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { Alert, Card, Collapse, Empty, Space, Spin, Typography } from "antd";
import Link from "next/link";
import { useSession } from "next-auth/react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";

import {
  ADMIN_GROUP_ORDER,
  canViewAdmin,
  filterVisibleAdminLinks,
  groupAdminLinksBySection,
  type AdminGroupKey,
  type AdminLinkPermission,
} from "./admin-content.utils";
import { buildAdminLogsHref } from "@/lib/admin-logs";
import { buildAdminSettingsHref } from "./settings/settings-navigation";
import styles from "./admin-content.module.css";

interface AdminLinkItem {
  key: string;
  title: string;
  description: string;
  href: string;
  permission?: AdminLinkPermission;
  group: AdminGroupKey;
  icon: ComponentType<{ className?: string }>;
}

interface AdminGroupItem {
  key: AdminGroupKey;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

export function AdminContent() {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const isAdminVisible = canViewAdmin(permissions);

  const adminGroups: AdminGroupItem[] = [
    {
      key: "operations",
      title: t("adminConsole.groups.operations.title", {
        defaultValue: "Operations & Delivery",
      }),
      description: t("adminConsole.groups.operations.description", {
        defaultValue: "Run content pipelines, dashboards, and alert routing.",
      }),
      icon: AppstoreOutlined,
    },
    {
      key: "monitoring",
      title: t("adminConsole.groups.monitoring.title", {
        defaultValue: "Monitoring & Quality",
      }),
      description: t("adminConsole.groups.monitoring.description", {
        defaultValue:
          "Track failures, data quality, and knowledge-review backlogs.",
      }),
      icon: LineChartOutlined,
    },
    {
      key: "governance",
      title: t("adminConsole.groups.governance.title", {
        defaultValue: "Governance & Access",
      }),
      description: t("adminConsole.groups.governance.description", {
        defaultValue: "Control organizations, permissions, and auditability.",
      }),
      icon: TeamOutlined,
    },
    {
      key: "platform",
      title: t("adminConsole.groups.platform.title", {
        defaultValue: "Platform & Infrastructure",
      }),
      description: t("adminConsole.groups.platform.description", {
        defaultValue:
          "Manage storage, runtime defaults, and core system behavior.",
      }),
      icon: SettingOutlined,
    },
  ];

  const adminLinks: AdminLinkItem[] = [
    {
      key: "ops",
      title: t("adminConsole.links.ops.title", { defaultValue: "Operations" }),
      description: t("adminConsole.links.ops.description", {
        defaultValue: "Manage crawl tasks and source scheduling",
      }),
      href: "/admin/ops",
      permission: "crawl.read",
      group: "operations",
      icon: AppstoreOutlined,
    },
    {
      key: "dashboards",
      title: t("adminConsole.links.dashboards.title", {
        defaultValue: "Dashboard Config",
      }),
      description: t("adminConsole.links.dashboards.description", {
        defaultValue: "Edit dashboard layouts and metrics",
      }),
      href: "/admin/dashboards",
      permission: "dashboards.write",
      group: "operations",
      icon: DashboardOutlined,
    },
    {
      key: "alerts",
      title: t("adminConsole.links.alerts.title", {
        defaultValue: "Alert Rules",
      }),
      description: t("adminConsole.links.alerts.description", {
        defaultValue: "Configure alert rules and channels",
      }),
      href: "/admin/alerts",
      permission: "alerts.manage",
      group: "operations",
      icon: AlertOutlined,
    },
    {
      key: "logs",
      title: t("adminConsole.links.logs.title", {
        defaultValue: "Logs",
      }),
      description: t("adminConsole.links.logs.description", {
        defaultValue: "Inspect task, error, and audit events in one workspace",
      }),
      href: buildAdminLogsHref({ tab: "task" }),
      permission: "settings.manage",
      group: "monitoring",
      icon: ExclamationCircleOutlined,
    },
    {
      key: "quality",
      title: t("adminConsole.links.quality.title", {
        defaultValue: "Data Quality",
      }),
      description: t("adminConsole.links.quality.description", {
        defaultValue:
          "Monitor pipeline success, latency, and source reliability",
      }),
      href: "/admin/quality",
      permission: "settings.manage",
      group: "monitoring",
      icon: LineChartOutlined,
    },
    {
      key: "knowledgeGraphReview",
      title: t("adminConsole.links.knowledgeGraphReview.title", {
        defaultValue: "Knowledge Graph Review",
      }),
      description: t("adminConsole.links.knowledgeGraphReview.description", {
        defaultValue:
          "Review low-confidence knowledge graph relations and record human feedback",
      }),
      href: buildAdminSettingsHref({
        page: "knowledge",
        panel: "knowledge-graph-review",
      }),
      permission: "knowledgegraph.review",
      group: "monitoring",
      icon: ClusterOutlined,
    },
    {
      key: "orgs",
      title: t("adminConsole.links.orgs.title", {
        defaultValue: "Organizations",
      }),
      description: t("adminConsole.links.orgs.description", {
        defaultValue: "Manage orgs and memberships",
      }),
      href: "/admin/orgs",
      permission: "org.write",
      group: "governance",
      icon: TeamOutlined,
    },
    {
      key: "settingsWorkspace",
      title: t("adminSettings.workspace.title", {
        defaultValue: "Settings Workspace",
      }),
      description: t("adminSettings.workspace.adminCardDescription", {
        defaultValue:
          "Open the unified workspace for access, system, storage, and service configuration.",
      }),
      href: "/admin/settings",
      permission: "settings.manage",
      group: "platform",
      icon: SettingOutlined,
    },
  ];

  const visibleLinks = filterVisibleAdminLinks(adminLinks, permissions);
  const groupedLinks = groupAdminLinksBySection(visibleLinks);
  const visibleGroupOrder = ADMIN_GROUP_ORDER.filter(
    (group) => groupedLinks[group].length > 0,
  );
  const highlightedMetrics = [
    {
      key: "sections",
      label: t("adminConsole.metrics.sections", { defaultValue: "Sections" }),
      value: visibleGroupOrder.length,
      hint: t("adminConsole.metrics.sectionsHint", {
        defaultValue: "Functional domains",
      }),
    },
    {
      key: "links",
      label: t("adminConsole.metrics.links", { defaultValue: "Quick Links" }),
      value: visibleLinks.length,
      hint: t("adminConsole.metrics.linksHint", {
        defaultValue: "Available shortcuts",
      }),
    },
    {
      key: "permissions",
      label: t("adminConsole.metrics.permissions", {
        defaultValue: "Permissions",
      }),
      value: permissions.length,
      hint: t("adminConsole.metrics.permissionsHint", {
        defaultValue: "Granted capabilities",
      }),
    },
  ];

  if (status === "loading") {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (!isAdminVisible) {
    return (
      <Card
        className="content-card"
        title={t("adminConsole.title", { defaultValue: "Admin Console" })}
      >
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  const renderGroupGrid = (group: AdminGroupItem) => {
    const links = groupedLinks[group.key];

    if (links.length === 0) {
      return null;
    }

    const GroupIcon = group.icon;

    return (
      <section
        key={group.key}
        data-tone={group.key}
        className={styles.groupSection}
      >
        <div className={styles.groupHeader}>
          <div className={styles.groupSummary}>
            <span className={styles.groupIconShell}>
              <GroupIcon className={styles.groupIcon} />
            </span>
            <div className={styles.groupText}>
              <h3 className={styles.groupTitle}>{group.title}</h3>
              <p className={styles.groupDescription}>{group.description}</p>
            </div>
          </div>
          <span className={styles.groupCounter}>
            {t("adminConsole.group.itemCount", {
              count: links.length,
              defaultValue: "{{count}} items",
            })}
          </span>
        </div>

        <div className={styles.linkGrid}>
          {links.map((item) => {
            const LinkIcon = item.icon;

            return (
              <Link key={item.key} href={item.href} className={styles.linkCard}>
                <div className={styles.linkContent}>
                  <span className={styles.linkIconShell}>
                    <LinkIcon className={styles.linkIcon} />
                  </span>
                  <div className={styles.linkText}>
                    <h4 className={styles.linkTitle}>{item.title}</h4>
                    <p className={styles.linkDescription}>{item.description}</p>
                  </div>
                </div>
                <div className={styles.cardAction}>
                  {t("adminConsole.card.enter", { defaultValue: "Open" })}
                  <RightOutlined className="ml-1 text-[10px]" />
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className={styles.adminShell}>
      <div className={styles.headerBlock}>
        <Space direction="vertical" size={2}>
          <Typography.Title
            level={4}
            className={styles.pageTitle}
            style={{ margin: 0 }}
          >
            {t("adminConsole.title", { defaultValue: "Admin Console" })}
          </Typography.Title>
          <Typography.Text className={styles.pageSubtitle}>
            {t("adminConsole.subtitle", {
              defaultValue:
                "Manage operations, organizations, dashboards, alerts, and system settings.",
            })}
          </Typography.Text>
        </Space>

        <div className={styles.metricsRail}>
          {highlightedMetrics.map((metric) => (
            <div key={metric.key} className={styles.metricCard}>
              <span className={styles.metricLabel}>{metric.label}</span>
              <span className={styles.metricValue}>{metric.value}</span>
              <span className={styles.metricHint}>{metric.hint}</span>
            </div>
          ))}
        </div>
      </div>

      <Card className={`content-card ${styles.mainCard}`}>
        {visibleLinks.length ? (
          <>
            <div className={styles.groupStack}>
              {visibleGroupOrder.map((groupKey) => {
                const group = adminGroups.find((item) => item.key === groupKey);
                return group ? renderGroupGrid(group) : null;
              })}
            </div>

            <div className={styles.mobileGroups}>
              <Collapse
                size="large"
                className={styles.adminCollapse}
                items={visibleGroupOrder.map((groupKey) => {
                  const group = adminGroups.find(
                    (item) => item.key === groupKey,
                  );
                  if (!group) {
                    return {
                      key: groupKey,
                      label: groupKey,
                      children: null,
                    };
                  }

                  const GroupIcon = group.icon;

                  return {
                    key: group.key,
                    label: (
                      <div
                        data-tone={group.key}
                        className={styles.mobileGroupLabel}
                      >
                        <div className={styles.mobileGroupTitle}>
                          <span
                            className={`${styles.groupIconShell} ${styles.groupIconShellCompact}`}
                          >
                            <GroupIcon className={styles.groupIcon} />
                          </span>
                          <span className={styles.mobileGroupName}>
                            {group.title}
                          </span>
                        </div>
                        <span className={styles.groupCounter}>
                          {groupedLinks[group.key].length}
                        </span>
                      </div>
                    ),
                    children: (
                      <div
                        data-tone={group.key}
                        className={styles.mobileGroupBody}
                      >
                        <div className={styles.mobileLinkGrid}>
                          {groupedLinks[group.key].map((item) => {
                            const LinkIcon = item.icon;

                            return (
                              <Link
                                key={item.key}
                                href={item.href}
                                className={styles.linkCard}
                              >
                                <div className={styles.linkContent}>
                                  <span className={styles.linkIconShell}>
                                    <LinkIcon className={styles.linkIcon} />
                                  </span>
                                  <div className={styles.linkText}>
                                    <h4 className={styles.linkTitle}>
                                      {item.title}
                                    </h4>
                                    <p className={styles.linkDescription}>
                                      {item.description}
                                    </p>
                                  </div>
                                </div>
                                <div className={styles.cardAction}>
                                  {t("adminConsole.card.enter", {
                                    defaultValue: "Open",
                                  })}
                                  <RightOutlined className="ml-1 text-[10px]" />
                                </div>
                              </Link>
                            );
                          })}
                        </div>
                      </div>
                    ),
                  };
                })}
              />
            </div>
          </>
        ) : (
          <Empty description={t("common.empty")} />
        )}
      </Card>
    </div>
  );
}
