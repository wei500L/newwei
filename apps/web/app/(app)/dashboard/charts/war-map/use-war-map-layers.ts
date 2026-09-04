"use client";

import type {
  WarMapAisMode,
  WarMapFlightMode,
  WarMapLayerVisibility,
  WarMapTranslateTarget,
} from "@modular/utils";
import { useEffect, useMemo } from "react";

import type { SupportedLocale } from "@/lib/i18n";

import type { WarMapBbox } from "./query-viewport";
import type { UseWarMapInteractionResult } from "./use-war-map-interaction";
import type { UseWarMapPointsResult } from "./use-war-map-points";
import { buildWarMapAisLayers } from "./war-map-ais-layers";
import type { WarMapLayersResponse } from "./war-map-data";
import { buildWarMapEventLayers } from "./war-map-event-layers";
import { buildWarMapNewsLayers } from "./war-map-news-layers";
import type { WarMapTranslateFn } from "./war-map-overlay-model";
import { buildWarMapStaticLayers } from "./war-map-static-layers";
import {
  createWarMapSymbolLayerBuilder,
} from "./war-map-symbol-layers";
import type { WarMapActivePointLayerLegendItem } from "./war-map-symbols";
import {
  createWarMapCursorGetter,
  createWarMapTooltipGetter,
} from "./war-map-tooltip";

export interface UseWarMapLayersOptions {
  t: WarMapTranslateFn;
  locale: SupportedLocale;
  flightMode: WarMapFlightMode;
  effectiveAisMode: WarMapAisMode;
  aisHighlightCandidates: boolean;
  layerVisibility: WarMapLayerVisibility;
  layersData: WarMapLayersResponse["layers"] | undefined;
  queryZoom: number;
  localClusterBbox?: WarMapBbox;
  translateTarget?: WarMapTranslateTarget;
  points: UseWarMapPointsResult;
  interaction: UseWarMapInteractionResult;
  setOverlayProps: (props: {
    layers: unknown[];
    getTooltip: ReturnType<typeof createWarMapTooltipGetter>;
    getCursor: ReturnType<typeof createWarMapCursorGetter>;
  }) => void;
  hasRenderableContainer: boolean;
}

export interface WarMapDeckData {
  deckLayers: unknown[];
  eventsCount: number;
  eventClustersCount: number;
  newsCount: number;
  newsClustersCount: number;
  staticVisibleCount: number;
  aisFeatureCount: number;
}

export interface UseWarMapLayersResult {
  deckData: WarMapDeckData;
  /** all 模式下高亮的军事候选船只数（AIS 摘要展示用）。 */
  aisHighlightedCandidateCount: number | undefined;
  /** 当前有数据的静态点图层（legend sections 用）。 */
  activePointLayers: WarMapActivePointLayerLegendItem[];
}

/**
 * War Map 图层编排域（FE-批4A）：
 * 点位派生结果 + 交互状态 → Deck 图层集合 + overlay props 更新。
 * 图层构造按领域拆分（static/ais/event/news），共享符号图层经
 * createWarMapSymbolLayerBuilder 构造；tooltip/cursor getter 在此创建并
 * 经 overlay.setOverlayProps 应用到 Deck overlay。
 */
