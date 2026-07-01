import {
  WAR_MAP_PRESETS,
  WAR_MAP_DEFAULT_LAYER_VISIBILITY,
  type WarMapLayerVisibility,
} from "@modular/utils";
import { beforeEach, describe, expect, it } from "vitest";

import {
  mergeWarMapSettingsWithUrlState,
  readWarMapUrlState,
  writeWarMapUrlState,
} from "@/app/(app)/dashboard/charts/war-map/url-state";
import {
  WAR_MAP_PRESET_VIEW_STATE,
  useWarMapSettingsStore,
} from "@/store/war-map-settings";

function cloneDefaultLayerVisibility(): WarMapLayerVisibility {
  return { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY };
}

describe("war-map url-state", () => {
  it("parses view/preset/time-range/layers from url", () => {
    const params = new URLSearchParams(
      "lat=34.1&lon=108.9&zoom=4.2&bearing=12&pitch=41&preset=asia&tr=24h&fm=all&am=density&aa=0&layers=conflicts,weather,monitors",
    );

    const parsed = readWarMapUrlState(params);

    expect(parsed.viewState).toMatchObject({
      lat: 34.1,
      lon: 108.9,
      zoom: 4.2,
      bearing: 0,
      pitch: 0,
    });
    expect(parsed.activePreset).toBe("asia");
    expect(parsed.timeRangePreset).toBe("24h");
    expect(parsed.flightMode).toBe("all");
    expect(parsed.aisMode).toBe("density");
    expect(parsed.aisAutoMode).toBe(false);
    expect(parsed.layerVisibility?.conflicts).toBe(true);
    expect(parsed.layerVisibility?.weather).toBe(true);
    expect(parsed.layerVisibility?.monitors).toBe(true);
    expect(parsed.layerVisibility?.bases).toBe(false);
  });

  it("serializes state and strips default layers token", () => {
    const params = new URLSearchParams("foo=bar&aa=0");

    const next = writeWarMapUrlState(params, {
      viewState: {
        lat: 20,
        lon: 0,
        zoom: 1.8,
        bearing: 0,
        pitch: 0,
      },
      activePreset: "global",
      timeRangePreset: "7d",
      layerVisibility: cloneDefaultLayerVisibility(),
      flightMode: "military",
      aisMode: "military",
    });

    expect(next.get("preset")).toBe("global");
    expect(next.get("tr")).toBe("7d");
    expect(next.get("fm")).toBeNull();
    expect(next.get("am")).toBeNull();
    expect(next.get("aa")).toBeNull();
    expect(next.get("layers")).toBeNull();
    expect(next.get("foo")).toBe("bar");
  });

  it("persists all-disabled layers via an empty layers token", () => {
    const noneVisible = cloneDefaultLayerVisibility();
    for (const layerId of Object.keys(noneVisible) as Array<
      keyof WarMapLayerVisibility
    >) {
      noneVisible[layerId] = false;
    }

    const written = writeWarMapUrlState(new URLSearchParams(), {
      viewState: {
        lat: 20,
        lon: 0,
        zoom: 1.8,
        bearing: 0,
        pitch: 0,
      },
      activePreset: "global",
      timeRangePreset: "7d",
      layerVisibility: noneVisible,
      flightMode: "military",
      aisMode: "military",
    });

    expect(written.get("layers")).toBe("");

    const parsed = readWarMapUrlState(written);
    expect(parsed.layerVisibility).toBeDefined();
    expect(
      Object.values(parsed.layerVisibility ?? {}).every(
        (visible) => visible === false,
      ),
    ).toBe(true);
  });

  it("round-trips non-default layer visibility", () => {
    const visibility = cloneDefaultLayerVisibility();
    visibility.conflicts = true;
    visibility.weather = true;
    visibility.monitors = false;
    visibility.hotspots = false;

    const written = writeWarMapUrlState(new URLSearchParams(), {
      viewState: {
        lat: -10.12345,
        lon: 120.56789,
        zoom: 5.4321,
        bearing: 24,
        pitch: 33,
      },
      activePreset: "oceania",
      timeRangePreset: "48h",
      layerVisibility: visibility,
      flightMode: "all",
      aisMode: "density",
    });

    const parsed = readWarMapUrlState(written);

    expect(parsed.activePreset).toBe("oceania");
    expect(parsed.timeRangePreset).toBe("48h");
    expect(parsed.flightMode).toBe("all");
    expect(parsed.aisMode).toBe("density");
    expect(parsed.aisAutoMode).toBeUndefined();
    expect(parsed.viewState?.bearing).toBe(0);
    expect(parsed.viewState?.pitch).toBe(0);
    expect(parsed.layerVisibility?.conflicts).toBe(true);
    expect(parsed.layerVisibility?.weather).toBe(true);
    expect(parsed.layerVisibility?.hotspots).toBe(false);
    expect(parsed.layerVisibility?.monitors).toBe(false);
  });

  it("preserves URL-selected view, layers, and AIS settings when merging remote settings", () => {
    const visibility = Object.fromEntries(
      Object.keys(cloneDefaultLayerVisibility()).map((layerId) => [
        layerId,
        false,
      ]),
    ) as WarMapLayerVisibility;
    visibility.conflicts = true;

    const merged = mergeWarMapSettingsWithUrlState(
      {
        activePreset: "asia",
        viewState: {
          lat: -15,
          lon: 130,
          zoom: 3.5,
          bearing: 0,
          pitch: 0,
        },
        timeRangePreset: "24h",
        layerVisibility: cloneDefaultLayerVisibility(),
        flightMode: "all",
        aisMode: "military",
        aisHighlightCandidates: true,
      },
      new URLSearchParams(
        "lat=26.44916&lon=56.45&zoom=8.3&preset=global&tr=7d&fm=military&am=density&aa=0&layers=conflicts",
      ),
    );

    expect(merged.viewState).toMatchObject({
      lat: 26.44916,
      lon: 56.45,
      zoom: 8.3,
      bearing: 0,
      pitch: 0,
    });
    expect(merged.activePreset).toBe("global");
    expect(merged.timeRangePreset).toBe("7d");
    expect(merged.flightMode).toBe("military");
    expect(merged.aisMode).toBe("density");
    expect(merged.aisHighlightCandidates).toBe(true);
    expect(merged.layerVisibility).toEqual(visibility);
  });

  it("applies preset camera when the URL only overrides the preset", () => {
    const merged = mergeWarMapSettingsWithUrlState(
      {
        activePreset: "asia",
        viewState: {
          lat: -15,
          lon: 130,
          zoom: 3.5,
          bearing: 0,
          pitch: 0,
        },
      },
      new URLSearchParams("preset=mena"),
    );

    expect(merged.activePreset).toBe("mena");
    expect(merged.viewState).toEqual(WAR_MAP_PRESET_VIEW_STATE.mena);
  });

  it("lets URL-derived view/preset/layers win over remote settings (F-3)", () => {
    const merged = mergeWarMapSettingsWithUrlState(
      {
        activePreset: "asia",
        timeRangePreset: "24h",
        flightMode: "military",
        aisMode: "military",
        layerVisibility: cloneDefaultLayerVisibility(),
      },
      new URLSearchParams("preset=oceania&tr=48h&fm=all&layers=flights"),
    );

    // Fields present in the URL must override remote settings, not be discarded.
    expect(merged.activePreset).toBe("oceania");
    expect(merged.timeRangePreset).toBe("48h");
    expect(merged.flightMode).toBe("all");
    expect(merged.layerVisibility.flights).toBe(true);
    expect(merged.layerVisibility.ais).toBe(false);
  });
});

