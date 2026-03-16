import { describe, expect, it } from "vitest";

import {
  getWarMapAisLabel,
  readWarMapAisProperties,
} from "../app/(app)/dashboard/charts/war-map/war-map-ais";

describe("war-map AIS helpers", () => {
  it("normalizes vessel properties defensively", () => {
    expect(
      readWarMapAisProperties({
        sourceType: "ais",
        featureKind: "vessel",
        mmsi: 123456789,
        name: "  USS Example  ",
        shipType: "55",
        heading: "182.4",
        speed: 21.6,
        course: "184",
        observedAt: "2026-03-16T12:00:00.000Z",
        description: "  Candidate vessel  ",
      }),
    ).toEqual({
      sourceType: "ais",
      featureKind: "vessel",
      mmsi: "123456789",
      name: "USS Example",
      shipType: 55,
      heading: 182.4,
      speed: 21.6,
      course: 184,
      observedAt: "2026-03-16T12:00:00.000Z",
      description: "Candidate vessel",
    });
  });

  it("infers density properties when feature kind is missing", () => {
    expect(
      readWarMapAisProperties({
        intensity: "0.78",
        deltaPct: "-12",
        shipsPerDay: 1640,
        note: "Heavy traffic lane",
        name: "Malacca Strait",
      }),
    ).toEqual({
      sourceType: "ais",
      featureKind: "density",
      intensity: 0.78,
      deltaPct: -12,
      shipsPerDay: 1640,
      note: "Heavy traffic lane",
      name: "Malacca Strait",
      description: undefined,
    });
  });

  it("normalizes disruption properties from fallback keys", () => {
    expect(
      readWarMapAisProperties({
        sourceType: "ais",
        name: " Bab el-Mandeb ",
        type: " congestion ",
        severity: " elevated ",
        vesselCount: "31",
        changePct: 44,
        windowHours: "24",
        region: "Red Sea",
        darkShips: "3",
      }),
    ).toEqual({
      sourceType: "ais",
      featureKind: "disruption",
      name: "Bab el-Mandeb",
      disruptionType: "congestion",
      severity: "medium",
      vesselCount: 31,
      changePct: 44,
      windowHours: 24,
      region: "Red Sea",
      description: undefined,
      darkShips: 3,
    });
  });

  it("rejects invalid or foreign AIS properties", () => {
    expect(readWarMapAisProperties(null)).toBeNull();
    expect(
      readWarMapAisProperties({
        sourceType: "opensky",
        featureKind: "vessel",
        mmsi: "123456789",
      }),
    ).toBeNull();
    expect(
      readWarMapAisProperties({
        sourceType: "ais",
        featureKind: "density",
        intensity: "unknown",
      }),
    ).toBeNull();
    expect(
      readWarMapAisProperties({
        sourceType: "ais",
        featureKind: "disruption",
        name: "Suez Canal",
        severity: "high",
      }),
    ).toBeNull();
  });

  it("picks the best available AIS label", () => {
    const vessel = readWarMapAisProperties({
      sourceType: "ais",
      featureKind: "vessel",
      mmsi: "123456789",
    });
    const vesselNameMatchesMmsi = readWarMapAisProperties({
      sourceType: "ais",
      featureKind: "vessel",
      mmsi: "123456789",
      name: "123456789",
    });
    const density = readWarMapAisProperties({
      sourceType: "ais",
      featureKind: "density",
      intensity: 0.6,
      note: "North Atlantic lane",
    });
    const disruption = readWarMapAisProperties({
      sourceType: "ais",
      featureKind: "disruption",
      name: "Suez Canal",
      disruptionType: "congestion",
      severity: "high",
    });

    expect(vessel).not.toBeNull();
    expect(vesselNameMatchesMmsi).not.toBeNull();
    expect(density).not.toBeNull();
    expect(disruption).not.toBeNull();
    expect(getWarMapAisLabel(vessel!, "Fallback")).toBe("MMSI 123456789");
    expect(getWarMapAisLabel(vesselNameMatchesMmsi!, "Fallback")).toBe(
      "MMSI 123456789",
    );
    expect(getWarMapAisLabel(density!, "Fallback")).toBe("North Atlantic lane");
    expect(getWarMapAisLabel(disruption!, "Fallback")).toBe("Suez Canal");
  });
});
