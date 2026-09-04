"use client";

import { WAR_MAP_LAYER_IDS } from "@modular/utils";
import { Grid } from "antd";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useRequestGeoTransportMutation } from "@/graphql/generated";
import { usePendingAction } from "@/hooks/use-pending-action";
import { createApiClient } from "@/lib/api-client";
import { resolveLocale } from "@/lib/i18n";
import { useWarMapSettingsStore } from "@/store/war-map-settings";

import { useDashboardStream } from "../../use-dashboard-stream";

import { useWarMapAnalyzeCurrentView } from "./use-war-map-analyze";
import { useWarMapContainer } from "./use-war-map-container";
import { useWarMapData } from "./use-war-map-data";
import { useWarMapInteraction } from "./use-war-map-interaction";
import { useWarMapLayers } from "./use-war-map-layers";
import { useWarMapOverlayContent } from "./use-war-map-overlay-content";
import { useWarMapPoints } from "./use-war-map-points";
import { useWarMapQueryState } from "./use-war-map-query-state";
import {
  useWarMapRuntime,
  type WarMapViewportSync,
} from "./use-war-map-runtime";
import { useWarMapStatusPresentation } from "./use-war-map-status-presentation";
import { useWarMapTransportDetail } from "./use-war-map-transport-detail";
import { useWarMapUrlState } from "./use-war-map-url-state";
import { WAR_MAP_UNSUPPORTED_LAYER_IDS } from "./war-map-data";
import { resolveWarMapContainerClassName } from "./war-map-layout";
import { buildWarMapLoadOverlayState } from "./war-map-load-state";
import {
  WarMapMapSurface,
  WarMapPreparingSurface,
} from "./war-map-map-surface";
import {
  OVERLAY_SURFACE_CLASS_NAME,
  resolveOverlayDensity,
} from "./war-map-overlay-model";
import { useWarMapOverlayPanels } from "./war-map-overlay-panels";
import type { WarMapProps } from "./war-map-props";
import { WarMapAisViewportEmptyBanner } from "./war-map-view-controls";

export type { WarMapProps } from "./war-map-props";

const DISPLAYABLE_WAR_MAP_LAYER_IDS = WAR_MAP_LAYER_IDS.filter(
  (layerId) => !WAR_MAP_UNSUPPORTED_LAYER_IDS.has(layerId),
);

