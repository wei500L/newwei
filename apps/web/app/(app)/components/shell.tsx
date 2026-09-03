"use client";

import { message } from "antd";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PropsWithChildren,
} from "react";

import { CONTENT_WIDTH_CLASSES } from "@/lib/content-widths";

import { ActionRail } from "./action-rail";
import { resolveNavMode, type NavMode } from "./nav-mode";
import { SystemHealthProvider } from "./system-health-context";
import { TopNav } from "./top-nav";
import { isFullWidthViewport } from "./top-nav-density";
import { UrlStateSync } from "./url-state-sync";
import { useViewportWidth, ViewportSizeProvider } from "./use-viewport-width";
import { UserUiSettingsSync } from "./user-ui-settings-sync";

/**
 * Pages that benefit from wider containers (monitoring/dashboard pages).
 * When adding new data-dense pages, consider adding them here for better screen utilization.
 * @example Adding a new monitoring page:
 *   1. Add the route prefix to this array: "/new-monitor"
 *   2. The page will automatically use max-w-[1920px] instead of max-w-[1440px]
 */
const WIDE_LAYOUT_PATHS = [
  "/situation-monitor", // Multi-panel monitoring dashboard
  "/dashboard", // Analytics and charts
  "/map", // Full-screen map visualization
] as const;

const FLUID_LAYOUT_PATHS = [
  "/assistant", // Chat layout benefits from using almost full width
  "/newsnow", // News board should feel edge-to-edge
] as const;

const EDGE_TO_EDGE_LAYOUT_PATHS = ["/newsnow"] as const;

// 内容宽度档位的单一真源在 @/lib/content-widths（服务端安全模块）：
// shell 的页面级容器与 PageContainer 的页内容容器共用同一份类型与
// class 映射；newsnow 的 1760px 特例是其中的 wide-board 档。

function useContainerClass(): string {
  const pathname = usePathname();
  const isAdminHome = pathname === "/admin";
  if (isAdminHome) {
    return `w-full ${CONTENT_WIDTH_CLASSES.full} mx-0`;
  }

  const isFluid = FLUID_LAYOUT_PATHS.some((path) => pathname?.startsWith(path));
  if (isFluid) {
    return `w-full ${CONTENT_WIDTH_CLASSES.full} mx-0`;
  }

  const isWide = WIDE_LAYOUT_PATHS.some((path) => pathname?.startsWith(path));
  if (isWide) {
    return `w-full ${CONTENT_WIDTH_CLASSES.wide} mx-auto`;
  }
  return `w-full ${CONTENT_WIDTH_CLASSES.default} mx-auto`;
}

// useContentPaddingClass 是页面级 padding 的唯一所有者：默认页 p-4
// md:p-6；edge-to-edge 页（newsnow）p-0 由页面内容自管。PageContainer
// 不产生任何 padding——避免双重边距。
function useContentPaddingClass(): string {
  const pathname = usePathname();
  const isEdgeToEdge = EDGE_TO_EDGE_LAYOUT_PATHS.some((path) =>
    pathname?.startsWith(path),
  );
  if (isEdgeToEdge) {
    return "p-0";
  }
  return "p-4 md:p-6";
}

function useMainScrollbarClass(): string {
  const pathname = usePathname();
  const isEdgeToEdge = EDGE_TO_EDGE_LAYOUT_PATHS.some((path) =>
    pathname?.startsWith(path),
  );
  if (isEdgeToEdge) {
    return "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";
  }
  return "scrollbar-thin scrollbar-thumb-slate-200/80 hover:scrollbar-thumb-slate-300/90 scrollbar-track-transparent";
}

