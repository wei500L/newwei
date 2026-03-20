import type {
  WarMapAisDensityProperties,
  WarMapAisDisruptionProperties,
  WarMapAisFeatureKind,
  WarMapAisVesselProperties,
  WarMapEventSeverity,
} from "@modular/utils";

type WarMapAisReadableVesselProperties = WarMapAisVesselProperties & {
  description?: string;
};

type WarMapAisReadableDensityProperties = WarMapAisDensityProperties & {
  description?: string;
  name?: string;
};

type WarMapAisReadableDisruptionProperties = WarMapAisDisruptionProperties;

export type WarMapAisReadableProperties =
  | WarMapAisReadableVesselProperties
  | WarMapAisReadableDensityProperties
  | WarMapAisReadableDisruptionProperties;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeMmsi(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? String(normalized) : undefined;
  }

  const trimmed = normalizeString(value);
  if (!trimmed) {
    return undefined;
  }

  return /^[0-9]{6,12}$/.test(trimmed) ? trimmed : undefined;
}

function normalizeSeverity(value: unknown): WarMapEventSeverity | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  if (
    normalized === "high" ||
    normalized === "medium" ||
    normalized === "low"
  ) {
    return normalized;
  }
  if (normalized === "elevated") {
    return "medium";
  }
  return undefined;
}

function normalizeFeatureKind(
  value: unknown,
): WarMapAisFeatureKind | undefined {
  const normalized = normalizeString(value)?.toLowerCase();
  if (
    normalized === "vessel" ||
    normalized === "density" ||
    normalized === "disruption"
  ) {
    return normalized;
  }
  return undefined;
}

function readFirstString(
  properties: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const normalized = normalizeString(properties[key]);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function readTranslatedString(
  properties: Record<string, unknown>,
  translatedKeys: readonly string[],
  fallbackKeys: readonly string[],
): string | undefined {
  return readFirstString(properties, [...translatedKeys, ...fallbackKeys]);
}

function readFirstNumber(
  properties: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const normalized = normalizeNumber(properties[key]);
    if (typeof normalized === "number") {
      return normalized;
    }
  }
  return undefined;
}

function inferFeatureKind(
  properties: Record<string, unknown>,
): WarMapAisFeatureKind | undefined {
  if (normalizeMmsi(properties.mmsi)) {
    return "vessel";
  }
  if (typeof normalizeNumber(properties.intensity) === "number") {
    return "density";
  }
  if (
    normalizeString(properties.disruptionType) ||
    normalizeString(properties.type)
  ) {
    return "disruption";
  }
  if (
    readTranslatedString(properties, ["nameZh"], ["name"]) &&
    (normalizeSeverity(properties.severity) ||
      typeof normalizeNumber(properties.vesselCount) === "number" ||
      typeof normalizeNumber(properties.darkShips) === "number")
  ) {
    return "disruption";
  }
  return undefined;
}

export function readWarMapAisProperties(
  properties: Record<string, unknown> | null | undefined,
): WarMapAisReadableProperties | null {
  if (!isRecord(properties)) {
    return null;
  }

  const sourceType = normalizeString(properties.sourceType)?.toLowerCase();
  if (sourceType && sourceType !== "ais") {
    return null;
  }

  const featureKind =
    normalizeFeatureKind(properties.featureKind) ??
    inferFeatureKind(properties);

  if (featureKind === "vessel") {
    const mmsi = normalizeMmsi(properties.mmsi);
    if (!mmsi) {
      return null;
    }

    return {
      sourceType: "ais",
      featureKind: "vessel",
      mmsi,
      name: readTranslatedString(properties, ["nameZh"], [
        "name",
        "vesselName",
        "label",
      ]),
      shipType: readFirstNumber(properties, ["shipType"]),
      shipTypeLabel: readTranslatedString(
        properties,
        ["shipTypeLabelZh"],
        ["shipTypeLabel"],
      ),
      shipTypeLabelZh: readFirstString(properties, ["shipTypeLabelZh"]),
      vesselRole: readTranslatedString(properties, ["vesselRoleZh", "roleZh"], [
        "vesselRole",
        "role",
      ]),
      vesselRoleZh: readFirstString(properties, ["vesselRoleZh", "roleZh"]),
      isMilitaryCandidate: properties.isMilitaryCandidate === true,
      heading: readFirstNumber(properties, ["heading"]),
      speed: readFirstNumber(properties, ["speed"]),
      course: readFirstNumber(properties, ["course"]),
      observedAt: readFirstString(properties, [
        "observedAt",
        "timestamp",
        "sourceUpdatedAt",
      ]),
      sourceUpdatedAt: readFirstString(properties, ["sourceUpdatedAt"]),
      description: readTranslatedString(properties, ["descriptionZh"], [
        "description",
      ]),
    };
  }

  if (featureKind === "density") {
    const intensity = readFirstNumber(properties, ["intensity"]);
    if (typeof intensity !== "number") {
      return null;
    }

    return {
      sourceType: "ais",
      featureKind: "density",
      intensity,
      deltaPct: readFirstNumber(properties, ["deltaPct"]),
      shipsPerDay: readFirstNumber(properties, ["shipsPerDay"]),
      note: readTranslatedString(properties, ["descriptionZh"], [
        "note",
        "description",
      ]),
      name: readTranslatedString(properties, ["nameZh"], ["name", "label"]),
      description: readTranslatedString(properties, ["descriptionZh"], [
        "description",
      ]),
    };
  }

  if (featureKind === "disruption") {
    const name = readTranslatedString(properties, ["nameZh"], [
      "name",
      "label",
    ]);
    const disruptionType = readFirstString(properties, [
      "disruptionType",
      "type",
    ]);
    const severity = normalizeSeverity(properties.severity);
    if (!name || !disruptionType || !severity) {
      return null;
    }

    return {
      sourceType: "ais",
      featureKind: "disruption",
      name,
      disruptionType,
      severity,
      vesselCount: readFirstNumber(properties, ["vesselCount"]),
      changePct: readFirstNumber(properties, ["changePct"]),
      windowHours: readFirstNumber(properties, ["windowHours"]),
      region: readFirstString(properties, ["region"]),
      description: readTranslatedString(properties, ["descriptionZh"], [
        "description",
      ]),
      darkShips: readFirstNumber(properties, ["darkShips"]),
    };
  }

  return null;
}

export function getWarMapAisLabel(
  properties: WarMapAisReadableProperties,
  fallbackLabel: string,
): string {
  if (properties.featureKind === "vessel") {
    if (properties.name && properties.name !== properties.mmsi) {
      return properties.name;
    }
    return properties.mmsi ? `MMSI ${properties.mmsi}` : fallbackLabel;
  }

  if (properties.featureKind === "density") {
    return properties.name ?? properties.note ?? fallbackLabel;
  }

  return properties.name || fallbackLabel;
}
