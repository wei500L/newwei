/** Overlay rail 领域契约（FE-批4B）。 */
import type { ReactNode, RefObject } from "react";

import type { OverlayDensity, OverlayPanelKey, WarMapLayoutVariant, WarMapSummaryStatusCard, WarMapTranslateFn } from "./war-map-overlay-model";
import type { WarMapLegendItem } from "./war-map-symbols";

/** 只读状态摘要切片（stream/data 卡）。 */
export interface WarMapOverlayRailSummary {
  statusCards: WarMapSummaryStatusCard[];
  dataLabel: string;
}

/** quick legend 切片：条目 + 聚焦/高亮状态 + hover/focus 命令。 */
export interface WarMapOverlayRailQuickLegend {
  items: WarMapLegendItem[];
  activeKey?: string | null;
  highlightedKey?: string | null;
  onItemHover?: (itemKey: string | null) => void;
  onItemFocus?: (itemKey: string | null) => void;
}

/** rail 命令切片。 */
export interface WarMapOverlayRailActions {
  onRefresh: () => void;
  onToggleControls: () => void;
  onToggleLegend: () => void;
}

/** rail 面板槽位切片。 */
export interface WarMapOverlayRailPanels {
  controls: ReactNode;
  legend: ReactNode;
}

export interface WarMapOverlayRailProps {
  overlayRailRef: RefObject<HTMLDivElement | null>;
  /** rail 布局切片：密度、变体、顶部偏移、宽度与 label 开关。 */
  layout: {
    density: OverlayDensity;
    variant?: WarMapLayoutVariant;
    topClassName: string;
    railWidth: number;
    useDrawerControls: boolean;
    showActionLabels: boolean;
    openPanel: OverlayPanelKey | null;
  };
  summary: WarMapOverlayRailSummary;
  refreshing: boolean;
  quickLegend: WarMapOverlayRailQuickLegend;
  actions: WarMapOverlayRailActions;
  panels: WarMapOverlayRailPanels;
  t: WarMapTranslateFn;
}
