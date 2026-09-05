/**
 * War Map 符号与 legend 领域类型（FE-批4B：自 war-map-symbols.tsx 拆出）。
 *
 * 纯类型叶子模块：无 React、无客户端边界；palette/deck icon 等实现
 * 细节（SymbolPalette、DeckIconDefinition）留在各自的实现模块内部。
 */
import type { WarMapAisMode } from "@modular/utils";

import type {
  OverlayDensity,
  WarMapTranslateFn,
} from "./war-map-overlay-model";

export type { OverlayDensity, WarMapTranslateFn };

export type WarMapSymbolState = "default" | "hover" | "selected" | "cluster";

export type WarMapSymbolKey =
  | "signal-high"
  | "signal-medium"
  | "signal-low"
  | "news-geocoded"
  | "news-fallback"
  | "monitor"
  | "flight"
  | "ais-vessel-military"
  | "ais-vessel-fishing"
  | "ais-vessel-passenger"
  | "ais-vessel-cargo"
  | "ais-vessel-tanker"
  | "ais-vessel-other"
  | "ais-vessel-generic"
  | "ais-density"
  | "ais-disruption-high"
  | "ais-disruption-medium"
  | "ais-disruption-low"
  | "generic-point";

export interface WarMapLegendItem {
  key: string;
  symbolKey: WarMapSymbolKey;
  label: string;
  note?: string;
  state?: WarMapSymbolState;
  tone?: "default" | "degraded";
  accentColor?: string;
  countLabel?: string;
  matchSymbolKeys?: WarMapSymbolKey[];
  matchLayerIds?: string[];
}

export type WarMapLegendStatusTone = "info" | "warning" | "critical";

export interface WarMapLegendSection {
  key: string;
  title: string;
  description?: string;
  statusLabel?: string;
  statusTone?: WarMapLegendStatusTone;
  statusHint?: string;
  defaultExpanded?: boolean;
  items: WarMapLegendItem[];
}

export interface WarMapActivePointLayerLegendItem {
  key: string;
  label: string;
  accentColor?: string;
}

export interface WarMapLegendMatchablePoint {
  symbolKey: WarMapSymbolKey;
  layerId?: string;
}

export interface WarMapTransportLegendItemState {
  note?: string;
  countLabel?: string;
  tone?: "default" | "degraded";
}

export interface WarMapTransportLegendState {
  sectionStatusLabel?: string;
  sectionStatusTone?: WarMapLegendStatusTone;
  sectionStatusHint?: string;
  flights?: WarMapTransportLegendItemState;
  aisPrimary?: WarMapTransportLegendItemState;
  aisDisruption?: WarMapTransportLegendItemState;
}

/** legend 构建输入的 AIS 模式别名（与 @modular/utils 对齐）。 */
export type WarMapLegendAisMode = WarMapAisMode;
