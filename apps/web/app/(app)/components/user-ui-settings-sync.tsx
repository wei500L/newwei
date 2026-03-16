"use client";

import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import {
  mergeWarMapSettingsWithUrlState,
} from "@/app/(app)/dashboard/charts/war-map/url-state";
import {
  buildDefaultSituationMonitorLayoutPayload,
  fingerprintSituationMonitorLayout,
  type SituationMonitorLayoutPayload,
} from "@/lib/situation-monitor-layout-serialization";
import { useSituationMonitorLayoutStore } from "@/store/situation-monitor-layout";
import { useSituationMonitorSettingsStore } from "@/store/situation-monitor-settings";
import { useUserUiSyncStatusStore } from "@/store/user-ui-sync-status";
import {
  WAR_MAP_DEFAULT_LAYER_VISIBILITY,
  WAR_MAP_PRESET_VIEW_STATE,
  normalizeWarMapSettingsSafe,
  useWarMapSettingsStore,
} from "@/store/war-map-settings";
import type { StoredSituationMonitor } from "@/app/(app)/situation-monitor/types/situation-monitor-monitors";
import { emitSituationMonitorMonitorsUpdated } from "@/app/(app)/situation-monitor/utils/monitor-events";

const LEGACY_STORAGE_KEY_SITUATION_MONITOR_LAYOUT =
  "situation-monitor:layout:v1";
const LEGACY_STORAGE_KEY_SITUATION_MONITOR_MONITORS =
  "situation-monitor:monitors:v1";
const LEGACY_STORAGE_KEY_SITUATION_MONITOR_SETTINGS =
  "situation-monitor:settings:v1";
const LEGACY_STORAGE_KEY_WAR_MAP_SETTINGS = "war-map:settings:v1";

const UI_CACHE_PREFIX = "ui-cache:user-ui-settings";

interface RemoteSituationMonitorUiSettings {
  version: number;
  updatedAt?: {
    layout?: string;
    settings?: string;
  };
  layout: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
}

interface RemoteWarMapUiSettings {
  version: number;
  updatedAt?: {
    settings?: string;
  };
  settings: Record<string, unknown> | null;
}

type SaveKind = "layout" | "settings" | "warMapSettings";

const debounceMsByKind: Record<SaveKind, number> = {
  layout: 1500,
  settings: 600,
  warMapSettings: 700,
};

const defaultSituationMonitorLayout =
  buildDefaultSituationMonitorLayoutPayload();

const defaultSituationMonitorSettings = {
  windowHours: 24,
  scope: "tagged",
  autoRefresh: true,
  resetLayoutOnPreset: false,
  translateToZh: false,
};

const defaultLayoutFingerprint = fingerprintSituationMonitorLayout(
  defaultSituationMonitorLayout,
);
const defaultSettingsFingerprint = fingerprintSettings(
  defaultSituationMonitorSettings,
);
const defaultWarMapFingerprint = fingerprintWarMapSettings({
  layerVisibility: WAR_MAP_DEFAULT_LAYER_VISIBILITY,
  viewState: WAR_MAP_PRESET_VIEW_STATE.global,
  activePreset: "global",
  timeRangePreset: "7d",
  flightMode: "military",
  aisMode: "military",
});

type UiCacheSection = "situation-monitor" | "war-map";

interface UiCacheEnvelope<T> {
  version: 1;
  updatedAt: number;
  payload: T;
}

interface SituationMonitorCachePayload {
  layout?: SituationMonitorLayoutPayload;
  settings?: Record<string, unknown>;
}

interface WarMapCachePayload {
  settings?: Record<string, unknown>;
}

interface LegacySituationMonitorPayload {
  name: string;
  rawKeywords: string[];
  enabled: boolean;
  color?: string;
  location?: {
    name: string;
    lat: number;
    lng: number;
  };
}

function fingerprintSettings(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "{}";
  }
  const record = payload as Record<string, unknown>;
  return JSON.stringify({
    windowHours: record.windowHours ?? null,
    scope: record.scope ?? null,
    autoRefresh: record.autoRefresh ?? null,
    resetLayoutOnPreset: record.resetLayoutOnPreset ?? null,
    translateToZh: record.translateToZh ?? null,
  });
}

