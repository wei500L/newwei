import {
  WAR_MAP_LAYER_IDS,
  type WarMapFlightMode,
  type WarMapLayerFeature,
  type WarMapLayerVisibility,
  type WarMapTranslateTarget,
} from "@modular/utils";

import type { WarMapBbox } from "./query-viewport";
import {
  clusterWarMapPoints,
  computeAverageClusterGeometry,
} from "./war-map-clustering";
import { WAR_MAP_UNSUPPORTED_LAYER_IDS, type WarMapLayersResponse } from "./war-map-data";
import {
  getWarMapFlightLabel,
  readWarMapFlightProperties,
} from "./war-map-flights";
import type { WarMapTranslateFn } from "./war-map-overlay-model";
import {
  clusterRadius,
  isValidLatLng,
  resolveAircraftIconAngle,
  toLayerLabel,
  toRgba,
  type DeckPoint,
} from "./war-map-point-model";
import { toTransportSelectionKey } from "./war-map-selection-model";
import { buildWarMapStaticVectorLayers } from "./war-map-static-vector-layers";
import type { BuildWarMapSymbolPointLayersInput } from "./war-map-symbol-layers";
import {
  coerceHexColor,
  getWarMapSymbolAccentColor,
  type WarMapActivePointLayerLegendItem,
} from "./war-map-symbols";

export interface WarMapStaticLayersOptions {
  layersData: WarMapLayersResponse["layers"];
  layerVisibility: WarMapLayerVisibility;
  translateTarget?: WarMapTranslateTarget;
  t: WarMapTranslateFn;
  queryZoom: number;
  localClusterBbox?: WarMapBbox;
  flightMode: WarMapFlightMode;
  buildSymbolPointLayers: (
    input: BuildWarMapSymbolPointLayersInput,
  ) => unknown[];
  onLayerPointClick: (info: { object?: DeckPoint }) => void;
}

export interface WarMapStaticLayersResult {
  layers: unknown[];
  activePointLayers: WarMapActivePointLayerLegendItem[];
}

/**
 * 构造静态图层（FE-批4A：从 war-map.tsx staticDeckData 的静态部分迁移）。
 *
 * 逐层处理（跳过 monitors/ais/未支持/未启用图层）：
 * - path：buildSanitizedPathGeometry 消毒 + 分段渲染 + 无效点回退为点位；
 * - polygon：消毒 + fill + outline fragments + 点位回退；
 * - raster：跳过；
 * - point：航班属性识别（flight 符号）+ 可聚类分片（clusterable hints）。
 * 消毒统计按 feature 汇总并经 warnWarMapGeometrySanitization 去重告警。
 */
