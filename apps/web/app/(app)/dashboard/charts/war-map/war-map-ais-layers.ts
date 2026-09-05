import { ScatterplotLayer } from "@deck.gl/layers";
import type { WarMapAisMode } from "@modular/utils";

import { getWarMapAisLabel, readWarMapAisProperties } from "./war-map-ais";
import type { WarMapLayersResponse } from "./war-map-data";
import type { WarMapTranslateFn } from "./war-map-overlay-model";
import {
  getAisDensityColor,
  getAisDisruptionColor,
  getAisShipTypeColor,
  isValidLatLng,
  resolveAisDisruptionSymbolKey,
  resolveAisVesselSymbolKey,
  resolveVesselIconAngle,
  type DeckPoint,
} from "./war-map-point-model";
import { toTransportSelectionKey } from "./war-map-selection-model";
import type { BuildWarMapSymbolPointLayersInput } from "./war-map-symbol-layers";
import { getWarMapSymbolAccentColor } from "./war-map-symbols";

export interface WarMapAisLayersOptions {
  layersData: WarMapLayersResponse["layers"];
  aisLayerVisible: boolean;
  effectiveAisMode: WarMapAisMode;
  aisHighlightCandidates: boolean;
  t: WarMapTranslateFn;
  buildSymbolPointLayers: (
    input: BuildWarMapSymbolPointLayersInput,
  ) => unknown[];
  onLayerPointClick: (info: { object?: DeckPoint }) => void;
  onSelectablePointClick: (info: { object?: DeckPoint }) => void;
}

export interface WarMapAisLayersResult {
  layers: unknown[];
  aisFeatureCount: number;
  aisHighlightedCandidateCount: number;
}

/**
 * 构造 AIS 图层（FE-批4A：从 war-map.tsx staticDeckData 的 AIS 部分迁移）。
 *
 * 按 featureKind 分三组：
 * - vessel：船型符号/颜色 + 军事候选高亮（all 模式且开启候选高亮时
 *   叠加 glow + ring ScatterplotLayer）；
 * - density：双 ScatterplotLayer（glow/core）+ 符号点位；
 * - disruption：按 severity 符号渲染。
 */
