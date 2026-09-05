/**
 * War Map overlay 领域类型（FE-批4B：自 war-map-overlay-model.ts 拆出）。
 * 纯类型叶子模块：无 React、无 "use client"。
 */
import type {
  WarMapEvent,
  WarMapEventSeverity,
  WarMapNewsMarker,
  WarMapTransportKind,
} from "@modular/utils";

export interface RenderableWarMapEvent extends WarMapEvent {
  label: string;
}

export interface RenderableWarMapNewsMarker extends WarMapNewsMarker {
  label: string;
  locationLabel: string;
  latestAt?: string;
}

export interface RenderableWarMapTransportSelection {
  objectKey: string;
  transportKind: WarMapTransportKind;
  label: string;
  subtitle?: string;
  latestAt?: string;
  sourceUpdatedAt?: string;
  callsign?: string;
  icao24?: string;
  registration?: string;
  aircraftType?: string;
  displayCategory?: string;
  displayCategoryZh?: string;
  role?: string;
  roleZh?: string;
  countryCode?: string;
  countryName?: string;
  heading?: number;
  altitudeFt?: number;
  groundSpeedKt?: number;
  name?: string;
  mmsi?: string;
  shipType?: number;
  shipTypeLabel?: string;
  shipTypeLabelZh?: string;
  vesselRole?: string;
  vesselRoleZh?: string;
  speed?: number;
  course?: number;
  isMilitaryCandidate?: boolean;
}

export type SelectedCluster =
  | {
      key: string;
      kind: "event-cluster";
      lat: number;
      lng: number;
      count: number;
      zoomTarget: number;
      members: RenderableWarMapEvent[];
    }
  | {
      key: string;
      kind: "news-cluster";
      lat: number;
      lng: number;
      count: number;
      zoomTarget: number;
      members: RenderableWarMapNewsMarker[];
    };

export type SelectedInspector =
  | SelectedCluster
  | {
      key: string;
      kind: "event";
      lat: number;
      lng: number;
      zoomTarget: number;
      item: RenderableWarMapEvent;
    }
  | {
      key: string;
      kind: "news";
      lat: number;
      lng: number;
      zoomTarget: number;
      item: RenderableWarMapNewsMarker;
    }
  | {
      key: string;
      kind: "flight";
      lat: number;
      lng: number;
      zoomTarget: number;
      item: RenderableWarMapTransportSelection;
    }
  | {
      key: string;
      kind: "vessel";
      lat: number;
      lng: number;
      zoomTarget: number;
      item: RenderableWarMapTransportSelection;
    };

export type OverlayDensity = "expanded" | "compact" | "minimal";
export type OverlayPanelKey = "controls" | "legend";
export type WarMapLayoutVariant = "embedded" | "standalone";
export type OverlayControlsSection =
  | "overview"
  | "view"
  | "transport"
  | "feeds"
  | "legend";

export type WarMapTranslateFn = (
  key: string,
  options?: { defaultValue?: string; [key: string]: unknown },
) => string;

export interface WarMapOverlayLayout {
  overlayTopClassName: string;
  overlayRailWidth: number;
  overlayPanelMaxHeight: number;
  controlsPanelWidth: number;
  legendPanelWidth: number;
  controlsDrawerHeight: number;
  standaloneDrawerHeight: number;
  inspectorPanelHeight: number;
  inspectorPanelWidth: number;
  showActionLabels: boolean;
}

export interface WarMapControlsSectionMeta {
  label: string;
  description: string;
}

export interface WarMapOverlayTab {
  key: OverlayControlsSection;
  label: string;
  attentionLabel?: string;
  attentionTone?: "warning" | "critical";
  attentionTooltip?: string;
}

export interface WarMapOverviewMetricCard {
  key: "signals" | "news" | "monitors" | "layers";
  label: string;
  value: number;
  note: string;
  className: string;
}

export interface WarMapSummaryStatusCard {
  key: "stream" | "data";
  label: string;
  value: string;
  detail: string;
  dotClassName: string;
  tagColor: string;
  tooltip?: string;
}

export interface WarMapFeedSummaryCard {
  key: "healthy" | "refreshing" | "issues";
  label: string;
  value: number;
  toneClassName: string;
}

export interface WarMapDetailedChainStatus {
  key: string;
  color: string;
  text: string;
  tooltip: string;
}

export interface WarMapOverlayViewModel {
  controlsSectionMeta: Record<
    OverlayControlsSection,
    WarMapControlsSectionMeta
  >;
  controlsTabs: WarMapOverlayTab[];
  overviewMetricCards: WarMapOverviewMetricCard[];
  summaryStatusCards: WarMapSummaryStatusCard[];
  summaryDataLabel: string;
  overviewDataTagLabel: string;
  feedSummaryCards: WarMapFeedSummaryCard[];
  detailedChainStatuses: WarMapDetailedChainStatus[];
}

export interface WarMapSelectableOption<T extends string> {
  key: T;
  label: string;
  active: boolean;
}

export function severityTagColor(severity: WarMapEventSeverity): string {
  switch (severity) {
    case "high":
      return "red";
    case "medium":
      return "gold";
    case "low":
    default:
      return "blue";
  }
}
