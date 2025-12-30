"use client";

import {
  LogoutOutlined,
  PlusOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, Skeleton } from "antd";
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
import { CommandBar } from "./command-bar";
import { SystemDefcon } from "./system-defcon";
import { TickerTape } from "./ticker-tape";

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
  const startNewCrawlLabel = "New Crawl";

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex flex-col">
      {/* Ticker Tape Layer */}
      <TickerTape />

      {/* Main Navbar Layer */}
      <header className="h-16 flex items-center justify-between px-6 border-b border-[var(--border)] shrink-0 glass relative">
        {/* Left: Logo */}
        <div className="flex items-center gap-8 min-w-[200px]">
          <span className="text-[var(--foreground)] font-semibold text-lg tracking-tight whitespace-nowrap font-serif flex items-center gap-2">
               <div className="w-2 h-2 bg-[var(--primary)] rounded-full" />
               {t("brand.full")}
          </span>
        </div>

        {/* Center: Command Bar (Replaces old nav links) */}
        <div className="flex-1 flex justify-center">
           <CommandBar />
        </div>

        {/* Right: Actions + User */}
        <div className="flex items-center gap-4 min-w-[200px] justify-end">
          <SystemDefcon />
          
          <div className="h-6 w-px bg-[var(--border)] mx-2" />
          
          {canStartCrawl && (
              <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  size="small"
                  onClick={() => router.push("/crawl?new=true")}
                  className="shadow-none"
              >
                  {startNewCrawlLabel}
              </Button>
          )}
          
          <div className="flex items-center gap-3">
              <NotificationCenter />
              <LanguageSwitcher />
              <OrganizationSwitcher />
          </div>

          <div className="h-6 w-px bg-[var(--border)] mx-2" />

          {isLoadingSession ? (
            <Skeleton.Avatar active size="default" />
          ) : (
              <Dropdown
                  menu={{
                  items: [
                      {
                          key: "profile-info",
                          label: (
                              <div className="flex flex-col">
                                  <span className="font-medium">{displayNameOrEmail}</span>
                                  <span className="text-xs text-slate-500">{planBadgeLabel}</span>
                              </div>
                          ),
                          disabled: true,
                          className: "cursor-default opacity-100 hover:bg-transparent"
                      },
                      { type: 'divider' },
                      {
                          key: "profile",
                          label: t("nav.profile", { defaultValue: "Profile" }),
                          icon: <UserOutlined />,
                          onClick: () => router.push("/profile")
                      },
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
                          className="bg-[var(--primary)] text-white border border-[var(--border)] font-bold"
                      />
                  </div>
              </Dropdown>
          )}
        </div>
      </header>
    </div>
  );
}
