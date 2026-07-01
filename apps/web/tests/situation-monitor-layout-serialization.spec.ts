import { describe, expect, it } from "vitest";

import {
  buildDefaultSituationMonitorLayoutPayload,
  fingerprintSituationMonitorLayout,
  hasSituationMonitorLayoutGeometry,
  normalizeSituationMonitorLayoutPayload,
} from "../lib/situation-monitor-layout-serialization";

describe("situation monitor layout serialization", () => {
  it("builds defaults in breakpoint-aware format", () => {
    const payload = buildDefaultSituationMonitorLayoutPayload();

    expect(payload.layouts.lg?.length).toBeGreaterThan(0);
    expect(payload.layouts.sm).toBeUndefined();
    expect(payload.visibility.summary).toBe(true);
    expect(payload.visibility.map).toBe(true);
    expect(payload.visibility["realtime-snapshot"]).toBe(true);
    expect(
      payload.layouts.lg?.some((entry) => entry.i === "realtime-snapshot"),
    ).toBe(true);
  });

  it("normalizes legacy payloads into the lg breakpoint", () => {
    const normalized = normalizeSituationMonitorLayoutPayload({
      layout: [{ i: "feeds-politics", x: 0, y: 0, w: 4, h: 7 }],
      visibility: { alerts: false },
    });

    expect(normalized.layouts.lg).toEqual([
      {
        i: "feeds-politics",
        x: 0,
        y: 0,
        w: 4,
        h: 7,
        minW: undefined,
        minH: undefined,
        maxW: undefined,
        maxH: undefined,
        static: undefined,
      },
    ]);
    expect(normalized.visibility).toEqual({ alerts: false });
  });

  it("fingerprints responsive payloads without legacy layout keys", () => {
    const fingerprint = fingerprintSituationMonitorLayout({
      layouts: {
        lg: [{ i: "feeds-politics", x: 0, y: 0, w: 4, h: 7 }],
        sm: [{ i: "feeds-politics", x: 0, y: 0, w: 6, h: 5 }],
      },
      visibility: { alerts: true },
    });

    expect(fingerprint).toContain('"layouts"');
    expect(fingerprint).toContain('"sm"');
    expect(fingerprint).not.toContain('"layout":[');
  });

  it("treats visibility-only legacy payloads as missing layout geometry", () => {
    expect(
      hasSituationMonitorLayoutGeometry({
        layout: [],
        visibility: { summary: true, map: true },
      }),
    ).toBe(false);

    expect(
      hasSituationMonitorLayoutGeometry({
        layouts: {
          lg: [{ i: "summary", x: 0, y: 0, w: 4, h: 4 }],
        },
        visibility: { summary: true },
      }),
    ).toBe(true);
  });
});
