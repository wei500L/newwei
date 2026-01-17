"use client";

import { create } from "zustand";

import type { Layout } from "react-grid-layout";

export type SituationMonitorPanelId =
  | "map"
  | "feeds-politics"
  | "feeds-tech"
  | "feeds-finance"
  | "feeds-gov"
  | "feeds-ai"
  | "feeds-intel"
  | "alerts"
  | "markets"
  | "crypto"
  | "fed"
  | "leaders"
  | "situation-venezuela"
  | "situation-greenland"
  | "situation-iran"
  | "correlation"
  | "narrative"
  | "main-character"
  | "monitors";

export interface SituationMonitorPanelConfig {
  id: SituationMonitorPanelId;
  title: string;
  defaultVisible: boolean;
  defaultLayout: Layout;
  locked?: boolean;
}

export const SITUATION_MONITOR_PANELS: readonly SituationMonitorPanelConfig[] = [
  {
    id: "map",
    title: "Global Map",
    defaultVisible: true,
    locked: true,
    defaultLayout: { i: "map", x: 0, y: 0, w: 12, h: 9, minW: 6, minH: 7, static: true },
  },
  {
    id: "feeds-politics",
    title: "Politics",
    defaultVisible: true,
    defaultLayout: { i: "feeds-politics", x: 0, y: 9, w: 4, h: 7, minW: 3, minH: 5 },
  },
  {
    id: "feeds-tech",
    title: "Tech",
    defaultVisible: true,
    defaultLayout: { i: "feeds-tech", x: 4, y: 9, w: 4, h: 7, minW: 3, minH: 5 },
  },
  {
    id: "feeds-finance",
    title: "Finance",
    defaultVisible: true,
    defaultLayout: { i: "feeds-finance", x: 8, y: 9, w: 4, h: 7, minW: 3, minH: 5 },
  },
  {
    id: "feeds-gov",
    title: "Government",
    defaultVisible: true,
    defaultLayout: { i: "feeds-gov", x: 0, y: 16, w: 4, h: 7, minW: 3, minH: 5 },
  },
  {
    id: "feeds-ai",
    title: "AI",
    defaultVisible: true,
    defaultLayout: { i: "feeds-ai", x: 4, y: 16, w: 4, h: 7, minW: 3, minH: 5 },
  },
  {
    id: "feeds-intel",
    title: "Intel",
    defaultVisible: true,
    defaultLayout: { i: "feeds-intel", x: 8, y: 16, w: 4, h: 7, minW: 3, minH: 5 },
  },
  {
    id: "alerts",
    title: "Alerts",
    defaultVisible: true,
    defaultLayout: { i: "alerts", x: 0, y: 23, w: 4, h: 8, minW: 3, minH: 6 },
  },
  {
    id: "markets",
    title: "Markets",
    defaultVisible: true,
    defaultLayout: { i: "markets", x: 4, y: 23, w: 4, h: 8, minW: 3, minH: 6 },
  },
  {
    id: "crypto",
    title: "Crypto",
    defaultVisible: true,
    defaultLayout: { i: "crypto", x: 8, y: 23, w: 4, h: 8, minW: 3, minH: 6 },
  },
  {
    id: "fed",
    title: "Federal Reserve",
    defaultVisible: true,
    defaultLayout: { i: "fed", x: 0, y: 31, w: 6, h: 10, minW: 4, minH: 7 },
  },
  {
    id: "leaders",
    title: "World Leaders",
    defaultVisible: true,
    defaultLayout: { i: "leaders", x: 6, y: 31, w: 6, h: 10, minW: 4, minH: 7 },
  },
  {
    id: "situation-venezuela",
    title: "Venezuela Watch",
    defaultVisible: true,
    defaultLayout: { i: "situation-venezuela", x: 0, y: 41, w: 4, h: 8, minW: 3, minH: 6 },
  },
  {
    id: "situation-greenland",
    title: "Greenland Watch",
    defaultVisible: true,
    defaultLayout: { i: "situation-greenland", x: 4, y: 41, w: 4, h: 8, minW: 3, minH: 6 },
  },
  {
    id: "situation-iran",
    title: "Iran Crisis",
    defaultVisible: true,
    defaultLayout: { i: "situation-iran", x: 8, y: 41, w: 4, h: 8, minW: 3, minH: 6 },
  },
  {
    id: "correlation",
    title: "Correlation Engine",
    defaultVisible: true,
    defaultLayout: { i: "correlation", x: 0, y: 49, w: 8, h: 12, minW: 6, minH: 8 },
  },
  {
    id: "narrative",
    title: "Narrative Tracker",
    defaultVisible: true,
    defaultLayout: { i: "narrative", x: 8, y: 49, w: 4, h: 12, minW: 4, minH: 8 },
  },
  {
    id: "main-character",
    title: "Main Character",
    defaultVisible: true,
    defaultLayout: { i: "main-character", x: 8, y: 61, w: 4, h: 8, minW: 4, minH: 6 },
  },
  {
    id: "monitors",
    title: "My Monitors",
    defaultVisible: true,
    defaultLayout: { i: "monitors", x: 0, y: 69, w: 12, h: 10, minW: 6, minH: 7 },
  },
] as const;

export type SituationMonitorPresetId =
  | "news-junkie"
  | "markets"
  | "geopolitics"
  | "intel"
  | "minimal"
  | "everything";

export interface SituationMonitorPreset {
  id: SituationMonitorPresetId;
  name: string;
  description: string;
  panels: SituationMonitorPanelId[];
}

