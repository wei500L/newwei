import { PathLayer, PolygonLayer } from "@deck.gl/layers";
import type { WarMapLayerFeature, WarMapLayerId, WarMapTranslateTarget } from "@modular/utils";
import type { WarMapLayerDataset } from "@modular/utils";

import {
  buildSanitizedPathGeometry,
  buildSanitizedPolygonResult,
  isValidDeckCoordinate,
  type DeckCoordinate,
} from "./war-map-geometry";
import type { DeckPoint } from "./war-map-point-model";
import type { BuildWarMapSymbolPointLayersInput } from "./war-map-symbol-layers";

export interface WarMapStaticVectorLayersOptions {
  dataset: WarMapLayerDataset;
  layerId: WarMapLayerId;
  layerLabel: string;
  color: [number, number, number, number];
  pointAccentColor: string | undefined;
  fallbackPointRadius: number;
  pickable: boolean;
  translateTarget?: WarMapTranslateTarget;
  buildSymbolPointLayers: (
    input: BuildWarMapSymbolPointLayersInput,
  ) => unknown[];
  onLayerPointClick: (info: { object?: DeckPoint }) => void;
}

export interface WarMapStaticVectorLayersResult {
  /** 是否为 path/polygon 几何（调用方据此 continue）。 */
  handled: boolean;
  layers: unknown[];
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


/** 读取图层要素的本地化文案（name/description）。 */
function readLayerFeatureCopy(
  feature: Pick<WarMapLayerFeature, "id" | "properties">,
  layerLabel: string,
  translateTarget?: WarMapTranslateTarget,
) {

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
}

/** 构造 path/polygon 静态图层（消毒 + 分段/回退点位）。 */
export function buildWarMapStaticVectorLayers(
  options: WarMapStaticVectorLayersOptions,
): WarMapStaticVectorLayersResult {
  const {
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
  } = options;
  const layers: unknown[] = [];
  const readCopy = (feature: Pick<WarMapLayerFeature, "id" | "properties">) =>
    readLayerFeatureCopy(feature, layerLabel, translateTarget);

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

        const { description, label } = readCopy(feature);
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

        const { description, label } = readCopy(feature);
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


  return { handled: true, layers };
}
