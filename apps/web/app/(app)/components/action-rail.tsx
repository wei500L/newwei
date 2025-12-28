"use client";

import {
  AlertOutlined,
  CalendarOutlined,
  CustomerServiceOutlined,
  DashboardOutlined,
  FundOutlined,
  RadarChartOutlined,
  ReadOutlined,
  RobotOutlined,
  SettingOutlined,
  StockOutlined,
  TableOutlined,
  UserOutlined
} from "@ant-design/icons";
import { Tooltip } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

interface ActionItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  path?: string;
  isAction?: boolean;
}

export function ActionRail() {
  const pathname = usePathname();
  const [activeActionKey, setActiveActionKey] = useState<string | null>(null);

  const mainNavItems: ActionItem[] = [
    { key: "/dashboard", icon: <DashboardOutlined />, label: "Overview", path: "/dashboard" },
    { key: "/items", icon: <TableOutlined />, label: "Market Intel", path: "/items" },
    { key: "/crawl", icon: <RadarChartOutlined />, label: "Sources", path: "/crawl" },
    { key: "/profile", icon: <UserOutlined />, label: "Profile", path: "/profile" },
    { key: "/settings", icon: <SettingOutlined />, label: "Settings", path: "/settings" },
  ];

  const toolItems: ActionItem[] = [
    { key: "watchlist", icon: <StockOutlined />, label: "Watchlist", isAction: true },
    { key: "alerts", icon: <AlertOutlined />, label: "Alerts", isAction: true },
    { key: "news", icon: <ReadOutlined />, label: "News Feed", isAction: true },
    { key: "ai", icon: <RobotOutlined />, label: "AI Assistant", isAction: true },
  ];

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

        {/* Tools / Actions */}
        <div className="flex flex-col gap-2 w-full px-2 pt-2">
           {toolItems.map((item) => {
            const isActive = activeActionKey === item.key;
            return (
              <Tooltip key={item.key} title={item.label} placement="right">
                <button
                  onClick={() => setActiveActionKey(item.key === activeActionKey ? null : item.key)}
                  className={`
                    w-10 h-10 flex items-center justify-center rounded-xl transition-all duration-200
                    ${isActive 
                      ? "text-[var(--accent)] border border-[var(--accent)] shadow-[0_0_10px_rgba(255,183,0,0.3)] bg-[var(--accent)]/10" 
                      : "text-gray-500 hover:text-[var(--accent)]"
                    }
                  `}
                >
                  <span className="text-lg">{item.icon}</span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