export function WarMap({
  className,
  layoutVariant = "embedded",
  translateTarget,
  streamState,
  onEffectiveRangeChange,
  onRealtimeQueryChange,
}: WarMapProps = {}) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const screens = Grid.useBreakpoint();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canRunAnalysis = permissions.includes("analysis.run");
  const [requestGeoTransport, { loading: submittingGeoTransport }] =
    useRequestGeoTransportMutation();


  const overlayRailRef = useRef<HTMLDivElement | null>(null);
  const legendDockRef = useRef<HTMLDivElement | null>(null);
  // 容器观测域：inView / wrapper 尺寸 / renderable 门禁（单一所有者）
  const {
    wrapperRef,
    mapContainerRef,
    inView,
    wrapperSize,
    hasRenderableMapContainer,
  } = useWarMapContainer();
  const overlayDensity = useMemo(
    () => resolveOverlayDensity(wrapperSize.width, wrapperSize.height),
    [wrapperSize.height, wrapperSize.width],
  );
  const standaloneLayout = layoutVariant === "standalone";
  const useDrawerControls = overlayDensity === "minimal";
  const useDesktopInspector = Boolean(
    screens.lg && overlayDensity !== "minimal",
  );

  // URL 与设置域：hydration 一次 + 防抖写回 + effective 合并（单一所有者）
  const { urlHydrated, effectiveViewState, effectiveTimeRangePreset } =
    useWarMapUrlState();

  const layerVisibility = useWarMapSettingsStore((s) => s.layerVisibility);
  const activePreset = useWarMapSettingsStore((s) => s.activePreset);
  const timeRangePreset = useWarMapSettingsStore((s) => s.timeRangePreset);
  const flightMode = useWarMapSettingsStore((s) => s.flightMode);
  const aisMode = useWarMapSettingsStore((s) => s.aisMode);
  const aisHighlightCandidates = useWarMapSettingsStore(
    (s) => s.aisHighlightCandidates,
  );
  const setLayerVisible = useWarMapSettingsStore((s) => s.setLayerVisible);
  const setViewState = useWarMapSettingsStore((s) => s.setViewState);
  const setActivePreset = useWarMapSettingsStore((s) => s.setActivePreset);
  const setTimeRangePreset = useWarMapSettingsStore(
    (s) => s.setTimeRangePreset,
  );
  const setFlightMode = useWarMapSettingsStore((s) => s.setFlightMode);
  const setAisMode = useWarMapSettingsStore((s) => s.setAisMode);
  const setAisHighlightCandidates = useWarMapSettingsStore(
    (s) => s.setAisHighlightCandidates,
  );
  const resetLayers = useWarMapSettingsStore((s) => s.resetLayers);
  const effectiveAisMode = aisMode;

  const dataEnabled = Boolean(session?.accessToken && inView && urlHydrated);
  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  // 查询状态域：range anchor / effectiveRange / query viewport / 实时回调
  const {
    effectiveRange,
    queryViewport,
    queryZoom,
    queryBbox,
    localClusterBbox,
    setQueryViewport,
  } = useWarMapQueryState({
    effectiveViewState,
    effectiveTimeRangePreset,
    inView,
    translateTarget,
    flightMode,
    aisMode: effectiveAisMode,
    onEffectiveRangeChange,
    onRealtimeQueryChange,
  });

  // 地图运行时域：MapLibre/Deck 实例创建与销毁、load/error/retry、resize
  const handleViewportSync = useCallback(
    (sync: WarMapViewportSync) => {
      setViewState(sync.viewState);
      setQueryViewport(sync.viewport);
    },
    [setQueryViewport, setViewState],
  );
  const { mapRef, mapReady, mapLoadError, retryMapLoad, setOverlayProps } =
    useWarMapRuntime({
      mapContainerRef,
      inView,
      hasRenderableMapContainer,
      targetViewState: effectiveViewState,
      onViewportSync: handleViewportSync,
    });

  const { eventsQuery, newsQuery, layersQuery, monitorsQuery } = useWarMapData({
    apiClient,
    enabled: dataEnabled,
    start: effectiveRange.start.toISOString(),
    end: effectiveRange.end.toISOString(),
    translateTarget,
    bbox: queryBbox,
    zoom: queryZoom,
    flightMode,
    aisMode: effectiveAisMode,
  });
  const internalStreamState = useDashboardStream({
    accessToken: session?.accessToken,
    start: effectiveRange.start,
    end: effectiveRange.end,
    warMapStart: effectiveRange.start,
    warMapEnd: effectiveRange.end,
    warMapBBox: queryBbox,
    warMapZoom: queryZoom,
    warMapTranslateTarget: translateTarget,
    warMapFlightMode: flightMode,
    warMapAisMode: effectiveAisMode,
    enabled: !streamState && dataEnabled,
  });
  const resolvedStreamState = streamState ?? internalStreamState;

  // 点位派生域：查询数据 → 点位/聚类/运输选择（不含图层构造）
  const pointsResult = useWarMapPoints({
    monitors,
    events: eventsQuery.data?.events,
    newsMarkers: newsQuery.data?.markers,
    layersData: layersQuery.data?.layers,
    translateTarget,
    queryZoom,
    localClusterBbox,
  });

  // 交互与选择域：选中/hover/legend focus、overlay 面板、Inspector 开合
  const interactionResult = useWarMapInteraction({
    t,
    points: pointsResult,
    overlayRailRef,
    legendDockRef,
    useDrawerControls,
    useDesktopInspector,
    mapRef,
    queryZoom,
  });
  const {
    selectedInspector,
    focusedLegendItemKey,
    hoveredLegendItemKey,
    updateHoveredLegendItemKey,
    updateFocusedLegendItemKey,
  } = interactionResult;

  const transportDetailQuery = useWarMapTransportDetail({
    apiClient,
    selectedInspector,
    effectiveRange,
  });

  const handleAnalyzeCurrentView = useWarMapAnalyzeCurrentView({
    t,
    canRunAnalysis,
    layerVisibility,
    effectiveRange,
    queryViewportBbox: queryViewport.bbox,
    requestGeoTransport,
  });

  // 图层编排域：点位 + 交互 → Deck 图层集合 + overlay props 应用
  const {
    deckData,
    aisHighlightedCandidateCount,
    activePointLayers,
  } = useWarMapLayers({
    t,
    locale,
    flightMode,
    effectiveAisMode,
    aisHighlightCandidates,
    layerVisibility,
    layersData: layersQuery.data?.layers,
    queryZoom,
    localClusterBbox,
    translateTarget,
    points: pointsResult,
    interaction: interactionResult,
    setOverlayProps,
    hasRenderableContainer: hasRenderableMapContainer,
  });

  const anyLoading =
    eventsQuery.isLoading ||
    newsQuery.isLoading ||
    layersQuery.isLoading ||
    monitorsQuery.isLoading;
  const anyFetching =
    eventsQuery.isFetching ||
    newsQuery.isFetching ||
    layersQuery.isFetching ||
    monitorsQuery.isFetching;
  const errors = [
    eventsQuery.error,
    newsQuery.error,
    layersQuery.error,
    monitorsQuery.error,
  ].filter(Boolean);
  const { pending: refreshingMapData, run: refreshMapData } = usePendingAction(
    async () => {
      await Promise.all([
        eventsQuery.refetch(),
        newsQuery.refetch(),
        layersQuery.refetch(),
        monitorsQuery.refetch(),
      ]);
    },
  );
  // 状态展示域：顶部状态摘要、航班/AIS 摘要、运输 legend 状态、窗口标签
  const {
    statusSummary,
    flightsPresentation,
    aisPresentation,
    transportLegendState,
    windowLabel,
  } = useWarMapStatusPresentation({
    t,
    locale,
    effectiveRange,
    layerVisibility,
    aisMode,
    effectiveAisMode,
    aisHighlightCandidates,
    aisHighlightedCandidateCount,
    streamState: resolvedStreamState,
    anyFetching,
    queries: {
      eventsQuery,
      newsQuery,
      layersQuery,
      monitorsQuery,
    },
  });

  const loadOverlayState = buildWarMapLoadOverlayState({
    deckCounts: deckData,
    monitorsVisible: layerVisibility.monitors,
    monitorPointsCount: pointsResult.monitorPoints.length,
    mapLoadError,
    mapReady,
    anyLoading,
    errors,
    refreshingMapData,
    retryMapLoad,
    refreshMapData: () => void refreshMapData(),
    t,
  });
  const {
    showBootOverlay,
    bootOverlayLabel,
    hasData,
    fatalOverlay,
    hasFatalOverlay,
    hasNonFatalDataError,
  } = loadOverlayState;

  // overlay 内容域：布局度量、顶部/概览 view model、legend 条目集合
  const {
    overlayLayout,
    overlayViewModel,
    quickLegendItems,
    interactionLegendItems,
    legendSections,
    legendItemsByKey,
  } = useWarMapOverlayContent({
    t,
    wrapperSize,
    overlayDensity,
    hasNonFatalDataError,
    layoutVariant,
    statusSummary,
    streamError: resolvedStreamState.error ?? null,
    pointsResult: {
      rawEventsCount: pointsResult.rawEvents.length,
      rawNewsMarkersCount: pointsResult.rawNewsMarkers.length,
      monitorPointsCount: pointsResult.monitorPoints.length,
    },
    monitorsCount: monitors.length,
    legend: {
      layerVisibility,
      effectiveAisMode,
      transportLegendState,
      activePointLayers,
    },
  });

  // legend focus/hover 键失效清理（依赖 legend 索引，留在编排层避免依赖环）
  useEffect(() => {
    if (focusedLegendItemKey && !legendItemsByKey.has(focusedLegendItemKey)) {
      updateFocusedLegendItemKey(null);
    }
    if (hoveredLegendItemKey && !legendItemsByKey.has(hoveredLegendItemKey)) {
      updateHoveredLegendItemKey(null);
    }
  }, [
    focusedLegendItemKey,
    hoveredLegendItemKey,
    legendItemsByKey,
    updateFocusedLegendItemKey,
    updateHoveredLegendItemKey,
  ]);

  const transportInput = {
    flightMode,
    onFlightModeChange: setFlightMode,
    aisMode,
    effectiveAisMode,
    onAisModeChange: setAisMode,
    aisHighlightCandidates,
    onAisHighlightCandidatesChange: setAisHighlightCandidates,
    flightsLayerVisible: layerVisibility.flights,
    aisLayerVisible: layerVisibility.ais,
    flightsPresentation,
    aisPresentation,
    aisHighlightedCandidateCount,
    canRunAnalysis,
    analyzingCurrentView: submittingGeoTransport,
    onAnalyzeCurrentView: () => void handleAnalyzeCurrentView(),
  };

  // Overlay 面板组合域：rail / Inspector / Drawer / 桌面面板内容装配
  const panels = useWarMapOverlayPanels({
    t,
    locale,
    overlayRailRef,
    layoutVariant,
    standaloneLayout,
    useDrawerControls,
    useDesktopInspector,
    overlayDensity,
    interaction: interactionResult,
    overlayViewModel,
    overlayLayout,
    legend: {
      sections: legendSections,
      interactionItems: interactionLegendItems,
      quickItems: quickLegendItems,
    },
    viewControls: {
      t,
      activePreset,
      timeRangePreset,
      onPresetSelect: setActivePreset,
      onTimeRangeSelect: setTimeRangePreset,
      onResetLayers: resetLayers,
      displayableLayerIds: DISPLAYABLE_WAR_MAP_LAYER_IDS,
      layerVisibility,
      monitorsCount: pointsResult.monitorPoints.length,
      onLayerVisible: setLayerVisible,
    },
    transport: transportInput,
    inspector: {
      transportDetail: transportDetailQuery.data?.detail ?? null,
      transportDetailLoading: transportDetailQuery.isLoading,
    },
    windowLabel,
    status: {
      refreshingMapData,
      onRefresh: () => {
        void refreshMapData();
      },
      scrollLegendDockIntoView,
    },
  });

  const containerClassName = standaloneLayout
    ? ["relative", className?.trim()].filter(Boolean).join(" ")
    : resolveWarMapContainerClassName(className);
  const mapViewportClassName = standaloneLayout
    ? "relative min-h-[24rem] h-[clamp(24rem,56dvh,38rem)] overflow-hidden rounded-[24px] md:h-[clamp(28rem,56dvh,38rem)] xl:h-[clamp(32rem,62dvh,44rem)]"
    : "relative h-full";

  if (!inView) {
    return (
      <WarMapPreparingSurface
        wrapperRef={wrapperRef}
        className={containerClassName}
        viewportClassName={mapViewportClassName}
        stacked={standaloneLayout}
        label={t("dashboard.charts.warMap.status.preparing")}
      />
    );
  }

  return (
    <div ref={wrapperRef} className={containerClassName}>
      <div className={standaloneLayout ? "flex flex-col gap-5" : "h-full"}>
        <WarMapMapSurface
          mapContainerRef={mapContainerRef}
          viewportClassName={mapViewportClassName}
          hasFatalOverlay={hasFatalOverlay}
          hasNonFatalDataError={hasNonFatalDataError}
          error={errors[0]}
          refreshingMapData={refreshingMapData}
          onRetry={() => void refreshMapData()}
          rail={panels.overlayRail}
          aisEmptyStateBanner={
            aisPresentation.aisViewportEmptyStateActive &&
            aisPresentation.aisViewportEmptyStateHint ? (
              <WarMapAisViewportEmptyBanner
                label={aisPresentation.aisViewportEmptyStateLabel ?? ""}
                hint={aisPresentation.aisViewportEmptyStateHint}
              />
            ) : null
          }
          inspector={panels.inspectorPanel}
          bottomDrawer={panels.bottomDrawer}
          showBootOverlay={showBootOverlay}
          bootOverlayLabel={bootOverlayLabel}
          showEmptyState={!anyLoading && !errors.length && !hasData && mapReady}
          emptyStateDescription={t("pages.map.empty")}
          fatalOverlay={fatalOverlay}
        />

        {standaloneLayout ? (
          <div ref={legendDockRef} className={OVERLAY_SURFACE_CLASS_NAME}>
            {panels.legendDockContent}
          </div>
        ) : null}
      </div>
    </div>
  );
}
