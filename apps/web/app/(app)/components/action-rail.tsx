"use client";

import {
  AppstoreOutlined,
  BellOutlined,
  BookOutlined,
  ClusterOutlined,
  DashboardOutlined,
  ExclamationCircleOutlined,
  FundOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  HistoryOutlined,
  ReadOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  RadarChartOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Tooltip } from "antd";
import type { TFunction } from "i18next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { resolveActiveItemKey } from "./action-rail-routing";
import { estimateRailContentHeight, type NavMode } from "./nav-mode";

export interface ActionItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  path?: string;
}

export interface ActionRailNavConfig {
  mainNavItems: ActionItem[];
  adminNavItems: ActionItem[];
}

interface ActionRailProps {
  mode: NavMode;
  onContentHeightChange?: (height: number) => void;
}

// Shared between the desktop ActionRail and the mobile Drawer in TopNav.
export function buildActionRailNavConfig(
  t: TFunction,
  permissions: readonly string[],
): ActionRailNavConfig {
  const canManageCrawl =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canUseAssistant =
    permissions.includes("assistant.read") ||
    permissions.includes("assistant.run");
  const canManageAdmin =
    permissions.includes("settings.manage") ||
    permissions.includes("org.write") ||
    permissions.includes("users.write") ||
    permissions.includes("crawl.read") ||
    permissions.includes("crawl.write") ||
    permissions.includes("dashboards.write") ||
    permissions.includes("alerts.manage");
  const canViewDashboards = permissions.includes("dashboards.read");
  const canUseAnalysis = permissions.includes("analysis.read") || permissions.includes("analysis.write");

  const mainNavItems: ActionItem[] = [
    {
      key: "/news-hub",
      icon: <AppstoreOutlined />,
      label: t("nav.main.newsHub", { defaultValue: "News Hub" }),
      path: "/news-hub",
    },
    {
      key: "/today",
      icon: <ReadOutlined />,
      label: t("nav.main.today", { defaultValue: "Today" }),
      path: "/today",
    },
    {
      key: "/newsnow",
      icon: <GlobalOutlined />,
      label: t("nav.main.newsnow", { defaultValue: "NewsNow" }),
      path: "/newsnow",
    },
    {
      key: "/topics",
      icon: <AppstoreOutlined />,
      label: t("nav.main.topics", { defaultValue: "Topics" }),
      path: "/topics",
    },
    {
      key: "/events",
      icon: <ClusterOutlined />,
      label: t("nav.main.events", { defaultValue: "News Events" }),
      path: "/events",
    },
    {
      key: "/events-archive",
      icon: <HistoryOutlined />,
      label: t("nav.main.eventsArchive", { defaultValue: "Events Archive" }),
      path: "/events-archive",
    },
    {
      key: "/rss",
      icon: <BookOutlined />,
      label: t("nav.main.rss", { defaultValue: "RSS Reader" }),
      path: "/rss",
    },
    {
      key: "/situation-monitor",
      icon: <RadarChartOutlined />,
      label: t("nav.main.situationMonitor", {
        defaultValue: "Situation Monitor",
      }),
      path: "/situation-monitor",
    },
    {
      key: "/map",
      icon: <GlobalOutlined />,
      label: t("nav.main.map", { defaultValue: "Map" }),
      path: "/map",
    },
    ...(canViewDashboards
      ? [
          {
            key: "/knowledge-graph",
            icon: <ClusterOutlined />,
            label: t("nav.main.knowledgeGraph", { defaultValue: "Knowledge Graph" }),
            path: "/knowledge-graph",
          },
        ]
      : []),
    {
      key: "/finance",
      icon: <FundOutlined />,
      label: t("nav.main.finance", { defaultValue: "Finance" }),
      path: "/finance",
    },
    {
      key: "/alerts",
      icon: <ExclamationCircleOutlined />,
      label: t("nav.main.alerts", { defaultValue: "Alert Center" }),
      path: "/alerts",
    },
    {
      key: "/search",
      icon: <SearchOutlined />,
      label: t("nav.main.search", { defaultValue: "Search" }),
      path: "/search",
    },
    ...(canUseAnalysis
      ? [
          {
            key: "/analysis",
            icon: <FolderOpenOutlined />,
            label: t("nav.main.analysis", { defaultValue: "Analysis" }),
            path: "/analysis",
          },
        ]
      : []),
  ];

  if (canUseAssistant) {
    mainNavItems.push({
      key: "/assistant",
      icon: <RobotOutlined />,
      label: t("nav.main.assistant", { defaultValue: "Assistant" }),
      path: "/assistant",
    });
  }

  mainNavItems.push(
    {
      key: "/subscriptions",
      icon: <BellOutlined />,
      label: t("nav.main.subscriptions", { defaultValue: "Subscriptions" }),
      path: "/subscriptions",
    },
    {
      key: "/profile",
      icon: <UserOutlined />,
      label: t("nav.main.profile", { defaultValue: "Profile" }),
      path: "/profile",
    },
  );

  const adminNavItems: ActionItem[] = [];
  if (canViewDashboards) {
    adminNavItems.push({
      key: "/dashboard",
      icon: <DashboardOutlined />,
      label: t("nav.dashboard", { defaultValue: "Dashboard" }),
      path: "/dashboard",
    });
  }
  if (canManageCrawl) {
    adminNavItems.push({
      key: "/admin/ops/crawl-tasks",
      icon: <RadarChartOutlined />,
      label: t("nav.crawlTasks", { defaultValue: "Crawl Tasks" }),
      path: "/admin/ops/crawl-tasks",
    });
  }
  if (canManageAdmin) {
    adminNavItems.push({
      key: "/admin",
      icon: <SettingOutlined />,
      label: t("nav.admin", { defaultValue: "Admin" }),
      path: "/admin",
    });
  }

  return { mainNavItems, adminNavItems };
}

