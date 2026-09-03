"use client";

import {
  MoonOutlined,
  PlusOutlined,
  SearchOutlined,
  SunOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { Button, Popover, Tooltip } from "antd";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { useTheme } from "@/hooks/use-theme";

import { LanguageSwitcher } from "./language-switcher";
import { NotificationCenter } from "./notification-center";
import { OrganizationSwitcher } from "./organization-switcher";
import { SystemDefcon } from "./system-defcon";
import type { TopNavLayout } from "./top-nav-density";
import { UserUiSettingsSyncIndicator } from "./user-ui-settings-sync-indicator";

interface TopNavActionsProps {
  layout: TopNavLayout;
}

/**
 * 顶部栏右区：系统状态 / 抓取操作 / 通知 / 语言 / 组织 / 同步 / 主题。
 * 各入口的形态（显隐、图标化、收进菜单）由 resolveTopNavLayout 的
 * 密度档位统一推导——本组件只负责呈现，不再自持优先级或权限判断。
 * minimal 档组织切换与主题切换收进用户菜单，本区不再渲染对应入口。
 */
export function TopNavActions({ layout }: TopNavActionsProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { isDark, toggleTheme } = useTheme();

  const startNewCrawlLabel = t("nav.newCrawl");
  const newCrawlHref = "/admin/ops/crawl-tasks?new=true";
  // 主题切换文案单一真源：aria-label 与 title 同值（i18n）。
  const themeToggleLabel = isDark
    ? t("nav.theme.toLight")
    : t("nav.theme.toDark");

  const renderOrganizationSwitcher = () => {
    if (layout.organizationSwitcher === "inline") {
      return (
        <div className="hidden min-w-0 xl:block">
          <OrganizationSwitcher mode="full" showErrorText={false} />
        </div>
      );
    }
    if (layout.organizationSwitcher === "menu") {
      // minimal：由用户菜单提供组织切换（TopNavUserMenu 的 dropdown 面板）
      return null;
    }
    // compact：xl 起显示 Popover 图标
    return (
      <Popover
        trigger="click"
        placement="bottomRight"
        content={
          <div className="w-[220px]">
            <OrganizationSwitcher mode="compact" showErrorText={false} />
          </div>
        }
      >
        <Button
          type="text"
          icon={<SwapOutlined />}
          aria-label={t("orgSwitcher.switch")}
          className="hidden xl:inline-flex h-8 w-8 items-center justify-center p-0"
        />
      </Popover>
    );
  };

  return (
    <div className="ml-auto flex max-w-full shrink-0 items-center gap-1 sm:gap-2 md:gap-3">
      {/* 系统状态：full 档 + 2xl 起显示（详细状态文字属最低优先级） */}
      {layout.showSystemStatus ? (
        <div className="hidden 2xl:block">
          <SystemDefcon />
        </div>
      ) : null}
      {layout.showSystemStatus ? (
        <div className="mx-1 hidden h-6 w-px bg-[var(--border)] 2xl:block" />
      ) : null}

      {/* 抓取操作：full 主按钮 / compact 图标 / minimal 收进用户菜单 /
          无权限时 crawlButton 为 "none"，本区不渲染（权限过滤单一真源） */}
      {layout.crawlButton === "primary" ? (
        <Button
          type="primary"
          icon={<PlusOutlined />}
          size="small"
          onClick={() => router.push(newCrawlHref)}
          className="hidden shadow-none xl:inline-flex"
        >
          {startNewCrawlLabel}
        </Button>
      ) : null}
      {layout.crawlButton === "compact" ? (
        <Button
          type="primary"
          icon={<PlusOutlined />}
          size="small"
          onClick={() => router.push(newCrawlHref)}
          aria-label={startNewCrawlLabel}
          className="hidden shadow-none xl:inline-flex !px-2"
        />
      ) : null}

      <div className="flex min-w-0 items-center gap-1 sm:gap-2">
        {/* 窄屏全局搜索兜底入口（minimal 档命令面板让位） */}
        {layout.showSearchEntry ? (
          <Tooltip title={t("nav.main.search")}>
            <Button
              type="text"
              icon={<SearchOutlined />}
              onClick={() => router.push("/search")}
              aria-label={t("nav.main.search")}
              className="inline-flex h-8 w-8 items-center justify-center p-0"
            />
          </Tooltip>
        ) : null}

        <NotificationCenter />

        {layout.languageSwitcher === "inline" ? (
          <div className="hidden lg:block">
            <LanguageSwitcher compact={layout.densityMode === "compact"} />
          </div>
        ) : null}

        {renderOrganizationSwitcher()}

        {/* 同步状态（纯指示）：minimal 档整体退场，full/compact 维持 xl 起 */}
        {layout.showSyncIndicator ? (
          <div className="hidden xl:block">
            <UserUiSettingsSyncIndicator />
          </div>
        ) : null}
      </div>

      <div className="mx-1 hidden h-6 w-px bg-[var(--border)] lg:block" />

      {/* 主题切换：minimal 档收进用户菜单（本区不渲染） */}
      {layout.themeToggle === "inline" ? (
        <Button
          type="text"
          icon={isDark ? <SunOutlined /> : <MoonOutlined />}
          onClick={toggleTheme}
          aria-pressed={isDark}
          aria-label={themeToggleLabel}
          title={themeToggleLabel}
          className="flex items-center rounded-md !text-[var(--foreground)] opacity-70 transition-opacity hover:opacity-100"
        />
      ) : null}
    </div>
  );
}
