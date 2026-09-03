"use client";

import {
  BgColorsOutlined,
  GlobalOutlined,
  LogoutOutlined,
  PlusOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, Skeleton } from "antd";
import type { MenuProps } from "antd";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useTheme } from "@/hooks/use-theme";
import { changeLanguage } from "@/lib/i18n-client";

import { AvatarFallback } from "./avatar-fallback";
import { OrganizationSwitcher } from "./organization-switcher";
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
 * minimal 密度下，抓取入口、语言切换、组织切换与主题切换收进本菜单
 * （顶部栏只保留菜单/品牌/搜索/通知/用户五个核心入口，每个动作仍有
 * 唯一入口）；退出流程见 use-logout。
 *
 * 头像触发器使用原生 button（Tab 可聚焦、Enter/Space 可打开），可访问
 * 名称本地化（nav.userMenu.label）；菜单内的组织切换复用既有
 * OrganizationSwitcher，会话语义与顶部栏一致。
 */
export function TopNavUserMenu({ layout }: TopNavUserMenuProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { data: session, status } = useSession();
  const { loggingOut, handleLogout } = useLogout();
  const { isDark, toggleTheme } = useTheme();

  const isLoadingSession = status === "loading";
  const user = session?.user;

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
  const planLabel = planTier ? formatLabel(planTier) : t("nav.userMenu.freePlan");
  const statusLabel = subscriptionStatus ? formatLabel(subscriptionStatus) : null;
  const planBadgeLabel = statusLabel ? `${planLabel} · ${statusLabel}` : planLabel;

  const themeToggleLabel = isDark
    ? t("nav.theme.toLight")
    : t("nav.theme.toDark");

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

    // 抓取入口的权限过滤单一事实源是 resolveTopNavLayout：无权限时
    // crawlButton 为 "none"，不会进入本菜单。
    if (layout.crawlButton === "menu") {
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

    if (layout.themeToggle === "menu") {
      items.push({
        key: "theme-toggle",
        label: themeToggleLabel,
        icon: <BgColorsOutlined />,
        onClick: toggleTheme,
      });
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
    displayNameOrEmail,
    handleLogout,
    layout.crawlButton,
    layout.languageSwitcher,
    layout.themeToggle,
    loggingOut,
    planBadgeLabel,
    router,
    t,
    themeToggleLabel,
    toggleTheme,
  ]);

  /**
   * minimal 档的组织切换面板：放在菜单下方的独立分区（popupRender），
   * 不进 menu role——避免在菜单项内嵌套 AutoComplete/Button 等交互元素。
   * 复用既有 OrganizationSwitcher，会话语义与顶部栏 Popover 形态一致。
   */
  const renderDropdown = (menu: ReactNode) => {
    if (layout.organizationSwitcher !== "menu") {
      return menu;
    }
    return (
      <div className="flex flex-col">
        {menu}
        <div className="flex min-w-0 flex-col gap-2 border-t border-[var(--border)] px-3 py-2.5">
          <span className="text-xs font-medium text-slate-500">
            {t("nav.userMenu.organizationSection")}
          </span>
          <OrganizationSwitcher mode="compact" showErrorText={false} />
        </div>
      </div>
    );
  };

  return (
    <div className="flex min-w-0 shrink-0 items-center">
      {isLoadingSession ? (
        <Skeleton.Avatar active size="default" />
      ) : (
        <Dropdown
          menu={{ items: userMenuItems }}
          popupRender={renderDropdown}
          placement="bottomRight"
          trigger={["click"]}
        >
          <Button
            type="text"
            aria-label={t("nav.userMenu.label")}
            aria-haspopup="menu"
            className="flex h-auto items-center justify-center rounded-full !p-0.5"
          >
            <AvatarFallback
              size="default"
              src={avatarSrc}
              name={displayName}
              email={displayEmail}
              className="bg-[var(--primary)] text-white border border-[var(--border)] font-bold"
            />
          </Button>
        </Dropdown>
      )}
    </div>
  );
}
