import { PathLayer, PolygonLayer } from "@deck.gl/layers";
import type {
  WarMapFlightMode,
  WarMapLayerFeature,
  WarMapLayerId,
  WarMapLayerVisibility,
  WarMapTranslateTarget,
} from "@modular/utils";
import { WAR_MAP_LAYER_IDS } from "@modular/utils";

import {
  clusterWarMapPoints,
  computeAverageClusterGeometry,
} from "./war-map-clustering";
import { WAR_MAP_UNSUPPORTED_LAYER_IDS, type WarMapLayersResponse } from "./war-map-data";
import {
  getWarMapFlightLabel,
  readWarMapFlightProperties,
} from "./war-map-flights";
import {
  buildSanitizedPathGeometry,
  buildSanitizedPolygonResult,
  isValidDeckCoordinate,
  type DeckCoordinate,
} from "./war-map-geometry";
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
import type { BuildWarMapSymbolPointLayersInput } from "./war-map-symbol-layers";
import {
  coerceHexColor,
  getWarMapSymbolAccentColor,
  type WarMapActivePointLayerLegendItem,
} from "./war-map-symbols";
import type { WarMapBbox } from "./query-viewport";

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

const warMapSanitizationWarningSignatures = new Map<string, string>();

/** 几何消毒告警（同签名去重，避免刷屏）。 */
function warnWarMapGeometrySanitization(
  kind: "path" | "polygon",
  layerId: WarMapLayerId,
  payload: Record<string, unknown>,
): void {
  const warningKey = `${kind}:${layerId}`;
  const signature = JSON.stringify(payload);
  if (warMapSanitizationWarningSignatures.get(warningKey) === signature) {
    return;
  }
  warMapSanitizationWarningSignatures.set(warningKey, signature);
  console.warn(
    `[WarMap] ${kind} geometry sanitized for layer "${layerId}".`,
    payload,
  );
}

function countInvalidPathCoordinates(path: unknown): number {
  if (!Array.isArray(path)) {
    return 0;
  }

  let invalidCount = 0;
  for (const coordinate of path) {
    if (!isValidDeckCoordinate(coordinate)) {
      invalidCount += 1;
    }
  }
  return invalidCount;
}

