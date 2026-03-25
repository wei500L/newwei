"use client";

import type { Layout } from "react-grid-layout";
import { createWithEqualityFn as create } from "zustand/traditional";

import {
  SITUATION_MONITOR_GRID_BREAKPOINT_ORDER,
  type SituationMonitorGridBreakpoint,
  type SituationMonitorResponsiveLayouts,
} from "@/lib/situation-monitor-grid";

export type SituationMonitorPanelId =
  | "map"
  | "realtime-snapshot"
  | "feeds-politics"
  | "feeds-tech"
  | "feeds-finance"
  | "feeds-gov"
  | "feeds-ai"
  | "feeds-intel"
  | "alerts"
  | "telegram-feed"
  | "oref-alerts"
  | "markets"
  | "crypto"
  | "fed"
  | "leaders"
  | "situation-venezuela"
  | "situation-greenland"
  | "situation-iran"
  | "live-news"
  | "live-webcams"
  | "correlation"
  | "narrative"
  | "main-character"
  | "monitors";

export interface SituationMonitorPanelConfig {
  id: SituationMonitorPanelId;
  title: string;
  titleKey?: string;
  defaultVisible: boolean;
  defaultLayout: Layout;
  locked?: boolean;
}

export type SituationMonitorLayoutBreakpoint = SituationMonitorGridBreakpoint;

export type SituationMonitorLayouts = SituationMonitorResponsiveLayouts;

