import type { WarMapFlightProperties } from '@modular/utils';

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function readWarMapFlightProperties(
  properties: Record<string, unknown> | null | undefined,
): WarMapFlightProperties | null {
  if (!properties || properties.sourceType !== 'opensky') {
    return null;
  }

  const icao24 = normalizeString(properties.icao24)?.toLowerCase();
  if (!icao24) {
    return null;
  }

  return {
    sourceType: 'opensky',
    source: normalizeString(properties.source),
    callsign: normalizeString(properties.callsign),
    icao24,
    registration: normalizeString(properties.registration),
    aircraftType: normalizeString(properties.aircraftType),
    countryCode: normalizeString(properties.countryCode)?.toUpperCase(),
    countryName: normalizeString(properties.countryName),
    heading: normalizeNumber(properties.heading),
    altitudeFt: normalizeNumber(properties.altitudeFt),
    groundSpeedKt: normalizeNumber(properties.groundSpeedKt),
    observedAt: normalizeString(properties.observedAt),
    sourceUpdatedAt: normalizeString(properties.sourceUpdatedAt),
  };
}

export function getWarMapFlightLabel(
  flight: WarMapFlightProperties,
  fallbackLabel: string,
): string {
  return (
    flight.callsign ??
    flight.registration ??
    flight.icao24.toUpperCase() ??
    fallbackLabel
  );
}
