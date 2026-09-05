"use client";

import type { WarMapTimeRangePreset, WarMapViewState } from "@modular/utils";
import { useEffect, useMemo, useRef, useState } from "react";

import { useWarMapSettingsStore } from "@/store/war-map-settings";

import { readWarMapUrlState, writeWarMapUrlState } from "./url-state";

/** URL 写回防抖：高频 view state 变化合并为一次 replaceState。 */
const URL_WRITE_DEBOUNCE_MS = 300;

export interface UseWarMapUrlStateResult {
  /** URL 首次 hydration 是否完成（完成前 effective 值优先 URL 覆盖）。 */
  urlHydrated: boolean;
  /** URL 合并后的视图状态（hydration 完成前含 URL 覆盖与 2D 强制）。 */
  effectiveViewState: WarMapViewState;
  /** URL 合并后的时间范围（hydration 完成前含 URL 覆盖）。 */
  effectiveTimeRangePreset: WarMapTimeRangePreset;
}

/**
 * War Map 的 URL 状态域（FE-批4A）。
 *
 * 单一所有者职责：
 * - 首次 hydration：把 URL 中的 view/preset/time range/layers/flight/AIS
 *   一次性写入 Zustand 设置（每字段独立判断，URL 未提供的字段保留远端
 *   同步值）；hydration 仅执行一次（hasHydratedUrlRef 守卫）。
 * - URL 写回：设置变化后 300ms 防抖合并写回 window.history.replaceState，
 *   与当前 search 相同时跳过（不产生回写循环）；旧 aa 参数在写回时清理、
 *   未知参数保留（writeWarMapUrlState 契约）。
 * - effective 合并：hydration 完成前，URL 提供的 viewState/timeRangePreset
 *   优先于 store 当前值（首次渲染即按链接视角执行查询）。
 *
 * 远端设置的 URL 优先级由 user-ui-settings-sync 经
 * mergeWarMapSettingsWithUrlState 保证，本 hook 不重复实现。
 */
export function useWarMapUrlState(): UseWarMapUrlStateResult {
  const viewState = useWarMapSettingsStore((state) => state.viewState);
  const activePreset = useWarMapSettingsStore((state) => state.activePreset);
  const timeRangePreset = useWarMapSettingsStore(
    (state) => state.timeRangePreset,
  );
  const layerVisibility = useWarMapSettingsStore(
    (state) => state.layerVisibility,
  );
  const flightMode = useWarMapSettingsStore((state) => state.flightMode);
  const aisMode = useWarMapSettingsStore((state) => state.aisMode);
  const setLayerVisibility = useWarMapSettingsStore(
    (state) => state.setLayerVisibility,
  );
  const setViewState = useWarMapSettingsStore((state) => state.setViewState);
  const setActivePreset = useWarMapSettingsStore(
    (state) => state.setActivePreset,
  );
  const setTimeRangePreset = useWarMapSettingsStore(
    (state) => state.setTimeRangePreset,
  );
  const setFlightMode = useWarMapSettingsStore(
    (state) => state.setFlightMode,
  );
  const setAisMode = useWarMapSettingsStore((state) => state.setAisMode);

  const hasHydratedUrlRef = useRef(false);
  const [urlHydrated, setUrlHydrated] = useState(
    () => typeof window === "undefined",
  );

  const initialUrlState = useMemo(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return readWarMapUrlState(new URLSearchParams(window.location.search));
  }, []);

  const effectiveViewState = useMemo(
    () =>
      !urlHydrated && initialUrlState?.viewState
        ? {
            ...viewState,
            ...initialUrlState.viewState,
            bearing: 0,
            pitch: 0,
          }
        : viewState,
    [initialUrlState?.viewState, urlHydrated, viewState],
  );
  const effectiveTimeRangePreset =
    !urlHydrated && initialUrlState?.timeRangePreset
      ? initialUrlState.timeRangePreset
      : timeRangePreset;

  useEffect(() => {
    if (hasHydratedUrlRef.current || typeof window === "undefined") {
      return;
    }

    const parsed =
      initialUrlState ??
      readWarMapUrlState(new URLSearchParams(window.location.search));
    if (parsed.layerVisibility) {
      setLayerVisibility(parsed.layerVisibility);
    }
    if (parsed.activePreset) {
      setActivePreset(parsed.activePreset);
    }
    if (parsed.timeRangePreset) {
      setTimeRangePreset(parsed.timeRangePreset);
    }
    if (parsed.flightMode) {
      setFlightMode(parsed.flightMode);
    }
    if (parsed.aisMode) {
      setAisMode(parsed.aisMode);
    }
    if (parsed.viewState) {
      setViewState(parsed.viewState);
    }

    hasHydratedUrlRef.current = true;
    setUrlHydrated(true);
  }, [
    initialUrlState,
    setActivePreset,
    setAisMode,
    setFlightMode,
    setLayerVisibility,
    setTimeRangePreset,
    setViewState,
  ]);

  useEffect(() => {
    if (!hasHydratedUrlRef.current || typeof window === "undefined") {
      return;
    }

    const timer = window.setTimeout(() => {
      const current = new URL(window.location.href);
      const nextParams = writeWarMapUrlState(current.searchParams, {
        viewState,
        activePreset,
        timeRangePreset,
        layerVisibility,
        flightMode,
        aisMode,
      });
      const nextSearch = nextParams.toString();
      const currentSearch = current.searchParams.toString();
      if (nextSearch !== currentSearch) {
        const nextUrl = `${current.pathname}${nextSearch ? `?${nextSearch}` : ""}${current.hash}`;
        window.history.replaceState(null, "", nextUrl);
      }
    }, URL_WRITE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [
    activePreset,
    aisMode,
    flightMode,
    layerVisibility,
    timeRangePreset,
    viewState,
  ]);

  return {
    urlHydrated,
    effectiveViewState,
    effectiveTimeRangePreset,
  };
}
