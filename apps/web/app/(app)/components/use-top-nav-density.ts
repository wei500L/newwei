"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import {
  alignDensityModeToBase,
  downgradeDensityModeForBase,
  NAV_OVERFLOW_EPSILON,
  NAV_UPGRADE_SLACK,
  resolveBaseDensityMode,
  upgradeDensityMode,
  type TopNavDensityMode,
} from "./top-nav-density";
import { useViewportWidth } from "./use-viewport-width";

export interface UseTopNavDensityResult {
  /** 挂在 header 上的引用，用于溢出测量 */
  headerRef: RefObject<HTMLElement | null>;
  densityMode: TopNavDensityMode;
}

export interface UseTopNavDensityInput {
  /**
   * 内容变化信号（语言 / 会话状态 / 权限 / 组织 / 路由等会影响 header
   * 内容宽度的值拼成的 key）。变化时触发一次重测。
   */
  remeasureKey: string;
}

/**
 * 顶部栏密度（full / compact / minimal）的集中管理（FE-批2 拆分）。
 *
 * 基线档位来自视口宽度（useViewportWidth，Shell 级单一来源）；
 * 实际档位在基线内按 header 溢出情况降级、按富余升级（阈值
 * NAV_OVERFLOW_EPSILON / NAV_UPGRADE_SLACK，语义与迁移前一致）。
 */
export function useTopNavDensity({
  remeasureKey,
}: UseTopNavDensityInput): UseTopNavDensityResult {
  const viewportWidth = useViewportWidth();
  const headerRef = useRef<HTMLElement | null>(null);
  const [densityMode, setDensityMode] = useState<TopNavDensityMode>(() =>
    resolveBaseDensityMode(viewportWidth),
  );

  const baseDensityMode = useMemo(
    () => resolveBaseDensityMode(viewportWidth),
    [viewportWidth],
  );

  useEffect(() => {
    setDensityMode((current) => alignDensityModeToBase(current, baseDensityMode));
  }, [baseDensityMode]);

  const checkDensityFit = useCallback(() => {
    const header = headerRef.current;
    if (!header) {
      return;
    }

    const overflow = header.scrollWidth - header.clientWidth;
    if (overflow > NAV_OVERFLOW_EPSILON) {
      setDensityMode((current) =>
        downgradeDensityModeForBase(current, baseDensityMode),
      );
      return;
    }

    const slack = header.clientWidth - header.scrollWidth;
    if (slack >= NAV_UPGRADE_SLACK) {
      setDensityMode((current) => upgradeDensityMode(current, baseDensityMode));
    }
  }, [baseDensityMode]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(checkDensityFit);
    return () => window.cancelAnimationFrame(frameId);
  }, [checkDensityFit, densityMode, remeasureKey]);

  useEffect(() => {
    const header = headerRef.current;
    if (!header || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => checkDensityFit());
    observer.observe(header);
    return () => observer.disconnect();
  }, [checkDensityFit]);

  return { headerRef, densityMode };
}
