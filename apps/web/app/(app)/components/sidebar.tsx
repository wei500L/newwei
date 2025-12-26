"use client";

import {
  ApartmentOutlined,
  BugOutlined,
  ControlOutlined,
  DashboardOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  RadarChartOutlined,
  SettingOutlined,
  TableOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Badge, Button, Dropdown, Skeleton, Tooltip, Typography } from "antd";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { AvatarFallback } from "./avatar-fallback";
import { captureClientError } from "@/lib/client-telemetry";
import { useSidebarStore } from "@/store/sidebar";
import { createTraceHeaders } from "@/lib/trace";

const formatLabel = (value: string): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

export function Sidebar() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
  const { collapsed, toggle } = useSidebarStore();
  const [loggingOut, setLoggingOut] = useState(false);
  const isLoadingSession = status === "loading";

  const handleLogout = useCallback(
    async (logoutAll: boolean) => {
      setLoggingOut(true);
      try {
        const response = await fetch("/api/logout", {
          method: "POST",
          headers: createTraceHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ logoutAll }),
        });

        if (!response.ok) {
          throw new Error("Logout failed");
        }

        await signOut({ callbackUrl: "/login" });
      } catch (error) {
        captureClientError("Logout error", error);
      } finally {
        setLoggingOut(false);
      }
    },
    []
  );

  const user = session?.user;
  const permissions = session?.permissions ?? user?.permissions ?? [];
  const canManageSettings = permissions.includes("settings.manage");
  const canManageOrganizations = permissions.includes("org.write");
  const canStartCrawl = permissions.includes("crawl.write");

  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  const displayEmail = user?.email ?? "";
  const displayNameOrEmail = displayName || displayEmail || t("common.notAvailable");
  const showEmail = Boolean(displayEmail && displayName);
  const avatarSrc = user?.image ?? user?.avatarUrl ?? undefined;
  const planTier = user?.planTier?.trim();
  const subscriptionStatus = user?.subscriptionStatus?.trim();
  const planLabel = planTier ? formatLabel(planTier) : "Free Plan";
  const statusLabel = subscriptionStatus ? formatLabel(subscriptionStatus) : null;
  const planBadgeLabel = statusLabel ? `${planLabel} · ${statusLabel}` : planLabel;
  const isFreePlan = !planTier;
  const badgeColor = isFreePlan
    ? "#d9d9d9"
    : subscriptionStatus?.toLowerCase() === "active"
      ? "#52c41a"
      : subscriptionStatus?.toLowerCase() === "past_due"
        ? "#faad14"
        : subscriptionStatus?.toLowerCase() === "canceled"
          ? "#f5222d"
          : "#1677ff";
  const startNewCrawlLabel = "Start New Crawl";
  const startNewCrawlBlockedLabel = "You do not have permission to start a new crawl";

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
      {
        key: "/profile",
        icon: <UserOutlined />,
        label: t("nav.profile"),
      },
    ];

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
        key: "/admin/storage",
        icon: <ControlOutlined />,
        label: t("nav.storage"),
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
  }, [canManageOrganizations, canManageSettings, t]);

  return (
    <aside
      className={`relative flex flex-col h-screen bg-white border-r border-gray-200 transition-all duration-300 ease-in-out ${
        collapsed ? "w-20" : "w-64"
      }`}
    >
      {/* Header / Logo */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-gray-100 shrink-0">
        {!collapsed && (
           <span className="text-gray-900 font-bold text-lg tracking-wide whitespace-nowrap overflow-hidden text-ellipsis">
             {t("brand.full")}
           </span>
        )}
        <button
          onClick={toggle}
          className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 transition-colors ml-auto"
        >
          {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </button>
      </div>

      {/* User Context */}
      <div className={`p-4 border-b border-gray-100 ${collapsed ? "flex justify-center" : ""}`}>
        {isLoadingSession ? (
          <div className={`flex items-center gap-3 ${collapsed ? "flex-col" : ""}`}>
            <Skeleton.Avatar active size={collapsed ? "large" : "default"} />
            {!collapsed ? (
              <div className="min-w-0 flex-1">
                <Skeleton.Input active size="small" style={{ width: "70%" }} />
                <div className="mt-2">
                  <Skeleton.Input active size="small" style={{ width: "90%" }} />
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className={`flex items-center gap-3 ${collapsed ? "flex-col" : ""}`}>
            <AvatarFallback
              size={collapsed ? "large" : "default"}
              src={avatarSrc}
              name={displayName}
              email={displayEmail}
              className="bg-blue-500 shrink-0"
            />
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm text-gray-900 truncate">
                  {displayNameOrEmail}
                </div>
                {showEmail ? (
                  <div className="text-xs text-gray-500 truncate mb-1">
                    {displayEmail}
                  </div>
                ) : null}
                <Badge
                  count={planBadgeLabel}
                  style={{
                    backgroundColor: badgeColor,
                    color: isFreePlan ? "#595959" : "#fff",
                    fontSize: "10px",
                    height: "16px",
                    lineHeight: "16px"
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="p-3">
        {collapsed ? (
             <Tooltip title={canStartCrawl ? startNewCrawlLabel : startNewCrawlBlockedLabel} placement="right">
                <Button 
                   type="primary" 
                   shape="circle" 
                   icon={<PlusOutlined />} 
                   className="w-full flex justify-center"
                   disabled={!canStartCrawl || isLoadingSession}
                   onClick={() => router.push("/crawl?new=true")}
                />
             </Tooltip>
        ) : (
          <div className="flex flex-col gap-2">
            <Typography.Text type="secondary" className="text-xs font-semibold uppercase px-2">
              Quick Actions
            </Typography.Text>
             <Tooltip title={!canStartCrawl ? startNewCrawlBlockedLabel : null}>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  block
                  disabled={!canStartCrawl || isLoadingSession}
                  onClick={() => router.push("/crawl?new=true")}
                  className="text-left flex items-center justify-center"
                >
                  {startNewCrawlLabel}
                </Button>
             </Tooltip>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
        {navigationItems.map((item) => {
          const isActive = pathname.startsWith(item.key);
          return (
            <Link
              key={item.key}
              href={item.key}
              className={`group flex items-center px-3 py-2.5 text-sm font-medium rounded-md transition-colors ${
                isActive
                  ? "bg-blue-50 text-blue-600"
                  : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
              } ${collapsed ? "justify-center" : ""}`}
              title={collapsed ? item.label : undefined}
            >
              <span className={`text-lg shrink-0 ${isActive ? "text-blue-600" : "text-gray-400 group-hover:text-gray-500"}`}>
                {item.icon}
              </span>
              {!collapsed && (
                <span className="ml-3 truncate">{item.label}</span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Footer / Logout */}
      <div className="p-3 border-t border-gray-200 shrink-0">
          <Dropdown
            menu={{
              items: [
                {
                  key: "logout",
                  label: t("auth.logoutThisDevice"),
                  onClick: () => handleLogout(false),
                  disabled: loggingOut
                },
                {
                  key: "logoutAll",
                  label: t("auth.logoutAllDevices"),
                  onClick: () => handleLogout(true),
                  disabled: loggingOut
                }
              ]
            }}
            placement="topRight"
          >
            <Button
              type="text"
              block
              className={`flex items-center ${collapsed ? "justify-center" : "justify-start"} text-gray-600 hover:text-red-600 hover:bg-red-50`}
            >
              <LogoutOutlined />
              {!collapsed && <span className="ml-2">{t("auth.logout")}</span>}
            </Button>
          </Dropdown>
      </div>
    </aside>
  );
}
