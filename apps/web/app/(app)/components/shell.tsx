"use client";

import {
  DashboardOutlined,
  LogoutOutlined,
  RadarChartOutlined,
  SettingOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { Breadcrumb, Button, Layout, Menu, Space, Typography } from "antd";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import type { PropsWithChildren } from "react";
import { useMemo } from "react";

import { useSidebarStore } from "@/store/sidebar";

const { Header, Sider, Content } = Layout;

export function ShellLayout({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const router = useRouter();
  const collapsed = useSidebarStore((state) => state.collapsed);
  const toggle = useSidebarStore((state) => state.toggle);
  const session = useSession();

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
  }, [pathname]);

  const breadcrumbs = pathname
    .split("/")
    .filter(Boolean)
    .map((segment, index) => ({
      title: segment.charAt(0).toUpperCase() + segment.slice(1),
      key: `${segment}-${index}`,
    }));

  return (
    <Layout className="main-layout">
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
            <Typography.Text>
              {session.data?.user?.firstName} {session.data?.user?.lastName}
            </Typography.Text>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              Logout
            </Button>
          </Space>
        </Header>
        <Content style={{ margin: "24px", display: "flex" }}>
          <div style={{ width: "100%" }}>{children}</div>
        </Content>
      </Layout>
    </Layout>
  );
}
