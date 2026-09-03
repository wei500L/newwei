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
 * 品牌区可收缩（shrink + truncate）：窄屏空间不足时长品牌文案截断
 * 而不是把右侧操作区（搜索/通知/用户）挤出视口；短名在 <sm 视口兜底，
 * 菜单按钮永不被压缩。
 */
export function TopNavBrand({
  onOpenMenu,
  menuExpanded,
  showDesktopMenuButton,
}: TopNavBrandProps) {
  const { t } = useTranslation();

  return (
    <div className="flex min-w-0 items-center gap-2 sm:gap-3">
      <Button
        type="text"
        size="large"
        icon={<MenuOutlined className="text-lg" aria-hidden />}
        onClick={onOpenMenu}
        className={`shrink-0 ${showDesktopMenuButton ? "" : "md:hidden"}`}
        aria-label={t("nav.openMenu")}
        aria-expanded={menuExpanded}
        aria-controls="mobile-navigation-drawer"
      />
      <span
        className="flex min-w-0 shrink items-center gap-2 font-serif text-lg font-semibold tracking-tight text-[var(--foreground)]"
        title={t("brand.full")}
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--primary)]" />
        <span className="truncate sm:hidden">{t("brand.short")}</span>
        <span className="hidden truncate sm:inline">{t("brand.full")}</span>
      </span>
    </div>
  );
}