/**
 * Shell 顶部占位的跑马灯高度策略（纯函数，供行为测试）。
 *
 * 跑马灯隐藏（非 full 宽屏档）时把 --ticker-height 压为 0：该变量同时
 * 驱动内容区 pt-[calc(var(--top-nav-height)+var(--ticker-height))] 与
 * .items-filter-rail 的 sticky max-height——在 Shell 根上一处覆盖，所有
 * 消费者同步收敛，不留 32px 空白；显示时回落到 :root 的 2rem。
 * 显示条件与 TopNav 的 TickerTape 条件渲染共用 isFullWidthViewport
 * （NAV_FULL_MIN_WIDTH 单一语义），两处不会漂移。
 */
export function resolveShellTickerStyle(
  showTickerTape: boolean,
): CSSProperties {
  return showTickerTape
    ? {}
    : ({ "--ticker-height": "0px" } as CSSProperties);
}

function AppShell({ children }: PropsWithChildren) {
  const [, contextHolder] = message.useMessage();
  const pathname = usePathname();
  const containerClass = useContainerClass();
  const contentPaddingClass = useContentPaddingClass();
  const mainScrollbarClass = useMainScrollbarClass();
  const shellContentRef = useRef<HTMLDivElement | null>(null);
  const [availableRailHeight, setAvailableRailHeight] = useState(0);
  const [railContentHeight, setRailContentHeight] = useState(0);

  // 视口宽度来自 Shell 级单一来源（use-viewport-width）——TopNav 密度
  // 与这里的 navMode 共用同一次 resize 监听，不再各自维护。
  const viewportWidth = useViewportWidth();

  useEffect(() => {
    const shellContent = shellContentRef.current;
    if (!shellContent) {
      return;
    }

    const updateAvailableRailHeight = () => {
      const styles = window.getComputedStyle(shellContent);
      const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
      setAvailableRailHeight(
        Math.max(shellContent.clientHeight - paddingTop, 0),
      );
    };

    updateAvailableRailHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateAvailableRailHeight);
      return () =>
        window.removeEventListener("resize", updateAvailableRailHeight);
    }

    const observer = new ResizeObserver(updateAvailableRailHeight);
    observer.observe(shellContent);
    window.addEventListener("resize", updateAvailableRailHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateAvailableRailHeight);
    };
  }, []);

  const navMode = useMemo<NavMode>(
    () =>
      resolveNavMode({
        viewportWidth,
        availableRailHeight,
        railContentHeight,
      }),
    [availableRailHeight, railContentHeight, viewportWidth],
  );
  const showTickerTape = isFullWidthViewport(viewportWidth);
  const systemHealthEnabled =
    pathname?.startsWith("/dashboard") || showTickerTape;
  const systemHealthRealtimeEnabled = pathname?.startsWith("/dashboard");

  return (
    <div
      className="flex flex-col h-screen overflow-hidden"
      style={resolveShellTickerStyle(showTickerTape)}
    >
      {contextHolder}

      <UrlStateSync />

      <UserUiSettingsSync />

      <SystemHealthProvider
        enabled={systemHealthEnabled}
        realtimeEnabled={systemHealthRealtimeEnabled}
      >
        <TopNav showDesktopMenuButton={navMode === "drawer"} />

        <div
          ref={shellContentRef}
          className="flex flex-1 overflow-hidden pt-[calc(var(--top-nav-height,4rem)+var(--ticker-height,0px))] relative isolate"
        >
          <div className="relative z-[var(--z-rail)] h-full shrink-0 min-h-0">
            <ActionRail
              mode={navMode}
              onContentHeightChange={setRailContentHeight}
            />
          </div>

          <main
            className={`relative z-[var(--z-content)] flex-1 overflow-auto ${mainScrollbarClass}`}
          >
            <div className={`${containerClass} ${contentPaddingClass}`}>
              {children}
            </div>
          </main>
        </div>
      </SystemHealthProvider>
    </div>
  );
}

export function ShellLayout({ children }: PropsWithChildren) {
  return (
    <ViewportSizeProvider>
      <AppShell>{children}</AppShell>
    </ViewportSizeProvider>
  );
}
