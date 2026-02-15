"use client";

import { message } from "antd";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";

import { ActionRail } from "./action-rail";
import { DESKTOP_RAIL_MIN_WIDTH, resolveNavMode, type NavMode } from "./nav-mode";
import { TopNav } from "./top-nav";
import { UrlStateSync } from "./url-state-sync";
import { UserUiSettingsSync } from "./user-ui-settings-sync";

/**
 * Pages that benefit from wider containers (monitoring/dashboard pages).
 * When adding new data-dense pages, consider adding them here for better screen utilization.
 * @example Adding a new monitoring page:
 *   1. Add the route prefix to this array: "/new-monitor"
 *   2. The page will automatically use max-w-[1920px] instead of max-w-[1440px]
 */
const WIDE_LAYOUT_PATHS = [
  "/situation-monitor",  // Multi-panel monitoring dashboard
  "/dashboard",          // Analytics and charts
  "/map",                // Full-screen map visualization
] as const;

const FLUID_LAYOUT_PATHS = [
  "/assistant",          // Chat layout benefits from using almost full width
] as const;

function useContainerClass(): string {
  const pathname = usePathname();
  const isFluid = FLUID_LAYOUT_PATHS.some(path => pathname?.startsWith(path));
  if (isFluid) {
    return "w-full max-w-none mx-0";
  }

  const isWide = WIDE_LAYOUT_PATHS.some(path => pathname?.startsWith(path));
  if (isWide) {
    return "w-full max-w-[1920px] mx-auto";
  }
  return "w-full max-w-[1440px] mx-auto";
}

export function ShellLayout({ children }: PropsWithChildren) {
  const [, contextHolder] = message.useMessage();
  const containerClass = useContainerClass();
  const shellContentRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(DESKTOP_RAIL_MIN_WIDTH);
  const [availableRailHeight, setAvailableRailHeight] = useState(0);
  const [railContentHeight, setRailContentHeight] = useState(0);

  const updateViewportWidth = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    setViewportWidth(window.innerWidth);
  }, []);

  useEffect(() => {
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, [updateViewportWidth]);

  useEffect(() => {
    const shellContent = shellContentRef.current;
    if (!shellContent) {
      return;
    }

    const updateAvailableRailHeight = () => {
      const styles = window.getComputedStyle(shellContent);
      const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
      setAvailableRailHeight(Math.max(shellContent.clientHeight - paddingTop, 0));
    };

    updateAvailableRailHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateAvailableRailHeight);
      return () => window.removeEventListener("resize", updateAvailableRailHeight);
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
        railContentHeight
      }),
    [availableRailHeight, railContentHeight, viewportWidth]
  );

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {contextHolder}

      <UrlStateSync />

      <UserUiSettingsSync />

      <TopNav showDesktopMenuButton={navMode === "drawer"} />

      <div
        ref={shellContentRef}
        className="flex flex-1 overflow-hidden pt-[calc(var(--top-nav-height,4rem)+var(--ticker-height,0px))] relative isolate"
      >
        <div className="relative z-20 h-full shrink-0 min-h-0">
          <ActionRail mode={navMode} onContentHeightChange={setRailContentHeight} />
        </div>

        <main className="relative z-0 flex-1 overflow-auto scrollbar-thin scrollbar-thumb-slate-200/80 hover:scrollbar-thumb-slate-300/90 scrollbar-track-transparent">
          <div className={`${containerClass} p-4 md:p-6`}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
