"use client";

import type { MapboxOverlay, MapboxOverlayProps } from "@deck.gl/mapbox";
import type { WarMapViewState } from "@modular/utils";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

import { captureClientError } from "@/lib/client-telemetry";
import {
  classifyMapLoadError,
  type MapLoadErrorPresentation,
} from "@/lib/map/map-load-error";
import {
  createDeckMapRuntime,
  extractMapBbox,
  setDeckOverlayProps,
} from "@/lib/map/map-runtime";
import { MAP_STYLE_URL } from "@/lib/map/map-style";

import type { WarMapBbox } from "./query-viewport";

/** 地图 moveend/onReady 同步给外部的 view state 与查询视口。 */
export interface WarMapViewportSync {
  viewState: {
    lat: number;
    lon: number;
    zoom: number;
    bearing: number;
    pitch: number;
  };
  viewport: {
    bbox?: WarMapBbox;
    zoom: number;
  };
}

export interface UseWarMapRuntimeOptions {
  mapContainerRef: RefObject<HTMLDivElement | null>;
  inView: boolean;
  hasRenderableMapContainer: boolean;
  /** 外部目标视图状态（URL 合并后的设置值；变化时 easeTo 对齐）。 */
  targetViewState: WarMapViewState;
  /** 地图 moveend/ready 后同步 view state 与查询视口（必须引用稳定）。 */
  onViewportSync: (sync: WarMapViewportSync) => void;
}

export interface UseWarMapRuntimeResult {
  /** 地图实例（运行时唯一所有者；外部只读用于 easeTo 等操作）。 */
  mapRef: RefObject<MapLibreMap | null>;
  mapReady: boolean;
  mapLoadError: MapLoadErrorPresentation | null;
  /** 销毁当前实例并以新 nonce 重建（错误重试）。 */
  retryMapLoad: () => void;
  /** 更新 Deck overlay props（图层/tooltip/cursor）。 */
  setOverlayProps: (
    props: Pick<MapboxOverlayProps, "layers" | "getTooltip" | "getCursor">,
  ) => void;
}

/** 外部视图状态与地图当前状态的差异阈值（低于阈值不 easeTo）。 */
const VIEW_STATE_DIFF_THRESHOLDS = {
  lat: 0.0005,
  lon: 0.0005,
  zoom: 0.02,
  bearing: 0.1,
  pitch: 0.1,
} as const;

const EASE_TO_DURATION_MS = 450;

/**
 * War Map 的地图运行时域（FE-批4A）。
 *
 * 单一所有者职责：
 * - MapLibre + Deck overlay 实例的创建（inView + renderable 门禁，仅一次）
 *   与销毁（unmount / retry nonce 变化）。
 * - load/error 生命周期：错误分类（classifyMapLoadError）+ telemetry +
 *   toast；retry 销毁旧实例后重建。
 * - moveend/ready 同步：把地图视图写回外部（onViewportSync），并以
 *   syncFromMapRef 守卫外部视图状态回放（easeTo）造成的循环。
 * - resize（ready/inView/renderable 变化时）与 overlay props 更新入口。
 *
 * 地图实例与 overlay 引用只在本 hook 创建与清空。
 */
export function useWarMapRuntime(
  options: UseWarMapRuntimeOptions,
): UseWarMapRuntimeResult {
  const {
    mapContainerRef,
    inView,
    hasRenderableMapContainer,
    targetViewState,
    onViewportSync,
  } = options;

  const mapRef = useRef<MapLibreMap | null>(null);
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);
  const syncFromMapRef = useRef(false);
  const targetViewStateRef = useRef(targetViewState);
  const [mapReady, setMapReady] = useState(false);
  const [mapLoadError, setMapLoadError] =
    useState<MapLoadErrorPresentation | null>(null);
  const [mapMountNonce, setMapMountNonce] = useState(0);

  const retryMapLoad = useCallback(() => {
    setMapLoadError(null);
    setMapReady(false);
    setMapMountNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (
      !mapContainerRef.current ||
      !inView ||
      !hasRenderableMapContainer ||
      mapRef.current
    ) {
      return;
    }

    const initialViewState = targetViewStateRef.current;
    setMapLoadError(null);
    const syncFromMap = (map: MapLibreMap) => {
      const center = map.getCenter();
      syncFromMapRef.current = true;
      onViewportSync({
        viewState: {
          lat: center.lat,
          lon: center.lng,
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        },
        viewport: {
          bbox: extractMapBbox(map),
          zoom: map.getZoom(),
        },
      });
      window.setTimeout(() => {
        syncFromMapRef.current = false;
      }, 0);
    };

    const runtime = createDeckMapRuntime({
      container: mapContainerRef.current,
      initialViewState,
      force2D: true,
      style: MAP_STYLE_URL,
      onMoveEnd: syncFromMap,
      onMapReady: (map) => {
        setMapLoadError(null);
        setMapReady(true);
        syncFromMap(map);
      },
      onMapError: (_map, detail) => {
        captureClientError("War map basemap load failed", detail.error ?? detail);
        const presentation = classifyMapLoadError(detail);
        setMapReady(false);
        setMapLoadError(presentation);
        toast.error(
          `${presentation.title}. ${presentation.rawMessage ?? presentation.description}`,
        );
      },
    });

    mapRef.current = runtime.map;
    deckOverlayRef.current = runtime.overlay;

    return () => {
      deckOverlayRef.current = null;
      mapRef.current = null;
      runtime.destroy();
      setMapReady(false);
    };
  }, [
    hasRenderableMapContainer,
    inView,
    mapContainerRef,
    mapMountNonce,
    onViewportSync,
  ]);

  // 外部视图状态 → 地图 easeTo 对齐（地图自身同步期间跳过，避免回环）
  useEffect(() => {
    targetViewStateRef.current = targetViewState;

    const map = mapRef.current;
    if (!map || !mapReady || syncFromMapRef.current) {
      return;
    }

    const center = map.getCenter();
    const changed =
      Math.abs(center.lat - targetViewState.lat) > VIEW_STATE_DIFF_THRESHOLDS.lat ||
      Math.abs(center.lng - targetViewState.lon) > VIEW_STATE_DIFF_THRESHOLDS.lon ||
      Math.abs(map.getZoom() - targetViewState.zoom) >
        VIEW_STATE_DIFF_THRESHOLDS.zoom ||
      Math.abs(map.getBearing() - targetViewState.bearing) >
        VIEW_STATE_DIFF_THRESHOLDS.bearing ||
      Math.abs(map.getPitch() - targetViewState.pitch) >
        VIEW_STATE_DIFF_THRESHOLDS.pitch;

    if (!changed) {
      return;
    }

    map.easeTo({
      center: [targetViewState.lon, targetViewState.lat],
      zoom: targetViewState.zoom,
      bearing: targetViewState.bearing,
      pitch: targetViewState.pitch,
      duration: EASE_TO_DURATION_MS,
      essential: true,
    });
  }, [mapReady, targetViewState]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !inView || !hasRenderableMapContainer) {
      return;
    }
    map.resize();
  }, [hasRenderableMapContainer, inView, mapReady]);

  const setOverlayProps = useCallback(
    (props: Pick<MapboxOverlayProps, "layers" | "getTooltip" | "getCursor">) => {
      if (!deckOverlayRef.current) {
        return;
      }
      setDeckOverlayProps(deckOverlayRef.current, props);
    },
    [],
  );

  return {
    mapRef,
    mapReady,
    mapLoadError,
    retryMapLoad,
    setOverlayProps,
  };
}
