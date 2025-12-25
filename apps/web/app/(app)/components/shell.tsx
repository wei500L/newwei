"use client";

import {
  ApartmentOutlined,
  BugOutlined,
  ControlOutlined,
  DashboardOutlined,
  LogoutOutlined,
  RadarChartOutlined,
  SettingOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { Breadcrumb, Dropdown, Layout, Menu, Space, Typography, message } from "antd";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import type { PropsWithChildren } from "react";
import { useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { captureClientError } from "@/lib/client-telemetry";
import { createTraceHeaders } from "@/lib/trace";

import { LanguageSwitcher } from "./language-switcher";
import { NotificationCenter } from "./notification-center";
import { OrganizationSwitcher } from "./organization-switcher";

const { Header, Content } = Layout;

export function ShellLayout({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const [messageApi, contextHolder] = message.useMessage();
  const [loggingOut, setLoggingOut] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession();

  const handleLogout = useCallback(
    async (logoutAll: boolean) => {
      const setLoading = logoutAll ? setLoggingOutAll : setLoggingOut;
      setLoading(true);
      try {
        const response = await fetch("/api/logout", {
          method: "POST",
          headers: createTraceHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ logoutAll })
        });

        if (!response.ok) {
          throw new Error("Logout failed");
        }

        await signOut({ callbackUrl: "/login" });
      } catch (error) {
        captureClientError("Logout error", error);
        messageApi.error(t("auth.logoutFailed"));
      } finally {
        setLoading(false);
      }
    },
    [messageApi, t]
  );

  const navigationItems = useMemo(() => {
    const base = [
      {
        key: "/dashboard",
        icon: <DashboardOutlined />,
        label: t("nav.dashboard"),
      },
      {
        key: "/items",
        icon: <TableOutlined />,
        label: t("nav.items"),
      },
      {
        key: "/crawl",
        icon: <RadarChartOutlined />,
        label: t("nav.crawlTasks"),
      },
    ];
    const canManageSettings =
      session.data?.permissions?.includes("settings.manage") ??
      session.data?.user?.permissions?.includes("settings.manage");
    const canManageOrganizations =
      session.data?.permissions?.includes("org.write") ??
      session.data?.user?.permissions?.includes("org.write");
    if (canManageOrganizations) {
      base.push({
        key: "/admin/orgs",
        icon: <ApartmentOutlined />,
        label: t("nav.organizations"),
      });
    }
    if (canManageSettings) {
      base.push({
        key: "/admin/errors",
        icon: <BugOutlined />,
        label: t("nav.errors"),
      });
      base.push({
        key: "/settings/system",
        icon: <ControlOutlined />,
        label: t("nav.systemSettings"),
      });
      base.push({
        key: "/settings",
        icon: <SettingOutlined />,
        label: t("nav.adminSettings"),
      });
    }
    return base;
  }, [session.data?.permissions, session.data?.user?.permissions, t]);

  const selectedKeys = useMemo(() => {
    const match = navigationItems.find((item) => pathname.startsWith(item.key));
    return match ? [match.key] : [];
  }, [pathname, navigationItems]);

  const isLoggingOut = loggingOut || loggingOutAll;

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
    admin: t("nav.admin"),
    orgs: t("nav.organizations"),
    errors: t("nav.errors"),
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
    <Layout className="main-layout min-h-screen">
      {contextHolder}
      <Header className="sticky top-0 z-10 w-full !bg-white/90 !backdrop-blur-md border-b border-gray-100 !px-6 flex items-center justify-between shadow-sm transition-all duration-200 h-16">
        <div className="flex items-center gap-8 flex-1">
           <div className="flex items-center shrink-0">
             <span className="text-gray-900 font-bold text-lg tracking-wide whitespace-nowrap">
               {t("brand.full")}
             </span>
           </div>
           <Menu
             mode="horizontal"
             selectedKeys={selectedKeys}
             items={navigationItems}
             onClick={(info) => router.push(info.key)}
             className="!bg-transparent border-none flex-1 min-w-0 [&_.ant-menu-item]:!px-4"
           />
        </div>

        <Space align="center" size="large" className="shrink-0 ml-4">
          <NotificationCenter />
          <LanguageSwitcher />
          <OrganizationSwitcher />
          <div className="hidden md:flex flex-col items-end leading-tight">
            <Typography.Text strong className="text-sm">
              {session.data?.user?.firstName} {session.data?.user?.lastName}
            </Typography.Text>
            <Typography.Text type="secondary" className="text-xs">
              {session.data?.user?.email}
            </Typography.Text>
          </div>
          <Dropdown.Button
            type="text"
            icon={<LogoutOutlined />}
            loading={isLoggingOut}
            onClick={() => handleLogout(false)}
            menu={{
              items: [
                {
                  key: "logout",
                  label: t("auth.logoutThisDevice"),
                  onClick: () => handleLogout(false),
                  disabled: isLoggingOut
                },
                {
                  key: "logoutAll",
                  label: t("auth.logoutAllDevices"),
                  onClick: () => handleLogout(true),
                  disabled: isLoggingOut
                }
              ]
            }}
          >
            {t("auth.logout")}
          </Dropdown.Button>
        </Space>
      </Header>
      <Content className="flex flex-col flex-1 min-w-0 bg-gray-50/50">
        <div className="w-full max-w-[1600px] mx-auto p-6">
          <div className="mb-6">
            <Breadcrumb items={breadcrumbs} className="font-medium" />
          </div>
          {children}
        </div>
      </Content>
    </Layout>
  );
}