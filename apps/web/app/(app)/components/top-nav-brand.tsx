"use client";

import { MenuOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

interface TopNavBrandProps {
  onOpenMenu: () => void;
  menuExpanded: boolean;
  /** 桌面矮视口 drawer 模式下菜单按钮在桌面也显示 */
  showDesktopMenuButton: boolean;
}

/**
 * 顶部栏左区：菜单入口 + 品牌（窄屏短名 / sm 起全名）。
 * 容器 min-w-0 + whitespace-nowrap 保证品牌永不挤压右侧操作区。
 */
export function TopNavBrand({
  onOpenMenu,
  menuExpanded,
  showDesktopMenuButton,
}: TopNavBrandProps) {
  const { t } = useTranslation();

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-3">
      <Button
        type="text"
        size="large"
        icon={<MenuOutlined className="text-lg" aria-hidden />}
        onClick={onOpenMenu}
        className={showDesktopMenuButton ? "" : "md:hidden"}
        aria-label={t("nav.openMenu")}
        aria-expanded={menuExpanded}
        aria-controls="mobile-navigation-drawer"
      />
      <span className="flex min-w-0 items-center gap-2 whitespace-nowrap font-serif text-lg font-semibold tracking-tight text-[var(--foreground)]">
        <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--primary)]" />
        <span className="sm:hidden">{t("brand.short")}</span>
        <span className="hidden sm:inline">{t("brand.full")}</span>
      </span>
    </div>
  );
}
