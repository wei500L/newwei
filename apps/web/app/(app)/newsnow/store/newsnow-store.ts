import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";

import {
  buildNewsnowSnapshotHash,
  type NewsnowSnapshotItem,
} from "../lib/newsnow-dnd";

export type NewsnowSortMode = "manual" | "personalized" | "smart";
export type NewsnowDensityMode = "compact" | "comfortable";
export type NewsnowInteractionType =
  | "open_original"
  | "open_event"
  | "open_item"
  | "refresh"
  | "focus";

export interface NewsnowSourceAffinity {
  score: number;
  openOriginalCount: number;
  openEventCount: number;
  openItemCount: number;
  refreshCount: number;
  focusCount: number;
  accumulatedDwellMs: number;
  lastInteractedAt: number;
}

export interface NewsnowSourceSnapshot {
  updatedAt: number;
  items: NewsnowSnapshotItem[];
}

export interface NewsnowRealtimeHighlight {
  sourceId: string;
  count: number;
  topTitles: string[];
  timestamp: string;
  updatedTime?: string;
}

export interface NewsnowPreferenceSettings {
  focusSources: string[];
  columnOrders: Record<string, string[]>;
  hideCrossSourceDuplicates: boolean;
  sortMode: NewsnowSortMode;
  densityMode: NewsnowDensityMode;
  sourceAffinity: Record<string, NewsnowSourceAffinity>;
}

interface NewsnowState {
  focusSources: string[];
  columnOrders: Record<string, string[]>;
  hideCrossSourceDuplicates: boolean;
  sortMode: NewsnowSortMode;
  densityMode: NewsnowDensityMode;
  sourceAffinity: Record<string, NewsnowSourceAffinity>;
  visibleSourceIds: string[];
  sourceSnapshots: Record<string, NewsnowSourceSnapshot>;
  sourceSnapshotHashes: Record<string, string>;
  sourceUnreadItemIds: Record<string, string[]>;
  liveUnreadBySource: Record<string, number>;
  realtimeHighlights: NewsnowRealtimeHighlight[];
  lastRealtimeEventAt?: number;
  realtimeConnected: boolean;
  realtimeConnectionError?: string;
  toggleFocus: (id: string) => void;
  setColumnOrder: (column: string, order: string[]) => void;
  resetColumnOrders: () => void;
  setHideCrossSourceDuplicates: (enabled: boolean) => void;
  setSortMode: (mode: NewsnowSortMode) => void;
  setDensityMode: (mode: NewsnowDensityMode) => void;
  resetSourceAffinity: () => void;
  replacePreferences: (settings: Partial<NewsnowPreferenceSettings>) => void;
  setSourceVisibility: (sourceId: string, visible: boolean) => void;
  incrementLiveUnread: (sourceId: string, count?: number) => void;
  recordRealtimeArrival: (payload: {
    sourceId: string;
    count?: number;
    topTitles?: string[];
    timestamp?: string;
    updatedTime?: string;
  }) => void;
  clearLiveUnread: (sourceId: string) => void;
  clearAllLiveUnread: () => void;
  setRealtimeConnectionState: (payload: {
    connected: boolean;
    error?: string;
  }) => void;
  trackSourceInteraction: (
    sourceId: string,
    interaction: NewsnowInteractionType,
    options?: { dwellMs?: number }
  ) => void;
  reconcileSourceItems: (sourceId: string, currentItemIds: string[]) => void;
  markSourceItemSeen: (sourceId: string, itemId: string) => void;
  clearSourceUnread: (sourceId: string) => void;
  upsertSourceSnapshot: (sourceId: string, snapshot: NewsnowSourceSnapshot) => void;
  removeSourceSnapshot: (sourceId: string) => void;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const NOOP_STORAGE: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function areStringArraysEqual(current: string[], next: string[]): boolean {
  if (current.length !== next.length) {
    return false;
  }
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

function normalizeItemIds(itemIds: string[]): string[] {
  const next: string[] = [];
  for (const rawItemId of itemIds) {
    const normalizedItemId = toItemId(rawItemId);
    if (!normalizedItemId || next.includes(normalizedItemId)) {
      continue;
    }
    next.push(normalizedItemId);
    if (next.length >= 5000) {
      break;
    }
  }
  return next;
}

function resolveInteractionWeight(
  interaction: NewsnowInteractionType,
  options?: { dwellMs?: number }
): number {
  const baseWeights: Record<NewsnowInteractionType, number> = {
    open_original: 1,
    open_event: 1.6,
    open_item: 2,
    refresh: 0.25,
    focus: 0.4,
  };

  const dwellMs =
    options && typeof options.dwellMs === "number" && Number.isFinite(options.dwellMs)
      ? clamp(options.dwellMs, 0, 5 * 60 * 1000)
      : 0;

  const dwellBoost = dwellMs > 0 ? Math.min(dwellMs / 60_000, 1.4) : 0;
  return baseWeights[interaction] + dwellBoost;
}

function toSourceId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return /^[a-z0-9_-]{1,64}$/i.test(trimmed) ? trimmed : null;
}

function toItemId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, 512);
}

