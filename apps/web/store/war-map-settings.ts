"use client";

import {
  type WarMapLayerId,
  type WarMapLayerVisibility,
  type WarMapPreset,
  type WarMapSettings,
  type WarMapTimeRangePreset,
  type WarMapViewState,
  WAR_MAP_DEFAULT_LAYER_VISIBILITY,
  normalizeWarMapSettings,
} from "@modular/utils";
import { create } from "zustand";

export {
  type WarMapLayerId,
  type WarMapLayerVisibility,
  type WarMapPreset,
  type WarMapTimeRangePreset,
  type WarMapViewState,
  WAR_MAP_DEFAULT_LAYER_VISIBILITY,
} from "@modular/utils";

export const WAR_MAP_PRESET_VIEW_STATE: Record<WarMapPreset, WarMapViewState> = {
  global: { lat: 20, lon: 0, zoom: 1.8, bearing: 0, pitch: 30 },
  america: { lat: 38, lon: -95, zoom: 2.8, bearing: 0, pitch: 35 },
  mena: { lat: 28, lon: 45, zoom: 3.2, bearing: 0, pitch: 35 },
  eu: { lat: 50, lon: 15, zoom: 3.2, bearing: 0, pitch: 35 },
  asia: { lat: 35, lon: 105, zoom: 2.9, bearing: 0, pitch: 35 },
  latam: { lat: -15, lon: -60, zoom: 2.9, bearing: 0, pitch: 35 },
  africa: { lat: 5, lon: 20, zoom: 3.1, bearing: 0, pitch: 35 },
  oceania: { lat: -25, lon: 135, zoom: 3.2, bearing: 0, pitch: 35 },
};

const DEFAULT_SETTINGS: WarMapSettings = {
  layerVisibility: { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY },
  viewState: { ...WAR_MAP_PRESET_VIEW_STATE.global },
  activePreset: "global",
  timeRangePreset: "7d",
};

export interface WarMapSettingsState {
  layerVisibility: WarMapLayerVisibility;
  viewState: WarMapViewState;
  activePreset: WarMapPreset;
  timeRangePreset: WarMapTimeRangePreset;
  setLayerVisible: (id: WarMapLayerId, visible: boolean) => void;
  setLayerVisibility: (visibility: WarMapLayerVisibility) => void;
  setViewState: (viewState: Partial<WarMapViewState>) => void;
  setActivePreset: (preset: WarMapPreset) => void;
  setTimeRangePreset: (preset: WarMapTimeRangePreset) => void;
  resetLayers: () => void;
  resetAll: () => void;
  hydrateFromRemote: (payload: unknown) => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const useWarMapSettingsStore = create<WarMapSettingsState>((set) => ({
  layerVisibility: { ...DEFAULT_SETTINGS.layerVisibility },
  viewState: { ...DEFAULT_SETTINGS.viewState },
  activePreset: DEFAULT_SETTINGS.activePreset,
  timeRangePreset: DEFAULT_SETTINGS.timeRangePreset,
  setLayerVisible: (id, visible) =>
    set((state) => ({
      layerVisibility: { ...state.layerVisibility, [id]: visible },
    })),
  setLayerVisibility: (visibility) =>
    set({ layerVisibility: { ...visibility } }),
  setViewState: (nextViewState) =>
    set((state) => ({
      viewState: {
        lat:
          typeof nextViewState.lat === "number"
            ? clamp(nextViewState.lat, -90, 90)
            : state.viewState.lat,
        lon:
          typeof nextViewState.lon === "number"
            ? clamp(nextViewState.lon, -180, 180)
            : state.viewState.lon,
        zoom:
          typeof nextViewState.zoom === "number"
            ? clamp(nextViewState.zoom, 0.5, 18)
            : state.viewState.zoom,
        bearing:
          typeof nextViewState.bearing === "number"
            ? clamp(nextViewState.bearing, -180, 180)
            : state.viewState.bearing,
        pitch:
          typeof nextViewState.pitch === "number"
            ? clamp(nextViewState.pitch, 0, 85)
            : state.viewState.pitch,
      },
    })),
  setActivePreset: (preset) =>
    set({
      activePreset: preset,
      viewState: { ...WAR_MAP_PRESET_VIEW_STATE[preset] },
    }),
  setTimeRangePreset: (preset) => set({ timeRangePreset: preset }),
  resetLayers: () =>
    set({ layerVisibility: { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY } }),
  resetAll: () =>
    set({
      layerVisibility: { ...DEFAULT_SETTINGS.layerVisibility },
      viewState: { ...DEFAULT_SETTINGS.viewState },
      activePreset: DEFAULT_SETTINGS.activePreset,
      timeRangePreset: DEFAULT_SETTINGS.timeRangePreset,
    }),
  hydrateFromRemote: (payload) => {
    const normalized = normalizeWarMapSettings(payload);
    set({
      layerVisibility: normalized.layerVisibility,
      viewState: normalized.viewState,
      activePreset: normalized.activePreset,
      timeRangePreset: normalized.timeRangePreset,
    });
  },
}));
