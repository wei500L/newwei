"use client";

import {
  DashboardOutlined,
  LogoutOutlined,
  RadarChartOutlined,
  SettingOutlined,
  TableOutlined,
  ApartmentOutlined,
  BugOutlined,
  ControlOutlined,
} from "@ant-design/icons";
import { Breadcrumb, Dropdown, Layout, Menu, Space, Typography, message } from "antd";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import type { PropsWithChildren } from "react";
import { useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { captureClientError } from "@/lib/client-telemetry";
import { createTraceHeaders } from "@/lib/trace";
import { useSidebarStore } from "@/store/sidebar";

import { LanguageSwitcher } from "./language-switcher";
import { NotificationCenter } from "./notification-center";
import { OrganizationSwitcher } from "./organization-switcher";

const { Header, Sider, Content } = Layout;

export function ShellLayout({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const [messageApi, contextHolder] = message.useMessage();
  const [loggingOut, setLoggingOut] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const collapsed = useSidebarStore((state) => state.collapsed);
  const toggle = useSidebarStore((state) => state.toggle);
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
    <Layout className="main-layout">
      {contextHolder}
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={toggle}
        width={220}
        breakpoint="lg"
      >
        <div
          style={{
            height: 64,
            display: "flex",
            alignItems: "center",
            justifyContent: collapsed ? "center" : "flex-start",
            padding: collapsed ? 0 : "0 16px",
            color: "#fff",
            fontWeight: 600,
            fontSize: collapsed ? 18 : 20,
          }}
        >
          {collapsed ? t("brand.short") : t("brand.full")}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selectedKeys}
          items={navigationItems}
          onClick={(info) => router.push(info.key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: "#fff",
            padding: "0 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
          }}
        >
          <Breadcrumb items={breadcrumbs} />
          <Space align="center" size="large">
            <NotificationCenter />
            <LanguageSwitcher />
            <OrganizationSwitcher />
            <Typography.Text>
              {session.data?.user?.firstName} {session.data?.user?.lastName}
            </Typography.Text>
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
        <Content style={{ margin: "24px", display: "flex" }}>
          <div style={{ width: "100%" }}>{children}</div>
        </Content>
      </Layout>
    </Layout>
  );
}
