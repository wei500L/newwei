/**
 * Controls 面板领域契约（FE-批4B：自 war-map-controls-panel.tsx 拆出）。
 * 纯类型叶子模块：无 React 组件、无 "use client"。
 */
import type { ReactNode } from "react";
import type { WarMapPreset, WarMapTimeRangePreset } from "@modular/utils";

import type { WarMapAisSummaryPresentation } from "./war-map-ais-status";
import type { WarMapFlightsSummaryPresentation } from "./war-map-flights-status";
import type {
  OverlayControlsSection,
  WarMapDetailedChainStatus,
  WarMapFeedSummaryCard,
  WarMapLayoutVariant,
  WarMapOverviewMetricCard,
  WarMapOverlayTab,
  WarMapSelectableOption,
  WarMapSummaryStatusCard,
  WarMapTranslateFn,
} from "./war-map-overlay-model";
import type {
  WarMapLegendItem,
  WarMapLegendSection,
} from "./war-map-symbols";

type FlightMode = "military" | "all";
type AisMode = "military" | "density" | "all";

export interface WarMapControlsPanelViewProps {
  presets: WarMapSelectableOption<WarMapPreset>[];
  timeRanges: WarMapSelectableOption<WarMapTimeRangePreset>[];
  layerVisibilityControls: ReactNode;
  onPresetSelect: (preset: WarMapPreset) => void;
  onTimeRangeSelect: (preset: WarMapTimeRangePreset) => void;
  onResetLayers: () => void;
}

/** Transport 航班域：模式、可见性与摘要展示（presentation 整体传递）。 */
export interface WarMapControlsPanelTransportFlights {
  mode: FlightMode;
  visible: boolean;
  presentation: WarMapFlightsSummaryPresentation;
  onModeChange: (mode: FlightMode) => void;
}

/** Transport 区块 AIS 域：模式、可见性、候选高亮与摘要展示。 */
export interface WarMapControlsPanelTransportAis {
  mode: AisMode;
  effectiveMode: AisMode;
  visible: boolean;
  highlightCandidates: boolean;
  highlightedCandidateCount: number | undefined;
  presentation: WarMapAisSummaryPresentation;
  onModeChange: (mode: AisMode) => void;
  onHighlightCandidatesChange: (enabled: boolean) => void;
}

/** Transport 区块分析域：权限门禁（含图层可见性）与提交。 */
export interface WarMapControlsPanelTransportAnalysis {
  allowed: boolean;
  submitting: boolean;
  onSubmit: () => void;
}

/** Transport 区块 legend 域：打开完整图例命令。 */
export interface WarMapControlsPanelTransportLegend {
  onOpen: () => void;
}

export interface WarMapControlsPanelTransportProps {
  flights: WarMapControlsPanelTransportFlights;
  ais: WarMapControlsPanelTransportAis;
  analysis: WarMapControlsPanelTransportAnalysis;
  legend: WarMapControlsPanelTransportLegend;
}

export interface WarMapControlsPanelProps {
  layoutVariant?: WarMapLayoutVariant;
  controlsSection: OverlayControlsSection;
  controlsSectionMeta: Record<
    OverlayControlsSection,
    {
      label: string;
      description: string;
    }
  >;
  controlsTabs: WarMapOverlayTab[];
  useDrawerControls: boolean;
  overlayPanelMaxHeight: number;
  overviewMetricCards: WarMapOverviewMetricCard[];
  summaryStatusCards: WarMapSummaryStatusCard[];
  summaryDataLabel: string;
  overviewDataTagLabel: string;
  windowLabel: string;
  feedSummaryCards: WarMapFeedSummaryCard[];
  detailedChainStatuses: WarMapDetailedChainStatus[];
  legendSections: WarMapLegendSection[];
  interactionLegendItems: WarMapLegendItem[];
  view: WarMapControlsPanelViewProps;
  transport: WarMapControlsPanelTransportProps;
  activeLegendKey?: string | null;
  highlightedLegendKey?: string | null;
  onLegendItemHover?: (itemKey: string | null) => void;
  onLegendItemFocus?: (itemKey: string | null) => void;
  onControlsSectionChange: (section: OverlayControlsSection) => void;
  onClose?: () => void;
  t: WarMapTranslateFn;
}

/** Legend 面板与 dock 共享的交互契约（hover 预览 / click 聚焦）。 */
export interface WarMapLegendInteractionProps {
  activeLegendKey?: string | null;
  highlightedLegendKey?: string | null;
  onLegendItemHover?: (itemKey: string | null) => void;
  onLegendItemFocus?: (itemKey: string | null) => void;
}

export interface WarMapLegendPanelProps extends WarMapLegendInteractionProps {
  legendSections: WarMapLegendSection[];
  interactionLegendItems: WarMapLegendItem[];
  summaryDataLabel?: string;
  onClose?: () => void;
  t: WarMapTranslateFn;
}

export interface WarMapLegendDockProps extends WarMapLegendInteractionProps {
  legendSections: WarMapLegendSection[];
  interactionLegendItems: WarMapLegendItem[];
  summaryDataLabel?: string;
  t: WarMapTranslateFn;
}