export function useWarMapLayers(
  options: UseWarMapLayersOptions,
): UseWarMapLayersResult {
  const {
    t,
    locale,
    flightMode,
    effectiveAisMode,
    aisHighlightCandidates,
    layerVisibility,
    layersData,
    queryZoom,
    localClusterBbox,
    translateTarget,
    points,
    interaction,
    setOverlayProps,
    hasRenderableContainer,
  } = options;

  const buildSymbolPointLayers = useMemo(
    () =>
      createWarMapSymbolLayerBuilder({
        hoveredInteractionKey: interaction.hoveredInteractionKey,
        selectedInspectorKey: interaction.selectedInspectorKey,
        highlightedLegendItemKey: interaction.highlightedLegendItemKey,
        onPointHover: interaction.handleDeckPointHover,
      }),
    [
      interaction.highlightedLegendItemKey,
      interaction.hoveredInteractionKey,
      interaction.onPointHover,
      interaction.selectedInspectorKey,
    ],
  );

  const staticDeckLayers = useMemo(
    () =>
      buildWarMapStaticLayers({
        layersData: layersData ?? {},
        layerVisibility,
        translateTarget,
        t,
        queryZoom,
        localClusterBbox,
        flightMode,
        buildSymbolPointLayers,
        onLayerPointClick: interaction.handleLayerPointClick,
      }),
    [
      buildSymbolPointLayers,
      flightMode,
      layerVisibility,
      layersData,
      localClusterBbox,
      queryZoom,
      t,
      translateTarget,
      interaction.handleLayerPointClick,
    ],
  );

  const aisDeckLayers = useMemo(
    () =>
      buildWarMapAisLayers({
        layersData: layersData ?? {},
        aisLayerVisible: layerVisibility.ais,
        effectiveAisMode,
        aisHighlightCandidates,
        t,
        buildSymbolPointLayers,
        onLayerPointClick: interaction.handleLayerPointClick,
        onSelectablePointClick: interaction.handleSelectablePointClick,
      }),
    [
      aisHighlightCandidates,
      buildSymbolPointLayers,
      effectiveAisMode,
      layerVisibility.ais,
      layersData,
      t,
      interaction.handleLayerPointClick,
      interaction.handleSelectablePointClick,
    ],
  );

  const monitorDeckLayers = useMemo(() => {
    if (!layerVisibility.monitors || points.monitorPoints.length === 0) {
      return [];
    }

    return buildSymbolPointLayers({
      id: "wm-monitors",
      data: points.monitorPoints,
      onClick: interaction.handleMonitorPointClick,
    });
  }, [
    buildSymbolPointLayers,
    interaction.handleMonitorPointClick,
    layerVisibility.monitors,
    points.monitorPoints,
  ]);

  const eventDeckData = useMemo(
    () =>
      buildWarMapEventLayers({
        clusteredEvents: points.clusteredEvents,
        rawEventsCount: points.rawEvents.length,
        t,
        buildSymbolPointLayers,
        onSelectablePointClick: interaction.handleSelectablePointClick,
      }),
    [
      buildSymbolPointLayers,
      points.clusteredEvents,
      points.rawEvents.length,
      interaction.handleSelectablePointClick,
      t,
    ],
  );

  const newsDeckData = useMemo(
    () =>
      buildWarMapNewsLayers({
        clusteredNews: points.clusteredNews,
        rawNewsMarkersCount: points.rawNewsMarkers.length,
        t,
        buildSymbolPointLayers,
        onSelectablePointClick: interaction.handleSelectablePointClick,
      }),
    [
      buildSymbolPointLayers,
      points.clusteredNews,
      points.rawNewsMarkers.length,
      interaction.handleSelectablePointClick,
      t,
    ],
  );

  const deckData = useMemo<WarMapDeckData>(
    () => ({
      deckLayers: [
        ...staticDeckLayers.layers,
        ...aisDeckLayers.layers,
        ...monitorDeckLayers,
        ...eventDeckData.layers,
        ...newsDeckData.layers,
      ],
      eventsCount: eventDeckData.eventsCount,
      eventClustersCount: eventDeckData.eventClustersCount,
      newsCount: newsDeckData.newsCount,
      newsClustersCount: newsDeckData.newsClustersCount,
      staticVisibleCount:
        staticDeckLayers.layers.length + aisDeckLayers.layers.length,
      aisFeatureCount: aisDeckLayers.aisFeatureCount,
    }),
    [
      aisDeckLayers,
      eventDeckData,
      monitorDeckLayers,
      newsDeckData,
      staticDeckLayers,
    ],
  );

  const tooltipGetter = useMemo(
    () => createWarMapTooltipGetter({ t, locale, flightMode }),
    [flightMode, locale, t],
  );

  const deckCursorGetter = useMemo(
    () => createWarMapCursorGetter(interaction.hoveredInteractionKey),
    [interaction.hoveredInteractionKey],
  );

  useEffect(() => {
    setOverlayProps({
      layers: hasRenderableContainer ? deckData.deckLayers : [],
      getTooltip: tooltipGetter,
      getCursor: deckCursorGetter,
    });
  }, [
    deckCursorGetter,
    deckData.deckLayers,
    hasRenderableContainer,
    setOverlayProps,
    tooltipGetter,
  ]);

  return {
    deckData,
    aisHighlightedCandidateCount:
      effectiveAisMode === "all"
        ? aisDeckLayers.aisHighlightedCandidateCount
        : undefined,
    activePointLayers: staticDeckLayers.activePointLayers,
  };
}
