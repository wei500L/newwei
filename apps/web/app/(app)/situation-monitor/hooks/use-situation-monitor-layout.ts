"use client";

import { Grid } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Layout } from "react-grid-layout";
import { useTranslation } from "react-i18next";

import {
  SITUATION_MONITOR_PANELS,
  SITUATION_MONITOR_PRESETS,
  type SituationMonitorPanelId,
  useSituationMonitorLayoutStore,
} from "@/store/situation-monitor-layout";
import { useSituationMonitorSettingsStore } from "@/store/situation-monitor-settings";

import {
  buildPackedResponsiveLayout,
  getDefaultPanelLayoutForBreakpoint,
  GRID_COLS,
  GRID_LAYOUT_METRICS,
  stabilizeDesktopDragLayout,
  type GridBreakpoint,
} from "../utils/layout-grid";
import {
  filterVisibleLayoutItems,
  isVisibilityMatchingPreset,
  mergePanelLayouts,
  stretchCorrelationToMonitorArea,
} from "../utils/situation-monitor-format";

export function useSituationMonitorLayout() {
  const { t } = useTranslation();
  const screens = Grid.useBreakpoint();

  const layout = useSituationMonitorLayoutStore((state) => state.layout);
  const responsiveLayouts = useSituationMonitorLayoutStore(
    (state) => state.layouts,
  );
  const visibility = useSituationMonitorLayoutStore(
    (state) => state.visibility,
  );
  const setLayout = useSituationMonitorLayoutStore((state) => state.setLayout);
  const setPanelVisible = useSituationMonitorLayoutStore(
    (state) => state.setPanelVisible,
  );
  const applyPreset = useSituationMonitorLayoutStore(
    (state) => state.applyPreset,
  );
  const resetPanels = useSituationMonitorLayoutStore((state) => state.reset);
  const ensurePanels = useSituationMonitorLayoutStore((state) => state.ensure);

  const [panelsOpen, setPanelsOpen] = useState(false);
  const resetLayoutOnPreset = useSituationMonitorSettingsStore(
    (state) => state.resetLayoutOnPreset,
  );
  const setResetLayoutOnPreset = useSituationMonitorSettingsStore(
    (state) => state.setResetLayoutOnPreset,
  );

  const activePreset = useMemo(() => {
    return (
      SITUATION_MONITOR_PRESETS.find((preset) =>
        isVisibilityMatchingPreset(visibility, preset.panels),
      ) ?? null
    );
  }, [visibility]);

  useEffect(() => {
    ensurePanels();
  }, [ensurePanels]);

  const visiblePanels = useMemo(
    () => SITUATION_MONITOR_PANELS.filter((panel) => visibility[panel.id]),
    [visibility],
  );

  const resolvedLayouts = useMemo(
    () => ({
      lg: layout.map((item) => ({ ...item })),
      md: mergePanelLayouts(
        buildPackedResponsiveLayout(layout, "md"),
        responsiveLayouts.md ?? [],
      ),
      sm: mergePanelLayouts(
        buildPackedResponsiveLayout(layout, "sm"),
        responsiveLayouts.sm ?? [],
      ),
      xs: mergePanelLayouts(
        buildPackedResponsiveLayout(layout, "xs"),
        responsiveLayouts.xs ?? [],
      ),
      xxs: mergePanelLayouts(
        buildPackedResponsiveLayout(layout, "xxs"),
        responsiveLayouts.xxs ?? [],
      ),
    }),
    [layout, responsiveLayouts],
  );

  const visibleLayout = useMemo(
    () =>
      stretchCorrelationToMonitorArea(
        filterVisibleLayoutItems(resolvedLayouts.lg, visibility),
      ),
    [resolvedLayouts.lg, visibility],
  );

  const inferredGridBreakpoint = useMemo<GridBreakpoint>(() => {
    if (screens.lg) {
      return "lg";
    }
    if (screens.md) {
      return "md";
    }
    if (screens.sm) {
      return "sm";
    }
    if (screens.xs) {
      return "xs";
    }
    return "xxs";
  }, [screens.lg, screens.md, screens.sm, screens.xs]);

  const [gridBreakpoint, setGridBreakpoint] = useState<GridBreakpoint>(
    inferredGridBreakpoint,
  );
  const [desktopLayoutEdit, setDesktopLayoutEdit] = useState(false);

  useEffect(() => {
    setGridBreakpoint(inferredGridBreakpoint);
  }, [inferredGridBreakpoint]);

  const isCompactGrid =
    gridBreakpoint === "sm" ||
    gridBreakpoint === "xs" ||
    gridBreakpoint === "xxs";
  const [compactLayoutEdit, setCompactLayoutEdit] = useState(false);
  const [layoutPreviewItem, setLayoutPreviewItem] = useState<Layout | null>(
    null,
  );

  useEffect(() => {
    if (!isCompactGrid) {
      setCompactLayoutEdit(false);
    }
  }, [isCompactGrid]);

  useEffect(() => {
    if (isCompactGrid) {
      setDesktopLayoutEdit(false);
    }
  }, [isCompactGrid]);

  useEffect(() => {
    setLayoutPreviewItem(null);
  }, [gridBreakpoint]);

  const handleGridBreakpointChange = useCallback((next: string) => {
    if (next in GRID_COLS) {
      const breakpoint = next as GridBreakpoint;
      setGridBreakpoint(breakpoint);
    }
  }, []);

  const canEditLayout = isCompactGrid ? compactLayoutEdit : desktopLayoutEdit;
  const toggleLayoutEdit = useCallback(() => {
    if (isCompactGrid) {
      setCompactLayoutEdit((prev) => !prev);
      return;
    }
    setDesktopLayoutEdit((prev) => !prev);
  }, [isCompactGrid]);

  const gridMetrics = GRID_LAYOUT_METRICS[gridBreakpoint];
  const gridMargin = gridMetrics.margin;

  useEffect(() => {
    if (!canEditLayout) {
      setLayoutPreviewItem(null);
    }
  }, [canEditLayout]);

  const gridLayouts = useMemo(
    () => ({
      lg: visibleLayout.map((item) => ({ ...item })),
      md: mergePanelLayouts(
        buildPackedResponsiveLayout(visibleLayout, "md"),
        filterVisibleLayoutItems(resolvedLayouts.md, visibility),
      ),
      sm: mergePanelLayouts(
        buildPackedResponsiveLayout(visibleLayout, "sm"),
        filterVisibleLayoutItems(resolvedLayouts.sm, visibility),
      ),
      xs: mergePanelLayouts(
        buildPackedResponsiveLayout(visibleLayout, "xs"),
        filterVisibleLayoutItems(resolvedLayouts.xs, visibility),
      ),
      xxs: mergePanelLayouts(
        buildPackedResponsiveLayout(visibleLayout, "xxs"),
        filterVisibleLayoutItems(resolvedLayouts.xxs, visibility),
      ),
    }),
    [
      resolvedLayouts.md,
      resolvedLayouts.sm,
      resolvedLayouts.xs,
      resolvedLayouts.xxs,
      visibility,
      visibleLayout,
    ],
  );

  const activeGridLayout = useMemo(() => {
    const baseLayout = gridLayouts[gridBreakpoint] ?? gridLayouts.lg ?? [];
    return layoutPreviewItem
      ? mergePanelLayouts(baseLayout, [layoutPreviewItem])
      : baseLayout;
  }, [gridBreakpoint, gridLayouts, layoutPreviewItem]);

  const activeGridLayoutMap = useMemo(
    () => new Map(activeGridLayout.map((item) => [item.i, item])),
    [activeGridLayout],
  );

  const handleLayoutChange = useCallback(
    (nextLayout: Layout[], options?: { source?: "drag" | "resize" }) => {
      const currentLayout =
        resolvedLayouts[gridBreakpoint] ?? resolvedLayouts.lg;
      const currentVisibleLayout = filterVisibleLayoutItems(
        currentLayout,
        visibility,
      );
      const nextVisibleLayout = mergePanelLayouts(
        currentVisibleLayout,
        nextLayout,
      );
      const stabilizedVisibleLayout =
        options?.source === "drag" && gridBreakpoint === "lg"
          ? stabilizeDesktopDragLayout(currentVisibleLayout, nextVisibleLayout)
          : nextVisibleLayout;

      setLayout(
        mergePanelLayouts(currentLayout, stabilizedVisibleLayout),
        gridBreakpoint,
      );
      setLayoutPreviewItem(null);
    },
    [gridBreakpoint, resolvedLayouts, setLayout, visibility],
  );

  const handleResetPanelSize = useCallback(
    (panelId: SituationMonitorPanelId) => {
      const defaultLayout = getDefaultPanelLayoutForBreakpoint(
        panelId,
        gridBreakpoint,
      );
      if (!defaultLayout) {
        return;
      }

      const currentLayout =
        resolvedLayouts[gridBreakpoint] ?? resolvedLayouts.lg;
      const currentPanelLayout = currentLayout.find(
        (item) => item.i === panelId,
      );
      if (!currentPanelLayout) {
        return;
      }

      const nextLayoutItem: Layout = {
        ...currentPanelLayout,
        w: defaultLayout.w,
        h: defaultLayout.h,
        minW: defaultLayout.minW,
        minH: defaultLayout.minH,
        maxW: defaultLayout.maxW,
        maxH: defaultLayout.maxH,
      };

      if (
        typeof nextLayoutItem.x === "number" &&
        nextLayoutItem.x + nextLayoutItem.w > GRID_COLS[gridBreakpoint]
      ) {
        nextLayoutItem.x = Math.max(
          0,
          GRID_COLS[gridBreakpoint] - nextLayoutItem.w,
        );
      }

      setLayout(
        mergePanelLayouts(currentLayout, [nextLayoutItem]),
        gridBreakpoint,
      );
      setLayoutPreviewItem(null);
    },
    [gridBreakpoint, resolvedLayouts, setLayout],
  );

  const layoutHint = canEditLayout
    ? t("situationMonitor.panels.hint")
    : isCompactGrid
      ? t("situationMonitor.panels.hintCompact")
      : t("situationMonitor.panels.hintDesktop");

  const gridClassName = [
    "layout",
    "sm-layout-grid",
    isCompactGrid ? "sm-layout-grid--compact" : null,
    canEditLayout ? "sm-layout-grid--editing" : "sm-layout-grid--readonly",
  ]
    .filter(Boolean)
    .join(" ");


  return {
    screens,
    layout,
    visibility,
    setPanelVisible,
    applyPreset,
    resetPanels,
    panelsOpen,
    setPanelsOpen,
    resetLayoutOnPreset,
    setResetLayoutOnPreset,
    activePreset,
    visiblePanels,
    gridBreakpoint,
    isCompactGrid,
    canEditLayout,
    toggleLayoutEdit,
    gridMetrics,
    gridMargin,
    gridLayouts,
    gridClassName,
    activeGridLayoutMap,
    layoutPreviewItem,
    setLayoutPreviewItem,
    handleGridBreakpointChange,
    handleLayoutChange,
    handleResetPanelSize,
    layoutHint,
  };
}
