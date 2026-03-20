import {
  classifyAircraftTransport,
  classifyAisShipType,
  isMilitaryLikeAircraft,
} from "../transport-classification";

describe("transport classification", () => {
  it("classifies military transport callsigns with bilingual labels", () => {
    expect(
      classifyAircraftTransport({
        callsign: "RCH123",
        sourceScope: "all",
      }),
    ).toEqual({
      displayCategory: "Military flight",
      displayCategoryZh: "军事飞行",
      role: "Military transport",
      roleZh: "军用运输",
      isMilitaryCandidate: true,
    });
  });

  it("falls back to civil labels for non-military aircraft", () => {
    expect(
      classifyAircraftTransport({
        callsign: "DAL456",
        icao24: "a1b2c3",
        sourceScope: "all",
      }),
    ).toEqual({
      displayCategory: "Civil flight",
      displayCategoryZh: "民航飞行",
      role: "Civil or general aviation",
      roleZh: "民航或通用航空",
      isMilitaryCandidate: false,
    });
    expect(
      isMilitaryLikeAircraft({
        callsign: "DAL456",
        icao24: "a1b2c3",
        sourceScope: "all",
      }),
    ).toBe(false);
  });

  it("maps AIS ship types to localized vessel roles", () => {
    expect(classifyAisShipType(70)).toEqual({
      shipTypeLabel: "Cargo",
      shipTypeLabelZh: "货船",
      vesselRole: "Cargo transport",
      vesselRoleZh: "货运",
      isMilitaryCandidate: false,
    });
    expect(classifyAisShipType(55)).toEqual({
      shipTypeLabel: "Military / government",
      shipTypeLabelZh: "军政船舶",
      vesselRole: "Military / government",
      vesselRoleZh: "军政船舶",
      isMilitaryCandidate: true,
    });
  });
});