function normalizeAffinityEntry(value: unknown): NewsnowSourceAffinity {
  const entry = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const toSafeInt = (raw: unknown) =>
    clamp(
      Math.round(typeof raw === "number" && Number.isFinite(raw) ? raw : 0),
      0,
      1_000_000_000
    );
  const toSafeFloat = (raw: unknown) =>
    clamp(typeof raw === "number" && Number.isFinite(raw) ? raw : 0, 0, 100);
  return {
    score: toSafeFloat(entry.score),
    openOriginalCount: toSafeInt(entry.openOriginalCount),
    openEventCount: toSafeInt(entry.openEventCount),
    openItemCount: toSafeInt(entry.openItemCount),
    refreshCount: toSafeInt(entry.refreshCount),
    focusCount: toSafeInt(entry.focusCount),
    accumulatedDwellMs: toSafeInt(entry.accumulatedDwellMs),
    lastInteractedAt: toSafeInt(entry.lastInteractedAt),
  };
}

export function normalizeNewsnowPreferenceSettings(
  settings: Partial<NewsnowPreferenceSettings>
): NewsnowPreferenceSettings {
  const focusSources: string[] = [];
  for (const raw of settings.focusSources ?? []) {
    const sourceId = toSourceId(raw);
    if (!sourceId || focusSources.includes(sourceId)) {
      continue;
    }
    focusSources.push(sourceId);
    if (focusSources.length >= 200) {
      break;
    }
  }

  const columnOrders: Record<string, string[]> = {};
  const rawColumnOrders =
    settings.columnOrders && typeof settings.columnOrders === "object"
      ? settings.columnOrders
      : {};
  for (const [column, rawOrder] of Object.entries(rawColumnOrders)) {
    const normalizedColumn = toSourceId(column);
    if (!normalizedColumn || !Array.isArray(rawOrder)) {
      continue;
    }
    const normalizedOrder: string[] = [];
    for (const rawSource of rawOrder) {
      const sourceId = toSourceId(rawSource);
      if (!sourceId || normalizedOrder.includes(sourceId)) {
        continue;
      }
      normalizedOrder.push(sourceId);
      if (normalizedOrder.length >= 200) {
        break;
      }
    }
    if (normalizedOrder.length > 0) {
      columnOrders[normalizedColumn] = normalizedOrder;
    }
  }

  const sourceAffinity: Record<string, NewsnowSourceAffinity> = {};
  const rawAffinity =
    settings.sourceAffinity && typeof settings.sourceAffinity === "object"
      ? settings.sourceAffinity
      : {};
  for (const [sourceId, affinity] of Object.entries(rawAffinity)) {
    const normalizedSourceId = toSourceId(sourceId);
    if (!normalizedSourceId) {
      continue;
    }
    sourceAffinity[normalizedSourceId] = normalizeAffinityEntry(affinity);
    if (Object.keys(sourceAffinity).length >= 300) {
      break;
    }
  }

  return {
    focusSources,
    columnOrders,
    hideCrossSourceDuplicates: settings.hideCrossSourceDuplicates === true,
    sortMode:
      settings.sortMode === "smart" || settings.sortMode === "personalized"
        ? "personalized"
        : "manual",
    densityMode: settings.densityMode === "comfortable" ? "comfortable" : "compact",
    sourceAffinity,
  };
}

