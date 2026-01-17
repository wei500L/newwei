"use client";

import { create } from "zustand";

export type UserUiSyncSection = "situation-monitor" | "war-map";

export type UserUiSyncState = "idle" | "loading" | "syncing" | "error";

export interface UserUiSyncSectionStatus {
  state: UserUiSyncState;
  pending: number;
  lastSyncedAt?: number;
  lastErrorAt?: number;
  lastErrorMessage?: string;
}

export interface UserUiSyncStatusState {
  sections: Record<UserUiSyncSection, UserUiSyncSectionStatus>;
  reloadToken: number;
  reset: () => void;
  requestReload: () => void;
  markLoading: (section: UserUiSyncSection) => void;
  markIdle: (section: UserUiSyncSection, syncedAt?: number) => void;
  beginSave: (section: UserUiSyncSection) => void;
  endSaveSuccess: (section: UserUiSyncSection, syncedAt?: number) => void;
  endSaveError: (section: UserUiSyncSection, message: string) => void;
  markError: (section: UserUiSyncSection, message: string) => void;
}

const initialSection = (): UserUiSyncSectionStatus => ({
  state: "idle",
  pending: 0,
});

const initialState = (): Record<UserUiSyncSection, UserUiSyncSectionStatus> => ({
  "situation-monitor": initialSection(),
  "war-map": initialSection(),
});

export const useUserUiSyncStatusStore = create<UserUiSyncStatusState>((set) => ({
  sections: initialState(),
  reloadToken: 0,
  reset: () => set({ sections: initialState(), reloadToken: 0 }),
  requestReload: () => set((state) => ({ reloadToken: state.reloadToken + 1 })),
  markLoading: (section) =>
    set((state) => ({
      sections: {
        ...state.sections,
        [section]: {
          ...state.sections[section],
          state: "loading",
          pending: 0,
          lastErrorAt: undefined,
          lastErrorMessage: undefined,
        },
      },
    })),
  markIdle: (section, syncedAt = Date.now()) =>
    set((state) => ({
      sections: {
        ...state.sections,
        [section]: {
          ...state.sections[section],
          state: "idle",
          pending: 0,
          lastSyncedAt: syncedAt,
          lastErrorAt: undefined,
          lastErrorMessage: undefined,
        },
      },
    })),
  beginSave: (section) =>
    set((state) => {
      const current = state.sections[section];
      const pending = current.pending + 1;
      return {
        sections: {
          ...state.sections,
          [section]: {
            ...current,
            pending,
            state: "syncing",
          },
        },
      };
    }),
  endSaveSuccess: (section, syncedAt = Date.now()) =>
    set((state) => {
      const current = state.sections[section];
      const pending = Math.max(0, current.pending - 1);
      return {
        sections: {
          ...state.sections,
          [section]: {
            ...current,
            pending,
            state: pending > 0 ? "syncing" : "idle",
            lastSyncedAt: syncedAt,
            lastErrorAt: undefined,
            lastErrorMessage: undefined,
          },
        },
      };
    }),
  endSaveError: (section, message) =>
    set((state) => {
      const current = state.sections[section];
      const pending = Math.max(0, current.pending - 1);
      return {
        sections: {
          ...state.sections,
          [section]: {
            ...current,
            pending,
            state: "error",
            lastErrorAt: Date.now(),
            lastErrorMessage: message,
          },
        },
      };
    }),
  markError: (section, message) =>
    set((state) => ({
      sections: {
        ...state.sections,
        [section]: {
          ...state.sections[section],
          state: "error",
          pending: 0,
          lastErrorAt: Date.now(),
          lastErrorMessage: message,
        },
      },
    })),
}));
