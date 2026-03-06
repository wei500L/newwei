import { describe, expect, it } from 'vitest';

import {
  buildDefaultSituationMonitorLayoutPayload,
  fingerprintSituationMonitorLayout,
  normalizeSituationMonitorLayoutPayload,
} from '../lib/situation-monitor-layout-serialization';

describe('situation monitor layout serialization', () => {
  it('builds defaults in breakpoint-aware format', () => {
    const payload = buildDefaultSituationMonitorLayoutPayload();

    expect(payload.layouts.lg?.length).toBeGreaterThan(0);
    expect(payload.layouts.sm).toBeUndefined();
    expect(payload.visibility.map).toBe(true);
  });

  it('normalizes legacy payloads into the lg breakpoint', () => {
    const normalized = normalizeSituationMonitorLayoutPayload({
      layout: [{ i: 'feeds-politics', x: 0, y: 0, w: 4, h: 7 }],
      visibility: { alerts: false },
    });

    expect(normalized.layouts.lg).toEqual([
      { i: 'feeds-politics', x: 0, y: 0, w: 4, h: 7, minW: undefined, minH: undefined, maxW: undefined, maxH: undefined, static: undefined },
    ]);
    expect(normalized.visibility).toEqual({ alerts: false });
  });

  it('fingerprints responsive payloads without legacy layout keys', () => {
    const fingerprint = fingerprintSituationMonitorLayout({
      layouts: {
        lg: [{ i: 'feeds-politics', x: 0, y: 0, w: 4, h: 7 }],
        sm: [{ i: 'feeds-politics', x: 0, y: 0, w: 6, h: 5 }],
      },
      visibility: { alerts: true },
    });

    expect(fingerprint).toContain('"layouts"');
    expect(fingerprint).toContain('"sm"');
    expect(fingerprint).not.toContain('"layout":[');
  });
});
