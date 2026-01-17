"use client";

import {
  AppstoreOutlined,
  BellOutlined,
  DashboardOutlined,
  ExclamationCircleOutlined,
  FundOutlined,
  GlobalOutlined,
  ReadOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  RadarChartOutlined,
  UserOutlined
} from "@ant-design/icons";
import { Tooltip } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

interface ActionItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  path?: string;
}

export function ActionRail() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageCrawl = permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canUseAssistant = permissions.includes("assistant.read") || permissions.includes("assistant.run");
  const canManageAdmin =
    permissions.includes("settings.manage") ||
    permissions.includes("org.write") ||
    permissions.includes("users.write") ||
    permissions.includes("crawl.read") ||
    permissions.includes("crawl.write") ||
    permissions.includes("dashboards.write") ||
    permissions.includes("alerts.manage");
  const canViewDashboards = permissions.includes("dashboards.read");

  const mainNavItems: ActionItem[] = [
    {
      key: "/today",
      icon: <ReadOutlined />,
      label: t("nav.main.today", { defaultValue: "Today" }),
      path: "/today"
    },
    {
      key: "/topics",
      icon: <AppstoreOutlined />,
      label: t("nav.main.topics", { defaultValue: "Topics" }),
      path: "/topics"
    },
    {
      key: "/map",
      icon: <GlobalOutlined />,
      label: t("nav.main.map", { defaultValue: "Map" }),
      path: "/map"
    },
    {
      key: "/finance",
      icon: <FundOutlined />,
      label: t("nav.main.finance", { defaultValue: "Finance" }),
      path: "/finance"
    },
    {
      key: "/alerts",
      icon: <ExclamationCircleOutlined />,
      label: t("nav.main.alerts", { defaultValue: "Alert Center" }),
      path: "/alerts"
    },
    {
      key: "/search",
      icon: <SearchOutlined />,
      label: t("nav.main.search", { defaultValue: "Search" }),
      path: "/search"
    },
    ...(canUseAssistant
      ? [
          {
            key: "/assistant",
            icon: <RobotOutlined />,
            label: t("nav.main.assistant", { defaultValue: "Assistant" }),
            path: "/assistant"
          } satisfies ActionItem
        ]
      : []),
    {
      key: "/subscriptions",
      icon: <BellOutlined />,
      label: t("nav.main.subscriptions", { defaultValue: "Subscriptions" }),
      path: "/subscriptions"
    },
    {
      key: "/profile",
      icon: <UserOutlined />,
      label: t("nav.main.profile", { defaultValue: "Profile" }),
      path: "/profile"
    }
  ];

  const adminNavItems = useMemo<ActionItem[]>(() => {
    const items: ActionItem[] = [];
    if (canViewDashboards) {
      items.push({
        key: "/dashboard",
        icon: <DashboardOutlined />,
        label: t("nav.dashboard", { defaultValue: "Dashboard" }),
        path: "/dashboard"
      });
    }
    if (canManageCrawl) {
      items.push({
        key: "/admin/ops/crawl-tasks",
        icon: <RadarChartOutlined />,
        label: t("nav.crawlTasks", { defaultValue: "Crawl Tasks" }),
        path: "/admin/ops/crawl-tasks"
      });
    }
    if (canManageAdmin) {
      items.push({
        key: "/admin",
        icon: <SettingOutlined />,
        label: t("nav.admin", { defaultValue: "Admin" }),
        path: "/admin"
      });
    }
    return items;
  }, [canManageAdmin, canManageCrawl, canViewDashboards, t]);

  return (
    <aside className="hidden md:flex flex-col justify-center h-full pl-4 pr-2 z-40">
      <div className="
        flex flex-col items-center py-4 gap-2
        glass-panel rounded-2xl border border-[var(--border)]
        shadow-[0_10px_30px_rgba(15,23,42,0.08)]
      ">
        {/* Main Navigation */}
        <div className="flex flex-col gap-2 w-full px-2 pb-4 border-b border-white/5">
          {mainNavItems.map((item) => {
             const isActive = item.path ? pathname.startsWith(item.path) : false;
             return (
              <Tooltip key={item.key} title={item.label} placement="right">
                <Link
                  href={item.path ?? "#"}
                  className={`
                    w-10 h-10 flex items-center justify-center rounded-xl transition-all duration-200
                    ${isActive 
                      ? "bg-[var(--primary)] text-white shadow-sm" 
                      : "text-slate-500 hover:text-[var(--primary)] hover:bg-slate-50"
                    }
                  `}
                >
                  <span className="text-lg">{item.icon}</span>
                </Link>
              </Tooltip>
            );
          })}
        </div>

        {adminNavItems.length > 0 ? (
          <div className="flex flex-col gap-2 w-full px-2 pt-3">
            <span className="px-2 text-[10px] uppercase tracking-[0.2em] text-slate-400">
              {t("nav.adminGroup", { defaultValue: "Admin" })}
            </span>
            {adminNavItems.map((item) => {
              const isActive = item.path ? pathname.startsWith(item.path) : false;
              return (
                <Tooltip key={item.key} title={item.label} placement="right">
                  <Link
                    href={item.path ?? "#"}
                    className={`
                      w-10 h-10 flex items-center justify-center rounded-xl transition-all duration-200
                      ${isActive 
                        ? "bg-[var(--primary)] text-white shadow-sm" 
                        : "text-slate-500 hover:text-[var(--primary)] hover:bg-slate-50"
                      }
                    `}
                  >
                    <span className="text-lg">{item.icon}</span>
                  </Link>
                </Tooltip>
              );
            })}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