export function buildWarMapAisLayers(
  options: WarMapAisLayersOptions,
): WarMapAisLayersResult {
  const {
    layersData,
    aisLayerVisible,
    effectiveAisMode,
    aisHighlightCandidates,
    t,
    buildSymbolPointLayers,
    onLayerPointClick,
    onSelectablePointClick,
  } = options;

  const aisLayers: unknown[] = [];
  const aisDataset = aisLayerVisible && layersData.ais ? layersData.ais : null;
  let aisFeatureCount = 0;
  let aisHighlightedCandidateCount = 0;

  if (aisDataset?.geometryType === "point") {
    const aisVessels: DeckPoint[] = [];
    const aisDensityZones: DeckPoint[] = [];
    const aisDisruptions: DeckPoint[] = [];

    for (const feature of aisDataset.features) {
      if (
        typeof feature.lat !== "number" ||
        typeof feature.lng !== "number" ||
        !isValidLatLng(feature.lat, feature.lng)
      ) {
        continue;
      }
      const properties =
        feature.properties &&
        typeof feature.properties === "object" &&
        !Array.isArray(feature.properties)
          ? (feature.properties as Record<string, unknown>)
          : undefined;
      const aisProperties = readWarMapAisProperties(properties);
      if (!aisProperties) {
        continue;
      }

      const label = getWarMapAisLabel(
        aisProperties,
        t("dashboard.charts.warMap.layerNames.ais"),
      );

      if (aisProperties.featureKind === "vessel") {
        const objectKey = `ais:${aisProperties.mmsi}`;
        const symbolKey = resolveAisVesselSymbolKey(aisProperties.shipType);
        aisVessels.push({
          id: `ais-vessel-${feature.id}`,
          interactionKey: `ais:vessel:${objectKey}`,
          lat: feature.lat,
          lng: feature.lng,
          label,
          color: getAisShipTypeColor(aisProperties.shipType),
          radius: effectiveAisMode === "military" ? 7 : 5,
          kind: "layer",
          layerId: "ais",
          symbolKey,
          accentColor: getWarMapSymbolAccentColor(symbolKey),
          sourceType: "ais",
          aisFeatureKind: "vessel",
          selectionKey: toTransportSelectionKey("vessel", objectKey),
          mmsi: aisProperties.mmsi,
          shipType: aisProperties.shipType,
          shipTypeLabel: aisProperties.shipTypeLabel,
          shipTypeLabelZh: aisProperties.shipTypeLabelZh,
          vesselRole: aisProperties.vesselRole,
          vesselRoleZh: aisProperties.vesselRoleZh,
          isMilitaryCandidate: aisProperties.isMilitaryCandidate,
          heading: aisProperties.heading,
          speed: aisProperties.speed,
          course: aisProperties.course,
          latestAt: aisProperties.observedAt,
          sourceUpdatedAt:
            aisProperties.sourceUpdatedAt ?? aisDataset.updatedAt,
          description:
            effectiveAisMode === "military"
              ? t("dashboard.charts.warMap.stats.aisMilitaryCandidates")
              : t("dashboard.charts.warMap.stats.aisVessels"),
        });
        continue;
      }

      if (aisProperties.featureKind === "density") {
        const intensity = Math.max(0, Math.min(1, aisProperties.intensity));
        aisDensityZones.push({
          id: `ais-density-${feature.id}`,
          interactionKey: `ais:density:${feature.id}`,
          lat: feature.lat,
          lng: feature.lng,
          label,
          color: getAisDensityColor(intensity, 0.34),
          radius: 12 + intensity * 18,
          kind: "layer",
          layerId: "ais",
          symbolKey: "ais-density",
          accentColor: getWarMapSymbolAccentColor("ais-density"),
          sourceType: "ais",
          aisFeatureKind: "density",
          intensity,
          deltaPct: aisProperties.deltaPct,
          shipsPerDay: aisProperties.shipsPerDay,
          latestAt: feature.timestamp ?? aisDataset.updatedAt,
          sourceUpdatedAt: aisDataset.updatedAt,
          description:
            aisProperties.description ??
            aisProperties.note ??
            t("dashboard.charts.warMap.stats.aisDensityAggregateHint"),
        });
        continue;
      }

      const symbolKey = resolveAisDisruptionSymbolKey(aisProperties.severity);
      aisDisruptions.push({
        id: `ais-disruption-${feature.id}`,
        interactionKey: `ais:disruption:${feature.id}`,
        lat: feature.lat,
        lng: feature.lng,
        label,
        color: getAisDisruptionColor(aisProperties.severity),
        radius:
          aisProperties.severity === "high"
            ? 18
            : aisProperties.severity === "medium"
              ? 14
              : 11,
        kind: "layer",
        layerId: "ais",
        symbolKey,
        accentColor: getWarMapSymbolAccentColor(symbolKey),
        sourceType: "ais",
        aisFeatureKind: "disruption",
        severity: aisProperties.severity,
        disruptionType: aisProperties.disruptionType,
        vesselCount: aisProperties.vesselCount,
        changePct: aisProperties.changePct,
        windowHours: aisProperties.windowHours,
        region: aisProperties.region,
        darkShips: aisProperties.darkShips,
        latestAt: feature.timestamp ?? aisDataset.updatedAt,
        sourceUpdatedAt: aisDataset.updatedAt,
        description:
          aisProperties.description ??
          t("dashboard.charts.warMap.stats.aisDisruptionAggregateHint"),
      });
    }

    aisFeatureCount =
      aisVessels.length + aisDensityZones.length + aisDisruptions.length;

    if (aisDensityZones.length > 0) {
      aisLayers.push(
        new ScatterplotLayer({
          id: "wm-ais-density-glow",
          data: aisDensityZones,
          pickable: false,
          stroked: false,
          filled: true,
          getPosition: (point: DeckPoint) => [point.lng, point.lat],
          getFillColor: (point: DeckPoint) =>
            getAisDensityColor(
              point.intensity ?? 0.2,
              0.1 + (point.intensity ?? 0.2) * 0.18,
            ),
          getRadius: (point: DeckPoint) => point.radius * 2.6,
          radiusMinPixels: 22,
          radiusMaxPixels: 76,
        }),
      );
      aisLayers.push(
        new ScatterplotLayer({
          id: "wm-ais-density-core",
          data: aisDensityZones,
          pickable: false,
          stroked: false,
          filled: true,
          getPosition: (point: DeckPoint) => [point.lng, point.lat],
          getFillColor: (point: DeckPoint) =>
            getAisDensityColor(
              point.intensity ?? 0.2,
              0.22 + (point.intensity ?? 0.2) * 0.2,
            ),
          getRadius: (point: DeckPoint) => point.radius * 1.6,
          radiusMinPixels: 14,
          radiusMaxPixels: 48,
        }),
      );
      aisLayers.push(
        ...buildSymbolPointLayers({
          id: "wm-ais-density-zones",
          data: aisDensityZones,
          onClick: onLayerPointClick,
        }),
      );
    }

    if (aisDisruptions.length > 0) {
      aisLayers.push(
        ...buildSymbolPointLayers({
          id: "wm-ais-disruptions",
          data: aisDisruptions,
          onClick: onLayerPointClick,
        }),
      );
    }

    if (aisVessels.length > 0) {
      const highlightedCandidateVessels =
        effectiveAisMode === "all" && aisHighlightCandidates
          ? aisVessels.filter((point) => point.isMilitaryCandidate)
          : [];
      aisHighlightedCandidateCount = highlightedCandidateVessels.length;

      if (highlightedCandidateVessels.length > 0) {
        aisLayers.push(
          new ScatterplotLayer({
            id: "wm-ais-candidate-highlight-glow",
            data: highlightedCandidateVessels,
            pickable: false,
            stroked: false,
            filled: true,
            radiusUnits: "pixels",
            getPosition: (point: DeckPoint) => [point.lng, point.lat],
            getFillColor: [249, 115, 22, 72],
            getRadius: (point: DeckPoint) => point.radius + 8,
            radiusMinPixels: 12,
            radiusMaxPixels: 26,
          }),
        );
        aisLayers.push(
          new ScatterplotLayer({
            id: "wm-ais-candidate-highlight-ring",
            data: highlightedCandidateVessels,
            pickable: false,
            stroked: true,
            filled: false,
            radiusUnits: "pixels",
            lineWidthUnits: "pixels",
            getPosition: (point: DeckPoint) => [point.lng, point.lat],
            getLineColor: [249, 115, 22, 220],
            getRadius: (point: DeckPoint) => point.radius + 3.5,
            lineWidthMinPixels: 2.5,
          }),
        );
      }

      aisLayers.push(
        ...buildSymbolPointLayers({
          id: "wm-ais-vessels",
          data: aisVessels,
          onClick: onSelectablePointClick,
          getAngle: resolveVesselIconAngle,
        }),
      );
    }
  }

  return {
    layers: aisLayers,
    aisFeatureCount,
    aisHighlightedCandidateCount,
  };
}