describe("war-map settings store", () => {
  beforeEach(() => {
    useWarMapSettingsStore.getState().resetAll();
  });

  it("keeps the OpenSky flights layer enabled by default", () => {
    expect(WAR_MAP_DEFAULT_LAYER_VISIBILITY.flights).toBe(true);
    expect(WAR_MAP_DEFAULT_LAYER_VISIBILITY.ais).toBe(true);
    expect(useWarMapSettingsStore.getState().layerVisibility.flights).toBe(
      true,
    );
    expect(useWarMapSettingsStore.getState().layerVisibility.ais).toBe(true);
    expect(useWarMapSettingsStore.getState().flightMode).toBe("military");
    expect(useWarMapSettingsStore.getState().aisMode).toBe("all");
    expect(useWarMapSettingsStore.getState().aisHighlightCandidates).toBe(true);
  });

  it("forces 2D camera in setViewState", () => {
    useWarMapSettingsStore.getState().setViewState({
      lat: 10,
      lon: 20,
      zoom: 5,
      bearing: 45,
      pitch: 35,
    });

    const { viewState } = useWarMapSettingsStore.getState();
    expect(viewState.lat).toBe(10);
    expect(viewState.lon).toBe(20);
    expect(viewState.zoom).toBe(5);
    expect(viewState.bearing).toBe(0);
    expect(viewState.pitch).toBe(0);
  });

  it("keeps all presets in flat 2D view", () => {
    for (const preset of WAR_MAP_PRESETS) {
      useWarMapSettingsStore.getState().setActivePreset(preset);
      const { activePreset, viewState } = useWarMapSettingsStore.getState();
      expect(activePreset).toBe(preset);
      expect(viewState).toEqual(WAR_MAP_PRESET_VIEW_STATE[preset]);
      expect(viewState.bearing).toBe(0);
      expect(viewState.pitch).toBe(0);
    }
  });

  it("normalizes remote settings to 2D camera", () => {
    useWarMapSettingsStore.getState().hydrateFromRemote({
      viewState: {
        lat: -15,
        lon: 130,
        zoom: 3.5,
        bearing: 80,
        pitch: 45,
      },
      activePreset: "asia",
      timeRangePreset: "24h",
      flightMode: "all",
      aisMode: "density",
      aisHighlightCandidates: false,
    });

    const {
      viewState,
      activePreset,
      timeRangePreset,
      flightMode,
      aisMode,
      aisHighlightCandidates,
    } = useWarMapSettingsStore.getState();
    expect(activePreset).toBe("asia");
    expect(timeRangePreset).toBe("24h");
    expect(flightMode).toBe("all");
    expect(aisMode).toBe("density");
    expect(aisHighlightCandidates).toBe(false);
    expect(viewState.lat).toBe(-15);
    expect(viewState.lon).toBe(130);
    expect(viewState.zoom).toBe(3.5);
    expect(viewState.bearing).toBe(0);
    expect(viewState.pitch).toBe(0);
  });

  it("keeps a saved candidates-only AIS mode for existing users", () => {
    useWarMapSettingsStore.getState().hydrateFromRemote({
      aisMode: "military",
    });

    expect(useWarMapSettingsStore.getState().aisMode).toBe("military");
  });
});
