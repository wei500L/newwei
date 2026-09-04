"use client";

import type { Map as MapLibreMap } from "maplibre-gl";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { toast } from "sonner";

import { safeHttpUrl } from "@/lib/url";

import type { UseWarMapPointsResult } from "./use-war-map-points";
import type {
  OverlayControlsSection,
  OverlayPanelKey,
  SelectedInspector,
  WarMapTranslateFn,
} from "./war-map-overlay-model";
import {
  resolveWarMapSelectedInspector,
  type ResolveWarMapSelectedInspectorInput,
} from "./war-map-selection-model";

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

/** 选中解析输入（selectedInspectorKey 由本 hook 提供）。 */
export type WarMapSelectionInput = Omit<
  ResolveWarMapSelectedInspectorInput,
  "selectedInspectorKey"
>;

export interface UseWarMapInteractionOptions {
  t: WarMapTranslateFn;
  /** 点位派生结果（Inspector 内容解析输入）。 */
  points: UseWarMapPointsResult;
  overlayRailRef: RefObject<HTMLDivElement | null>;
  /** standalone legend dock（滚动定位目标）。 */
  legendDockRef: RefObject<HTMLDivElement | null>;
  useDrawerControls: boolean;
  useDesktopInspector: boolean;
  mapRef: RefObject<MapLibreMap | null>;
  queryZoom: number;
}

export interface UseWarMapInteractionResult {
  /** 当前选中对象的 Inspector 解析结果。 */
  selectedInspector: SelectedInspector | null;
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
  /** 安全外链打开（新闻原文；非 http(s) 链接弹警告）。 */
  openNewsLink: (url?: string | null) => void;
  /** standalone Legend 按钮滚动定位到 dock。 */
  scrollLegendDockIntoView: () => void;
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
 * - 选中/hover/legend focus 状态、选中键 → Inspector 内容解析
 *   （resolveWarMapSelectedInspector）与 Inspector 开合（含桌面最小化）；
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
    points,
    overlayRailRef,
    legendDockRef,
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

  // 选中解析输入（memo 保持引用稳定，避免每渲染重算 Inspector 解析）
  const selectionInput = useMemo<WarMapSelectionInput>(
    () => ({
      clusteredEvents: points.clusteredEvents,
      clusteredNews: points.clusteredNews,
      rawEvents: points.rawEvents,
      rawNewsMarkers: points.rawNewsMarkers,
      transportSelections: points.transportSelections,
    }),
    [points],
  );

  // 选中键 → Inspector 内容解析（选中数据失效时由下方 effect 清理键）
  const selectedInspector = useMemo<SelectedInspector | null>(
    () =>
      resolveWarMapSelectedInspector({
        ...selectionInput,
        selectedInspectorKey,
      }),
    [selectedInspectorKey, selectionInput],
  );

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

  const scrollLegendDockIntoView = useCallback(() => {
    setOpenOverlayPanel(null);

    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        legendDockRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    }
  }, [legendDockRef]);

  const openNewsLink = useCallback(
    (url?: string | null) => {
      const safeUrl = typeof url === "string" ? safeHttpUrl(url) : null;
      if (!safeUrl) {
        toast.warning(t("dashboard.charts.warMap.missingNewsUrl"));
        return;
      }
      window.open(safeUrl, "_blank", "noopener,noreferrer");
    },
    [t],
  );

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
    selectedInspector,
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
    openNewsLink,
    scrollLegendDockIntoView,
    openOverlayPanel,
    setOpenOverlayPanel,
    controlsSection,
    setControlsSection,
    desktopInspectorMinimized,
    setDesktopInspectorMinimized,
  };
}
