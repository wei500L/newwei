"use client";

import type {
  WarMapAisMode,
  WarMapFlightMode,
  WarMapPreset,
  WarMapTimeRangePreset,
  WarMapTransportDetail,
} from "@modular/utils";
import { Drawer } from "antd";
import {
  useMemo,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";

import type { SupportedLocale } from "@/lib/i18n";

import {
  WarMapControlsPanel,
  WarMapLegendDock,
  WarMapLegendPanel,
} from "./war-map-controls-panel";
import { WarMapInspectorPanel } from "./war-map-inspector-panel";
import {
  OVERLAY_SURFACE_CLASS_NAME,
  type OverlayControlsSection,
  type OverlayDensity,
  type OverlayPanelKey,
  type SelectedInspector,
  type WarMapLayoutVariant,
  type WarMapOverlayLayout,
  type WarMapOverlayViewModel,
  type WarMapTranslateFn,
} from "./war-map-overlay-model";
import { WarMapOverlayRail } from "./war-map-overlay-rail";
import type {
  WarMapAisSummaryPresentation,
  WarMapFlightsSummaryPresentation,
} from "./war-map-status-model";
import type {
  WarMapLegendItem,
  WarMapLegendSection,
} from "./war-map-symbols";

export interface WarMapTransportPanelPropsInput {
  flightMode: WarMapFlightMode;
  onFlightModeChange: (mode: WarMapFlightMode) => void;
  aisMode: WarMapAisMode;
  effectiveAisMode: WarMapAisMode;
  onAisModeChange: (mode: WarMapAisMode) => void;
  aisHighlightCandidates: boolean;
  onAisHighlightCandidatesChange: (enabled: boolean) => void;
  flightsLayerVisible: boolean;
  aisLayerVisible: boolean;
  flightsPresentation: WarMapFlightsSummaryPresentation;
  aisPresentation: WarMapAisSummaryPresentation;
  aisHighlightedCandidateCount: number | undefined;
  canRunAnalysis: boolean;
  analyzingCurrentView: boolean;
  onAnalyzeCurrentView: () => void;
  onOpenLegend: () => void;
}

/** Controls 面板 transport 区块 props 装配（FE-批4A：字段与迁移前一致）。 */
export function buildWarMapTransportPanelProps(
  input: WarMapTransportPanelPropsInput,
) {
  const { flightsPresentation: fl, aisPresentation: ais } = input;
  return {
    flightMode: input.flightMode,
    onFlightModeChange: input.onFlightModeChange,
    flightsLayerVisible: input.flightsLayerVisible,
    flightsSourceBadgeLabel: fl.flightsSourceBadgeLabel,
    flightsTooltipText: fl.flightsTooltipText,
    flightsReturnedCount: fl.flightsReturnedCount,
    flightsSnapshotCount: fl.flightsSnapshotCount,
    flightsRawLabel: fl.flightsRawLabel,
    flightsFreshness: fl.flightsFreshness,
    flightsTruncated: fl.flightsTruncated,
    aisLayerVisible: input.aisLayerVisible,
    aisMode: input.aisMode,
    aisEffectiveMode: input.effectiveAisMode,
    onAisModeChange: input.onAisModeChange,
    aisHighlightCandidates: input.aisHighlightCandidates,
    onAisHighlightCandidatesChange: input.onAisHighlightCandidatesChange,
    aisAllModeDegraded: ais.aisAllModeDegraded,
    aisAllModeDegradedLabel: ais.aisAllModeDegradedLabel,
    aisTooltipText: ais.aisTooltipText,
    aisStatusReason: ais.aisResolvedStatusReason ?? null,
    aisSourceStatusColor: ais.aisSourceStatusColor,
    aisSourceStatusLabel: ais.aisSourceStatusLabel,
    aisFreshness: ais.aisFreshness,
    aisModeLabel: ais.aisEffectiveModeLabel,
    aisRelayVesselCount: ais.aisRelayVesselCount,
    aisSnapshotRelative: ais.aisSnapshotRelative,
    aisSnapshotExact: ais.aisSnapshotExact,
    aisPrimaryCountValue: ais.aisPrimaryCountValue,
    aisPrimaryCountLabel: ais.aisPrimaryCountLabel,
    aisHighlightCountValue: input.aisHighlightedCandidateCount,
    aisHighlightCountLabel: ais.aisHighlightCountLabel,
    aisDisruptionsCount: ais.aisDisruptionsCount,
    aisViewportEmptyStateActive: ais.aisViewportEmptyStateActive,
    aisViewportEmptyStateLabel: ais.aisViewportEmptyStateLabel,
    aisViewportEmptyStateHint: ais.aisViewportEmptyStateHint,
    canAnalyzeCurrentView:
      input.canRunAnalysis && (input.flightsLayerVisible || input.aisLayerVisible),
    analyzingCurrentView: input.analyzingCurrentView,
    onAnalyzeCurrentView: input.onAnalyzeCurrentView,
    onOpenLegend: input.onOpenLegend,
  };
}

export interface WarMapOverlayPanelsInteraction {
  focusedLegendItemKey: string | null;
  highlightedLegendItemKey: string | null;
  updateHoveredLegendItemKey: (next: string | null) => void;
  updateFocusedLegendItemKey: (next: string | null) => void;
  controlsSection: OverlayControlsSection;
  setControlsSection: (section: OverlayControlsSection) => void;
  openOverlayPanel: OverlayPanelKey | null;
  setOpenOverlayPanel: Dispatch<SetStateAction<OverlayPanelKey | null>>;
  desktopInspectorMinimized: boolean;
  setDesktopInspectorMinimized: Dispatch<SetStateAction<boolean>>;
  closeSelectedInspector: () => void;
  zoomToSelectedInspector: () => void;
  openNewsLink: (url?: string | null) => void;
  selectedInspector: SelectedInspector;
}

export interface UseWarMapOverlayPanelsOptions {
  t: WarMapTranslateFn;
  locale: SupportedLocale;
  overlayRailRef: RefObject<HTMLDivElement | null>;
  layoutVariant?: WarMapLayoutVariant;
  standaloneLayout: boolean;
  useDrawerControls: boolean;
  useDesktopInspector: boolean;
  overlayDensity: import("./war-map-overlay-model").OverlayDensity;
  interaction: WarMapOverlayPanelsInteraction;
  overlayViewModel: WarMapOverlayViewModel;
  overlayLayout: WarMapOverlayLayout;
  legend: {
    sections: WarMapLegendSection[];
    interactionItems: WarMapLegendItem[];
    quickItems: WarMapLegendItem[];
  };
  view: {
    presets: { key: WarMapPreset; label: string; active: boolean }[];
    timeRanges: {
      key: WarMapTimeRangePreset;
      label: string;
      active: boolean;
    }[];
    layerVisibilityControls: ReactNode;
    onPresetSelect: (preset: WarMapPreset) => void;
    onTimeRangeSelect: (preset: WarMapTimeRangePreset) => void;
    onResetLayers: () => void;
  };
  transportPanelProps: ReturnType<typeof buildWarMapTransportPanelProps>;
  inspector: {
    transportDetail:
      | import("@modular/utils").WarMapTransportDetail
      | null;
    transportDetailLoading: boolean;
  };
  windowLabel: string;
  status: {
    refreshingMapData: boolean;
    onRefresh: () => void;
    scrollLegendDockIntoView: () => void;
  };
}

export interface UseWarMapOverlayPanelsResult {
  overlayRail: ReactNode;
  inspectorPanel: ReactNode;
  bottomDrawer: ReactNode;
  controlsPanelContent: ReactNode;
  legendPanelContent: ReactNode;
  legendDockContent: ReactNode;
  desktopControlsPanel: ReactNode;
  desktopLegendPanel: ReactNode;
  mobileControlsDrawerHeight: string;
  standaloneControlsDrawerHeight: string;
}

/**
 * Overlay 面板组合域（FE-批4A）：Controls/Legend/Inspector/Drawer 的
 * 内容装配与桌面包装。编排层传入 view-model 与交互回调，本 hook 返回
 * 可直接放入 Map surface 槽位的 ReactNode。
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
    view,
    transportPanelProps,
    inspector,
    windowLabel,
    status,
  } = options;

  const activeControlsSection =
    interaction.controlsSection === "overview"
      ? "view"
      : interaction.controlsSection;
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
        presets: view.presets,
        timeRanges: view.timeRanges,
        layerVisibilityControls: view.layerVisibilityControls,
        onPresetSelect: view.onPresetSelect,
        onTimeRangeSelect: view.onTimeRangeSelect,
        onResetLayers: view.onResetLayers,
      }}
      transport={transportPanelProps}
      activeLegendKey={interaction.focusedLegendItemKey}
      highlightedLegendKey={interaction.highlightedLegendItemKey}
      onLegendItemHover={interaction.updateHoveredLegendItemKey}
      onLegendItemFocus={interaction.updateFocusedLegendItemKey}
      onControlsSectionChange={interaction.setControlsSection}
      onClose={() => interaction.setOpenOverlayPanel(null)}
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
      activeLegendKey={interaction.focusedLegendItemKey}
      highlightedLegendKey={interaction.highlightedLegendItemKey}
      onLegendItemHover={interaction.updateHoveredLegendItemKey}
      onLegendItemFocus={interaction.updateFocusedLegendItemKey}
      onClose={() => interaction.setOpenOverlayPanel(null)}
      t={t}
    />
  );
  const legendDockContent: ReactNode = (
    <WarMapLegendDock
      legendSections={legend.sections}
      interactionLegendItems={legend.interactionItems}
      summaryDataLabel={overlayViewModel.summaryDataLabel}
      activeLegendKey={interaction.focusedLegendItemKey}
      highlightedLegendKey={interaction.highlightedLegendItemKey}
      onLegendItemHover={interaction.updateHoveredLegendItemKey}
      onLegendItemFocus={interaction.updateFocusedLegendItemKey}
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
      overlayDensity={overlayDensity}
      layoutVariant={layoutVariant}
      overlayTopClassName={overlayLayout.overlayTopClassName}
      overlayRailWidth={overlayLayout.overlayRailWidth}
      useDrawerControls={useDrawerControls}
      summaryStatusCards={overlayViewModel.summaryStatusCards}
      summaryDataLabel={overlayViewModel.summaryDataLabel}
      refreshingMapData={status.refreshingMapData}
      showActionLabels={overlayLayout.showActionLabels}
      openOverlayPanel={interaction.openOverlayPanel}
      quickLegendItems={legend.quickItems}
      activeLegendKey={interaction.focusedLegendItemKey}
      highlightedLegendKey={interaction.highlightedLegendItemKey}
      onRefresh={status.onRefresh}
      onToggleControls={() => {
        if (interaction.controlsSection === "legend") {
          interaction.setControlsSection("view");
        }
        interaction.setOpenOverlayPanel((current) =>
          current === "controls" ? null : "controls",
        );
      }}
      onToggleLegend={() => {
        if (standaloneLayout) {
          status.scrollLegendDockIntoView();
          return;
        }
        interaction.setOpenOverlayPanel((current) =>
          current === "legend" ? null : "legend",
        );
      }}
      onLegendItemHover={interaction.updateHoveredLegendItemKey}
      onLegendItemFocus={interaction.updateFocusedLegendItemKey}
      controlsPanel={desktopControlsPanel}
      legendPanel={desktopLegendPanel}
      t={t}
    />
  );
  const inspectorPanel: ReactNode = (
    <WarMapInspectorPanel
      selectedInspector={interaction.selectedInspector}
      transportDetail={inspector.transportDetail}
      transportDetailLoading={inspector.transportDetailLoading}
      useDesktopInspector={useDesktopInspector}
      desktopInspectorMinimized={interaction.desktopInspectorMinimized}
      inspectorPanelWidth={overlayLayout.inspectorPanelWidth}
      inspectorPanelHeight={overlayLayout.inspectorPanelHeight}
      locale={locale}
      onZoomToSelectedInspector={interaction.zoomToSelectedInspector}
      onMinimizeInspector={() => interaction.setDesktopInspectorMinimized(true)}
      onExpandInspector={() => interaction.setDesktopInspectorMinimized(false)}
      onCloseInspector={interaction.closeSelectedInspector}
      onOpenNewsLink={interaction.openNewsLink}
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
          ? interaction.openOverlayPanel === "controls"
          : Boolean(interaction.openOverlayPanel)
      }
      onClose={() => interaction.setOpenOverlayPanel(null)}
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
      {interaction.openOverlayPanel === "legend" && !standaloneLayout
        ? legendPanelContent
        : controlsPanelContent}
    </Drawer>
  ) : null;

  return {
    overlayRail,
    inspectorPanel,
    bottomDrawer,
    controlsPanelContent,
    legendPanelContent,
    legendDockContent,
    desktopControlsPanel,
    desktopLegendPanel,
    mobileControlsDrawerHeight,
    standaloneControlsDrawerHeight,
  };
}
