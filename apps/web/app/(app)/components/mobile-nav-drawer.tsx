"use client";

import { Drawer } from "antd";
import Link from "next/link";
import { useTranslation } from "react-i18next";

import { navItemStateClass } from "./nav-item-state";
import { useNavigation } from "./use-navigation";

interface MobileNavDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 桌面矮视口 drawer 模式下为 ""，否则仅移动端可见（md:hidden） */
  className?: string;
}

/**
 * 移动/矮视口导航 Drawer。与桌面 ActionRail 消费同一份五组导航模型
 * （useNavigation），组标题完整展示。
 *
 * 路由入口使用 Next.js Link（链接语义：中键/⌘点击新标签页、复制链接
 * 等浏览器原生能力可用）；点击导航后关闭 Drawer。
 */
export function MobileNavDrawer({ open, onClose, className }: MobileNavDrawerProps) {
  const { t } = useTranslation();
  const { groups, activeKey } = useNavigation();

  return (
    <Drawer
      id="mobile-navigation-drawer"
      title={t("nav.menu")}
      placement="left"
      width="var(--nav-drawer-width)"
      open={open}
      onClose={onClose}
      destroyOnHidden
      className={className}
    >
      <nav className="flex flex-col gap-6" aria-label={t("nav.menu")}>
        {groups.map((group) => (
          <section
            key={group.id}
            aria-label={t(group.labelKey)}
            className="flex flex-col gap-1"
          >
            <span className="nav-group-label px-1">{t(group.labelKey)}</span>
            {group.items.map((item) => {
              const isActive = item.key === activeKey;
              const label = t(item.labelKey);
              return (
                <Link
                  key={item.key}
                  href={item.path}
                  onClick={onClose}
                  aria-label={label}
                  aria-current={isActive ? "page" : undefined}
                  className={`
                    nav-item ${navItemStateClass(isActive, "strong")}
                    flex min-h-[var(--rail-item-size)] w-full items-center gap-3
                    rounded-xl px-3 py-2 text-left
                  `}
                >
                  <span className="text-lg shrink-0" aria-hidden>
                    <item.icon />
                  </span>
                  <span className="font-medium truncate">{label}</span>
                </Link>
              );
            })}
          </section>
        ))}
      </nav>
    </Drawer>
  );
}
