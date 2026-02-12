"use client";

import { message } from "antd";
import { usePathname } from "next/navigation";
import type { PropsWithChildren } from "react";

import { ActionRail } from "./action-rail";
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

function useContainerClass(): string {
  const pathname = usePathname();
  const isWide = WIDE_LAYOUT_PATHS.some(path => pathname?.startsWith(path));
  if (isWide) {
    return "w-full max-w-[1920px] mx-auto";
  }
  return "w-full max-w-[1440px] mx-auto";
}

export function ShellLayout({ children }: PropsWithChildren) {
  const [, contextHolder] = message.useMessage();
  const containerClass = useContainerClass();

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {contextHolder}

      <UrlStateSync />

      <UserUiSettingsSync />

      <TopNav />

      <div className="flex flex-1 overflow-hidden pt-[calc(var(--top-nav-height,4rem)+var(--ticker-height,0px))] relative isolate">
        <ActionRail />

        <main className="relative z-0 flex-1 overflow-auto scrollbar-thin scrollbar-thumb-slate-200/80 hover:scrollbar-thumb-slate-300/90 scrollbar-track-transparent">
          <div className={`${containerClass} p-4 md:p-6`}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
