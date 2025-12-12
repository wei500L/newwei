"use client";

import {
  DashboardOutlined,
  LogoutOutlined,
  RadarChartOutlined,
  SettingOutlined,
  TableOutlined,
  ApartmentOutlined,
} from "@ant-design/icons";
import { Breadcrumb, Dropdown, Layout, Menu, Space, Typography, message } from "antd";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import type { PropsWithChildren } from "react";
import { useMemo, useState, useCallback } from "react";

import { useSidebarStore } from "@/store/sidebar";
import { OrganizationSwitcher } from "./organization-switcher";
import { captureClientError } from "@/lib/client-telemetry";
import { createTraceHeaders } from "@/lib/trace";
import { NotificationCenter } from "./notification-center";

const { Header, Sider, Content } = Layout;

export function ShellLayout({ children }: PropsWithChildren) {
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
        messageApi.error("Failed to logout. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [messageApi]
  );

  const navigationItems = useMemo(() => {
    const base = [
      {
        key: "/dashboard",
        icon: <DashboardOutlined />,
        label: "Dashboard",
      },
      {
        key: "/items",
        icon: <TableOutlined />,
        label: "Items",
      },
      {
        key: "/crawl",
        icon: <RadarChartOutlined />,
        label: "Crawl Tasks",
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
        label: "Organizations",
      });
    }
    if (canManageSettings) {
      base.push({
        key: "/settings",
        icon: <SettingOutlined />,
        label: "Admin Settings",
      });
    }
    return base;
  }, [session.data?.permissions, session.data?.user?.permissions]);

  const selectedKeys = useMemo(() => {
    const match = navigationItems.find((item) => pathname.startsWith(item.key));
    return match ? [match.key] : [];
  }, [pathname, navigationItems]);

  const isLoggingOut = loggingOut || loggingOutAll;

  const breadcrumbs = pathname
    .split("/")
    .filter(Boolean)
    .map((segment, index) => ({
      title: segment.charAt(0).toUpperCase() + segment.slice(1),
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
          {collapsed ? "MM" : "Modular Monolith"}
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
                    label: "Logout (this device)",
                    onClick: () => handleLogout(false),
                    disabled: isLoggingOut
                  },
                  {
                    key: "logoutAll",
                    label: "Logout all devices",
                    onClick: () => handleLogout(true),
                    disabled: isLoggingOut
                  }
                ]
              }}
            >
              Logout
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
