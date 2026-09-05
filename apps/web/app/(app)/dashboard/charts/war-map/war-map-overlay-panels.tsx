"use client";

import type {
  WarMapLayerId,
  WarMapLayerVisibility,
  WarMapPreset,
  WarMapTimeRangePreset,
  WarMapTransportDetail,
} from "@modular/utils";
import { Drawer } from "antd";
import { type ReactNode, type RefObject } from "react";

import type { SupportedLocale } from "@/lib/i18n";

import type {
  WarMapInspectorSlice,
  WarMapLegendInteractionSlice,
  WarMapOverlayPanelSlice,
} from "./use-war-map-interaction";
import {
  WarMapControlsPanel,
  type WarMapControlsPanelTransportProps,
  WarMapLegendDock,
  WarMapLegendPanel,
} from "./war-map-controls-panel";
import { WarMapInspectorPanel } from "./war-map-inspector-panel";
import {
  OVERLAY_SURFACE_CLASS_NAME,
  type OverlayDensity,
  type WarMapLayoutVariant,
  type WarMapOverlayLayout,
  type WarMapOverlayViewModel,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";
import { WarMapOverlayRail } from "./war-map-overlay-rail";
import type {
  WarMapLegendItem,
  WarMapLegendSection,
} from "./war-map-symbols";
import {
  useWarMapViewOptions,
  WarMapLayerVisibilityControls,
} from "./war-map-view-controls";

/**
 * Controls 面板 transport 契约输入：领域对象（flights/ais/analysis），
 * legend 打开命令由本 hook 依据布局（standalone dock vs overlay 面板）装配。
 */
export type WarMapOverlayPanelsTransportInput = Omit<
  WarMapControlsPanelTransportProps,
  "legend"
>;

/** Overlay 组合层消费的交互切片（legend/inspector/overlay 面板）。 */
export interface WarMapOverlayPanelsInteraction {
  legend: WarMapLegendInteractionSlice;
  inspector: WarMapInspectorSlice;
  overlayPanel: WarMapOverlayPanelSlice;
}

export interface UseWarMapOverlayPanelsOptions {
  t: WarMapTranslateFn;
  locale: SupportedLocale;
  overlayRailRef: RefObject<HTMLDivElement | null>;
  layoutVariant?: WarMapLayoutVariant;
  standaloneLayout: boolean;
  useDrawerControls: boolean;
  useDesktopInspector: boolean;
  overlayDensity: OverlayDensity;
  interaction: WarMapOverlayPanelsInteraction;
  overlayViewModel: WarMapOverlayViewModel;
  overlayLayout: WarMapOverlayLayout;
  legend: {
    sections: WarMapLegendSection[];
    interactionItems: WarMapLegendItem[];
    quickItems: WarMapLegendItem[];
  };
  viewControls: {
    t: WarMapTranslateFn;
    activePreset: WarMapPreset;
    timeRangePreset: WarMapTimeRangePreset;
    onPresetSelect: (preset: WarMapPreset) => void;
    onTimeRangeSelect: (preset: WarMapTimeRangePreset) => void;
    onResetLayers: () => void;
    displayableLayerIds: WarMapLayerId[];
    layerVisibility: WarMapLayerVisibility;
    monitorsCount: number;
    onLayerVisible: (layerId: WarMapLayerId, visible: boolean) => void;
  };
  transport: WarMapOverlayPanelsTransportInput;
  inspector: {
    transportDetail:
      | WarMapTransportDetail
      | null;
    transportDetailLoading: boolean;
  };
  windowLabel: string;
  status: {
    refreshingMapData: boolean;
    onRefresh: () => void;
  };
}

export interface UseWarMapOverlayPanelsResult {
  overlayRail: ReactNode;
  inspectorPanel: ReactNode;
  bottomDrawer: ReactNode;
  legendDockContent: ReactNode;
}

/**
 * Overlay 面板组合域（FE-批4A）：Controls/Legend/Inspector/Drawer 的
 * 内容装配与桌面包装。编排层传入 view-model、transport 领域对象与
 * 交互切片（legend/inspector/overlay 面板），本 hook 返回可直接放入
 * Map surface 槽位的 ReactNode；仅暴露根组件实际消费的四个槽位，
 * controls/legend 面板内容、桌面包装与抽屉高度为内部装配。
 */
export function useWarMapOverlayPanels(
  options: UseWarMapOverlayPanelsOptions,
): UseWarMapOverlayPanelsResult {
  const {
    t,
    locale,
    overlayRailRef,
    layoutVariant,
    standaloneLayout,
    useDrawerControls,
    useDesktopInspector,
    overlayDensity,
    interaction,
    overlayViewModel,
    overlayLayout,
    legend,
    viewControls,
    transport,
    inspector,
    windowLabel,
    status,
  } = options;

  const activeControlsSection =
    interaction.overlayPanel.controlsSection === "overview"
      ? "view"
      : interaction.overlayPanel.controlsSection;
  // transport 领域对象整体下传；legend 打开命令按布局装配：
  // standalone 滚动定位 dock，embedded/overlay 打开 legend 面板
  const transportPanelProps: WarMapControlsPanelTransportProps = {
    ...transport,
    legend: {
      onOpen: () => {
        if (standaloneLayout) {
          interaction.legend.scrollLegendDockIntoView();
          return;
        }
        interaction.overlayPanel.setOpenOverlayPanel("legend");
      },
    },
  };
  const { presetOptions, timeRangeOptions } = useWarMapViewOptions({
    t: viewControls.t,
    activePreset: viewControls.activePreset,
    timeRangePreset: viewControls.timeRangePreset,
  });
  const layerVisibilityControls = (
    <WarMapLayerVisibilityControls
      displayableLayerIds={viewControls.displayableLayerIds}
      layerVisibility={viewControls.layerVisibility}
      monitorsCount={viewControls.monitorsCount}
      onLayerVisible={viewControls.onLayerVisible}
      t={viewControls.t}
    />
  );
  const controlsPanelContent: ReactNode = (
    <WarMapControlsPanel
      layoutVariant={layoutVariant}
      controlsSection={activeControlsSection}
      controlsSectionMeta={overlayViewModel.controlsSectionMeta}
      controlsTabs={overlayViewModel.controlsTabs}
      useDrawerControls={useDrawerControls}
      overlayPanelMaxHeight={overlayLayout.overlayPanelMaxHeight}
      overviewMetricCards={overlayViewModel.overviewMetricCards}
      summaryStatusCards={overlayViewModel.summaryStatusCards}
      summaryDataLabel={overlayViewModel.summaryDataLabel}
      overviewDataTagLabel={overlayViewModel.overviewDataTagLabel}
      windowLabel={windowLabel}
      feedSummaryCards={overlayViewModel.feedSummaryCards}
      detailedChainStatuses={overlayViewModel.detailedChainStatuses}
      legendSections={legend.sections}
      interactionLegendItems={legend.interactionItems}
      view={{
        presets: presetOptions,
        timeRanges: timeRangeOptions,
        layerVisibilityControls,
        onPresetSelect: viewControls.onPresetSelect,
        onTimeRangeSelect: viewControls.onTimeRangeSelect,
        onResetLayers: viewControls.onResetLayers,
      }}
      transport={transportPanelProps}
      activeLegendKey={interaction.legend.focusedLegendItemKey}
      highlightedLegendKey={interaction.legend.highlightedLegendItemKey}
      onLegendItemHover={interaction.legend.updateHoveredLegendItemKey}
      onLegendItemFocus={interaction.legend.updateFocusedLegendItemKey}
      onControlsSectionChange={interaction.overlayPanel.setControlsSection}
      onClose={() => interaction.overlayPanel.setOpenOverlayPanel(null)}
      t={t}
    />
  );
  const desktopControlsPanel = (
    <div
      className={`${OVERLAY_SURFACE_CLASS_NAME} pointer-events-auto self-end overflow-hidden`}
      style={{
        width: overlayLayout.controlsPanelWidth,
        maxHeight: overlayLayout.overlayPanelMaxHeight,
      }}
    >
      {controlsPanelContent}
    </div>
  );
  const legendPanelContent: ReactNode = (
    <WarMapLegendPanel
      legendSections={legend.sections}
      interactionLegendItems={legend.interactionItems}
      summaryDataLabel={overlayViewModel.summaryDataLabel}
      activeLegendKey={interaction.legend.focusedLegendItemKey}
      highlightedLegendKey={interaction.legend.highlightedLegendItemKey}
      onLegendItemHover={interaction.legend.updateHoveredLegendItemKey}
      onLegendItemFocus={interaction.legend.updateFocusedLegendItemKey}
      onClose={() => interaction.overlayPanel.setOpenOverlayPanel(null)}
      t={t}
    />
  );
  const legendDockContent: ReactNode = (
    <WarMapLegendDock
      legendSections={legend.sections}
      interactionLegendItems={legend.interactionItems}
      summaryDataLabel={overlayViewModel.summaryDataLabel}
      activeLegendKey={interaction.legend.focusedLegendItemKey}
      highlightedLegendKey={interaction.legend.highlightedLegendItemKey}
      onLegendItemHover={interaction.legend.updateHoveredLegendItemKey}
      onLegendItemFocus={interaction.legend.updateFocusedLegendItemKey}
      t={t}
    />
  );
  const desktopLegendPanel = (
    <div
      className={`${OVERLAY_SURFACE_CLASS_NAME} pointer-events-auto self-end overflow-hidden`}
      style={{
        width: overlayLayout.legendPanelWidth,
        maxHeight: overlayLayout.overlayPanelMaxHeight,
      }}
    >
      {legendPanelContent}
    </div>
  );
  const overlayRail: ReactNode = (
    <WarMapOverlayRail
      overlayRailRef={overlayRailRef}
      layout={{
        density: overlayDensity,
        variant: layoutVariant,
        topClassName: overlayLayout.overlayTopClassName,
        railWidth: overlayLayout.overlayRailWidth,
        useDrawerControls,
        showActionLabels: overlayLayout.showActionLabels,
        openPanel: interaction.overlayPanel.openOverlayPanel,
      }}
      summary={{
        statusCards: overlayViewModel.summaryStatusCards,
        dataLabel: overlayViewModel.summaryDataLabel,
      }}
      refreshing={status.refreshingMapData}
      quickLegend={{
        items: legend.quickItems,
        activeKey: interaction.legend.focusedLegendItemKey,
        highlightedKey: interaction.legend.highlightedLegendItemKey,
        onItemHover: interaction.legend.updateHoveredLegendItemKey,
        onItemFocus: interaction.legend.updateFocusedLegendItemKey,
      }}
      actions={{
        onRefresh: status.onRefresh,
        onToggleControls: () => {
          if (interaction.overlayPanel.controlsSection === "legend") {
            interaction.overlayPanel.setControlsSection("view");
          }
          interaction.overlayPanel.setOpenOverlayPanel((current) =>
            current === "controls" ? null : "controls",
          );
        },
        onToggleLegend: () => {
          if (standaloneLayout) {
            interaction.legend.scrollLegendDockIntoView();
            return;
          }
          interaction.overlayPanel.setOpenOverlayPanel((current) =>
            current === "legend" ? null : "legend",
          );
        },
      }}
      panels={{
        controls: desktopControlsPanel,
        legend: desktopLegendPanel,
      }}
      t={t}
    />
  );
  const inspectorPanel: ReactNode = (
    <WarMapInspectorPanel
      selectedInspector={interaction.inspector.selectedInspector}
      transportDetail={inspector.transportDetail}
      transportDetailLoading={inspector.transportDetailLoading}
      useDesktopInspector={useDesktopInspector}
      desktopInspectorMinimized={interaction.inspector.desktopInspectorMinimized}
      inspectorPanelWidth={overlayLayout.inspectorPanelWidth}
      inspectorPanelHeight={overlayLayout.inspectorPanelHeight}
      locale={locale}
      onZoomToSelectedInspector={interaction.inspector.zoomToSelectedInspector}
      onMinimizeInspector={() =>
        interaction.inspector.setDesktopInspectorMinimized(true)
      }
      onExpandInspector={() =>
        interaction.inspector.setDesktopInspectorMinimized(false)
      }
      onCloseInspector={interaction.inspector.closeSelectedInspector}
      onOpenNewsLink={interaction.inspector.openNewsLink}
      t={t}
    />
  );
  const mobileControlsDrawerHeight = `min(${overlayLayout.controlsDrawerHeight}px, calc(100dvh - 72px))`;
  const standaloneControlsDrawerHeight = `min(${overlayLayout.standaloneDrawerHeight}px, calc(100dvh - 96px))`;
  const useBottomDrawer = standaloneLayout || useDrawerControls;
  const bottomDrawer: ReactNode = useBottomDrawer ? (
    <Drawer
      open={
        standaloneLayout
          ? interaction.overlayPanel.openOverlayPanel === "controls"
          : Boolean(interaction.overlayPanel.openOverlayPanel)
      }
      onClose={() => interaction.overlayPanel.setOpenOverlayPanel(null)}
      placement="bottom"
      height={
        standaloneLayout
          ? standaloneControlsDrawerHeight
          : mobileControlsDrawerHeight
      }
      closable={false}
      destroyOnClose={false}
      getContainer={standaloneLayout ? false : undefined}
      rootStyle={standaloneLayout ? { position: "absolute" } : undefined}
      styles={{ body: { padding: 0 } }}
    >
      {interaction.overlayPanel.openOverlayPanel === "legend" && !standaloneLayout
        ? legendPanelContent
        : controlsPanelContent}
    </Drawer>
  ) : null;

  return {
    overlayRail,
    inspectorPanel,
    bottomDrawer,
    legendDockContent,
  };
}
