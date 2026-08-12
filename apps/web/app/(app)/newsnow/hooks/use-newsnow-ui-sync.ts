"use client";

import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef } from "react";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";

import {
  normalizeNewsnowPreferenceSettings,
  type NewsnowPreferenceSettings,
  useNewsnowStore,
} from "../store/newsnow-store";

interface RemoteNewsnowUiSettingsResponse {
  version: number;
  updatedAt?: {
    settings?: string;
  };
  settings: Partial<NewsnowPreferenceSettings> | null;
}

const NEWSNOW_UI_SETTINGS_PATH = "user-settings/ui/newsnow";
const SAVE_DEBOUNCE_MS = 900;

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function buildFingerprint(settings: Partial<NewsnowPreferenceSettings>): string {
  const normalized = normalizeNewsnowPreferenceSettings(settings);
  return stableStringify(normalized);
}

export function useNewsnowUiSync() {
  const { data: session, status } = useSession();
  const accessToken = session?.accessToken as string | undefined;
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );

  const focusSources = useNewsnowStore((state) => state.focusSources);
  const columnOrders = useNewsnowStore((state) => state.columnOrders);
  const hideCrossSourceDuplicates = useNewsnowStore(
    (state) => state.hideCrossSourceDuplicates,
  );
  const sortMode = useNewsnowStore((state) => state.sortMode);
  const densityMode = useNewsnowStore((state) => state.densityMode);
  const sourceAffinity = useNewsnowStore((state) => state.sourceAffinity);
  const replacePreferences = useNewsnowStore((state) => state.replacePreferences);

  const hydratedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedFingerprintRef = useRef<string | null>(null);
  const dirtyBeforeHydrationRef = useRef(false);
  const skipFirstChangeRunRef = useRef(true);

  // If the user interacts (toggle/drag/etc.) before the remote fetch returns,
  // hydration must not clobber those local changes. Track dirtiness during
  // the pre-hydration window; fetchRemote then skips replacePreferences and
  // lets the save effect upload the local state instead.
  useEffect(() => {
    if (skipFirstChangeRunRef.current) {
      skipFirstChangeRunRef.current = false;
      return;
    }
    if (!hydratedRef.current) {
      dirtyBeforeHydrationRef.current = true;
    }
  }, [
    focusSources,
    columnOrders,
    hideCrossSourceDuplicates,
    sortMode,
    densityMode,
    sourceAffinity,
  ]);

  useEffect(() => {
    if (status !== "authenticated" || !accessToken) {
      hydratedRef.current = false;
      lastSavedFingerprintRef.current = null;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      return;
    }

    hydratedRef.current = false;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    let cancelled = false;

    const fetchRemote = async () => {
      try {
        const response = await apiClient.get<RemoteNewsnowUiSettingsResponse>(
          NEWSNOW_UI_SETTINGS_PATH,
        );
        if (cancelled) {
          return;
        }
        const remoteSettings = response.data?.settings;
        if (remoteSettings && !dirtyBeforeHydrationRef.current) {
          replacePreferences(remoteSettings);
          lastSavedFingerprintRef.current = buildFingerprint(remoteSettings);
        } else if (
          !remoteSettings &&
          !dirtyBeforeHydrationRef.current
        ) {
          // No server prefs for this (org, user). The store persists under a single
          // global localStorage key, so without a reset the previous org's prefs would
          // remain and get uploaded into this org's slot. Reset to defaults and baseline
          // the fingerprint to defaults so nothing is saved until the user changes a pref.
          const defaults = normalizeNewsnowPreferenceSettings({});
          replacePreferences(defaults);
          lastSavedFingerprintRef.current = buildFingerprint(defaults);
        }
        hydratedRef.current = true;
      } catch (error) {
        if (cancelled) {
          return;
        }
        hydratedRef.current = false;
        captureClientError("Failed to load NewsNow UI settings", error);
      }
    };

    void fetchRemote();

    return () => {
      cancelled = true;
    };
  }, [accessToken, apiClient, replacePreferences, status]);

  useEffect(() => {
    if (status !== "authenticated" || !accessToken || !hydratedRef.current) {
      return;
    }

    const settings: NewsnowPreferenceSettings = {
      focusSources,
      columnOrders,
      hideCrossSourceDuplicates,
      sortMode,
      densityMode,
      sourceAffinity,
    };
    const nextFingerprint = buildFingerprint(settings);
    if (nextFingerprint === lastSavedFingerprintRef.current) {
      return;
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      apiClient
        .put(NEWSNOW_UI_SETTINGS_PATH, { settings })
        .then(() => {
          lastSavedFingerprintRef.current = nextFingerprint;
        })
        .catch((error) => {
          captureClientError("Failed to save NewsNow UI settings", error);
        });
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [
    accessToken,
    apiClient,
    columnOrders,
    densityMode,
    focusSources,
    hideCrossSourceDuplicates,
    sourceAffinity,
    sortMode,
    status,
  ]);
}