function summarizePolygonInput(polygon: unknown): {
  invalidCoordinateCount: number;
  malformedRingCount: number;
  ringCount: number;
} {
  if (!Array.isArray(polygon)) {
    return {
      invalidCoordinateCount: 0,
      malformedRingCount: 0,
      ringCount: 0,
    };
  }

  let invalidCoordinateCount = 0;
  let malformedRingCount = 0;
  for (const ring of polygon) {
    if (!Array.isArray(ring)) {
      malformedRingCount += 1;
      continue;
    }

    for (const coordinate of ring) {
      if (!isValidDeckCoordinate(coordinate)) {
        invalidCoordinateCount += 1;
      }
    }
  }

  return {
    invalidCoordinateCount,
    malformedRingCount,
    ringCount: polygon.length,
  };
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

    const readLayerFeatureCopy = (
      feature: Pick<WarMapLayerFeature, "id" | "properties">,
    ) => {
      const properties =
        feature.properties &&
        typeof feature.properties === "object" &&
        !Array.isArray(feature.properties)
          ? (feature.properties as Record<string, unknown>)
          : undefined;
      const label =
        typeof properties?.nameZh === "string" && translateTarget === "zh-CN"
          ? properties.nameZh
          : typeof properties?.name === "string"
            ? properties.name
            : layerLabel;
      const description =
        typeof properties?.descriptionZh === "string" &&
        translateTarget === "zh-CN"
          ? properties.descriptionZh
          : typeof properties?.description === "string"
            ? properties.description
            : undefined;

      return { description, label, properties };
    };

    if (dataset.geometryType === "path") {
      const paths: (WarMapLayerFeature & { path: DeckCoordinate[] })[] = [];
      const pathFallbackPoints: DeckPoint[] = [];
      const pathSanitizationSummary = {
        affectedFeatureCount: 0,
        invalidCoordinateCount: 0,
        splitFeatureCount: 0,
        renderedPathSegmentCount: 0,
        pointFallbackCount: 0,
        sampleFeatureIds: [] as string[],
      };

      for (const feature of dataset.features) {
        const sanitized = buildSanitizedPathGeometry(feature);
        const invalidCoordinateCount = countInvalidPathCoordinates(
          feature.path,
        );
        const wasSplit = sanitized.pathFeatures.length > 1;
        const hadPointFallback = sanitized.pointFeatures.length > 0;
        if (invalidCoordinateCount > 0 || wasSplit || hadPointFallback) {
          pathSanitizationSummary.affectedFeatureCount += 1;
          pathSanitizationSummary.invalidCoordinateCount +=
            invalidCoordinateCount;
          pathSanitizationSummary.renderedPathSegmentCount +=
            sanitized.pathFeatures.length;
          pathSanitizationSummary.pointFallbackCount +=
            sanitized.pointFeatures.length;
          if (wasSplit) {
            pathSanitizationSummary.splitFeatureCount += 1;
          }
          if (pathSanitizationSummary.sampleFeatureIds.length < 5) {
            pathSanitizationSummary.sampleFeatureIds.push(feature.id);
          }
        }
        paths.push(...sanitized.pathFeatures);

        const { description, label } = readLayerFeatureCopy(feature);
        for (const fallbackPoint of sanitized.pointFeatures) {
          pathFallbackPoints.push({
            id: `path-fallback:${layerId}:${feature.id}:${pathFallbackPoints.length}`,
            interactionKey: `path-fallback:${layerId}:${feature.id}:${pathFallbackPoints.length}`,
            lat: fallbackPoint.lat,
            lng: fallbackPoint.lng,
            label,
            description,
            color,
            radius: fallbackPointRadius,
            kind: "layer",
            layerId,
            symbolKey: "generic-point",
            accentColor: pointAccentColor,
          });
        }
      }

      if (pathSanitizationSummary.affectedFeatureCount > 0) {
        warnWarMapGeometrySanitization(
          "path",
          layerId,
          pathSanitizationSummary,
        );
      }
      if (paths.length > 0) {
        staticLayers.push(
          new PathLayer({
            id: `wm-path-${layerId}`,
            data: paths,
            pickable,
            getPath: (
              feature: WarMapLayerFeature & { path: DeckCoordinate[] },
            ) => feature.path,
            getColor: color,
            getWidth: 2,
            widthMinPixels: 1.4,
            widthMaxPixels: 5,
          }),
        );
      }
      if (pathFallbackPoints.length > 0) {
        staticLayers.push(
          ...buildSymbolPointLayers({
            id: `wm-path-${layerId}-points`,
            data: pathFallbackPoints,
            pickable,
            onClick: onLayerPointClick,
          }),
        );
      }
      continue;
    }

    if (dataset.geometryType === "polygon") {
      const polygons: (WarMapLayerFeature & {
        polygon: DeckCoordinate[][];
      })[] = [];
      const polygonOutlineFeatures: (WarMapLayerFeature & {
        path: DeckCoordinate[];
      })[] = [];
      const polygonFallbackPoints: DeckPoint[] = [];
      const polygonSanitizationSummary = {
        affectedFeatureCount: 0,
        invalidCoordinateCount: 0,
        malformedRingCount: 0,
        degradedFillCount: 0,
        outlineFragmentCount: 0,
        pointFallbackCount: 0,
        sampleFeatureIds: [] as string[],
      };

      for (const feature of dataset.features) {
        const sanitized = buildSanitizedPolygonResult(feature);
        const inputSummary = summarizePolygonInput(feature.polygon);
        const degradedFill =
          Array.isArray(feature.polygon) &&
          feature.polygon.length > 0 &&
          sanitized.polygonFeature === null;
        if (
          inputSummary.invalidCoordinateCount > 0 ||
          inputSummary.malformedRingCount > 0 ||
          degradedFill ||
          sanitized.outlineFeatures.length > 0 ||
          sanitized.pointFeatures.length > 0
        ) {
          polygonSanitizationSummary.affectedFeatureCount += 1;
          polygonSanitizationSummary.invalidCoordinateCount +=
            inputSummary.invalidCoordinateCount;
          polygonSanitizationSummary.malformedRingCount +=
            inputSummary.malformedRingCount;
          polygonSanitizationSummary.outlineFragmentCount +=
            sanitized.outlineFeatures.length;
          polygonSanitizationSummary.pointFallbackCount +=
            sanitized.pointFeatures.length;
          if (degradedFill) {
            polygonSanitizationSummary.degradedFillCount += 1;
          }
          if (polygonSanitizationSummary.sampleFeatureIds.length < 5) {
            polygonSanitizationSummary.sampleFeatureIds.push(feature.id);
          }
        }
        if (sanitized.polygonFeature) {
          polygons.push(sanitized.polygonFeature);
        }
        polygonOutlineFeatures.push(...sanitized.outlineFeatures);

        const { description, label } = readLayerFeatureCopy(feature);
        for (const fallbackPoint of sanitized.pointFeatures) {
          polygonFallbackPoints.push({
            id: `polygon-fallback:${layerId}:${feature.id}:${polygonFallbackPoints.length}`,
            interactionKey: `polygon-fallback:${layerId}:${feature.id}:${polygonFallbackPoints.length}`,
            lat: fallbackPoint.lat,
            lng: fallbackPoint.lng,
            label,
            description,
            color,
            radius: fallbackPointRadius,
            kind: "layer",
            layerId,
            symbolKey: "generic-point",
            accentColor: pointAccentColor,
          });
        }
      }

      if (polygonSanitizationSummary.affectedFeatureCount > 0) {
        warnWarMapGeometrySanitization(
          "polygon",
          layerId,
          polygonSanitizationSummary,
        );
      }
      if (polygons.length > 0) {
        staticLayers.push(
          new PolygonLayer({
            id: `wm-polygon-${layerId}`,
            data: polygons,
            pickable,
            getPolygon: (
              feature: WarMapLayerFeature & { polygon: DeckCoordinate[][] },
            ) => feature.polygon[0] ?? [],
            getFillColor: color,
            getLineColor: toRgba(
              dataset.renderHints?.color,
              0.85,
              [59, 130, 246],
            ),
            lineWidthMinPixels: 1,
            filled: true,
            stroked: true,
          }),
        );
      }
      if (polygonOutlineFeatures.length > 0) {
        staticLayers.push(
          new PathLayer({
            id: `wm-polygon-${layerId}-fragments`,
            data: polygonOutlineFeatures,
            pickable,
            getPath: (
              feature: WarMapLayerFeature & { path: DeckCoordinate[] },
            ) => feature.path,
            getColor: toRgba(
              dataset.renderHints?.color,
              0.92,
              [59, 130, 246],
            ),
            getWidth: 2,
            widthMinPixels: 1.2,
            widthMaxPixels: 4,
          }),
        );
      }
      if (polygonFallbackPoints.length > 0) {
        staticLayers.push(
          ...buildSymbolPointLayers({
            id: `wm-polygon-${layerId}-points`,
            data: polygonFallbackPoints,
            pickable,
            onClick: onLayerPointClick,
          }),
        );
      }
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
