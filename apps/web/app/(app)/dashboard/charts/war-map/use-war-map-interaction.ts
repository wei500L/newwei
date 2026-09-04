"use client";

import type { Map as MapLibreMap } from "maplibre-gl";
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { toast } from "sonner";

import type {
  OverlayControlsSection,
  OverlayPanelKey,
  SelectedInspector,
  WarMapTranslateFn,
} from "./war-map-overlay-model";

/** Deck picking 回调的最小结构（点位模型字段由调用方决定）。 */
export interface WarMapDeckPick<TPoint> {
  object?: TPoint;
}

interface HoverableDeckPoint {
  interactionKey?: string;
}

interface SelectableDeckPoint {
  selectionKey?: string;
}

/** 聚类点击的缩放目标（layer cluster 点）。 */
export interface WarMapLayerClusterZoomTarget {
  lat: number;
  lng: number;
}

export interface UseWarMapInteractionOptions {
  t: WarMapTranslateFn;
  selectedInspector: SelectedInspector | null;
  overlayRailRef: RefObject<HTMLDivElement | null>;
  useDrawerControls: boolean;
  useDesktopInspector: boolean;
  mapRef: RefObject<MapLibreMap | null>;
  queryZoom: number;
}

export interface UseWarMapInteractionResult {
  selectedInspectorKey: string | null;
  setSelectedInspectorKey: Dispatch<SetStateAction<string | null>>;
  hoveredInteractionKey: string | null;
  hoveredLegendItemKey: string | null;
  focusedLegendItemKey: string | null;
  /** focus 优先于 hover 的 legend 高亮键。 */
  highlightedLegendItemKey: string | null;
  updateHoveredInteractionKey: (next: string | null) => void;
  updateHoveredLegendItemKey: (next: string | null) => void;
  updateFocusedLegendItemKey: (next: string | null) => void;
  handleDeckPointHover: (info: WarMapDeckPick<HoverableDeckPoint>) => void;
  handleSelectablePointClick: (
    info: WarMapDeckPick<SelectableDeckPoint>,
  ) => void;
  handleMonitorPointClick: (info: WarMapDeckPick<MonitorClickPoint>) => void;
  handleLayerPointClick: (
    info: WarMapDeckPick<LayerClickPoint & { lat: number; lng: number }>,
  ) => void;
  closeSelectedInspector: () => void;
  zoomToSelectedInspector: () => void;
  openOverlayPanel: OverlayPanelKey | null;
  setOpenOverlayPanel: Dispatch<SetStateAction<OverlayPanelKey | null>>;
  controlsSection: OverlayControlsSection;
  setControlsSection: Dispatch<SetStateAction<OverlayControlsSection>>;
  desktopInspectorMinimized: boolean;
  setDesktopInspectorMinimized: Dispatch<SetStateAction<boolean>>;
}

/** 监控点位点击所需字段。 */
interface MonitorClickPoint {
  query?: string;
  label: string;
}

/** 图层点位点击所需字段（含聚类）。 */
interface LayerClickPoint {
  isCluster?: boolean;
  selectionKey?: string;
}

/**
 * War Map 的交互与选择域（FE-批4A）。
 *
 * 单一所有者职责：
 * - 选中/hover/legend focus 状态与 Inspector 开合（含桌面最小化）；
 * - overlay panel 与 controls section 状态；
 * - Escape（先关面板再关 Inspector）与面板外 pointerdown 关闭；
 * - 失效清理：选中键在数据中不再可解析时清空；
 * - deck 点位 hover/点击 handlers（选中、监控搜索跳转、聚类缩放）。
 *
 * legend focus/hover 键的失效清理依赖 legendItemsByKey（其派生链上游
 * 含图层构造使用的本 hook 状态），由 war-map.tsx 在 legend 索引就绪后
 * 以 updateXxxLegendItemKey(null) 执行，避免循环依赖。
 */
