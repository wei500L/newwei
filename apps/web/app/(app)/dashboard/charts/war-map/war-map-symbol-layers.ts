import { IconLayer, TextLayer } from "@deck.gl/layers";

import {
  createWarMapLegendPointMatcher,
  resolveDeckPointClusterTextOffset,
  resolveDeckPointClusterTextSize,
  resolveDeckPointSymbolSize,
  resolveDeckPointSymbolState,
  type DeckPoint,
} from "./war-map-point-model";
import {
  formatWarMapClusterCountLabel,
  getWarMapDeckIcon,
} from "./war-map-symbols";

/** 图层构建回调的 picking 形状（与原 buildSymbolPointLayers 一致）。 */
export type WarMapDeckLayerClickHandler = (info: {
  object?: DeckPoint;
}) => void;

export interface WarMapSymbolLayerContext {
  hoveredInteractionKey: string | null;
  selectedInspectorKey: string | null;
  /** legend focus 优先于 hover 的高亮键。 */
  highlightedLegendItemKey: string | null;
  onPointHover: (info: { object?: DeckPoint }) => void;
}

export interface BuildWarMapSymbolPointLayersInput {
  id: string;
  data: DeckPoint[];
  onClick?: WarMapDeckLayerClickHandler;
  pickable?: boolean;
  getAngle?: (point: DeckPoint) => number | null;
}

/**
 * 构造共享的符号点位图层工厂（FE-批4A：从 war-map.tsx buildSymbolPointLayers
 * 迁移）。返回的 builder 语义与原 useCallback 版本一致：
 * - legend 高亮时按匹配器拆分 emphasized / muted 两组 IconLayer
 *   （muted 透明度 0.44、尺寸 -0.5；emphasized 尺寸 +1.5）；
 * - 聚类点附带 TextLayer 计数（primary 248 / muted 134 透明度）；
 * - 空 data 直接返回空数组（不产生图层实例）。
 */
export function createWarMapSymbolLayerBuilder(context: WarMapSymbolLayerContext) {
  const {
    hoveredInteractionKey,
    selectedInspectorKey,
    highlightedLegendItemKey,
    onPointHover,
  } = context;

  return function buildSymbolPointLayers({
    id,
    data,
    onClick,
    pickable = true,
    getAngle,
  }: BuildWarMapSymbolPointLayersInput): unknown[] {
    if (data.length === 0) {
      return [];
    }

    const pointMatchesHighlightedLegendItem = createWarMapLegendPointMatcher(
      highlightedLegendItemKey,
    );
    const emphasizedPoints = pointMatchesHighlightedLegendItem
      ? data.filter((point) => pointMatchesHighlightedLegendItem(point))
      : data;
    const mutedPoints = pointMatchesHighlightedLegendItem
      ? data.filter((point) => !pointMatchesHighlightedLegendItem(point))
      : [];
    const layers: unknown[] = [];
    const buildIconLayer = ({
      layerData,
      layerSuffix,
      opacity,
      sizeBoost,
    }: {
      layerData: DeckPoint[];
      layerSuffix: string;
      opacity: number;
      sizeBoost: number;
    }) =>
      new IconLayer({
        id: `${id}-symbols-${layerSuffix}`,
        data: layerData,
        pickable,
        billboard: true,
        opacity,
        sizeUnits: "pixels",
        getPosition: (point: DeckPoint) => [point.lng, point.lat],
        getIcon: (point: DeckPoint) =>
          getWarMapDeckIcon({
            symbolKey: point.symbolKey,
            state: resolveDeckPointSymbolState({
              point,
              hoveredInteractionKey,
              selectedInspectorKey,
            }),
            accentColor: point.accentColor,
          }),
        getSize: (point: DeckPoint) =>
          resolveDeckPointSymbolSize({
            point,
            hoveredInteractionKey,
            selectedInspectorKey,
          }) + sizeBoost,
        getAngle: (point: DeckPoint) => getAngle?.(point) ?? 0,
        sizeMinPixels: 18,
        sizeMaxPixels: 64,
        onHover: pickable ? onPointHover : undefined,
        onClick,
      });

    if (mutedPoints.length > 0) {
      layers.push(
        buildIconLayer({
          layerData: mutedPoints,
          layerSuffix: "muted",
          opacity: 0.44,
          sizeBoost: -0.5,
        }),
      );
    }

    if (emphasizedPoints.length > 0) {
      layers.push(
        buildIconLayer({
          layerData: emphasizedPoints,
          layerSuffix: "primary",
          opacity: 1,
          sizeBoost: pointMatchesHighlightedLegendItem ? 1.5 : 0,
        }),
      );
    }

    const buildClusterTextLayer = ({
      layerData,
      layerSuffix,
      colorAlpha,
    }: {
      layerData: DeckPoint[];
      layerSuffix: string;
      colorAlpha: number;
    }) =>
      new TextLayer({
        id: `${id}-counts-${layerSuffix}`,
        data: layerData,
        pickable,
        billboard: true,
        getPosition: (point: DeckPoint) => [point.lng, point.lat],
        getText: (point: DeckPoint) =>
          formatWarMapClusterCountLabel(point.clusterCount ?? 0),
        getSize: (point: DeckPoint) => resolveDeckPointClusterTextSize(point),
        getPixelOffset: (point: DeckPoint) =>
          resolveDeckPointClusterTextOffset(point),
        getColor: [15, 23, 42, colorAlpha],
        fontWeight: 700,
        getTextAnchor: "middle",
        getAlignmentBaseline: "center",
        onHover: pickable ? onPointHover : undefined,
        onClick,
      });

    const clusters = emphasizedPoints.filter(
      (point) => point.isCluster && typeof point.clusterCount === "number",
    );
    if (clusters.length > 0) {
      layers.push(
        buildClusterTextLayer({
          layerData: clusters,
          layerSuffix: "primary",
          colorAlpha: 248,
        }),
      );
    }

    const mutedClusters = mutedPoints.filter(
      (point) => point.isCluster && typeof point.clusterCount === "number",
    );
    if (mutedClusters.length > 0) {
      layers.push(
        buildClusterTextLayer({
          layerData: mutedClusters,
          layerSuffix: "muted",
          colorAlpha: 134,
        }),
      );
    }

    return layers;
  };
}
