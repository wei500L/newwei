import { describe, expect, it } from "vitest";

import { readWarMapAisProperties } from "../app/(app)/dashboard/charts/war-map/war-map-ais";
import { readWarMapFlightProperties } from "../app/(app)/dashboard/charts/war-map/war-map-flights";

describe("war map transport parsers", () => {
  it("reads localized aircraft fields", () => {
    expect(
      readWarMapFlightProperties({
        sourceType: "opensky",
        icao24: "ABC123",
        callsign: "RCH123",
        displayCategory: "Military flight",
        displayCategoryZh: "军事飞行",
        role: "Military transport",
        roleZh: "军用运输",
        heading: "92",
        altitudeFt: 18000,
        groundSpeedKt: "410",
      }),
    ).toMatchObject({
      sourceType: "opensky",
      icao24: "abc123",
      callsign: "RCH123",
      displayCategory: "Military flight",
      displayCategoryZh: "军事飞行",
      role: "Military transport",
      roleZh: "军用运输",
      heading: 92,
      altitudeFt: 18000,
      groundSpeedKt: 410,
    });
  });

  it("reads localized vessel fields", () => {
    const parsed = readWarMapAisProperties({
      sourceType: "ais",
      featureKind: "vessel",
      mmsi: "123456789",
      name: "USS Example",
      shipType: 55,
      shipTypeLabel: "Military / government",
      shipTypeLabelZh: "军政船舶",
      vesselRole: "Military / government",
      vesselRoleZh: "军政船舶",
      isMilitaryCandidate: true,
      observedAt: "2026-03-20T00:00:00.000Z",
      sourceUpdatedAt: "2026-03-20T00:01:00.000Z",
    });

    expect(parsed && parsed.featureKind === "vessel").toBe(true);
    if (!parsed || parsed.featureKind !== "vessel") {
      throw new Error("Expected a vessel payload");
    }

    expect(parsed).toMatchObject({
      sourceType: "ais",
      featureKind: "vessel",
      mmsi: "123456789",
      shipType: 55,
      shipTypeLabel: "军政船舶",
      shipTypeLabelZh: "军政船舶",
      vesselRole: "军政船舶",
      vesselRoleZh: "军政船舶",
      isMilitaryCandidate: true,
      observedAt: "2026-03-20T00:00:00.000Z",
      sourceUpdatedAt: "2026-03-20T00:01:00.000Z",
    });
  });
});
