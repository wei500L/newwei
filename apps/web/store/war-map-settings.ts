"use client";

import { create } from "zustand";

export type WarMapLayerId =
  | "hotspots"
  | "conflictZones"
  | "chokepoints"
  | "cableLandings"
  | "nuclearSites"
  | "militaryBases"
  | "monitors";

export type WarMapLayerVisibility = Record<WarMapLayerId, boolean>;

export const WAR_MAP_DEFAULT_LAYER_VISIBILITY: WarMapLayerVisibility = {
  hotspots: true,
  conflictZones: true,
  chokepoints: false,
  cableLandings: false,
  nuclearSites: false,
  militaryBases: false,
  monitors: true
} as const;

export interface WarMapSettingsState {
  layerVisibility: WarMapLayerVisibility;
  setLayerVisible: (id: WarMapLayerId, visible: boolean) => void;
  resetLayers: () => void;
  hydrateFromRemote: (payload: unknown) => void;
}

export const useWarMapSettingsStore = create<WarMapSettingsState>((set) => ({
  layerVisibility: { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY },
  setLayerVisible: (id, visible) =>
    set((state) => ({
      layerVisibility: { ...state.layerVisibility, [id]: visible },
    })),
  resetLayers: () => set({ layerVisibility: { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY } }),
  hydrateFromRemote: (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const record = payload as Record<string, unknown>;
    const rawVisibility =
      record.layerVisibility && typeof record.layerVisibility === "object" && !Array.isArray(record.layerVisibility)
        ? (record.layerVisibility as Record<string, unknown>)
        : record;

    const normalized: WarMapLayerVisibility = { ...WAR_MAP_DEFAULT_LAYER_VISIBILITY };
    for (const key of Object.keys(WAR_MAP_DEFAULT_LAYER_VISIBILITY) as WarMapLayerId[]) {
      const raw = rawVisibility[key];
      if (typeof raw === "boolean") {
        normalized[key] = raw;
      }
    }
    set({ layerVisibility: normalized });
  },
}));