export function buildWarMapStaticLayers(
  options: WarMapStaticLayersOptions,
): WarMapStaticLayersResult {
  const {
    layersData,
    layerVisibility,
    translateTarget,
    t,
    queryZoom,
    localClusterBbox,
    flightMode,
    buildSymbolPointLayers,
    onLayerPointClick,
  } = options;

  const staticLayers: unknown[] = [];
  const activePointLayers: WarMapActivePointLayerLegendItem[] = [];

  for (const layerId of WAR_MAP_LAYER_IDS) {
    if (
      layerId === "monitors" ||
      layerId === "ais" ||
      WAR_MAP_UNSUPPORTED_LAYER_IDS.has(layerId) ||
      !layerVisibility[layerId]
    ) {
      continue;
    }

    const dataset = layersData[layerId];
    if (
      !dataset ||
      !Array.isArray(dataset.features) ||
      dataset.features.length === 0
    ) {
      continue;
    }

    const color = toRgba(
      dataset.renderHints?.color,
      dataset.renderHints?.opacity ?? 0.72,
      [59, 130, 246],
    );
    const pointAccentColor = coerceHexColor(dataset.renderHints?.color);
    const minZoom = dataset.renderHints?.minZoom;
    const maxZoom = dataset.renderHints?.maxZoom;
    const isZoomVisible =
      (typeof minZoom !== "number" || queryZoom >= minZoom) &&
      (typeof maxZoom !== "number" || queryZoom <= maxZoom);
    if (!isZoomVisible) {
      continue;
    }

    const layerLabel = t(`dashboard.charts.warMap.layerNames.${layerId}`, {
      defaultValue: toLayerLabel(layerId),
    });
    const layerPointRadius = Math.max(
      4,
      Math.min(18, Math.round((dataset.renderHints?.radiusScale ?? 1) * 6)),
    );
    const fallbackPointRadius = Math.max(
      4,
      Math.min(14, Math.round((dataset.renderHints?.radiusScale ?? 1) * 5)),
    );
    const pickable = Boolean(dataset.renderHints?.pickable ?? true);

    const vectorResult = buildWarMapStaticVectorLayers({
      dataset,
      layerId,
      layerLabel,
      color,
      pointAccentColor,
      fallbackPointRadius,
      pickable,
      translateTarget,
      buildSymbolPointLayers,
      onLayerPointClick,
    });
    if (vectorResult.handled) {
      staticLayers.push(...vectorResult.layers);
      continue;
    }

    if (dataset.geometryType === "raster") {
      continue;
    }

    const points: DeckPoint[] = dataset.features
      .filter(
        (
          feature,
        ): feature is WarMapLayerFeature & { lat: number; lng: number } =>
          typeof feature.lat === "number" &&
          typeof feature.lng === "number" &&
          isValidLatLng(feature.lat, feature.lng),
      )
      .map((feature) => {
        const { description, label, properties } =
          readLayerFeatureCopy(feature);
        const flight = readWarMapFlightProperties(properties);
        const symbolKey = flight
          ? ("flight" as const)
          : ("generic-point" as const);
        const accentColor = flight
          ? getWarMapSymbolAccentColor("flight")
          : pointAccentColor;
        const interactionKey = `layer:${layerId}:${feature.id}`;

        return {
          id: `${layerId}-${feature.id}`,
          interactionKey,
          lat: feature.lat,
          lng: feature.lng,
          label: flight ? getWarMapFlightLabel(flight, label) : label,
          description,
          color: flight ? toRgba(accentColor, 0.92, [51, 65, 85]) : color,
          radius: layerPointRadius,
          kind: "layer",
          layerId,
          symbolKey,
          accentColor,
          ...(flight
            ? {
                selectionKey: toTransportSelectionKey(
                  "aircraft",
                  `opensky:${flight.icao24}`,
                ),
                sourceType: flight.sourceType,
                callsign: flight.callsign,
                icao24: flight.icao24,
                registration: flight.registration,
                aircraftType: flight.aircraftType,
                displayCategory: flight.displayCategory,
                displayCategoryZh: flight.displayCategoryZh,
                role: flight.role,
                roleZh: flight.roleZh,
                countryCode: flight.countryCode,
                countryName: flight.countryName,
                heading: flight.heading,
                altitudeFt: flight.altitudeFt,
                groundSpeedKt: flight.groundSpeedKt,
                latestAt: flight.observedAt,
                sourceUpdatedAt: flight.sourceUpdatedAt,
              }
            : {}),
        };
      });

    const clusterablePartition = dataset.renderHints?.clusterable
      ? clusterWarMapPoints(points, {
          bbox: localClusterBbox,
          zoom: queryZoom,
          getClusterGeometry: (members) =>
            computeAverageClusterGeometry(members),
        })
      : null;
    const pointSingles = clusterablePartition
      ? clusterablePartition.singles
      : points;
    const pointClusters: DeckPoint[] = clusterablePartition
      ? clusterablePartition.clusters.map((cluster) => {
          const representative = cluster.members[0];
          const interactionKey = `layer-cluster:${layerId}:${cluster.memberKey}`;

          return {
            id: interactionKey,
            interactionKey,
            lat: cluster.lat,
            lng: cluster.lng,
            label: layerLabel,
            description:
              layerId === "flights"
                ? t("dashboard.charts.warMap.tooltip.clusterFlights", {
                    defaultValue:
                      flightMode === "all"
                        ? "{{count}} flights. Click to zoom in."
                        : "{{count}} military/possible military flights. Click to zoom in.",
                    count: cluster.count,
                  })
                : t("dashboard.charts.warMap.tooltip.clusterLayer", {
                    count: cluster.count,
                    layer: layerLabel,
                  }),
            color: representative?.color ?? color,
            radius: clusterRadius(cluster.count),
            kind: "layer-cluster",
            layerId,
            symbolKey:
              representative?.symbolKey ??
              (layerId === "flights" ? "flight" : "generic-point"),
            accentColor: representative?.accentColor ?? pointAccentColor,
            isCluster: true,
            clusterCount: cluster.count,
          };
        })
      : [];

    if (layerId !== "flights" && points.length > 0) {
      activePointLayers.push({
        key: layerId,
        label: layerLabel,
        accentColor: pointAccentColor,
      });
    }

    if (pointSingles.length > 0 || pointClusters.length > 0) {
      staticLayers.push(
        ...buildSymbolPointLayers({
          id: `wm-point-${layerId}`,
          data: [...pointClusters, ...pointSingles],
          pickable,
          onClick: onLayerPointClick,
          getAngle:
            layerId === "flights" ? resolveAircraftIconAngle : undefined,
        }),
      );
    }
  }

  return {
    layers: staticLayers,
    activePointLayers,
  };
}
