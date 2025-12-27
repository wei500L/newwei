"use client";

import {
  DashboardOutlined,
  LogoutOutlined,
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
import { NotificationCenter } from "./notification-center";
import { OrganizationSwitcher } from "./organization-switcher";
import { LanguageSwitcher } from "./language-switcher";
import { captureClientError } from "@/lib/client-telemetry";
import { createTraceHeaders } from "@/lib/trace";

const formatLabel = (value: string): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

export function TopNav() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, status } = useSession();
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
  const startNewCrawlLabel = "New Crawl";

  const navigationItems = useMemo(() => {
    const base = [
      {
        key: "/dashboard",
        icon: <DashboardOutlined />,
        label: "Overview",
      },
      {
        key: "/items",
        icon: <TableOutlined />,
        label: "Market Intel",
      },
      {
        key: "/crawl",
        icon: <RadarChartOutlined />,
        label: "Sources",
      },
      {
        key: "/profile",
        icon: <UserOutlined />,
        label: t("nav.profile"),
      },
    ];

    if (canManageSettings || canManageOrganizations) {
        base.push({
            key: "/settings",
            icon: <SettingOutlined />,
            label: "Settings",
        });
    }

    return base;
  }, [canManageOrganizations, canManageSettings, t]);

  return (
    <header className="h-16 flex items-center justify-between px-6 border-b border-white/10 shrink-0 backdrop-blur-md bg-[#0f172a]/90 fixed top-0 left-0 right-0 z-50">
      {/* Left: Logo + Nav */}
      <div className="flex items-center gap-8">
        <span className="text-white font-bold text-lg tracking-wide whitespace-nowrap font-mono">
             {t("brand.full")}
        </span>

        <nav className="flex items-center gap-1">
            {navigationItems.map((item) => {
            const isActive = pathname.startsWith(item.key);
            return (
                <Link
                key={item.key}
                href={item.key}
                className={`group flex items-center px-3 py-1.5 text-sm font-medium rounded-full transition-all duration-200 ${
                    isActive
                    ? "bg-blue-600/10 text-blue-400 border border-blue-600/20 shadow-[0_0_10px_rgba(37,99,235,0.1)]"
                    : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
                }`}
                >
                <span className={`text-lg shrink-0 mr-2 transition-colors ${isActive ? "text-blue-400" : "text-gray-500 group-hover:text-gray-300"}`}>
                    {item.icon}
                </span>
                <span>{item.label}</span>
                </Link>
            );
            })}
        </nav>
      </div>

      {/* Right: Actions + User */}
      <div className="flex items-center gap-4">
        {canStartCrawl && (
            <Button
                type="primary"
                icon={<PlusOutlined />}
                size="small"
                onClick={() => router.push("/crawl?new=true")}
                className="shadow-lg shadow-blue-900/20 border-0 flex items-center"
            >
                {startNewCrawlLabel}
            </Button>
        )}

        <div className="h-6 w-px bg-white/10 mx-2" />
        
        <div className="flex items-center gap-3">
            <NotificationCenter />
            <LanguageSwitcher />
            <OrganizationSwitcher />
        </div>

        <div className="h-6 w-px bg-white/10 mx-2" />

        {isLoadingSession ? (
          <Skeleton.Avatar active size="default" />
        ) : (
            <Dropdown
                menu={{
                items: [
                    {
                        key: "profile",
                        label: (
                            <div className="flex flex-col">
                                <span className="font-medium text-white">{displayNameOrEmail}</span>
                                <span className="text-xs text-gray-500">{planBadgeLabel}</span>
                            </div>
                        ),
                        disabled: true,
                        className: "cursor-default opacity-100 hover:bg-transparent"
                    },
                    { type: 'divider' },
                    {
                        key: "logout",
                        label: t("auth.logout"),
                        icon: <LogoutOutlined />,
                        onClick: () => handleLogout(false),
                        disabled: loggingOut
                    }
                ]
                }}
                placement="bottomRight"
                trigger={['click']}
            >
                <div className="cursor-pointer hover:opacity-80 transition-opacity">
                    <AvatarFallback
                        size="default"
                        src={avatarSrc}
                        name={displayName}
                        email={displayEmail}
                        className="bg-blue-600 border border-white/10"
                    />
                </div>
            </Dropdown>
        )}
      </div>
    </header>
  );
}