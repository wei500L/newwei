"use client";

import {
  GlobalOutlined,
  LogoutOutlined,
  PlusOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Dropdown, Skeleton } from "antd";
import type { MenuProps } from "antd";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { changeLanguage } from "@/lib/i18n-client";

import { AvatarFallback } from "./avatar-fallback";
import type { TopNavLayout } from "./top-nav-density";
import { useLogout } from "./use-logout";

const formatLabel = (value: string): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

interface TopNavUserMenuProps {
  layout: TopNavLayout;
}

/**
 * 顶部栏用户区：头像 + 用户菜单（资料 / 计划徽标 / 窄屏兜底入口 / 退出）。
 * minimal 密度下，抓取入口与语言切换收进本菜单（顶部栏去冗余，每个动作
 * 仍有唯一入口）；退出流程见 use-logout。
 */
export function TopNavUserMenu({ layout }: TopNavUserMenuProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { data: session, status } = useSession();
  const { loggingOut, handleLogout } = useLogout();

  const isLoadingSession = status === "loading";
  const user = session?.user;
  const permissions = session?.permissions ?? user?.permissions ?? [];
  const canStartCrawl = permissions.includes("crawl.write");

  const displayName = [user?.firstName, user?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const displayEmail = user?.email ?? "";
  const displayNameOrEmail =
    displayName || displayEmail || t("common.notAvailable");
  const avatarSrc = user?.image ?? user?.avatarUrl ?? undefined;
  const planTier = user?.planTier?.trim();
  const subscriptionStatus = user?.subscriptionStatus?.trim();
  const planLabel = planTier ? formatLabel(planTier) : "Free Plan";
  const statusLabel = subscriptionStatus ? formatLabel(subscriptionStatus) : null;
  const planBadgeLabel = statusLabel ? `${planLabel} · ${statusLabel}` : planLabel;

  const userMenuItems: MenuProps["items"] = useMemo(() => {
    const items: MenuProps["items"] = [
      {
        key: "profile-info",
        label: (
          <div className="flex flex-col">
            <span className="font-medium">{displayNameOrEmail}</span>
            <span className="text-xs text-slate-500">{planBadgeLabel}</span>
          </div>
        ),
        disabled: true,
        className: "cursor-default opacity-100 hover:bg-transparent",
      },
      { type: "divider" },
      {
        key: "profile",
        label: t("nav.profile"),
        icon: <UserOutlined />,
        onClick: () => router.push("/profile"),
      },
    ];

    if (canStartCrawl && layout.crawlButton === "menu") {
      items.push({
        key: "new-crawl",
        label: t("nav.newCrawl"),
        icon: <PlusOutlined />,
        onClick: () => router.push("/admin/ops/crawl-tasks?new=true"),
      });
    }

    if (layout.languageSwitcher === "menu") {
      items.push(
        {
          key: "lang-zh",
          label: t("language.chinese"),
          icon: <GlobalOutlined />,
          onClick: () => void changeLanguage("zh-CN"),
        },
        {
          key: "lang-en",
          label: t("language.english"),
          icon: <GlobalOutlined />,
          onClick: () => void changeLanguage("en-US"),
        },
      );
    }

    items.push({
      key: "logout",
      label: t("auth.logout"),
      icon: <LogoutOutlined />,
      onClick: () => handleLogout(false),
      disabled: loggingOut,
    });

    return items;
  }, [
    canStartCrawl,
    displayNameOrEmail,
    handleLogout,
    layout.crawlButton,
    layout.languageSwitcher,
    loggingOut,
    planBadgeLabel,
    router,
    t,
  ]);

  return (
    <div className="flex min-w-0 shrink-0 items-center">
      {isLoadingSession ? (
        <Skeleton.Avatar active size="default" />
      ) : (
        <Dropdown
          menu={{ items: userMenuItems }}
          placement="bottomRight"
          trigger={["click"]}
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
  );
}
