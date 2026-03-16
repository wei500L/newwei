import { describe, expect, it } from 'vitest';

import {
  getWarMapFlightLabel,
  readWarMapFlightProperties,
} from '../app/(app)/dashboard/charts/war-map/war-map-flights';

describe('war-map flights helpers', () => {
  it('normalizes OpenSky flight properties defensively', () => {
    expect(
      readWarMapFlightProperties({
        sourceType: 'opensky',
        callsign: ' SPAR416 ',
        icao24: 'AE017A',
        registration: '84-0142',
        aircraftType: 'LJ35',
        countryCode: 'us',
        countryName: 'United States',
        heading: '261.89',
        altitudeFt: 35975,
        groundSpeedKt: '375.8',
        observedAt: '2026-01-01T11:59:30.000Z',
        sourceUpdatedAt: '2026-01-01T12:00:00.000Z',
      }),
    ).toEqual({
      sourceType: 'opensky',
      callsign: 'SPAR416',
      icao24: 'ae017a',
      registration: '84-0142',
      aircraftType: 'LJ35',
      countryCode: 'US',
      countryName: 'United States',
      heading: 261.89,
      altitudeFt: 35975,
      groundSpeedKt: 375.8,
      observedAt: '2026-01-01T11:59:30.000Z',
      sourceUpdatedAt: '2026-01-01T12:00:00.000Z',
      source: undefined,
    });
  });

  it('picks the best available flight label', () => {
    const fromCallsign = readWarMapFlightProperties({
      sourceType: 'opensky',
      callsign: 'SPAR416',
      icao24: 'ae017a',
    });
    const fromRegistration = readWarMapFlightProperties({
      sourceType: 'opensky',
      registration: '84-0142',
      icao24: 'ae017a',
    });
    const fromHex = readWarMapFlightProperties({
      sourceType: 'opensky',
      icao24: 'ae017a',
    });

    expect(fromCallsign).not.toBeNull();
    expect(fromRegistration).not.toBeNull();
    expect(fromHex).not.toBeNull();
    expect(getWarMapFlightLabel(fromCallsign!, 'Fallback')).toBe('SPAR416');
    expect(getWarMapFlightLabel(fromRegistration!, 'Fallback')).toBe('84-0142');
    expect(getWarMapFlightLabel(fromHex!, 'Fallback')).toBe('AE017A');
  });
});
