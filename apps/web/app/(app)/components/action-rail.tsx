"use client";

import { Tooltip } from "antd";
import Link from "next/link";
import { Fragment, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { navItemStateClass } from "./nav-item-state";
import { estimateRailContentHeight, type NavMode } from "./nav-mode";
import { useNavigation } from "./use-navigation";

interface ActionRailProps {
  mode: NavMode;
  onContentHeightChange?: (height: number) => void;
}

/**
 * 桌面导航 rail。导航数据与权限过滤来自 useNavigation（单一真源），
 * 与移动 Drawer 共用同一份五组配置；rail 只负责「图标 + 组节奏」的
 * 桌面呈现——组间用细分隔线，管理组带标题与上边界以示权限分区。
 */
export function ActionRail({ mode, onContentHeightChange }: ActionRailProps) {
  const { t } = useTranslation();
  const { groups, activeKey } = useNavigation();

  const estimatedContentHeight = useMemo(
    () =>
      estimateRailContentHeight({
        groupItemCounts: groups.map((group) => group.items.length),
        hasTitledAdminGroup: groups.some((group) => group.id === "admin"),
      }),
    [groups],
  );

  useEffect(() => {
    onContentHeightChange?.(estimatedContentHeight);
  }, [estimatedContentHeight, onContentHeightChange]);

  if (mode === "drawer") {
    return null;
  }

  const isScrollable = mode === "rail-scroll";
  const scrollableRailClass = isScrollable
    ? "rail-scrollbar max-h-full overflow-y-auto overscroll-contain pr-1"
    : "";

  return (
    <aside
      className={`
        hidden md:flex flex-col h-full px-3 shrink-0 relative z-[var(--z-rail)] pointer-events-auto min-h-0
        ${isScrollable ? "justify-start" : "justify-center"}
      `}
    >
      <div
        className={`
        flex flex-col items-center py-4 w-[var(--shell-rail-width)]
        glass-panel rounded-2xl border border-[var(--border)] shadow-panel
        ${scrollableRailClass}
      `}
      >
        {groups.map((group, index) => {
          const isAdminGroup = group.id === "admin";
          return (
            <Fragment key={group.id}>
              {index > 0 && !isAdminGroup ? (
                <div className="rail-group-divider" aria-hidden />
              ) : null}
              <section
                aria-label={t(group.labelKey)}
                className={`flex flex-col gap-[var(--rail-item-gap)] w-full px-2 ${
                  isAdminGroup
                    ? "mt-3 pt-3 border-t border-[var(--nav-divider-soft)]"
                    : ""
                }`}
              >
                {isAdminGroup ? (
                  <span className="nav-group-label px-2 whitespace-nowrap">
                    {t(group.labelKey)}
                  </span>
                ) : null}
                {group.items.map((item) => {
                  const isActive = item.key === activeKey;
                  const label = t(item.labelKey);
                  return (
                    <Tooltip key={item.key} title={label} placement="right">
                      <Link
                        href={item.path}
                        aria-label={label}
                        aria-current={isActive ? "page" : undefined}
                        className={`
                          nav-item ${navItemStateClass(isActive)}
                          flex h-[var(--rail-item-size)] w-full items-center justify-center
                          rounded-[var(--rail-item-radius)] select-none cursor-pointer active:scale-[0.97]
                        `}
                      >
                        <span className="text-lg" aria-hidden>
                          <item.icon />
                        </span>
                      </Link>
                    </Tooltip>
                  );
                })}
              </section>
            </Fragment>
          );
        })}
      </div>
    </aside>
  );
}