export function ActionRail({ mode, onContentHeightChange }: ActionRailProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];

  const { mainNavItems, adminNavItems } = useMemo(
    () => buildActionRailNavConfig(t, permissions),
    [permissions, t],
  );
  const allNavItems = useMemo(
    () => [...mainNavItems, ...adminNavItems],
    [adminNavItems, mainNavItems],
  );
  const activeKey = useMemo(
    () => resolveActiveItemKey(pathname, allNavItems),
    [allNavItems, pathname],
  );
  const estimatedContentHeight = useMemo(
    () => estimateRailContentHeight(mainNavItems.length, adminNavItems.length),
    [adminNavItems.length, mainNavItems.length],
  );

  useEffect(() => {
    onContentHeightChange?.(estimatedContentHeight);
  }, [estimatedContentHeight, onContentHeightChange]);

  if (mode === "drawer") {
    return null;
  }

  const isScrollable = mode === "rail-scroll";
  const scrollableRailClass = isScrollable
    ? "rail-scrollbar max-h-full overflow-y-auto overscroll-contain pr-1"
    : "";

  return (
    <aside
      className={`
        hidden md:flex flex-col h-full px-3 shrink-0 relative z-20 pointer-events-auto min-h-0
        ${isScrollable ? "justify-start" : "justify-center"}
      `}
    >
      <div
        className={`
        flex flex-col items-center py-4 gap-2 w-[4.5rem]
        glass-panel rounded-2xl border border-[var(--border)]
        shadow-[0_10px_30px_rgba(15,23,42,0.08)]
        ${scrollableRailClass}
      `}
      >
        {/* Main Navigation */}
        <div className="flex flex-col gap-1.5 w-full px-2 pb-4 border-b border-white/5">
          {mainNavItems.map((item) => {
            const isActive = item.key === activeKey;
            return (
              <Tooltip key={item.key} title={item.label} placement="right">
                <Link
                  href={item.path ?? "#"}
                  aria-label={item.label}
                  aria-current={isActive ? "page" : undefined}
                  className={`
                    w-full h-11 flex items-center justify-center rounded-xl transition-all duration-150 select-none
                    cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-white
                    active:scale-[0.97]
                    ${
                      isActive
                        ? "bg-[var(--primary)] text-white shadow-sm"
                        : "text-slate-500 hover:text-[var(--primary)] hover:bg-slate-100 active:bg-slate-200"
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
          <div className="flex flex-col gap-1.5 w-full px-2 pt-3">
            <span className="px-2 text-[10px] uppercase tracking-[0.2em] text-slate-400 whitespace-nowrap">
              {t("nav.adminGroup", { defaultValue: "Admin" })}
            </span>
            {adminNavItems.map((item) => {
              const isActive = item.key === activeKey;
              return (
                <Tooltip key={item.key} title={item.label} placement="right">
                  <Link
                    href={item.path ?? "#"}
                    aria-label={item.label}
                    aria-current={isActive ? "page" : undefined}
                    className={`
                      w-full h-11 flex items-center justify-center rounded-xl transition-all duration-150 select-none
                      cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-white
                      active:scale-[0.97]
                      ${
                        isActive
                          ? "bg-[var(--primary)] text-white shadow-sm"
                          : "text-slate-500 hover:text-[var(--primary)] hover:bg-slate-100 active:bg-slate-200"
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