export function useWarMapInteraction(
  options: UseWarMapInteractionOptions,
): UseWarMapInteractionResult {
  const {
    t,
    selectedInspector,
    overlayRailRef,
    useDrawerControls,
    useDesktopInspector,
    mapRef,
    queryZoom,
  } = options;

  const [openOverlayPanel, setOpenOverlayPanel] =
    useState<OverlayPanelKey | null>(null);
  const [controlsSection, setControlsSection] =
    useState<OverlayControlsSection>("view");
  const [desktopInspectorMinimized, setDesktopInspectorMinimized] =
    useState(false);
  const [selectedInspectorKey, setSelectedInspectorKey] = useState<
    string | null
  >(null);
  const [focusedLegendItemKey, setFocusedLegendItemKey] = useState<
    string | null
  >(null);
  const [hoveredLegendItemKey, setHoveredLegendItemKey] = useState<
    string | null
  >(null);
  const [hoveredInteractionKey, setHoveredInteractionKey] = useState<
    string | null
  >(null);

  const closeSelectedInspector = useCallback(() => {
    setDesktopInspectorMinimized(false);
    setSelectedInspectorKey(null);
  }, []);

  const zoomToSelectedInspector = useCallback(() => {
    const map = mapRef.current;
    if (!map || !selectedInspector) {
      return;
    }

    map.easeTo({
      center: [selectedInspector.lng, selectedInspector.lat],
      zoom: Math.min(selectedInspector.zoomTarget, map.getZoom() + 2),
      duration: 350,
      essential: true,
    });
  }, [mapRef, selectedInspector]);

  const zoomToLayerCluster = useCallback(
    (point?: WarMapLayerClusterZoomTarget) => {
      const map = mapRef.current;
      if (!map || !point) {
        return;
      }

      map.easeTo({
        center: [point.lng, point.lat],
        zoom: Math.min(Math.max(5, queryZoom + 2), 10),
        duration: 350,
        essential: true,
      });
    },
    [mapRef, queryZoom],
  );

  // 选中键失效清理（数据刷新后选中对象可能消失）
  useEffect(() => {
    if (selectedInspectorKey && !selectedInspector) {
      setSelectedInspectorKey(null);
    }
  }, [selectedInspector, selectedInspectorKey]);

  // 新选中：关闭 overlay 面板并复位桌面 Inspector 最小化
  useEffect(() => {
    if (selectedInspector) {
      setOpenOverlayPanel(null);
    }
    setDesktopInspectorMinimized(false);
  }, [selectedInspector?.key]);

  // 桌面面板打开时，点击面板外区域关闭
  useEffect(() => {
    if (
      !openOverlayPanel ||
      useDrawerControls ||
      typeof document === "undefined"
    ) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (overlayRailRef.current?.contains(target)) {
        return;
      }
      setOpenOverlayPanel(null);
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [openOverlayPanel, overlayRailRef, useDrawerControls]);

  // Escape：优先关闭 overlay 面板，其次关闭桌面 Inspector
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (openOverlayPanel) {
        setOpenOverlayPanel(null);
        return;
      }
      if (
        useDesktopInspector &&
        selectedInspector &&
        !desktopInspectorMinimized
      ) {
        closeSelectedInspector();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    closeSelectedInspector,
    desktopInspectorMinimized,
    openOverlayPanel,
    selectedInspector,
    useDesktopInspector,
  ]);

  // legend focus/hover 键失效清理
  const updateHoveredInteractionKey = useCallback((next: string | null) => {
    setHoveredInteractionKey((current) => (current === next ? current : next));
  }, []);
  const updateHoveredLegendItemKey = useCallback((next: string | null) => {
    setHoveredLegendItemKey((current) => (current === next ? current : next));
  }, []);
  const updateFocusedLegendItemKey = useCallback((next: string | null) => {
    setFocusedLegendItemKey((current) => (current === next ? current : next));
  }, []);

  const handleDeckPointHover = useCallback(
    (info: WarMapDeckPick<HoverableDeckPoint>) => {
      updateHoveredInteractionKey(info.object?.interactionKey ?? null);
    },
    [updateHoveredInteractionKey],
  );

  const handleSelectablePointClick = useCallback(
    (info: WarMapDeckPick<SelectableDeckPoint>) => {
      const object = info.object;
      if (!object?.selectionKey) {
        return;
      }
      setSelectedInspectorKey(object.selectionKey);
    },
    [],
  );

  const handleMonitorPointClick = useCallback(
    (info: WarMapDeckPick<MonitorClickPoint>) => {
      const object = info.object;
      if (!object) {
        return;
      }
      const query = (object.query ?? object.label).trim();
      if (!query) {
        toast.warning(t("dashboard.charts.warMap.missingMonitorQuery"));
        return;
      }
      window.open(
        `/search?q=${encodeURIComponent(query)}`,
        "_blank",
        "noopener,noreferrer",
      );
    },
    [t],
  );

  const handleLayerPointClick = useCallback(
    (info: WarMapDeckPick<LayerClickPoint & { lat: number; lng: number }>) => {
      const object = info.object;
      if (!object) {
        return;
      }
      if (object.isCluster) {
        zoomToLayerCluster(object);
        return;
      }
      if (object.selectionKey) {
        setSelectedInspectorKey(object.selectionKey);
      }
    },
    [zoomToLayerCluster],
  );

  return {
    selectedInspectorKey,
    setSelectedInspectorKey,
    hoveredInteractionKey,
    hoveredLegendItemKey,
    focusedLegendItemKey,
    highlightedLegendItemKey: focusedLegendItemKey ?? hoveredLegendItemKey ?? null,
    updateHoveredInteractionKey,
    updateHoveredLegendItemKey,
    updateFocusedLegendItemKey,
    handleDeckPointHover,
    handleSelectablePointClick,
    handleMonitorPointClick,
    handleLayerPointClick,
    closeSelectedInspector,
    zoomToSelectedInspector,
    openOverlayPanel,
    setOpenOverlayPanel,
    controlsSection,
    setControlsSection,
    desktopInspectorMinimized,
    setDesktopInspectorMinimized,
  };
}