function fingerprintWarMapSettings(payload: unknown): string {
  const normalized = normalizeWarMapSettingsSafe(payload);
  return JSON.stringify(normalized);
}

function normalizeTextValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return /^#[0-9a-f]{3}$/i.test(normalized) ||
    /^#[0-9a-f]{6}$/i.test(normalized)
    ? normalized.toLowerCase()
    : undefined;
}

function normalizeLegacyMonitorKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 30),
    ),
  );
}

function normalizeLegacyMonitorLocation(
  value: unknown,
): LegacySituationMonitorPayload["location"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = normalizeTextValue(value.name, 64);
  const lat =
    typeof value.lat === "number" && Number.isFinite(value.lat)
      ? value.lat
      : Number.NaN;
  const lng =
    typeof value.lng === "number" && Number.isFinite(value.lng)
      ? value.lng
      : Number.NaN;
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return undefined;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return undefined;
  }
  return { name, lat, lng };
}

function normalizeLegacySituationMonitors(
  state: Record<string, unknown> | null,
): LegacySituationMonitorPayload[] {
  const monitors = Array.isArray(state?.monitors) ? state.monitors : [];
  const normalized: LegacySituationMonitorPayload[] = [];
  for (const monitor of monitors) {
    if (!isRecord(monitor)) {
      continue;
    }
    const name = normalizeTextValue(monitor.name, 64);
    const rawKeywords = normalizeLegacyMonitorKeywords(monitor.keywords);
    if (!name || rawKeywords.length === 0) {
      continue;
    }
    normalized.push({
      name,
      rawKeywords,
      enabled: typeof monitor.enabled === "boolean" ? monitor.enabled : true,
      color: normalizeHexColor(monitor.color),
      location: normalizeLegacyMonitorLocation(monitor.location),
    });
    if (normalized.length >= 20) {
      break;
    }
  }
  return normalized;
}

