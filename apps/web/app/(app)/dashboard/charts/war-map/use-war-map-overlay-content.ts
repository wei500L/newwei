"use client";

import type {
  WarMapAisMode,
  WarMapLayerVisibility,
} from "@modular/utils";
import { useMemo } from "react";

import type {
  WarMapLayoutVariant,
  WarMapTranslateFn,
} from "./war-map-overlay-model";
import {
  buildWarMapOverlayLayout,
  buildWarMapOverlayViewModel,
  type OverlayDensity,
} from "./war-map-overlay-model";
import {
  buildWarMapInteractionLegendItems,
  buildWarMapLegendSections,
  buildWarMapQuickLegendItems,
  type WarMapActivePointLayerLegendItem,
  type WarMapLegendItem,
  type WarMapTransportLegendState,
} from "./war-map-symbols";

export interface UseWarMapOverlayContentOptions {
  t: WarMapTranslateFn;
  wrapperSize: { width: number; height: number };
  overlayDensity: OverlayDensity;
  hasNonFatalDataError: boolean;
  layoutVariant?: WarMapLayoutVariant;
  statusSummary: WarMapStatusSummary;
  streamError: string | null;
  pointsResult: {
    rawEventsCount: number;
    rawNewsMarkersCount: number;
    monitorPointsCount: number;
  };
  monitorsCount: number;
  visibleLayerCount: number;
  legend: {
    layerVisibility: WarMapLayerVisibility;
    effectiveAisMode: WarMapAisMode;
    transportLegendState: WarMapTransportLegendState;
    activePointLayers: WarMapActivePointLayerLegendItem[];
  };
}

export interface UseWarMapOverlayContentResult {
  overlayLayout: ReturnType<typeof buildWarMapOverlayLayout>;
  overlayViewModel: ReturnType<typeof buildWarMapOverlayViewModel>;
  quickLegendItems: WarMapLegendItem[];
  interactionLegendItems: WarMapLegendItem[];
  legendSections: ReturnType<typeof buildWarMapLegendSections>;
  legendItemsByKey: Map<string, WarMapLegendItem>;
}

/**
 * War Map overlay 内容域（FE-批4A）：布局度量、顶部/概览 view model 与
 * legend 条目集合的派生。纯派生，不含 DOM 与交互状态。
 */
export function useWarMapOverlayContent(
  options: UseWarMapOverlayContentOptions,
): UseWarMapOverlayContentResult {
  const {
    t,
    wrapperSize,
    overlayDensity,
    hasNonFatalDataError,
    layoutVariant,
    statusSummary,
    streamError,
    pointsResult,
    monitorsCount,
    visibleLayerCount,
    legend,
  } = options;

  const overlayLayout = useMemo(
    () =>
      buildWarMapOverlayLayout({
        wrapperWidth: wrapperSize.width,
        wrapperHeight: wrapperSize.height,
        overlayDensity,
        hasNonFatalErrors: hasNonFatalDataError,
        layoutVariant,
      }),
    [
      hasNonFatalDataError,
      layoutVariant,
      overlayDensity,
      wrapperSize.height,
      wrapperSize.width,
    ],
  );

  const overlayViewModel = useMemo(
    () =>
      buildWarMapOverlayViewModel({
        t,
        rawEventsCount: pointsResult.rawEventsCount,
        rawNewsMarkersCount: pointsResult.rawNewsMarkersCount,
        monitorsCount,
        visibleLayerCount,
        streamStatusLabel: statusSummary.streamStatusLabel,
        streamStatusColor: statusSummary.streamStatusColor,
        streamMessageRelative: statusSummary.streamMessageRelative,
        streamMessageExact: statusSummary.streamMessageExact,
        streamError,
        dataStatusLabel: statusSummary.dataStatusLabel,
        dataStatusColor: statusSummary.dataStatusColor,
        latestQueryUpdatedRelative: statusSummary.latestQueryUpdatedRelative,
        latestQueryUpdatedExact: statusSummary.latestQueryUpdatedExact,
        summaryDataLabel: statusSummary.summaryDataLabel,
        healthyChainCount: statusSummary.healthyChainCount,
        refreshingChainCount: statusSummary.refreshingChainCount,
        errorChainCount: statusSummary.errorChainCount,
        detailedChainStatuses: statusSummary.detailedChainStatuses,
      }),
    [
      monitorsCount,
      pointsResult.rawEventsCount,
      pointsResult.rawNewsMarkersCount,
      visibleLayerCount,
      statusSummary,
      streamError,
      t,
    ],
  );

  const quickLegendItems = useMemo<WarMapLegendItem[]>(
    () =>
      buildWarMapQuickLegendItems({
        t,
        showMonitors:
          legend.layerVisibility.monitors && pointsResult.monitorPointsCount > 0,
        showFlights: legend.layerVisibility.flights,
        showAis: legend.layerVisibility.ais,
        effectiveAisMode: legend.effectiveAisMode,
        transportState: legend.transportLegendState,
      }),
    [
      legend.effectiveAisMode,
      legend.layerVisibility.ais,
      legend.layerVisibility.flights,
      legend.layerVisibility.monitors,
      pointsResult.monitorPointsCount,
      legend.transportLegendState,
      t,
    ],
  );

  const interactionLegendItems = useMemo<WarMapLegendItem[]>(
    () => buildWarMapInteractionLegendItems({ t }),
    [t],
  );

  const legendSections = useMemo(
    () =>
      buildWarMapLegendSections({
        t,
        showMonitors:
          legend.layerVisibility.monitors && pointsResult.monitorPointsCount > 0,
        showFlights: legend.layerVisibility.flights,
        showAis: legend.layerVisibility.ais,
        effectiveAisMode: legend.effectiveAisMode,
        activePointLayers: legend.activePointLayers,
        transportState: legend.transportLegendState,
      }),
    [
      legend.activePointLayers,
      legend.effectiveAisMode,
      legend.layerVisibility.ais,
      legend.layerVisibility.flights,
      legend.layerVisibility.monitors,
      pointsResult.monitorPointsCount,
      legend.transportLegendState,
      t,
    ],
  );

  const legendItemsByKey = useMemo(() => {
    const items = new Map<string, WarMapLegendItem>();

    for (const item of quickLegendItems) {
      items.set(item.key, item);
    }

    for (const item of interactionLegendItems) {
      if (!items.has(item.key)) {
        items.set(item.key, item);
      }
    }

    for (const section of legendSections) {
      for (const item of section.items) {
        if (!items.has(item.key)) {
          items.set(item.key, item);
        }
      }
    }

    return items;
  }, [interactionLegendItems, legendSections, quickLegendItems]);

  return {
    overlayLayout,
    overlayViewModel,
    quickLegendItems,
    interactionLegendItems,
    legendSections,
    legendItemsByKey,
  };
}
