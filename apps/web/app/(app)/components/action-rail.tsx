"use client";

import {
  AppstoreOutlined,
  BellOutlined,
  FundOutlined,
  GlobalOutlined,
  ReadOutlined,
  SearchOutlined,
  SettingOutlined,
  RadarChartOutlined
} from "@ant-design/icons";
import { Tooltip } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { useSession } from "next-auth/react";

interface ActionItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  path?: string;
}

export function ActionRail() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageSettings = permissions.includes("settings.manage");
  const canManageCrawl = permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManageAdmin = permissions.includes("org.write") || permissions.includes("users.write");

  const mainNavItems: ActionItem[] = [
    { key: "/today", icon: <ReadOutlined />, label: "Today", path: "/today" },
    { key: "/topics", icon: <AppstoreOutlined />, label: "Topics", path: "/topics" },
    { key: "/map", icon: <GlobalOutlined />, label: "Map", path: "/map" },
    { key: "/finance", icon: <FundOutlined />, label: "Finance", path: "/finance" },
    { key: "/search", icon: <SearchOutlined />, label: "Search", path: "/search" },
    { key: "/subscriptions", icon: <BellOutlined />, label: "Subscriptions", path: "/subscriptions" }
  ];

  const adminNavItems = useMemo<ActionItem[]>(() => {
    const items: ActionItem[] = [];
    if (canManageCrawl) {
      items.push({ key: "/crawl", icon: <RadarChartOutlined />, label: "Sources", path: "/crawl" });
    }
    if (canManageSettings) {
      items.push({ key: "/settings", icon: <SettingOutlined />, label: "Settings", path: "/settings" });
    }
    if (canManageAdmin) {
      items.push({ key: "/admin", icon: <SettingOutlined />, label: "Admin", path: "/admin" });
    }
    return items;
  }, [canManageAdmin, canManageCrawl, canManageSettings]);

  return (
    <aside className="hidden md:flex flex-col justify-center h-full pl-4 pr-2 z-40">
      <div className="
        flex flex-col items-center py-4 gap-2
        glass-panel rounded-2xl border border-[var(--border)]
        shadow-[0_0_20px_rgba(0,0,0,0.5)]
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
                      ? "bg-[var(--primary)] text-black shadow-[0_0_10px_rgba(0,240,255,0.5)] scale-110" 
                      : "text-gray-400 hover:text-white hover:bg-white/10"
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
          <div className="flex flex-col gap-2 w-full px-2 pt-2">
            {adminNavItems.map((item) => {
              const isActive = item.path ? pathname.startsWith(item.path) : false;
              return (
                <Tooltip key={item.key} title={item.label} placement="right">
                  <Link
                    href={item.path ?? "#"}
                    className={`
                      w-10 h-10 flex items-center justify-center rounded-xl transition-all duration-200
                      ${isActive 
                        ? "bg-[var(--primary)] text-black shadow-[0_0_10px_rgba(0,240,255,0.5)] scale-110" 
                        : "text-gray-400 hover:text-white hover:bg-white/10"
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
