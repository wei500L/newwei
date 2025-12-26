"use client";

import { Breadcrumb, Layout, Space, message, theme } from "antd";
import { usePathname } from "next/navigation";
import type { PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";

import { LanguageSwitcher } from "./language-switcher";
import { NotificationCenter } from "./notification-center";
import { OrganizationSwitcher } from "./organization-switcher";
import { Sidebar } from "./sidebar";

const { Content } = Layout;

export function ShellLayout({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const [messageApi, contextHolder] = message.useMessage();
  const pathname = usePathname();
  const { token } = theme.useToken();

  const breadcrumbLabels: Record<string, string> = {
    dashboard: t("nav.dashboard"),
    "key-monitor": t("dashboard.tabs.keyMonitor"),
    "military-alert": t("dashboard.tabs.militaryAlert"),
    "economic-alert": t("dashboard.tabs.economicAlert"),
    "economic-short": t("dashboard.tabs.economicShort"),
    "economic-medium": t("dashboard.tabs.economicMedium"),
    "economic-long": t("dashboard.tabs.economicLong"),
    "livelihood-prices": t("dashboard.tabs.livelihoodPrices"),
    items: t("nav.items"),
    crawl: t("nav.crawlTasks"),
    profile: t("nav.profile"),
    admin: t("nav.admin"),
    orgs: t("nav.organizations"),
    errors: t("nav.errors"),
    storage: t("nav.storage"),
    settings: t("nav.settings"),
    system: t("nav.systemSettings")
  };

  const breadcrumbs = pathname
    .split("/")
    .filter(Boolean)
    .map((segment, index) => ({
      title: breadcrumbLabels[segment] ?? segment,
      key: `${segment}-${index}`,
    }));

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50/50">
      {contextHolder}
      
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Bar */}
        <header className="flex items-center justify-between px-6 py-4 bg-white/50 backdrop-blur-sm border-b border-gray-200 sticky top-0 z-10">
           <div className="flex-1 min-w-0">
             {pathname !== "/dashboard" && (
                <Breadcrumb items={breadcrumbs} className="font-medium" />
             )}
           </div>

           <Space align="center" size="middle" className="shrink-0 ml-4">
              <NotificationCenter />
              <LanguageSwitcher />
              <OrganizationSwitcher />
           </Space>
        </header>

        {/* Scrollable Content */}
        <main className="flex-1 overflow-auto">
           <div className="w-full max-w-[1600px] mx-auto p-6">
              {children}
           </div>
        </main>
      </div>
    </div>
  );
}
