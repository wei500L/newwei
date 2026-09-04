import type { WarMapClusterPartition } from "./war-map-clustering";
import type {
  RenderableWarMapEvent,
  RenderableWarMapNewsMarker,
  WarMapTranslateFn,
} from "./war-map-overlay-model";
import {
  clusterRadius,
  severityColor,
  type DeckPoint,
} from "./war-map-point-model";
import { toClusterSelectionKey, toSingleSelectionKey } from "./war-map-selection-model";
import type { BuildWarMapSymbolPointLayersInput } from "./war-map-symbol-layers";
import { getWarMapSymbolAccentColor } from "./war-map-symbols";

export interface WarMapEventLayersOptions {
  clusteredEvents: WarMapClusterPartition<RenderableWarMapEvent>;
  rawEventsCount: number;
  t: WarMapTranslateFn;
  buildSymbolPointLayers: (
    input: BuildWarMapSymbolPointLayersInput,
  ) => unknown[];
  onSelectablePointClick: (info: { object?: DeckPoint }) => void;
}

export interface WarMapEventLayersResult {
  layers: unknown[];
  eventsCount: number;
  eventClustersCount: number;
}

/** 构造事件（signals）图层：单点按 severity 符号，聚类按 lead severity。 */
export function buildWarMapEventLayers(
  options: WarMapEventLayersOptions,
): WarMapEventLayersResult {
  const {
    clusteredEvents,
    rawEventsCount,
    t,
    buildSymbolPointLayers,
    onSelectablePointClick,
  } = options;

  const eventPoints: DeckPoint[] = clusteredEvents.singles.map((event) => {
    const score =
      typeof event.derivedScore === "number"
        ? event.derivedScore
        : (event.value ?? 0);
    const symbolKey =
      event.severity === "high"
        ? "signal-high"
        : event.severity === "medium"
          ? "signal-medium"
          : "signal-low";
    const selectionKey = toSingleSelectionKey("event", event.id);

    return {
      id: event.id,
      interactionKey: selectionKey,
      lat: event.lat,
      lng: event.lng,
      label: event.label,
      kind: "event",
      selectionKey,
      color: severityColor(event.severity),
      radius: Math.max(5, Math.min(24, Math.sqrt(Math.max(1, score)) * 2.5)),
      symbolKey,
      accentColor: getWarMapSymbolAccentColor(symbolKey),
      severity: event.severity,
      alertCount: event.alertCount,
      newsCount: event.newsCount,
      latestAt: event.latestAt,
    };
  });

  const eventClusters: DeckPoint[] = clusteredEvents.clusters.map(
    (cluster) => {
      const selectionKey = toClusterSelectionKey("event", cluster.memberKey);
      const leadSeverity = cluster.members[0]?.severity ?? "medium";
      const symbolKey =
        leadSeverity === "high"
          ? "signal-high"
          : leadSeverity === "medium"
            ? "signal-medium"
            : "signal-low";

      return {
        id: selectionKey,
        interactionKey: selectionKey,
        lat: cluster.lat,
        lng: cluster.lng,
        label: t("dashboard.charts.warMap.panel.signalsTitle"),
        kind: "event-cluster",
        selectionKey,
        color: severityColor(leadSeverity),
        radius: clusterRadius(cluster.count),
        symbolKey,
        accentColor: getWarMapSymbolAccentColor(symbolKey),
        isCluster: true,
        clusterCount: cluster.count,
        description: t("dashboard.charts.warMap.tooltip.clusterSignals", {
          count: cluster.count,
        }),
      };
    },
  );

  return {
    layers: buildSymbolPointLayers({
      id: "wm-events",
      data: [...eventClusters, ...eventPoints],
      onClick: onSelectablePointClick,
    }),
    eventsCount: rawEventsCount,
    eventClustersCount: eventClusters.length,
  };
}