function buildSituationMonitorSignature(input: {
  name: string;
  rawKeywords: string[];
}): string {
  return JSON.stringify({
    name: normalizeTextValue(input.name, 64).toLowerCase(),
    rawKeywords: input.rawKeywords
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .sort(),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildCacheKey(section: UiCacheSection, orgId: string, userId: string) {
  return `${UI_CACHE_PREFIX}:v1:${section}:org=${orgId}:user=${userId}`;
}

function readJsonFromStorage(key: string): unknown | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function writeJsonToStorage(key: string, value: unknown) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / serialization errors
  }
}

function removeStorageKey(key: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function readLegacyZustandPersistState(
  key: string,
): Record<string, unknown> | null {
  const parsed = readJsonFromStorage(key);
  if (!isRecord(parsed)) {
    return null;
  }
  const state = parsed.state;
  return isRecord(state) ? state : null;
}

function readCacheEnvelope<T>(key: string): UiCacheEnvelope<T> | null {
  const parsed = readJsonFromStorage(key);
  if (!isRecord(parsed)) {
    return null;
  }
  if (parsed.version !== 1) {
    return null;
  }
  const updatedAt =
    typeof parsed.updatedAt === "number" ? parsed.updatedAt : Number.NaN;
  if (!Number.isFinite(updatedAt)) {
    return null;
  }
  if (!("payload" in parsed)) {
    return null;
  }
  return parsed as unknown as UiCacheEnvelope<T>;
}

function writeSituationMonitorCache(orgId: string, userId: string) {
  const key = buildCacheKey("situation-monitor", orgId, userId);
  const layout = {
    layouts: useSituationMonitorLayoutStore.getState().layouts,
    visibility: useSituationMonitorLayoutStore.getState().visibility,
  };
  const settings = {
    windowHours: useSituationMonitorSettingsStore.getState().windowHours,
    scope: useSituationMonitorSettingsStore.getState().scope,
    autoRefresh: useSituationMonitorSettingsStore.getState().autoRefresh,
    resetLayoutOnPreset:
      useSituationMonitorSettingsStore.getState().resetLayoutOnPreset,
    translateToZh: useSituationMonitorSettingsStore.getState().translateToZh,
  };
  writeJsonToStorage(key, {
    version: 1,
    updatedAt: Date.now(),
    payload: {
      layout,
      settings,
    },
  } satisfies UiCacheEnvelope<SituationMonitorCachePayload>);
}

function writeWarMapCache(orgId: string, userId: string) {
  const key = buildCacheKey("war-map", orgId, userId);
  const state = useWarMapSettingsStore.getState();
  const settings = {
    layerVisibility: state.layerVisibility,
    viewState: state.viewState,
    activePreset: state.activePreset,
    timeRangePreset: state.timeRangePreset,
    flightMode: state.flightMode,
    aisMode: state.aisMode,
  };
  writeJsonToStorage(key, {
    version: 1,
    updatedAt: Date.now(),
    payload: {
      settings,
    },
  } satisfies UiCacheEnvelope<WarMapCachePayload>);
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (!error) {
    return fallback;
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  if (typeof error === "string") {
    return error || fallback;
  }
  return fallback;
}

export function UserUiSettingsSync() {
  const { data: session } = useSession();
  const [ready, setReady] = useState({
    situationMonitor: false,
    warMap: false,
  });
  const readyRef = useRef(ready);

  const accessToken = session?.accessToken;
  const orgId = session?.orgId;
  const userId = session?.user?.id;
  const reloadToken = useUserUiSyncStatusStore((state) => state.reloadToken);

  const layouts = useSituationMonitorLayoutStore((state) => state.layouts);
  const visibility = useSituationMonitorLayoutStore(
    (state) => state.visibility,
  );
  const settings = useSituationMonitorSettingsStore((state) => ({
    windowHours: state.windowHours,
    scope: state.scope,
    autoRefresh: state.autoRefresh,
    resetLayoutOnPreset: state.resetLayoutOnPreset,
    translateToZh: state.translateToZh,
  }));
  const warMapSettings = useWarMapSettingsStore((state) => ({
    layerVisibility: state.layerVisibility,
    viewState: state.viewState,
    activePreset: state.activePreset,
    timeRangePreset: state.timeRangePreset,
    flightMode: state.flightMode,
    aisMode: state.aisMode,
  }));

  const hydratingRef = useRef(false);
  const lastContextRef = useRef<{ orgId: string; userId: string } | null>(null);
  const lastReloadTokenRef = useRef(0);
  const legacyMonitorImportContextRef = useRef<string | null>(null);
  const pendingRef = useRef<Record<SaveKind, boolean>>({
    layout: false,
    settings: false,
    warMapSettings: false,
  });
  const lastSentRef = useRef<Record<SaveKind, string>>({
    layout: "",
    settings: "",
    warMapSettings: "",
  });
  const timersRef = useRef<
    Partial<Record<SaveKind, ReturnType<typeof setTimeout>>>
  >({});

  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );

  const layoutFingerprint = useMemo(
    () => fingerprintSituationMonitorLayout({ layouts, visibility }),
    [layouts, visibility],
  );
  const settingsFingerprint = useMemo(
    () => fingerprintSettings(settings),
    [settings],
  );
  const warMapSettingsFingerprint = useMemo(
    () => fingerprintWarMapSettings(warMapSettings),
    [warMapSettings],
  );

  const scheduleSave = (kind: SaveKind, runner: () => void) => {
    const existing = timersRef.current[kind];
    if (existing) {
      clearTimeout(existing);
    }
    timersRef.current[kind] = setTimeout(runner, debounceMsByKind[kind]);
  };

  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  useEffect(() => {
    if (!accessToken || !orgId || !userId) {
      useUserUiSyncStatusStore.getState().reset();
      setReady({ situationMonitor: false, warMap: false });
      lastContextRef.current = null;
      lastReloadTokenRef.current = 0;
      legacyMonitorImportContextRef.current = null;
      hydratingRef.current = true;
      try {
        useSituationMonitorLayoutStore.getState().reset();
        useSituationMonitorSettingsStore.getState().reset();
        useWarMapSettingsStore.getState().resetAll();
      } finally {
        hydratingRef.current = false;
      }
      return;
    }

    const sameContext =
      lastContextRef.current?.orgId === orgId &&
      lastContextRef.current?.userId === userId;
    if (
      sameContext &&
      readyRef.current.situationMonitor &&
      readyRef.current.warMap &&
      lastReloadTokenRef.current === reloadToken
    ) {
      return;
    }
    lastContextRef.current = { orgId, userId };
    lastReloadTokenRef.current = reloadToken;

    useUserUiSyncStatusStore.getState().markLoading("situation-monitor");
    useUserUiSyncStatusStore.getState().markLoading("war-map");

    for (const timer of Object.values(timersRef.current)) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    timersRef.current = {};
    pendingRef.current = {
      layout: false,
      settings: false,
      warMapSettings: false,
    };
    lastSentRef.current = {
      layout: "",
      settings: "",
      warMapSettings: "",
    };

    let cancelled = false;
    setReady({ situationMonitor: false, warMap: false });

    const situationMonitorCacheKey = buildCacheKey(
      "situation-monitor",
      orgId,
      userId,
    );
    const warMapCacheKey = buildCacheKey("war-map", orgId, userId);

    hydratingRef.current = true;
    try {
      useSituationMonitorLayoutStore.getState().reset();
      useSituationMonitorSettingsStore.getState().reset();
      useWarMapSettingsStore.getState().resetAll();

      const smCache = readCacheEnvelope<SituationMonitorCachePayload>(
        situationMonitorCacheKey,
      );
      if (smCache) {
        const payload = smCache.payload;
        if (payload.layout) {
          useSituationMonitorLayoutStore
            .getState()
            .hydrateFromRemote(payload.layout);
        }
        if (payload.settings) {
          useSituationMonitorSettingsStore
            .getState()
            .hydrateFromRemote(payload.settings);
        }
      } else {
        const legacyLayoutState = readLegacyZustandPersistState(
          LEGACY_STORAGE_KEY_SITUATION_MONITOR_LAYOUT,
        );
        const legacySettingsState = readLegacyZustandPersistState(
          LEGACY_STORAGE_KEY_SITUATION_MONITOR_SETTINGS,
        );

        if (legacyLayoutState) {
          useSituationMonitorLayoutStore
            .getState()
            .hydrateFromRemote(legacyLayoutState);
        }
        if (legacySettingsState) {
          useSituationMonitorSettingsStore
            .getState()
            .hydrateFromRemote(legacySettingsState);
        }
      }

      const warMapCache = readCacheEnvelope<WarMapCachePayload>(warMapCacheKey);
      if (warMapCache?.payload?.settings) {
        useWarMapSettingsStore
          .getState()
          .hydrateFromRemote(warMapCache.payload.settings);
      } else {
        const legacyWarMapState = readLegacyZustandPersistState(
          LEGACY_STORAGE_KEY_WAR_MAP_SETTINGS,
        );
        if (legacyWarMapState) {
          useWarMapSettingsStore
            .getState()
            .hydrateFromRemote(legacyWarMapState);
        }
      }
    } finally {
      hydratingRef.current = false;
    }

    void (async () => {
      try {
        const [smResult, warMapResult] = await Promise.allSettled([
          apiClient.get<RemoteSituationMonitorUiSettings>(
            "user-settings/ui/situation-monitor",
          ),
          apiClient.get<RemoteWarMapUiSettings>("user-settings/ui/war-map"),
        ]);
        if (cancelled) return;
        hydratingRef.current = true;
        try {
          if (smResult.status === "fulfilled") {
            const data = smResult.value.data;
            const remoteHasLayout = Boolean(data) && data.layout !== null;
            const remoteHasSettings = Boolean(data) && data.settings !== null;

            const remoteLayoutFingerprint =
              remoteHasLayout && data?.layout
                ? fingerprintSituationMonitorLayout(data.layout)
                : "";
            const layoutRepaired =
              remoteHasLayout && data?.layout
                ? useSituationMonitorLayoutStore
                    .getState()
                    .hydrateFromRemote(data.layout)
                : false;
            if (remoteHasSettings && data?.settings) {
              useSituationMonitorSettingsStore
                .getState()
                .hydrateFromRemote(data.settings);
            }

            const currentLayout = {
              layouts: useSituationMonitorLayoutStore.getState().layouts,
              visibility: useSituationMonitorLayoutStore.getState().visibility,
            };
            const currentSettings = {
              windowHours:
                useSituationMonitorSettingsStore.getState().windowHours,
              scope: useSituationMonitorSettingsStore.getState().scope,
              autoRefresh:
                useSituationMonitorSettingsStore.getState().autoRefresh,
              resetLayoutOnPreset:
                useSituationMonitorSettingsStore.getState().resetLayoutOnPreset,
              translateToZh:
                useSituationMonitorSettingsStore.getState().translateToZh,
            };

            const currentLayoutFingerprint =
              fingerprintSituationMonitorLayout(currentLayout);
            const currentSettingsFingerprint =
              fingerprintSettings(currentSettings);

            const shouldMigrateLayout =
              !remoteHasLayout &&
              currentLayoutFingerprint !== defaultLayoutFingerprint;
            const shouldMigrateSettings =
              !remoteHasSettings &&
              currentSettingsFingerprint !== defaultSettingsFingerprint;

            if (shouldMigrateLayout || shouldMigrateSettings) {
              useUserUiSyncStatusStore
                .getState()
                .beginSave("situation-monitor");
              const payload: Record<string, unknown> = {};
              if (shouldMigrateLayout) {
                payload.layout = currentLayout;
              }
              if (shouldMigrateSettings) {
                payload.settings = currentSettings;
              }

              try {
                await apiClient.put(
                  "user-settings/ui/situation-monitor",
                  payload,
                );
                useUserUiSyncStatusStore
                  .getState()
                  .endSaveSuccess("situation-monitor");

                lastSentRef.current.layout = currentLayoutFingerprint;
                lastSentRef.current.settings = currentSettingsFingerprint;

                removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_LAYOUT);
                removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_SETTINGS);
              } catch (error) {
                captureClientError(
                  "Failed to migrate legacy UI settings",
                  error,
                );
                useUserUiSyncStatusStore
                  .getState()
                  .endSaveError(
                    "situation-monitor",
                    getErrorMessage(error, "Failed to migrate settings."),
                  );

                lastSentRef.current.layout = currentLayoutFingerprint;
                lastSentRef.current.settings = currentSettingsFingerprint;
              }
            } else {
              lastSentRef.current.layout = layoutRepaired
                ? remoteLayoutFingerprint
                : currentLayoutFingerprint;
              lastSentRef.current.settings = currentSettingsFingerprint;

              useUserUiSyncStatusStore.getState().markIdle("situation-monitor");

              removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_LAYOUT);
              removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_SETTINGS);
            }

            writeJsonToStorage(situationMonitorCacheKey, {
              version: 1,
              updatedAt: Date.now(),
              payload: {
                layout: currentLayout,
                settings: currentSettings,
              },
            } satisfies UiCacheEnvelope<SituationMonitorCachePayload>);

            setReady((prev) => ({ ...prev, situationMonitor: true }));
          } else {
            captureClientError(
              "Failed to load situation monitor UI settings",
              smResult.reason,
            );
            useUserUiSyncStatusStore
              .getState()
              .markError(
                "situation-monitor",
                getErrorMessage(smResult.reason, "Failed to load settings."),
              );
          }

          if (warMapResult.status === "fulfilled") {
            const data = warMapResult.value.data;
            const remoteHasSettings = Boolean(data) && data.settings !== null;

            if (remoteHasSettings && data.settings) {
              const settings = mergeWarMapSettingsWithUrlState(
                data.settings,
                new URLSearchParams(window.location.search),
              );
              useWarMapSettingsStore
                .getState()
                .hydrateFromRemote(settings);
            }

            const currentState = useWarMapSettingsStore.getState();
            const currentSettings = {
              layerVisibility: currentState.layerVisibility,
              viewState: currentState.viewState,
              activePreset: currentState.activePreset,
              timeRangePreset: currentState.timeRangePreset,
              flightMode: currentState.flightMode,
              aisMode: currentState.aisMode,
            };
            const currentFingerprint =
              fingerprintWarMapSettings(currentSettings);

            const shouldMigrateSettings =
              !remoteHasSettings &&
              currentFingerprint !== defaultWarMapFingerprint;
            if (shouldMigrateSettings) {
              useUserUiSyncStatusStore.getState().beginSave("war-map");
              try {
                await apiClient.put("user-settings/ui/war-map", {
                  settings: currentSettings,
                });
                useUserUiSyncStatusStore.getState().endSaveSuccess("war-map");
                lastSentRef.current.warMapSettings = currentFingerprint;
                removeStorageKey(LEGACY_STORAGE_KEY_WAR_MAP_SETTINGS);
              } catch (error) {
                captureClientError(
                  "Failed to migrate legacy WarMap settings",
                  error,
                );
                useUserUiSyncStatusStore
                  .getState()
                  .endSaveError(
                    "war-map",
                    getErrorMessage(error, "Failed to migrate settings."),
                  );

                lastSentRef.current.warMapSettings = currentFingerprint;
              }
            } else {
              lastSentRef.current.warMapSettings = currentFingerprint;

              useUserUiSyncStatusStore.getState().markIdle("war-map");
              removeStorageKey(LEGACY_STORAGE_KEY_WAR_MAP_SETTINGS);
            }

            writeJsonToStorage(warMapCacheKey, {
              version: 1,
              updatedAt: Date.now(),
              payload: {
                settings: currentSettings,
              },
            } satisfies UiCacheEnvelope<WarMapCachePayload>);

            setReady((prev) => ({ ...prev, warMap: true }));
          } else {
            captureClientError(
              "Failed to load WarMap UI settings",
              warMapResult.reason,
            );
            useUserUiSyncStatusStore
              .getState()
              .markError(
                "war-map",
                getErrorMessage(
                  warMapResult.reason,
                  "Failed to load settings.",
                ),
              );
          }
        } finally {
          hydratingRef.current = false;
        }
      } catch (error) {
        captureClientError("Failed to load user UI settings", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiClient, accessToken, orgId, reloadToken, userId]);

  useEffect(() => {
    if (!accessToken || !orgId || !userId) {
      legacyMonitorImportContextRef.current = null;
      return;
    }

    const contextKey = `${orgId}:${userId}`;
    if (legacyMonitorImportContextRef.current === contextKey) {
      return;
    }

    const legacyState = readLegacyZustandPersistState(
      LEGACY_STORAGE_KEY_SITUATION_MONITOR_MONITORS,
    );
    const legacyMonitors = normalizeLegacySituationMonitors(legacyState);
    if (legacyMonitors.length === 0) {
      removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_MONITORS);
      legacyMonitorImportContextRef.current = contextKey;
      return;
    }

    legacyMonitorImportContextRef.current = contextKey;
    let cancelled = false;

    void (async () => {
      try {
        const response = await apiClient.get<StoredSituationMonitor[]>(
          "situation-monitor/monitors",
        );
        if (cancelled) {
          return;
        }
        const existing = new Set(
          (response.data ?? [])
            .filter((monitor) => monitor.kind === "manual")
            .map((monitor) => buildSituationMonitorSignature(monitor)),
        );

        let createdCount = 0;
        for (const legacyMonitor of legacyMonitors) {
          if (cancelled) {
            return;
          }
          const signature = buildSituationMonitorSignature(legacyMonitor);
          if (existing.has(signature)) {
            continue;
          }
          await apiClient.post("situation-monitor/monitors", legacyMonitor);
          existing.add(signature);
          createdCount += 1;
        }

        if (cancelled) {
          return;
        }
        removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_MONITORS);
        if (createdCount > 0) {
          emitSituationMonitorMonitorsUpdated("legacy-import");
        }
      } catch (error) {
        const status = (error as { response?: { status?: number } }).response
          ?.status;
        if (status !== 401 && status !== 403) {
          captureClientError(
            "Failed to import legacy situation monitors",
            error,
          );
        }
        legacyMonitorImportContextRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken, apiClient, orgId, userId]);

  useEffect(() => {
    if (
      !ready.situationMonitor ||
      hydratingRef.current ||
      !accessToken ||
      !orgId ||
      !userId
    ) {
      return;
    }
    if (layoutFingerprint === lastSentRef.current.layout) {
      return;
    }

    if (!pendingRef.current.layout) {
      pendingRef.current.layout = true;
      useUserUiSyncStatusStore.getState().beginSave("situation-monitor");
    }
    scheduleSave("layout", () => {
      void apiClient
        .put("user-settings/ui/situation-monitor", {
          layout: { layouts, visibility },
        })
        .then(() => {
          lastSentRef.current.layout = fingerprintSituationMonitorLayout({
            layouts,
            visibility,
          });
          pendingRef.current.layout = false;
          useUserUiSyncStatusStore
            .getState()
            .endSaveSuccess("situation-monitor");

          writeSituationMonitorCache(orgId, userId);
          removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_LAYOUT);
        })
        .catch((error) => {
          captureClientError("Failed to save layout settings", error);
          pendingRef.current.layout = false;
          useUserUiSyncStatusStore
            .getState()
            .endSaveError(
              "situation-monitor",
              getErrorMessage(error, "Failed to save settings."),
            );
        });
    });
  }, [
    accessToken,
    apiClient,
    layoutFingerprint,
    layouts,
    orgId,
    ready.situationMonitor,
    userId,
    visibility,
  ]);

  useEffect(() => {
    if (
      !ready.situationMonitor ||
      hydratingRef.current ||
      !accessToken ||
      !orgId ||
      !userId
    ) {
      return;
    }
    if (settingsFingerprint === lastSentRef.current.settings) {
      return;
    }

    if (!pendingRef.current.settings) {
      pendingRef.current.settings = true;
      useUserUiSyncStatusStore.getState().beginSave("situation-monitor");
    }
    scheduleSave("settings", () => {
      void apiClient
        .put("user-settings/ui/situation-monitor", { settings })
        .then(() => {
          lastSentRef.current.settings = fingerprintSettings(settings);
          pendingRef.current.settings = false;
          useUserUiSyncStatusStore
            .getState()
            .endSaveSuccess("situation-monitor");

          writeSituationMonitorCache(orgId, userId);
          removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_SETTINGS);
        })
        .catch((error) => {
          captureClientError("Failed to save view settings", error);
          pendingRef.current.settings = false;
          useUserUiSyncStatusStore
            .getState()
            .endSaveError(
              "situation-monitor",
              getErrorMessage(error, "Failed to save settings."),
            );
        });
    });
  }, [
    accessToken,
    apiClient,
    orgId,
    ready.situationMonitor,
    settings,
    settingsFingerprint,
    userId,
  ]);

  useEffect(() => {
    if (
      !ready.warMap ||
      hydratingRef.current ||
      !accessToken ||
      !orgId ||
      !userId
    ) {
      return;
    }
    if (warMapSettingsFingerprint === lastSentRef.current.warMapSettings) {
      return;
    }

    if (!pendingRef.current.warMapSettings) {
      pendingRef.current.warMapSettings = true;
      useUserUiSyncStatusStore.getState().beginSave("war-map");
    }
    scheduleSave("warMapSettings", () => {
      void apiClient
        .put("user-settings/ui/war-map", { settings: warMapSettings })
        .then(() => {
          lastSentRef.current.warMapSettings =
            fingerprintWarMapSettings(warMapSettings);
          pendingRef.current.warMapSettings = false;
          useUserUiSyncStatusStore.getState().endSaveSuccess("war-map");

          writeWarMapCache(orgId, userId);
          removeStorageKey(LEGACY_STORAGE_KEY_WAR_MAP_SETTINGS);
        })
        .catch((error) => {
          captureClientError("Failed to save WarMap settings", error);
          pendingRef.current.warMapSettings = false;
          useUserUiSyncStatusStore
            .getState()
            .endSaveError(
              "war-map",
              getErrorMessage(error, "Failed to save settings."),
            );
        });
    });
  }, [
    accessToken,
    apiClient,
    orgId,
    ready.warMap,
    userId,
    warMapSettings,
    warMapSettingsFingerprint,
  ]);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(timersRef.current)) {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
  }, []);

  return null;
}
