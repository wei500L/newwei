import {
  buildWarMapLayersResponse,
  WAR_MAP_CABLE_LANDINGS,
} from "../war-map-layers";

describe("war-map layers contract", () => {
  it("keeps cables layer as point geometry for cable landing features", () => {
    const response = buildWarMapLayersResponse();
    const cablesLayer = response.layers.cables;

    expect(cablesLayer.geometryType).toBe("point");
    expect(cablesLayer.features).toHaveLength(WAR_MAP_CABLE_LANDINGS.length);
    expect(
      cablesLayer.features.every(
        (feature) =>
          typeof feature.lat === "number" &&
          typeof feature.lng === "number" &&
          !Array.isArray(feature.path),
      ),
    ).toBe(true);
  });
});
