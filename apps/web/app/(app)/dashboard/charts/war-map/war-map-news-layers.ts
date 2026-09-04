import type { WarMapClusterPartition } from "./war-map-clustering";
import type {
  RenderableWarMapNewsMarker,
  WarMapTranslateFn,
} from "./war-map-overlay-model";
import {
  clusterRadius,
  type DeckPoint,
} from "./war-map-point-model";
import { toClusterSelectionKey, toSingleSelectionKey } from "./war-map-selection-model";
import type { BuildWarMapSymbolPointLayersInput } from "./war-map-symbol-layers";
import { getWarMapSymbolAccentColor } from "./war-map-symbols";

export interface WarMapNewsLayersOptions {
  clusteredNews: WarMapClusterPartition<RenderableWarMapNewsMarker>;
  rawNewsMarkersCount: number;
  t: WarMapTranslateFn;
  buildSymbolPointLayers: (
    input: BuildWarMapSymbolPointLayersInput,
  ) => unknown[];
  onSelectablePointClick: (info: { object?: DeckPoint }) => void;
}

export interface WarMapNewsLayersResult {
  layers: unknown[];
  newsCount: number;
  newsClustersCount: number;
}

/** 构造新闻图层：geocoded/fallback 双符号，聚类按是否含 geocoded 点。 */
export function buildWarMapNewsLayers(
  options: WarMapNewsLayersOptions,
): WarMapNewsLayersResult {
  const {
    clusteredNews,
    rawNewsMarkersCount,
    t,
    buildSymbolPointLayers,
    onSelectablePointClick,
  } = options;

  const newsPoints: DeckPoint[] = clusteredNews.singles.map((marker) => {
    const isFallback = marker.geoSource === "fallback-country";
    const selectionKey = toSingleSelectionKey("news", marker.id);
    const symbolKey = isFallback ? "news-fallback" : "news-geocoded";
    const baseColor = isFallback ? [8, 145, 178] : [5, 150, 105];
    const [baseR = 8, baseG = 145, baseB = 178] = baseColor;

    return {
      id: marker.id,
      interactionKey: selectionKey,
      lat: marker.lat,
      lng: marker.lng,
      label: marker.label,
      kind: "news",
      selectionKey,
      color: [baseR, baseG, baseB, isFallback ? 110 : 200],
      radius: 5,
      symbolKey,
      accentColor: getWarMapSymbolAccentColor(symbolKey),
      url: marker.url ?? null,
      publishedAt: marker.publishedAt,
      ingestedAt: marker.ingestedAt,
      locationLabel: marker.locationLabel,
      geoSource: marker.geoSource,
    };
  });

  const newsClusters: DeckPoint[] = clusteredNews.clusters.map((cluster) => {
    const selectionKey = toClusterSelectionKey("news", cluster.memberKey);
    const hasGeocodedPoint = cluster.members.some(
      (member) => member.geoSource !== "fallback-country",
    );
    const symbolKey = hasGeocodedPoint ? "news-geocoded" : "news-fallback";

    return {
      id: selectionKey,
      interactionKey: selectionKey,
      lat: cluster.lat,
      lng: cluster.lng,
      label: t("dashboard.charts.warMap.panel.newsTitle"),
      kind: "news-cluster",
      selectionKey,
      color: hasGeocodedPoint ? [21, 128, 61, 176] : [8, 145, 178, 160],
      radius: clusterRadius(cluster.count),
      symbolKey,
      accentColor: getWarMapSymbolAccentColor(symbolKey),
      isCluster: true,
      clusterCount: cluster.count,
      description: t("dashboard.charts.warMap.tooltip.clusterNews", {
        count: cluster.count,
      }),
    };
  });

  return {
    layers: buildSymbolPointLayers({
      id: "wm-news",
      data: [...newsClusters, ...newsPoints],
      onClick: onSelectablePointClick,
    }),
    newsCount: rawNewsMarkersCount,
    newsClustersCount: newsClusters.length,
  };
}
