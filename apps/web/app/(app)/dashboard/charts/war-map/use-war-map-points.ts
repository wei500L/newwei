"use client";

import type { WarMapTranslateTarget } from "@modular/utils";
import { useMemo } from "react";

import type { StoredSituationMonitor } from "@/app/(app)/situation-monitor/types/situation-monitor-monitors";
import type { WarMapEvent, WarMapNewsMarker } from "@modular/utils";

import {
  clusterWarMapPoints,
  computeAverageClusterGeometry,
  computeWeightedClusterGeometry,
  sortWarMapEventClusterMembers,
  sortWarMapNewsClusterMembers,
} from "./war-map-clustering";
import type { WarMapLayersResponse } from "./war-map-data";
import type {
  RenderableWarMapEvent,
  RenderableWarMapNewsMarker,
} from "./war-map-overlay-model";
import { isValidLatLng, toRgba, type DeckPoint } from "./war-map-point-model";
import type { WarMapBbox } from "./query-viewport";
import { buildWarMapTransportSelections } from "./war-map-transport-points";

export interface UseWarMapPointsOptions {
  monitors: StoredSituationMonitor[];
  events: WarMapEvent[] | undefined;
  newsMarkers: WarMapNewsMarker[] | undefined;
  layersData: WarMapLayersResponse["layers"] | undefined;
  translateTarget?: WarMapTranslateTarget;
  queryZoom: number;
  localClusterBbox?: WarMapBbox;
}

export interface UseWarMapPointsResult {
  monitorPoints: DeckPoint[];
  rawEvents: RenderableWarMapEvent[];
  rawNewsMarkers: RenderableWarMapNewsMarker[];
  clusteredEvents: ReturnType<typeof clusterWarMapPoints<RenderableWarMapEvent>>;
  clusteredNews: ReturnType<typeof clusterWarMapPoints<RenderableWarMapNewsMarker>>;
  transportSelections: ReturnType<typeof buildWarMapTransportSelections>;
}

/**
 * War Map 点位派生域（FE-批4A）：查询数据 → 可渲染点位/聚类/运输选择。
 * 不构造 Deck 图层（图层工厂见 war-map-*-layers）。
 */
export function useWarMapPoints(options: UseWarMapPointsOptions): UseWarMapPointsResult {
  const {
    monitors,
    events,
    newsMarkers,
    layersData,
    translateTarget,
    queryZoom,
    localClusterBbox,
  } = options;

  const monitorPoints = useMemo(
    () =>
      monitors
        .filter((monitor) => monitor.enabled && monitor.location)
        .filter((monitor) =>
          isValidLatLng(monitor.location!.lat, monitor.location!.lng),
        )
        .map((monitor) => ({
          interactionKey: `monitor:${monitor.id}`,
          query:
            monitor.rawKeywords
              .find((keyword: string) => keyword.trim().length > 0)
              ?.trim() ?? monitor.name,
          id: monitor.id,
          lat: monitor.location!.lat,
          lng: monitor.location!.lng,
          label: monitor.name,
          color: toRgba("#4f46e5", 0.9, [79, 70, 229]),
          radius: 8,
          symbolKey: "monitor" as const,
          accentColor: "#4f46e5",
          kind: "monitor" as const,
          description: monitor.location!.name,
        })),
    [monitors],
  );

  const rawEvents = useMemo<RenderableWarMapEvent[]>(
    () =>
      (events ?? [])
        .filter((event) => isValidLatLng(event.lat, event.lng))
        .map((event) => ({
          ...event,
          label:
            translateTarget === "zh-CN" && typeof event.nameZh === "string"
              ? event.nameZh
              : event.name,
        })),
    [events, translateTarget],
  );

  const rawNewsMarkers = useMemo<RenderableWarMapNewsMarker[]>(
    () =>
      (newsMarkers ?? [])
        .filter((marker) => isValidLatLng(marker.lat, marker.lng))
        .map((marker) => ({
          ...marker,
          label:
            translateTarget === "zh-CN" && typeof marker.titleZh === "string"
              ? marker.titleZh
              : marker.title,
          locationLabel:
            translateTarget === "zh-CN"
              ? (marker.displayNameZh ??
                marker.locationZh ??
                marker.displayName ??
                marker.location)
              : (marker.displayName ?? marker.location),
          latestAt: marker.publishedAt ?? marker.ingestedAt,
        })),
    [newsMarkers, translateTarget],
  );

  const clusteredEvents = useMemo(
    () =>
      clusterWarMapPoints(rawEvents, {
        bbox: localClusterBbox,
        zoom: queryZoom,
        sortMembers: sortWarMapEventClusterMembers,
        getClusterGeometry: (members) =>
          computeWeightedClusterGeometry(members, (event) =>
            Math.max(1, event.derivedScore ?? event.value ?? 1),
          ),
      }),
    [localClusterBbox, queryZoom, rawEvents],
  );

  const clusteredNews = useMemo(
    () =>
      clusterWarMapPoints(rawNewsMarkers, {
        bbox: localClusterBbox,
        zoom: queryZoom,
        sortMembers: sortWarMapNewsClusterMembers,
        getClusterGeometry: (members) => computeAverageClusterGeometry(members),
      }),
    [localClusterBbox, queryZoom, rawNewsMarkers],
  );

  const transportSelections = useMemo(
    () => buildWarMapTransportSelections(layersData ?? {}),
    [layersData],
  );

  return {
    monitorPoints,
    rawEvents,
    rawNewsMarkers,
    clusteredEvents,
    clusteredNews,
    transportSelections,
  };
}