export const useNewsnowStore = create<NewsnowState>()(
  persist(
    (set) => ({
      focusSources: [],
      columnOrders: {},
      hideCrossSourceDuplicates: false,
      sortMode: "manual",
      densityMode: "compact",
      sourceAffinity: {},
      visibleSourceIds: [],
      sourceSnapshots: {},
      sourceSnapshotHashes: {},
      sourceUnreadItemIds: {},
      liveUnreadBySource: {},
      realtimeHighlights: [],
      lastRealtimeEventAt: undefined,
      realtimeConnected: false,
      realtimeConnectionError: undefined,
      toggleFocus: (id) =>
        set((state) => ({
          focusSources: state.focusSources.includes(id)
            ? state.focusSources.filter((s) => s !== id)
            : [...state.focusSources, id],
        })),
      setColumnOrder: (column, order) =>
        set((state) => ({
          columnOrders: {
            ...state.columnOrders,
            [column]: order,
          },
        })),
      resetColumnOrders: () =>
        set(() => ({
          columnOrders: {},
        })),
      setHideCrossSourceDuplicates: (enabled) =>
        set(() => ({
          hideCrossSourceDuplicates: enabled,
        })),
      setSortMode: (mode) =>
        set(() => ({
          sortMode:
            mode === "smart" || mode === "personalized"
              ? "personalized"
              : "manual",
        })),
      setDensityMode: (mode) =>
        set(() => ({
          densityMode: mode === "comfortable" ? "comfortable" : "compact",
        })),
      resetSourceAffinity: () =>
        set(() => ({
          sourceAffinity: {},
        })),
      replacePreferences: (settings) =>
        set((state) => {
          const normalized = normalizeNewsnowPreferenceSettings(settings);
          return {
            focusSources: normalized.focusSources,
            columnOrders: normalized.columnOrders,
            hideCrossSourceDuplicates: normalized.hideCrossSourceDuplicates,
            sortMode: normalized.sortMode,
            densityMode:
              settings.densityMode === undefined
                ? state.densityMode
                : normalized.densityMode,
            sourceAffinity: normalized.sourceAffinity,
          };
        }),
      setSourceVisibility: (sourceId, visible) =>
        set((state) => {
          const normalizedSourceId = toSourceId(sourceId);
          if (!normalizedSourceId) {
            return state;
          }

          if (visible) {
            if (state.visibleSourceIds.includes(normalizedSourceId)) {
              return state;
            }
            return {
              visibleSourceIds: [...state.visibleSourceIds, normalizedSourceId],
            };
          }

          if (!state.visibleSourceIds.includes(normalizedSourceId)) {
            return state;
          }

          return {
            visibleSourceIds: state.visibleSourceIds.filter(
              (entry) => entry !== normalizedSourceId,
            ),
          };
        }),
      incrementLiveUnread: (sourceId, count = 1) =>
        set((state) => {
          const normalizedSourceId = toSourceId(sourceId);
          if (!normalizedSourceId) {
            return state;
          }
          const safeCount =
            Number.isFinite(count) && count > 0 ? Math.min(Math.round(count), 5000) : 1;
          const current = state.liveUnreadBySource[normalizedSourceId] ?? 0;
          return {
            liveUnreadBySource: {
              ...state.liveUnreadBySource,
              [normalizedSourceId]: current + safeCount,
            },
            lastRealtimeEventAt: Date.now(),
          };
        }),
      recordRealtimeArrival: ({ sourceId, count = 1, topTitles, timestamp, updatedTime }) =>
        set((state) => {
          const normalizedSourceId = toSourceId(sourceId);
          if (!normalizedSourceId) {
            return state;
          }
          const safeCount =
            Number.isFinite(count) && count > 0 ? Math.min(Math.round(count), 5000) : 1;
          const current = state.liveUnreadBySource[normalizedSourceId] ?? 0;
          const normalizedTopTitles = Array.isArray(topTitles)
            ? topTitles
                .map((title) => (typeof title === "string" ? title.trim() : ""))
                .filter((title) => title.length > 0)
                .slice(0, 3)
            : [];
          const normalizedTimestamp =
            typeof timestamp === "string" && timestamp.trim().length > 0
              ? timestamp.trim()
              : new Date().toISOString();
          const normalizedUpdatedTime =
            typeof updatedTime === "string" && updatedTime.trim().length > 0
              ? updatedTime.trim()
              : undefined;
          const nextHighlights = [
            {
              sourceId: normalizedSourceId,
              count: safeCount,
              topTitles: normalizedTopTitles,
              timestamp: normalizedTimestamp,
              ...(normalizedUpdatedTime ? { updatedTime: normalizedUpdatedTime } : {}),
            },
            ...state.realtimeHighlights.filter(
              (entry) =>
                !(
                  entry.sourceId === normalizedSourceId &&
                  entry.timestamp === normalizedTimestamp
                ),
            ),
          ].slice(0, 12);
          return {
            liveUnreadBySource: {
              ...state.liveUnreadBySource,
              [normalizedSourceId]: current + safeCount,
            },
            realtimeHighlights: nextHighlights,
            lastRealtimeEventAt: Date.now(),
          };
        }),
      clearLiveUnread: (sourceId) =>
        set((state) => {
          const normalizedSourceId = toSourceId(sourceId);
          if (!normalizedSourceId || !state.liveUnreadBySource[normalizedSourceId]) {
            return state;
          }
          const next = { ...state.liveUnreadBySource };
          delete next[normalizedSourceId];
          return {
            liveUnreadBySource: next,
            realtimeHighlights: state.realtimeHighlights.filter(
              (entry) => entry.sourceId !== normalizedSourceId,
            ),
          };
        }),
      clearAllLiveUnread: () =>
        set(() => ({
          liveUnreadBySource: {},
          realtimeHighlights: [],
        })),
      setRealtimeConnectionState: ({ connected, error }) =>
        set(() => ({
          realtimeConnected: connected,
          realtimeConnectionError: error,
        })),
      trackSourceInteraction: (sourceId, interaction, options) =>
        set((state) => {
          const now = Date.now();
          const existing = state.sourceAffinity[sourceId];
          const elapsedDays =
            existing && typeof existing.lastInteractedAt === "number"
              ? clamp((now - existing.lastInteractedAt) / ONE_DAY_MS, 0, 30)
              : 30;
          const decayFactor = Math.pow(0.93, elapsedDays);
          const baseScore = (existing?.score ?? 0) * decayFactor;
          const increment = resolveInteractionWeight(interaction, options);

          const next: NewsnowSourceAffinity = {
            score: clamp(baseScore + increment, 0, 100),
            openOriginalCount:
              (existing?.openOriginalCount ?? 0) + (interaction === "open_original" ? 1 : 0),
            openEventCount:
              (existing?.openEventCount ?? 0) + (interaction === "open_event" ? 1 : 0),
            openItemCount:
              (existing?.openItemCount ?? 0) + (interaction === "open_item" ? 1 : 0),
            refreshCount: (existing?.refreshCount ?? 0) + (interaction === "refresh" ? 1 : 0),
            focusCount: (existing?.focusCount ?? 0) + (interaction === "focus" ? 1 : 0),
            accumulatedDwellMs:
              (existing?.accumulatedDwellMs ?? 0) +
              (typeof options?.dwellMs === "number" && Number.isFinite(options.dwellMs)
                ? clamp(options.dwellMs, 0, 5 * 60 * 1000)
                : 0),
            lastInteractedAt: now,
          };

          return {
            sourceAffinity: {
              ...state.sourceAffinity,
              [sourceId]: next,
            },
          };
        }),
      reconcileSourceItems: (sourceId, currentItemIds) =>
        set((state) => {
          const normalizedSourceId = toSourceId(sourceId);
          if (!normalizedSourceId) {
            return state;
          }

          const nextItemIds = normalizeItemIds(currentItemIds);
          const currentItemIdSet = new Set(nextItemIds);
          const existingUnread = state.sourceUnreadItemIds[normalizedSourceId] ?? [];
          const previousSnapshotItemIds =
            state.sourceSnapshots[normalizedSourceId]?.items.map((item) => item.id) ?? [];
          const previousItemIdSet = new Set(previousSnapshotItemIds);
          const addedItemIds =
            previousSnapshotItemIds.length === 0
              ? []
              : nextItemIds.filter((itemId) => !previousItemIdSet.has(itemId));
          const preservedUnread = existingUnread.filter((itemId) => currentItemIdSet.has(itemId));
          const mergedUnread = Array.from(new Set([...addedItemIds, ...preservedUnread])).slice(0, 80);

          if (areStringArraysEqual(existingUnread, mergedUnread)) {
            return state;
          }

          const nextSourceUnreadItemIds = { ...state.sourceUnreadItemIds };
          if (mergedUnread.length === 0) {
            delete nextSourceUnreadItemIds[normalizedSourceId];
          } else {
            nextSourceUnreadItemIds[normalizedSourceId] = mergedUnread;
          }

          return {
            sourceUnreadItemIds: nextSourceUnreadItemIds,
          };
        }),
      markSourceItemSeen: (sourceId, itemId) =>
        set((state) => {
          const normalizedSourceId = toSourceId(sourceId);
          const normalizedItemId = toItemId(itemId);
          if (!normalizedSourceId || !normalizedItemId) {
            return state;
          }
          const existingUnread = state.sourceUnreadItemIds[normalizedSourceId];
          if (!existingUnread || !existingUnread.includes(normalizedItemId)) {
            return state;
          }
          const nextUnread = existingUnread.filter((entry) => entry !== normalizedItemId);
          const nextSourceUnreadItemIds = { ...state.sourceUnreadItemIds };
          if (nextUnread.length === 0) {
            delete nextSourceUnreadItemIds[normalizedSourceId];
          } else {
            nextSourceUnreadItemIds[normalizedSourceId] = nextUnread;
          }
          return {
            sourceUnreadItemIds: nextSourceUnreadItemIds,
          };
        }),
      clearSourceUnread: (sourceId) =>
        set((state) => {
          const normalizedSourceId = toSourceId(sourceId);
          if (!normalizedSourceId || !state.sourceUnreadItemIds[normalizedSourceId]) {
            return state;
          }
          const nextSourceUnreadItemIds = { ...state.sourceUnreadItemIds };
          delete nextSourceUnreadItemIds[normalizedSourceId];
          return {
            sourceUnreadItemIds: nextSourceUnreadItemIds,
          };
        }),
      upsertSourceSnapshot: (sourceId, snapshot) =>
        set((state) => {
          const normalizedSourceId = toSourceId(sourceId);
          if (!normalizedSourceId) {
            return state;
          }

          const nextHash = buildNewsnowSnapshotHash(snapshot.items);
          if (state.sourceSnapshotHashes[normalizedSourceId] === nextHash) {
            return state;
          }

          return {
            sourceSnapshots: {
              ...state.sourceSnapshots,
              [normalizedSourceId]: snapshot,
            },
            sourceSnapshotHashes: {
              ...state.sourceSnapshotHashes,
              [normalizedSourceId]: nextHash,
            },
          };
        }),
      removeSourceSnapshot: (sourceId) =>
        set((state) => {
          const normalizedSourceId = toSourceId(sourceId);
          if (!normalizedSourceId || !state.sourceSnapshots[normalizedSourceId]) {
            return state;
          }
          const nextSnapshots = { ...state.sourceSnapshots };
          const nextHashes = { ...state.sourceSnapshotHashes };
          delete nextSnapshots[normalizedSourceId];
          delete nextHashes[normalizedSourceId];
          return {
            sourceSnapshots: nextSnapshots,
            sourceSnapshotHashes: nextHashes,
          };
        }),
    }),
    {
      name: "newsnow-storage",
      storage: createJSONStorage(() => {
        if (typeof window === "undefined") {
          return NOOP_STORAGE;
        }
        const storageCandidate = window.localStorage;
        if (
          !storageCandidate ||
          typeof storageCandidate.getItem !== "function" ||
          typeof storageCandidate.setItem !== "function" ||
          typeof storageCandidate.removeItem !== "function"
        ) {
          return NOOP_STORAGE;
        }
        return storageCandidate;
      }),
      partialize: (state) => ({
        focusSources: state.focusSources,
        columnOrders: state.columnOrders,
        hideCrossSourceDuplicates: state.hideCrossSourceDuplicates,
        sortMode: state.sortMode,
        densityMode: state.densityMode,
        sourceAffinity: state.sourceAffinity,
      }),
    }
  )
);
