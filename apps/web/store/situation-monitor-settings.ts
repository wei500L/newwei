"use client";

import { create } from "zustand";

export type SituationMonitorScope = "tagged" | "all";

export interface SituationMonitorSettingsState {
  windowHours: number;
  scope: SituationMonitorScope;
  autoRefresh: boolean;
  resetLayoutOnPreset: boolean;
  setWindowHours: (hours: number) => void;
  setScope: (scope: SituationMonitorScope) => void;
  setAutoRefresh: (enabled: boolean) => void;
  setResetLayoutOnPreset: (enabled: boolean) => void;
  hydrateFromRemote: (payload: unknown) => void;
  reset: () => void;
}

const normalizeWindowHours = (value: unknown): number => {
  const raw = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(raw)) {
    return 24;
  }
  const allowed = new Set([6, 24, 72]);
  return allowed.has(raw) ? raw : 24;
};

const normalizeScope = (value: unknown): SituationMonitorScope => {
  return value === "all" ? "all" : "tagged";
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean => {
  return typeof value === "boolean" ? value : fallback;
};

export const useSituationMonitorSettingsStore = create<SituationMonitorSettingsState>((set) => ({
  windowHours: 24,
  scope: "tagged",
  autoRefresh: true,
  resetLayoutOnPreset: false,
  setWindowHours: (hours) => set({ windowHours: normalizeWindowHours(hours) }),
  setScope: (scope) => set({ scope: normalizeScope(scope) }),
  setAutoRefresh: (enabled) => set({ autoRefresh: Boolean(enabled) }),
  setResetLayoutOnPreset: (enabled) => set({ resetLayoutOnPreset: Boolean(enabled) }),
  hydrateFromRemote: (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const record = payload as Record<string, unknown>;
    set({
      windowHours: normalizeWindowHours(record.windowHours),
      scope: normalizeScope(record.scope),
      autoRefresh: normalizeBoolean(record.autoRefresh, true),
      resetLayoutOnPreset: normalizeBoolean(record.resetLayoutOnPreset, false),
    });
  },
  reset: () =>
    set({
      windowHours: 24,
      scope: "tagged",
      autoRefresh: true,
      resetLayoutOnPreset: false,
    }),
}));
