"use client";

import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CommandBar } from "./command-bar";
import { MobileNavDrawer } from "./mobile-nav-drawer";
import { TickerTape } from "./ticker-tape";
import { TopNavActions } from "./top-nav-actions";
import { TopNavBrand } from "./top-nav-brand";
import { resolveTopNavLayout } from "./top-nav-density";
import { TopNavUserMenu } from "./top-nav-user-menu";
import { useTopNavDensity } from "./use-top-nav-density";

interface TopNavProps {
  /** 桌面矮视口 drawer 模式（navMode=drawer）下，菜单按钮在桌面也显示 */
  showDesktopMenuButton?: boolean;
}

/**
 * 顶部栏编排层（FE-批2 拆分后）：只负责分区组合与少量顶层状态
 * （drawer 开合、密度换算）。各分区的实现：
 * - 品牌/菜单入口：TopNavBrand
 * - 右侧操作区（状态/抓取/通知/语言/组织/同步/主题）：TopNavActions
 * - 用户区（菜单+退出）：TopNavUserMenu
 * - 移动/矮视口导航：MobileNavDrawer（与 ActionRail 共用导航模型）
 * - 密度与溢出测量：useTopNavDensity（视口宽度来自 Shell 级单一来源）
 */
export function TopNav({ showDesktopMenuButton = false }: TopNavProps) {
  const { i18n } = useTranslation();
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canStartCrawl = permissions.includes("crawl.write");
  const permissionsKey = useMemo(() => permissions.join("|"), [permissions]);

  // 会影响 header 内容宽度的值都进 key，密度 hook 据此重测溢出。
  const remeasureKey = [
    i18n.language,
    status,
    permissionsKey,
    session?.orgId ?? "",
    pathname ?? "",
    canStartCrawl,
  ].join("\u0000");

  const { headerRef, densityMode } = useTopNavDensity({ remeasureKey });
  const layout = useMemo(
    () => resolveTopNavLayout({ densityMode, canStartCrawl }),
    [canStartCrawl, densityMode],
  );

  // 路由变化后关闭导航 Drawer。
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  // 回到桌面断点时关闭 Drawer（桌面矮视口 drawer 模式除外）。
  useEffect(() => {
    if (showDesktopMenuButton) {
      return;
    }
    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) {
        setMobileNavOpen(false);
      }
    };
    handleChange(mediaQuery);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [showDesktopMenuButton]);

  const headerSpacingClassName =
    layout.densityMode === "full"
      ? "gap-2 border-b border-[var(--border)] px-3 sm:gap-3 sm:px-4 lg:gap-4 lg:px-6"
      : layout.densityMode === "compact"
        ? "gap-2 border-b border-[var(--border)] px-3 sm:gap-2 sm:px-4 lg:gap-3 lg:px-5"
        : "gap-1.5 border-b border-[var(--border)] px-2.5 sm:gap-2 sm:px-3";

  return (
    <div className="fixed top-0 left-0 right-0 z-[var(--z-top-nav)] flex flex-col">
      {/* Ticker Tape Layer */}
      <TickerTape />

      {/* Main Navbar Layer */}
      <header
        ref={headerRef}
        className={`relative flex h-16 shrink-0 items-center ${headerSpacingClassName} glass`}
      >
        <TopNavBrand
          onOpenMenu={() => setMobileNavOpen(true)}
          menuExpanded={mobileNavOpen}
          showDesktopMenuButton={showDesktopMenuButton}
        />

        {/* Center: Command Bar（minimal 档让位于搜索兜底入口） */}
        {layout.showCommandBar ? (
          <div className="hidden min-w-0 flex-1 items-center justify-center px-1 sm:flex md:px-2 lg:px-4">
            <div
              className={`w-full ${layout.densityMode === "full" ? "max-w-[640px]" : "max-w-[380px]"}`}
            >
              <CommandBar />
            </div>
          </div>
        ) : null}

        <TopNavActions layout={layout} canStartCrawl={canStartCrawl} />
        <TopNavUserMenu layout={layout} />
      </header>

      <MobileNavDrawer
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        className={showDesktopMenuButton ? "" : "md:hidden"}
      />
    </div>
  );
}