export const SITUATION_MONITOR_PANELS: readonly SituationMonitorPanelConfig[] =
  [
    {
      id: "map",
      title: "Global Map",
      titleKey: "situationMonitor.map.title",
      defaultVisible: true,
      locked: true,
      defaultLayout: {
        i: "map",
        x: 0,
        y: 0,
        w: 12,
        h: 9,
        minW: 6,
        minH: 7,
        static: true,
      },
    },
    {
      id: "realtime-snapshot",
      title: "Realtime Snapshot",
      titleKey: "situationMonitor.realtimeSnapshot.title",
      defaultVisible: true,
      defaultLayout: {
        i: "realtime-snapshot",
        x: 0,
        y: 9,
        w: 12,
        h: 8,
        minW: 6,
        minH: 6,
      },
    },
    {
      id: "feeds-politics",
      title: "Politics",
      titleKey: "situationMonitor.categories.politics",
      defaultVisible: true,
      defaultLayout: {
        i: "feeds-politics",
        x: 0,
        y: 17,
        w: 4,
        h: 7,
        minW: 3,
        minH: 5,
      },
    },
    {
      id: "feeds-tech",
      title: "Tech",
      titleKey: "situationMonitor.categories.tech",
      defaultVisible: true,
      defaultLayout: {
        i: "feeds-tech",
        x: 4,
        y: 17,
        w: 4,
        h: 7,
        minW: 3,
        minH: 5,
      },
    },
    {
      id: "feeds-finance",
      title: "Finance",
      titleKey: "situationMonitor.categories.finance",
      defaultVisible: true,
      defaultLayout: {
        i: "feeds-finance",
        x: 8,
        y: 17,
        w: 4,
        h: 7,
        minW: 3,
        minH: 5,
      },
    },
    {
      id: "feeds-gov",
      title: "Government",
      titleKey: "situationMonitor.categories.gov",
      defaultVisible: true,
      defaultLayout: {
        i: "feeds-gov",
        x: 0,
        y: 24,
        w: 4,
        h: 7,
        minW: 3,
        minH: 5,
      },
    },
    {
      id: "feeds-ai",
      title: "AI",
      titleKey: "situationMonitor.categories.ai",
      defaultVisible: true,
      defaultLayout: {
        i: "feeds-ai",
        x: 4,
        y: 24,
        w: 4,
        h: 7,
        minW: 3,
        minH: 5,
      },
    },
    {
      id: "feeds-intel",
      title: "Intel",
      titleKey: "situationMonitor.categories.intel",
      defaultVisible: true,
      defaultLayout: {
        i: "feeds-intel",
        x: 8,
        y: 24,
        w: 4,
        h: 7,
        minW: 3,
        minH: 5,
      },
    },
    {
      id: "alerts",
      title: "Alerts",
      titleKey: "situationMonitor.alerts.title",
      defaultVisible: true,
      defaultLayout: { i: "alerts", x: 0, y: 31, w: 4, h: 8, minW: 3, minH: 6 },
    },
    {
      id: "telegram-feed",
      title: "Telegram Early Signals",
      titleKey: "situationMonitor.telegram.title",
      defaultVisible: true,
      defaultLayout: {
        i: "telegram-feed",
        x: 4,
        y: 31,
        w: 4,
        h: 8,
        minW: 3,
        minH: 6,
      },
    },
    {
      id: "oref-alerts",
      title: "OREF Alerts",
      titleKey: "situationMonitor.oref.title",
      defaultVisible: true,
      defaultLayout: {
        i: "oref-alerts",
        x: 8,
        y: 31,
        w: 4,
        h: 8,
        minW: 3,
        minH: 6,
      },
    },
    {
      id: "markets",
      title: "Markets",
      titleKey: "situationMonitor.markets.title",
      defaultVisible: true,
      defaultLayout: {
        i: "markets",
        x: 0,
        y: 39,
        w: 4,
        h: 8,
        minW: 3,
        minH: 6,
      },
    },
    {
      id: "crypto",
      title: "Crypto",
      titleKey: "situationMonitor.crypto.title",
      defaultVisible: true,
      defaultLayout: { i: "crypto", x: 4, y: 39, w: 4, h: 8, minW: 3, minH: 6 },
    },
    {
      id: "fed",
      title: "Federal Reserve",
      titleKey: "situationMonitor.fed.title",
      defaultVisible: true,
      defaultLayout: { i: "fed", x: 8, y: 39, w: 4, h: 8, minW: 4, minH: 7 },
    },
    {
      id: "leaders",
      title: "World Leaders",
      titleKey: "situationMonitor.leaders.title",
      defaultVisible: true,
      defaultLayout: {
        i: "leaders",
        x: 0,
        y: 47,
        w: 6,
        h: 10,
        minW: 4,
        minH: 7,
      },
    },
    {
      id: "situation-venezuela",
      title: "Venezuela Watch",
      titleKey: "situationMonitor.situations.venezuela",
      defaultVisible: true,
      defaultLayout: {
        i: "situation-venezuela",
        x: 6,
        y: 47,
        w: 6,
        h: 10,
        minW: 3,
        minH: 6,
      },
    },
    {
      id: "situation-greenland",
      title: "Greenland Watch",
      titleKey: "situationMonitor.situations.greenland",
      defaultVisible: true,
      defaultLayout: {
        i: "situation-greenland",
        x: 0,
        y: 57,
        w: 4,
        h: 8,
        minW: 3,
        minH: 6,
      },
    },
    {
      id: "situation-iran",
      title: "Iran Crisis",
      titleKey: "situationMonitor.situations.iran",
      defaultVisible: true,
      defaultLayout: {
        i: "situation-iran",
        x: 4,
        y: 57,
        w: 4,
        h: 8,
        minW: 3,
        minH: 6,
      },
    },
    {
      id: "live-news",
      title: "Live News",
      titleKey: "situationMonitor.liveNews.title",
      defaultVisible: true,
      defaultLayout: {
        i: "live-news",
        x: 8,
        y: 57,
        w: 4,
        h: 8,
        minW: 4,
        minH: 6,
      },
    },
    {
      id: "live-webcams",
      title: "Live Webcams",
      titleKey: "situationMonitor.liveWebcams.title",
      defaultVisible: true,
      defaultLayout: {
        i: "live-webcams",
        x: 0,
        y: 65,
        w: 12,
        h: 10,
        minW: 6,
        minH: 7,
      },
    },
    {
      id: "correlation",
      title: "Correlation Engine",
      titleKey: "situationMonitor.correlation.title",
      defaultVisible: true,
      defaultLayout: {
        i: "correlation",
        x: 0,
        y: 75,
        w: 8,
        h: 20,
        minW: 6,
        minH: 10,
      },
    },
    {
      id: "narrative",
      title: "Narrative Tracker",
      titleKey: "situationMonitor.narrative.title",
      defaultVisible: true,
      defaultLayout: {
        i: "narrative",
        x: 8,
        y: 75,
        w: 4,
        h: 12,
        minW: 4,
        minH: 8,
      },
    },
    {
      id: "main-character",
      title: "Main Character",
      titleKey: "situationMonitor.mainCharacter.title",
      defaultVisible: true,
      defaultLayout: {
        i: "main-character",
        x: 8,
        y: 87,
        w: 4,
        h: 8,
        minW: 4,
        minH: 6,
      },
    },
    {
      id: "monitors",
      title: "My Monitors",
      titleKey: "situationMonitor.monitors.title",
      defaultVisible: true,
      defaultLayout: {
        i: "monitors",
        x: 0,
        y: 95,
        w: 12,
        h: 10,
        minW: 6,
        minH: 7,
      },
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
  nameKey?: string;
  descriptionKey?: string;
  panels: SituationMonitorPanelId[];
}

export const SITUATION_MONITOR_PRESETS: readonly SituationMonitorPreset[] = [
  {
    id: "news-junkie",
    name: "News Junkie",
    nameKey: "situationMonitor.presets.newsJunkie.name",
    description: "Broad news coverage across all categories plus monitors.",
    descriptionKey: "situationMonitor.presets.newsJunkie.description",
    panels: [
      "map",
      "realtime-snapshot",
      "feeds-politics",
      "feeds-tech",
      "feeds-finance",
      "feeds-gov",
      "feeds-ai",
      "feeds-intel",
      "alerts",
      "telegram-feed",
      "oref-alerts",
      "live-news",
      "monitors",
    ],
  },
  {
    id: "markets",
    name: "Markets",
    nameKey: "situationMonitor.presets.markets.name",
    description: "Markets-focused view with finance + macro signals.",
    descriptionKey: "situationMonitor.presets.markets.description",
    panels: ["map", "feeds-finance", "markets", "crypto", "fed", "alerts"],
  },
  {
    id: "geopolitics",
    name: "Geopolitics",
    nameKey: "situationMonitor.presets.geopolitics.name",
    description:
      "Global situation awareness with hotspots and regional watches.",
    descriptionKey: "situationMonitor.presets.geopolitics.description",
    panels: [
      "map",
      "realtime-snapshot",
      "feeds-politics",
      "feeds-gov",
      "feeds-intel",
      "alerts",
      "telegram-feed",
      "oref-alerts",
      "leaders",
      "situation-venezuela",
      "situation-greenland",
      "situation-iran",
      "live-webcams",
      "correlation",
      "narrative",
    ],
  },
  {
    id: "intel",
    name: "Intel Analyst",
    nameKey: "situationMonitor.presets.intel.name",
    description: "Deep analysis: correlation, narratives, and key figures.",
    descriptionKey: "situationMonitor.presets.intel.description",
    panels: [
      "map",
      "realtime-snapshot",
      "feeds-intel",
      "telegram-feed",
      "correlation",
      "narrative",
      "leaders",
      "main-character",
      "monitors",
    ],
  },
  {
    id: "minimal",
    name: "Minimal",
    nameKey: "situationMonitor.presets.minimal.name",
    description: "Just the essentials: map, key feed, and alerts.",
    descriptionKey: "situationMonitor.presets.minimal.description",
    panels: ["map", "feeds-politics", "alerts"],
  },
  {
    id: "everything",
    name: "Everything",
    nameKey: "situationMonitor.presets.everything.name",
    description: "All panels enabled.",
    descriptionKey: "situationMonitor.presets.everything.description",
    panels: SITUATION_MONITOR_PANELS.map(
      (panel) => panel.id,
    ) as SituationMonitorPanelId[],
  },
] as const;

const LOCKED_PANEL_IDS = new Set<SituationMonitorPanelId>(
  SITUATION_MONITOR_PANELS.filter((panel) => panel.locked).map(
    (panel) => panel.id,
  ),
);

function buildDefaults() {
  const visibility: Record<SituationMonitorPanelId, boolean> =
    Object.fromEntries(
      SITUATION_MONITOR_PANELS.map((panel) => [panel.id, panel.defaultVisible]),
    ) as Record<SituationMonitorPanelId, boolean>;

  const layout = SITUATION_MONITOR_PANELS.map((panel) => ({
    ...panel.defaultLayout,
  }));
  const layouts: SituationMonitorLayouts = {
    lg: layout.map((entry) => ({ ...entry })),
  };

  return { visibility, layout, layouts };
}

function getLayoutItem(
  layout: Layout[],
  id: SituationMonitorPanelId,
): Layout | undefined {
  return layout.find((item) => item.i === id);
}

function isLockedPanelLayoutValid(
  layout: Layout[],
  defaults: Layout[],
  options?: { enforceGeometry?: boolean },
): boolean {
  const enforceGeometry = options?.enforceGeometry ?? true;
  for (const panelId of LOCKED_PANEL_IDS) {
    const actual = getLayoutItem(layout, panelId);
    const expected = getLayoutItem(defaults, panelId);
    if (!actual || !expected) {
      return false;
    }
    if (
      enforceGeometry &&
      (actual.x !== expected.x ||
        actual.y !== expected.y ||
        actual.w !== expected.w ||
        actual.h !== expected.h)
    ) {
      return false;
    }
    if (expected.static === true && actual.static !== true) {
      return false;
    }
  }
  return true;
}

function repairLayoutIfNeeded(
  layout: Layout[],
  defaults: Layout[],
  options?: { enforceGeometry?: boolean },
): { layout: Layout[]; repaired: boolean } {
  if (!isLockedPanelLayoutValid(layout, defaults, options)) {
    return { layout: defaults.map((entry) => ({ ...entry })), repaired: true };
  }
  return { layout, repaired: false };
}

function buildVisibilityForPreset(
  preset: SituationMonitorPreset,
): Record<SituationMonitorPanelId, boolean> {
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

function normalizeResponsiveLayouts(
  rawLayouts: unknown,
  rawLayout: unknown,
  defaults: Layout[],
): { layouts: SituationMonitorLayouts; repaired: boolean } {
  const layouts: SituationMonitorLayouts = {};
  let repaired = false;

  if (
    rawLayouts &&
    typeof rawLayouts === "object" &&
    !Array.isArray(rawLayouts)
  ) {
    const record = rawLayouts as Record<string, unknown>;
    for (const breakpoint of SITUATION_MONITOR_GRID_BREAKPOINT_ORDER) {
      const value = record[breakpoint];
      if (!Array.isArray(value) || value.length === 0) {
        continue;
      }
      const merged = mergeLayout(value as Layout[], defaults);
      const repairedLayout = repairLayoutIfNeeded(merged, defaults, {
        enforceGeometry: breakpoint === "lg",
      });
      layouts[breakpoint] = repairedLayout.layout;
      repaired = repaired || repairedLayout.repaired;
    }
  }

  if (!layouts.lg) {
    const merged = mergeLayout(
      Array.isArray(rawLayout) ? (rawLayout as Layout[]) : [],
      defaults,
    );
    const repairedLayout = repairLayoutIfNeeded(merged, defaults, {
      enforceGeometry: true,
    });
    layouts.lg = repairedLayout.layout;
    repaired = repaired || repairedLayout.repaired;
  }

  return { layouts, repaired };
}

function reconcileResponsiveLayouts(
  layouts: SituationMonitorLayouts,
  defaults: Layout[],
): SituationMonitorLayouts {
  const nextLayouts: SituationMonitorLayouts = {};

  for (const breakpoint of SITUATION_MONITOR_GRID_BREAKPOINT_ORDER) {
    const currentLayout =
      breakpoint === "lg" ? layouts.lg : layouts[breakpoint];
    if (!currentLayout || currentLayout.length === 0) {
      continue;
    }

    const mergedLayout = mergeLayout(currentLayout, defaults);
    nextLayouts[breakpoint] = repairLayoutIfNeeded(mergedLayout, defaults, {
      enforceGeometry: breakpoint === "lg",
    }).layout;
  }

  if (!nextLayouts.lg) {
    nextLayouts.lg = defaults.map((entry) => ({ ...entry }));
  }

  return nextLayouts;
}

export interface SituationMonitorLayoutState {
  layout: Layout[];
  layouts: SituationMonitorLayouts;
  visibility: Record<SituationMonitorPanelId, boolean>;
  setLayout: (
    layout: Layout[],
    breakpoint?: SituationMonitorLayoutBreakpoint,
  ) => void;
  setPanelVisible: (id: SituationMonitorPanelId, visible: boolean) => void;
  togglePanel: (id: SituationMonitorPanelId) => void;
  hydrateFromRemote: (payload: unknown) => boolean;
  applyPreset: (
    presetId: SituationMonitorPresetId,
    options?: { resetLayout?: boolean },
  ) => void;
  reset: () => void;
  ensure: () => void;
}

export const useSituationMonitorLayoutStore =
  create<SituationMonitorLayoutState>((set, get) => {
    const defaults = buildDefaults();
    return {
      layout: defaults.layout,
      layouts: defaults.layouts,
      visibility: defaults.visibility,
      setLayout: (layout, breakpoint = "lg") =>
        set((state) => {
          const nextLayout = layout.map((entry) => ({ ...entry }));
          const nextLayouts: SituationMonitorLayouts = {
            ...state.layouts,
            [breakpoint]: nextLayout,
          };

          return {
            layout: breakpoint === "lg" ? nextLayout : state.layout,
            layouts: nextLayouts,
          };
        }),
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
          return true;
        }

        const record = payload as Record<string, unknown>;
        const rawVisibility = record.visibility;

        const visibilityPatch: Partial<
          Record<SituationMonitorPanelId, boolean>
        > = {};
        if (
          rawVisibility &&
          typeof rawVisibility === "object" &&
          !Array.isArray(rawVisibility)
        ) {
          const visibilityRecord = rawVisibility as Record<string, unknown>;
          for (const panel of SITUATION_MONITOR_PANELS) {
            const val = visibilityRecord[panel.id];
            if (typeof val === "boolean") {
              visibilityPatch[panel.id] = val;
            }
          }
        }

        const normalizedLayouts = normalizeResponsiveLayouts(
          record.layouts,
          record.layout,
          defaults.layout,
        );
        const nextLgLayout = normalizedLayouts.layouts.lg ?? defaults.layout;

        set({
          visibility: { ...defaults.visibility, ...visibilityPatch },
          layout: nextLgLayout,
          layouts: normalizedLayouts.layouts,
        });

        return normalizedLayouts.repaired;
      },
      applyPreset: (presetId, options) => {
        const preset = SITUATION_MONITOR_PRESETS.find(
          (entry) => entry.id === presetId,
        );
        if (!preset) {
          return;
        }
        const defaults = buildDefaults();
        const presetVisibility = buildVisibilityForPreset(preset);
        set((state) => ({
          visibility: presetVisibility,
          layout: options?.resetLayout
            ? defaults.layout
            : mergeLayout(state.layout, defaults.layout),
          layouts: options?.resetLayout
            ? defaults.layouts
            : reconcileResponsiveLayouts(
                {
                  ...state.layouts,
                  lg: mergeLayout(state.layout, defaults.layout),
                },
                defaults.layout,
              ),
        }));
      },
      reset: () => set(buildDefaults()),
      ensure: () => {
        const nextDefaults = buildDefaults();
        const state = get();
        const mergedLayout = mergeLayout(state.layout, nextDefaults.layout);
        const repairedLayout = repairLayoutIfNeeded(
          mergedLayout,
          nextDefaults.layout,
        );
        set({
          visibility: { ...nextDefaults.visibility, ...state.visibility },
          layout: repairedLayout.layout,
          layouts: reconcileResponsiveLayouts(
            { ...state.layouts, lg: repairedLayout.layout },
            nextDefaults.layout,
          ),
        });
      },
    };
  });
