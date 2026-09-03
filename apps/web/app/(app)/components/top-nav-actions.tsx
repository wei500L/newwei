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
  canStartCrawl: boolean;
}

/**
 * 顶部栏右区：系统状态 / 抓取操作 / 通知 / 语言 / 组织 / 同步 / 主题。
 * 各入口的形态（显隐、图标化、收进菜单）由 resolveTopNavLayout 的
 * 密度档位统一推导——本组件只负责呈现，不再自持优先级判断。
 */
export function TopNavActions({ layout, canStartCrawl }: TopNavActionsProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { isDark, toggleTheme } = useTheme();

  const startNewCrawlLabel = t("nav.newCrawl");
  const newCrawlHref = "/admin/ops/crawl-tasks?new=true";

  const renderOrganizationSwitcher = () => {
    if (layout.organizationSwitcher === "inline") {
      return (
        <div className="hidden min-w-0 xl:block">
          <OrganizationSwitcher mode="full" showErrorText={false} />
        </div>
      );
    }
    // compact：xl 起显示；minimal：常显（窄屏也保留组织切换入口）
    const visibilityClass =
      layout.densityMode === "minimal" ? "inline-flex" : "hidden xl:inline-flex";
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
          className={`${visibilityClass} h-8 w-8 items-center justify-center p-0`}
        />
      </Popover>
    );
  };

  return (
    <div className="ml-auto flex min-w-0 max-w-full items-center gap-1 sm:gap-2 md:gap-3">
      {/* 系统状态：full 档 + 2xl 起显示（详细状态文字属最低优先级） */}
      {layout.showSystemStatus ? (
        <div className="hidden 2xl:block">
          <SystemDefcon />
        </div>
      ) : null}
      {layout.showSystemStatus ? (
        <div className="mx-1 hidden h-6 w-px bg-[var(--border)] 2xl:block" />
      ) : null}

      {/* 抓取操作：full 主按钮 / compact 图标 / minimal 收进用户菜单 */}
      {canStartCrawl && layout.crawlButton === "primary" ? (
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
      {canStartCrawl && layout.crawlButton === "compact" ? (
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

        {/* 同步指示：minimal 档 lg 起、其余档 xl 起（与迁移前一致） */}
        {layout.showSyncIndicator ? (
          <div className="hidden xl:block">
            <UserUiSettingsSyncIndicator />
          </div>
        ) : (
          <div className="hidden lg:block">
            <UserUiSettingsSyncIndicator />
          </div>
        )}
      </div>

      <div className="mx-1 hidden h-6 w-px bg-[var(--border)] lg:block" />

      <Button
        type="text"
        icon={isDark ? <SunOutlined /> : <MoonOutlined />}
        onClick={toggleTheme}
        aria-pressed={isDark}
        aria-label={isDark ? "切换到浅色主题" : "切换到深色主题"}
        title={isDark ? "切换到浅色主题" : "切换到深色主题"}
        className="flex items-center rounded-md !text-[var(--foreground)] opacity-70 transition-opacity hover:opacity-100"
      />
    </div>
  );
}
