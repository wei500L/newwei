import { getWarMapAisLabel, readWarMapAisProperties } from "./war-map-ais";
import type { WarMapLayersResponse } from "./war-map-data";
import { getWarMapFlightLabel, readWarMapFlightProperties } from "./war-map-flights";
import { isValidLatLng } from "./war-map-point-model";
import { toTransportSelectionKey, type WarMapTransportSelectionEntry } from "./war-map-selection-model";

/**
 * 从 layers 数据派生运输选择条目（FE-批4A：从 war-map.tsx
 * transportSelections 迁移）：flights（opensky 机位）与 AIS vessel（mmsi）。
 * 仅收集 Inspector 可解析的点位（不含渲染图层）。
 */
export function buildWarMapTransportSelections(
  layersData: WarMapLayersResponse["layers"],
): WarMapTransportSelectionEntry[] {
  const selections: WarMapTransportSelectionEntry[] = [];

  const flightsDataset = layersData.flights;
  if (flightsDataset?.geometryType === "point") {
    for (const feature of flightsDataset.features) {
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
      const flight = readWarMapFlightProperties(properties);
      if (!flight) {
        continue;
      }
      const objectKey = `opensky:${flight.icao24}`;
      selections.push({
        objectKey,
        transportKind: "aircraft",
        label: getWarMapFlightLabel(flight, flight.icao24.toUpperCase()),
        subtitle:
          flight.displayCategoryZh ??
          flight.displayCategory ??
          flight.roleZh ??
          flight.role,
        latestAt: flight.observedAt,
        sourceUpdatedAt: flight.sourceUpdatedAt,
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
        lat: feature.lat,
        lng: feature.lng,
        selectionKey: toTransportSelectionKey("aircraft", objectKey),
      });
    }
  }

  const aisDataset = layersData.ais;
  if (aisDataset?.geometryType === "point") {
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
      const ais = readWarMapAisProperties(properties);
      if (!ais || ais.featureKind !== "vessel") {
        continue;
      }
      const objectKey = `ais:${ais.mmsi}`;
      selections.push({
        objectKey,
        transportKind: "vessel",
        label: getWarMapAisLabel(ais, `MMSI ${ais.mmsi}`),
        subtitle:
          ais.vesselRoleZh ??
          ais.vesselRole ??
          ais.shipTypeLabelZh ??
          ais.shipTypeLabel,
        latestAt: ais.observedAt,
        sourceUpdatedAt: ais.sourceUpdatedAt,
        name: ais.name,
        mmsi: ais.mmsi,
        shipType: ais.shipType,
        shipTypeLabel: ais.shipTypeLabel,
        shipTypeLabelZh: ais.shipTypeLabelZh,
        vesselRole: ais.vesselRole,
        vesselRoleZh: ais.vesselRoleZh,
        heading: ais.heading,
        speed: ais.speed,
        course: ais.course,
        isMilitaryCandidate: ais.isMilitaryCandidate,
        lat: feature.lat,
        lng: feature.lng,
        selectionKey: toTransportSelectionKey("vessel", objectKey),
      });
    }
  }

  return selections;
}
