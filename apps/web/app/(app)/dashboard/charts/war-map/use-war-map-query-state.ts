"use client";

import type {
  WarMapAisMode,
  WarMapFlightMode,
  WarMapTimeRangePreset,
  WarMapTranslateTarget,
  WarMapViewState,
} from "@modular/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  BBOX_QUERY_MIN_ZOOM,
  buildWarMapQueryBbox,
  type WarMapBbox,
} from "./query-viewport";

/** `all` 时间范围的固定起点（epoch）。 */
const ALL_TIME_START = new Date("1970-01-01T00:00:00.000Z");

const TIME_RANGE_MS: Record<Exclude<WarMapTimeRangePreset, "all">, number> = {
  "1h": 1 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "48h": 48 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/** range anchor 的周期性刷新间隔（保证相对时间窗口向前滚动）。 */
const RANGE_ANCHOR_REFRESH_MS = 60_000;

/** 地图 moveend 同步过来的查询视口。 */
export interface WarMapQueryViewport {
  bbox?: WarMapBbox;
  zoom: number;
}

export interface WarMapRealtimeQuery {
  start: Date;
  end: Date;
  bbox?: string;
  zoom?: number;
  translateTarget?: WarMapTranslateTarget;
  flightMode?: WarMapFlightMode;
  aisMode?: WarMapAisMode;
}

export interface UseWarMapQueryStateOptions {
  /** hydration 合并后的视图状态（用于初始 query zoom）。 */
  effectiveViewState: WarMapViewState;
  effectiveTimeRangePreset: WarMapTimeRangePreset;
  /** 地图进入视口后才开始 anchor 刷新。 */
  inView: boolean;
  translateTarget?: WarMapTranslateTarget;
  flightMode: WarMapFlightMode;
  aisMode: WarMapAisMode;
  onEffectiveRangeChange?: (range: { start: Date; end: Date }) => void;
  onRealtimeQueryChange?: (query: WarMapRealtimeQuery) => void;
}

export interface UseWarMapQueryStateResult {
  /** 当前生效的时间窗口（all → epoch 起点；其余 → anchor 往前推 preset 时长）。 */
  effectiveRange: { start: Date; end: Date };
  /** 查询视口（bbox + zoom），由地图 moveend 同步写入。 */
  queryViewport: WarMapQueryViewport;
  /** 2 位小数化的查询 zoom（稳定 query key / 回调精度）。 */
  queryZoom: number;
  /** 低于 BBOX_QUERY_MIN_ZOOM 时不发送的 bbox 查询参数。 */
  queryBbox: string | undefined;
  /** 本地聚类使用的 bbox（同样受最小 zoom 门禁）。 */
  localClusterBbox: WarMapBbox | undefined;
  /** 地图 moveend 同步入口（view state 写回由调用方接入设置 store）。 */
  setQueryViewport: (viewport: WarMapQueryViewport) => void;
}

/**
 * War Map 的查询状态域（FE-批4A）。
 *
 * 单一所有者职责：
 * - range anchor：进入视口后的首次激活不刷新（保持挂载时刻），此后
 *   time range 切换或 60s 周期触发 refreshRangeAnchor；`all` 语义为
 *   epoch 起点。
 * - effectiveRange 派生与 onEffectiveRangeChange 回调。
 * - queryViewport（bbox+zoom）状态、queryZoom/queryBbox/localClusterBbox
 *   派生（BBOX_QUERY_MIN_ZOOM 门禁在 query-viewport.ts）。
 * - onRealtimeQueryChange 回调（range + viewport + modes 一起上报）。
 */
export function useWarMapQueryState(
  options: UseWarMapQueryStateOptions,
): UseWarMapQueryStateResult {
  const {
    effectiveViewState,
    effectiveTimeRangePreset,
    inView,
    translateTarget,
    flightMode,
    aisMode,
    onEffectiveRangeChange,
    onRealtimeQueryChange,
  } = options;

  const [rangeAnchorMs, setRangeAnchorMs] = useState(() => Date.now());
  const hasActivatedRangeAnchorRef = useRef(false);
  const [queryViewport, setQueryViewport] = useState<WarMapQueryViewport>(
    () => ({
      zoom: Number(effectiveViewState.zoom.toFixed(2)),
    }),
  );

  const refreshRangeAnchor = useCallback(() => {
    setRangeAnchorMs(Date.now());
  }, []);

  useEffect(() => {
    if (!inView) {
      return;
    }

    if (!hasActivatedRangeAnchorRef.current) {
      hasActivatedRangeAnchorRef.current = true;
      return;
    }

    refreshRangeAnchor();
  }, [effectiveTimeRangePreset, inView, refreshRangeAnchor]);

  useEffect(() => {
    if (!inView || typeof window === "undefined") {
      return;
    }
    const interval = window.setInterval(() => {
      refreshRangeAnchor();
    }, RANGE_ANCHOR_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [inView, refreshRangeAnchor]);

  const effectiveRange = useMemo(() => {
    const end = new Date(rangeAnchorMs);
    if (effectiveTimeRangePreset === "all") {
      return { start: ALL_TIME_START, end };
    }
    const duration = TIME_RANGE_MS[effectiveTimeRangePreset];
    return {
      end,
      start: new Date(end.getTime() - duration),
    };
  }, [effectiveTimeRangePreset, rangeAnchorMs]);

  useEffect(() => {
    if (!onEffectiveRangeChange) {
      return;
    }
    onEffectiveRangeChange({
      start: effectiveRange.start,
      end: effectiveRange.end,
    });
  }, [effectiveRange.end, effectiveRange.start, onEffectiveRangeChange]);

  const queryZoom = useMemo(
    () => Number(queryViewport.zoom.toFixed(2)),
    [queryViewport.zoom],
  );

  const queryBbox = useMemo(() => {
    return buildWarMapQueryBbox(queryViewport.bbox, queryZoom);
  }, [queryViewport.bbox, queryZoom]);
  const localClusterBbox = useMemo(
    () => (queryZoom >= BBOX_QUERY_MIN_ZOOM ? queryViewport.bbox : undefined),
    [queryViewport.bbox, queryZoom],
  );

  useEffect(() => {
    if (!onRealtimeQueryChange) {
      return;
    }
    onRealtimeQueryChange({
      start: effectiveRange.start,
      end: effectiveRange.end,
      bbox: queryBbox,
      zoom: queryZoom,
      translateTarget,
      flightMode,
      aisMode,
    });
  }, [
    effectiveRange.end,
    effectiveRange.start,
    aisMode,
    flightMode,
    onRealtimeQueryChange,
    queryBbox,
    queryZoom,
    translateTarget,
  ]);

  return {
    effectiveRange,
    queryViewport,
    queryZoom,
    queryBbox,
    localClusterBbox,
    setQueryViewport,
  };
}
