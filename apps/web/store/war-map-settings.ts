"use client";

import {
  type WarMapAisMode,
  type WarMapLayerId,
  type WarMapLayerVisibility,
  type WarMapFlightMode,
  type WarMapPreset,
  type WarMapSettings,
  type WarMapTimeRangePreset,
  type WarMapViewState,
  WAR_MAP_DEFAULT_LAYER_VISIBILITY,
  normalizeWarMapSettings,
} from "@modular/utils";
import { createWithEqualityFn as create } from "zustand/traditional";

export {
  type WarMapAisMode,
  type WarMapFlightMode,
  type WarMapLayerId,
  type WarMapLayerVisibility,
  type WarMapPreset,
  type WarMapTimeRangePreset,
  type WarMapViewState,
  WAR_MAP_DEFAULT_LAYER_VISIBILITY,
} from "@modular/utils";

export const WAR_MAP_PRESET_VIEW_STATE: Record<WarMapPreset, WarMapViewState> = {
  global: { lat: 20, lon: 0, zoom: 1.8, bearing: 0, pitch: 0 },
  america: { lat: 38, lon: -95, zoom: 2.8, bearing: 0, pitch: 0 },
  mena: { lat: 28, lon: 45, zoom: 3.2, bearing: 0, pitch: 0 },
  eu: { lat: 50, lon: 15, zoom: 3.2, bearing: 0, pitch: 0 },
  asia: { lat: 35, lon: 105, zoom: 2.9, bearing: 0, pitch: 0 },
  latam: { lat: -15, lon: -60, zoom: 2.9, bearing: 0, pitch: 0 },
  africa: { lat: 5, lon: 20, zoom: 3.1, bearing: 0, pitch: 0 },
  oceania: { lat: -25, lon: 135, zoom: 3.2, bearing: 0, pitch: 0 },
};

const DEFAULT_SETTINGS: WarMapSettings = {
  layerVisibility: { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY },
  viewState: { ...WAR_MAP_PRESET_VIEW_STATE.global },
  activePreset: "global",
  timeRangePreset: "7d",
  flightMode: "military",
  aisMode: "all",
  aisHighlightCandidates: true,
};

export function normalizeWarMapSettingsSafe(payload: unknown): WarMapSettings {
  return normalizeWarMapSettings(payload);
}

export interface WarMapSettingsState {
  layerVisibility: WarMapLayerVisibility;
  viewState: WarMapViewState;
  activePreset: WarMapPreset;
  timeRangePreset: WarMapTimeRangePreset;
  flightMode: WarMapFlightMode;
  aisMode: WarMapAisMode;
  aisHighlightCandidates: boolean;
  setLayerVisible: (id: WarMapLayerId, visible: boolean) => void;
  setLayerVisibility: (visibility: WarMapLayerVisibility) => void;
  setViewState: (viewState: Partial<WarMapViewState>) => void;
  setActivePreset: (preset: WarMapPreset) => void;
  setTimeRangePreset: (preset: WarMapTimeRangePreset) => void;
  setFlightMode: (mode: WarMapFlightMode) => void;
  setAisMode: (mode: WarMapAisMode) => void;
  setAisHighlightCandidates: (enabled: boolean) => void;
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
  flightMode: DEFAULT_SETTINGS.flightMode,
  aisMode: DEFAULT_SETTINGS.aisMode,
  aisHighlightCandidates: DEFAULT_SETTINGS.aisHighlightCandidates,
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
        // Keep the map in 2D regardless of incoming values.
        bearing: 0,
        pitch: 0,
      },
    })),
  setActivePreset: (preset) =>
    set({
      activePreset: preset,
      viewState: { ...WAR_MAP_PRESET_VIEW_STATE[preset] },
    }),
  setTimeRangePreset: (preset) => set({ timeRangePreset: preset }),
  setFlightMode: (flightMode) => set({ flightMode }),
  setAisMode: (aisMode) => set({ aisMode }),
  setAisHighlightCandidates: (aisHighlightCandidates) =>
    set({ aisHighlightCandidates }),
  resetLayers: () =>
    set({ layerVisibility: { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY } }),
  resetAll: () =>
    set({
      layerVisibility: { ...DEFAULT_SETTINGS.layerVisibility },
      viewState: { ...DEFAULT_SETTINGS.viewState },
      activePreset: DEFAULT_SETTINGS.activePreset,
      timeRangePreset: DEFAULT_SETTINGS.timeRangePreset,
      flightMode: DEFAULT_SETTINGS.flightMode,
      aisMode: DEFAULT_SETTINGS.aisMode,
      aisHighlightCandidates: DEFAULT_SETTINGS.aisHighlightCandidates,
    }),
  hydrateFromRemote: (payload) => {
    const normalized = normalizeWarMapSettingsSafe(payload);
    set({
      layerVisibility: normalized.layerVisibility,
      viewState: normalized.viewState,
      activePreset: normalized.activePreset,
      timeRangePreset: normalized.timeRangePreset,
      flightMode: normalized.flightMode,
      aisMode: normalized.aisMode,
      aisHighlightCandidates: normalized.aisHighlightCandidates,
    });
  },
}));