export const SITUATION_MONITOR_PRESETS: readonly SituationMonitorPreset[] = [
  {
    id: "news-junkie",
    name: "News Junkie",
    description: "Broad news coverage across all categories plus monitors.",
    panels: [
      "map",
      "feeds-politics",
      "feeds-tech",
      "feeds-finance",
      "feeds-gov",
      "feeds-ai",
      "feeds-intel",
      "alerts",
      "monitors"
    ]
  },
  {
    id: "markets",
    name: "Markets",
    description: "Markets-focused view with finance + macro signals.",
    panels: ["map", "feeds-finance", "markets", "crypto", "fed", "alerts"]
  },
  {
    id: "geopolitics",
    name: "Geopolitics",
    description: "Global situation awareness with hotspots and regional watches.",
    panels: [
      "map",
      "feeds-politics",
      "feeds-gov",
      "feeds-intel",
      "alerts",
      "leaders",
      "situation-venezuela",
      "situation-greenland",
      "situation-iran",
      "correlation",
      "narrative"
    ]
  },
  {
    id: "intel",
    name: "Intel Analyst",
    description: "Deep analysis: correlation, narratives, and key figures.",
    panels: ["map", "feeds-intel", "correlation", "narrative", "leaders", "main-character", "monitors"]
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Just the essentials: map, key feed, and alerts.",
    panels: ["map", "feeds-politics", "alerts"]
  },
  {
    id: "everything",
    name: "Everything",
    description: "All panels enabled.",
    panels: SITUATION_MONITOR_PANELS.map((panel) => panel.id) as SituationMonitorPanelId[]
  }
] as const;

function buildDefaults() {
  const visibility: Record<SituationMonitorPanelId, boolean> = Object.fromEntries(
    SITUATION_MONITOR_PANELS.map((panel) => [panel.id, panel.defaultVisible]),
  ) as Record<SituationMonitorPanelId, boolean>;

  const layout = SITUATION_MONITOR_PANELS.map((panel) => panel.defaultLayout);
  return { visibility, layout };
}

function buildVisibilityForPreset(preset: SituationMonitorPreset): Record<SituationMonitorPanelId, boolean> {
  const enabled = new Set<SituationMonitorPanelId>(preset.panels);
  return Object.fromEntries(
    SITUATION_MONITOR_PANELS.map((panel) => [panel.id, enabled.has(panel.id)]),
  ) as Record<SituationMonitorPanelId, boolean>;
}

function mergeLayout(existing: Layout[], defaults: Layout[]): Layout[] {
  const known = new Map(defaults.map((entry) => [entry.i, entry]));
  const merged: Layout[] = [];

  for (const item of existing) {
    const fallback = known.get(item.i);
    if (!fallback) {
      continue;
    }
    merged.push({
      ...fallback,
      ...item,
      i: fallback.i,
      static: fallback.static ?? item.static,
    });
    known.delete(item.i);
  }

  for (const entry of known.values()) {
    merged.push(entry);
  }

  return merged;
}

export interface SituationMonitorLayoutState {
  layout: Layout[];
  visibility: Record<SituationMonitorPanelId, boolean>;
  setLayout: (layout: Layout[]) => void;
  setPanelVisible: (id: SituationMonitorPanelId, visible: boolean) => void;
  togglePanel: (id: SituationMonitorPanelId) => void;
  hydrateFromRemote: (payload: unknown) => void;
  applyPreset: (presetId: SituationMonitorPresetId, options?: { resetLayout?: boolean }) => void;
  reset: () => void;
  ensure: () => void;
}

export const useSituationMonitorLayoutStore = create<SituationMonitorLayoutState>((set, get) => {
  const defaults = buildDefaults();
  return {
    layout: defaults.layout,
    visibility: defaults.visibility,
    setLayout: (layout) => set({ layout }),
    setPanelVisible: (id, visible) =>
      set((state) => ({
        visibility: { ...state.visibility, [id]: visible },
      })),
    togglePanel: (id) =>
      set((state) => ({
        visibility: { ...state.visibility, [id]: !state.visibility[id] },
      })),
    hydrateFromRemote: (payload) => {
      const defaults = buildDefaults();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        set(defaults);
        return;
      }

      const record = payload as Record<string, unknown>;
      const rawLayout = record.layout;
      const rawVisibility = record.visibility;

      const visibilityPatch: Partial<Record<SituationMonitorPanelId, boolean>> = {};
      if (rawVisibility && typeof rawVisibility === "object" && !Array.isArray(rawVisibility)) {
        const visibilityRecord = rawVisibility as Record<string, unknown>;
        for (const panel of SITUATION_MONITOR_PANELS) {
          const val = visibilityRecord[panel.id];
          if (typeof val === "boolean") {
            visibilityPatch[panel.id] = val;
          }
        }
      }

      set({
        visibility: { ...defaults.visibility, ...visibilityPatch },
        layout: mergeLayout(Array.isArray(rawLayout) ? (rawLayout as Layout[]) : [], defaults.layout),
      });
    },
    applyPreset: (presetId, options) => {
      const preset = SITUATION_MONITOR_PRESETS.find((entry) => entry.id === presetId);
      if (!preset) {
        return;
      }
      const defaults = buildDefaults();
      const presetVisibility = buildVisibilityForPreset(preset);
      set((state) => ({
        visibility: presetVisibility,
        layout: options?.resetLayout ? defaults.layout : mergeLayout(state.layout, defaults.layout),
      }));
    },
    reset: () => set(buildDefaults()),
    ensure: () => {
      const nextDefaults = buildDefaults();
      const state = get();
      set({
        visibility: { ...nextDefaults.visibility, ...state.visibility },
        layout: mergeLayout(state.layout, nextDefaults.layout),
      });
    },
  };
});
