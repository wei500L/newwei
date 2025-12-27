"use client";

import {
  AlertOutlined,
  CalendarOutlined,
  CustomerServiceOutlined,
  FundOutlined,
  ReadOutlined,
  RobotOutlined,
  StockOutlined
} from "@ant-design/icons";
import { Tooltip } from "antd";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

interface ActionItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  path?: string;
}

export function ActionRail() {
  const router = useRouter();
  const pathname = usePathname();
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const items: ActionItem[] = [
    { key: "watchlist", icon: <StockOutlined />, label: "Watchlist" },
    { key: "alerts", icon: <AlertOutlined />, label: "Alerts" },
    { key: "news", icon: <ReadOutlined />, label: "News Feed" },
    { key: "calendar", icon: <CalendarOutlined />, label: "Economic Calendar" },
    { key: "ai", icon: <RobotOutlined />, label: "AI Assistant" },
    { key: "support", icon: <CustomerServiceOutlined />, label: "Support" },
  ];

  return (
    <aside className="w-14 flex-shrink-0 flex flex-col items-center py-4 bg-[#0f172a]/50 border-r border-white/10 backdrop-blur-md z-40 hidden md:flex">
      <div className="flex flex-col gap-6 w-full px-2">
        {items.map((item) => {
          const isActive = activeKey === item.key;
          return (
            <Tooltip key={item.key} title={item.label} placement="right">
              <button
                onClick={() => setActiveKey(item.key === activeKey ? null : item.key)}
                className={`
                  w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200
                  ${isActive 
                    ? "bg-blue-600 text-white shadow-lg shadow-blue-900/50" 
                    : "text-gray-400 hover:text-white hover:bg-white/10"
                  }
                `}
              >
                <span className="text-xl">{item.icon}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>
    </aside>
  );
}
