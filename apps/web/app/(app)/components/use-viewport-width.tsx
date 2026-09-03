"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
} from "react";

import { NAV_FULL_MIN_WIDTH } from "./top-nav-density";

/**
 * Shell 级视口宽度的单一来源（FE-批2）。
 *
 * 迁移前 Shell 与 TopNav 各自维护一份 viewportWidth state + resize 监听
 * （SSR 初值还不一致：900 vs 1700）；现在 ShellLayout 挂一次
 * ViewportSizeProvider，navMode 与 TopNav 密度都从这里读。
 *
 * SSR 初值取 NAV_FULL_MIN_WIDTH（1700）——与迁移前 TopNav 的 SSR 渲染
 * 一致；navMode 首帧也与迁移前相同（两侧初值均落在 rail 档）。唯一的首
 * 帧差异：Shell 的 systemHealth 启用条件（≥1700）在非 dashboard 页的
 * SSR 首帧为 true，挂载后按真实宽度收敛（SystemHealthProvider 内有
 * canManageQueue + 会话 loading 双重门，窄屏无实际请求）。
 */
const SSR_VIEWPORT_WIDTH = NAV_FULL_MIN_WIDTH;

const ViewportWidthContext = createContext<number>(SSR_VIEWPORT_WIDTH);

export function ViewportSizeProvider({ children }: PropsWithChildren) {
  const [viewportWidth, setViewportWidth] = useState(SSR_VIEWPORT_WIDTH);

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  return (
    <ViewportWidthContext.Provider value={viewportWidth}>
      {children}
    </ViewportWidthContext.Provider>
  );
}

/** 当前视口宽度（px）。SSR/首帧返回 SSR_VIEWPORT_WIDTH，挂载后为真实值。 */
export function useViewportWidth(): number {
  return useContext(ViewportWidthContext);
}
