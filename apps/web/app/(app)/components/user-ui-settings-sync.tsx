"use client";

import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { SITUATION_MONITOR_PANELS, useSituationMonitorLayoutStore } from "@/store/situation-monitor-layout";
import { useSituationMonitorMonitorsStore } from "@/store/situation-monitor-monitors";
import { useSituationMonitorSettingsStore } from "@/store/situation-monitor-settings";
import { useUserUiSyncStatusStore } from "@/store/user-ui-sync-status";
import { WAR_MAP_DEFAULT_LAYER_VISIBILITY, useWarMapSettingsStore } from "@/store/war-map-settings";

const LEGACY_STORAGE_KEY_SITUATION_MONITOR_MONITORS = "situation-monitor:monitors:v1";
const LEGACY_STORAGE_KEY_SITUATION_MONITOR_LAYOUT = "situation-monitor:layout:v1";
const LEGACY_STORAGE_KEY_SITUATION_MONITOR_SETTINGS = "situation-monitor:settings:v1";
const LEGACY_STORAGE_KEY_WAR_MAP_SETTINGS = "war-map:settings:v1";

const UI_CACHE_PREFIX = "ui-cache:user-ui-settings";

interface RemoteSituationMonitorUiSettings {
  version: number;
  updatedAt?: {
    monitors?: string;
    layout?: string;
    settings?: string;
  };
  monitors: unknown[] | null;
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

type SaveKind = "monitors" | "layout" | "settings" | "warMapSettings";

const debounceMsByKind: Record<SaveKind, number> = {
  monitors: 900,
  layout: 1500,
  settings: 600,
  warMapSettings: 700,
};

const defaultSituationMonitorLayout = {
  layout: SITUATION_MONITOR_PANELS.map((panel) => panel.defaultLayout),
  visibility: Object.fromEntries(
    SITUATION_MONITOR_PANELS.map((panel) => [panel.id, panel.defaultVisible]),
  ) as Record<string, boolean>,
};

const defaultSituationMonitorSettings = {
  windowHours: 24,
  scope: "tagged",
  autoRefresh: true,
  resetLayoutOnPreset: false,
  translateToZh: false,
};

const defaultLayoutFingerprint = fingerprintLayout(defaultSituationMonitorLayout);
const defaultSettingsFingerprint = fingerprintSettings(defaultSituationMonitorSettings);
const defaultWarMapFingerprint = fingerprintWarMapSettings({ layerVisibility: WAR_MAP_DEFAULT_LAYER_VISIBILITY });

type UiCacheSection = "situation-monitor" | "war-map";

interface UiCacheEnvelope<T> {
  version: 1;
  updatedAt: number;
  payload: T;
}

interface SituationMonitorCachePayload {
  monitors?: unknown[];
  layout?: { layout: unknown[]; visibility: Record<string, boolean> };
  settings?: Record<string, unknown>;
}

interface WarMapCachePayload {
  settings?: Record<string, unknown>;
}

function fingerprintMonitors(monitors: unknown): string {
  if (!Array.isArray(monitors)) {
    return "[]";
  }
  const normalized = monitors
    .filter((monitor) => monitor && typeof monitor === "object" && !Array.isArray(monitor))
    .map((monitor) => monitor as Record<string, unknown>)
    .map((monitor) => ({
      id: typeof monitor.id === "string" ? monitor.id : "",
      name: typeof monitor.name === "string" ? monitor.name : "",
      keywords: Array.isArray(monitor.keywords) ? monitor.keywords : [],
      enabled: typeof monitor.enabled === "boolean" ? monitor.enabled : true,
      color: typeof monitor.color === "string" ? monitor.color : null,
      location: monitor.location ?? null,
      createdAt: typeof monitor.createdAt === "number" ? monitor.createdAt : 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify(normalized);
}

function fingerprintLayout(payload: { layout: unknown[]; visibility: Record<string, boolean> }): string {
  const normalizedLayout = Array.isArray(payload.layout)
    ? payload.layout
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => entry as Record<string, unknown>)
        .map((entry) => ({
          i: typeof entry.i === "string" ? entry.i : "",
          x: typeof entry.x === "number" ? entry.x : 0,
          y: typeof entry.y === "number" ? entry.y : 0,
          w: typeof entry.w === "number" ? entry.w : 0,
          h: typeof entry.h === "number" ? entry.h : 0,
          minW: typeof entry.minW === "number" ? entry.minW : null,
          minH: typeof entry.minH === "number" ? entry.minH : null,
          static: typeof entry.static === "boolean" ? entry.static : null,
        }))
        .sort((a, b) => a.i.localeCompare(b.i))
    : [];

  const visibility = Object.fromEntries(
    Object.entries(payload.visibility)
      .filter(([key, val]) => typeof key === "string" && typeof val === "boolean")
      .sort(([a], [b]) => a.localeCompare(b)),
  );

  return JSON.stringify({ layout: normalizedLayout, visibility });
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
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "{}";
  }
  const record = payload as Record<string, unknown>;
  const rawVisibility =
    record.layerVisibility && typeof record.layerVisibility === "object" && !Array.isArray(record.layerVisibility)
      ? (record.layerVisibility as Record<string, unknown>)
      : record;

  const normalized = {
    hotspots: typeof rawVisibility.hotspots === "boolean" ? rawVisibility.hotspots : WAR_MAP_DEFAULT_LAYER_VISIBILITY.hotspots,
    conflictZones: typeof rawVisibility.conflictZones === "boolean" ? rawVisibility.conflictZones : WAR_MAP_DEFAULT_LAYER_VISIBILITY.conflictZones,
    chokepoints: typeof rawVisibility.chokepoints === "boolean" ? rawVisibility.chokepoints : WAR_MAP_DEFAULT_LAYER_VISIBILITY.chokepoints,
    cableLandings: typeof rawVisibility.cableLandings === "boolean" ? rawVisibility.cableLandings : WAR_MAP_DEFAULT_LAYER_VISIBILITY.cableLandings,
    nuclearSites: typeof rawVisibility.nuclearSites === "boolean" ? rawVisibility.nuclearSites : WAR_MAP_DEFAULT_LAYER_VISIBILITY.nuclearSites,
    militaryBases: typeof rawVisibility.militaryBases === "boolean" ? rawVisibility.militaryBases : WAR_MAP_DEFAULT_LAYER_VISIBILITY.militaryBases,
    monitors: typeof rawVisibility.monitors === "boolean" ? rawVisibility.monitors : WAR_MAP_DEFAULT_LAYER_VISIBILITY.monitors,
  };

  return JSON.stringify({ layerVisibility: normalized });
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

function readLegacyZustandPersistState(key: string): Record<string, unknown> | null {
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
  const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : Number.NaN;
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
  const monitors = useSituationMonitorMonitorsStore.getState().monitors;
  const layout = {
    layout: useSituationMonitorLayoutStore.getState().layout,
    visibility: useSituationMonitorLayoutStore.getState().visibility,
  };
  const settings = {
    windowHours: useSituationMonitorSettingsStore.getState().windowHours,
    scope: useSituationMonitorSettingsStore.getState().scope,
    autoRefresh: useSituationMonitorSettingsStore.getState().autoRefresh,
    resetLayoutOnPreset: useSituationMonitorSettingsStore.getState().resetLayoutOnPreset,
    translateToZh: useSituationMonitorSettingsStore.getState().translateToZh,
  };
  writeJsonToStorage(key, {
    version: 1,
    updatedAt: Date.now(),
    payload: {
      monitors,
      layout,
      settings,
    },
  } satisfies UiCacheEnvelope<SituationMonitorCachePayload>);
}

function writeWarMapCache(orgId: string, userId: string) {
  const key = buildCacheKey("war-map", orgId, userId);
  const settings = { layerVisibility: useWarMapSettingsStore.getState().layerVisibility };
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
  const [ready, setReady] = useState({ situationMonitor: false, warMap: false });
  const readyRef = useRef(ready);

  const accessToken = session?.accessToken;
  const orgId = session?.orgId;
  const userId = session?.user?.id;
  const reloadToken = useUserUiSyncStatusStore((state) => state.reloadToken);

  const monitors = useSituationMonitorMonitorsStore((state) => state.monitors);
  const layout = useSituationMonitorLayoutStore((state) => state.layout);
  const visibility = useSituationMonitorLayoutStore((state) => state.visibility);
  const settings = useSituationMonitorSettingsStore((state) => ({
    windowHours: state.windowHours,
    scope: state.scope,
    autoRefresh: state.autoRefresh,
    resetLayoutOnPreset: state.resetLayoutOnPreset,
    translateToZh: state.translateToZh,
  }));
  const warMapLayerVisibility = useWarMapSettingsStore((state) => state.layerVisibility);

  const hydratingRef = useRef(false);
  const lastContextRef = useRef<{ orgId: string; userId: string } | null>(null);
  const lastReloadTokenRef = useRef(0);
  const pendingRef = useRef<Record<SaveKind, boolean>>({
    monitors: false,
    layout: false,
    settings: false,
    warMapSettings: false,
  });
  const lastSentRef = useRef<Record<SaveKind, string>>({
    monitors: "",
    layout: "",
    settings: "",
    warMapSettings: "",
  });
  const timersRef = useRef<Partial<Record<SaveKind, ReturnType<typeof setTimeout>>>>({});

  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );

  const monitorsFingerprint = useMemo(() => fingerprintMonitors(monitors), [monitors]);
  const layoutFingerprint = useMemo(
    () => fingerprintLayout({ layout, visibility }),
    [layout, visibility],
  );
  const settingsFingerprint = useMemo(() => fingerprintSettings(settings), [settings]);
  const warMapSettingsFingerprint = useMemo(
    () => fingerprintWarMapSettings({ layerVisibility: warMapLayerVisibility }),
    [warMapLayerVisibility],
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
      hydratingRef.current = true;
      try {
        useSituationMonitorMonitorsStore.getState().reset();
        useSituationMonitorLayoutStore.getState().reset();
        useSituationMonitorSettingsStore.getState().reset();
        useWarMapSettingsStore.getState().resetLayers();
      } finally {
        hydratingRef.current = false;
      }
      return;
    }

    const sameContext = lastContextRef.current?.orgId === orgId && lastContextRef.current?.userId === userId;
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
      monitors: false,
      layout: false,
      settings: false,
      warMapSettings: false,
    };
    lastSentRef.current = {
      monitors: "",
      layout: "",
      settings: "",
      warMapSettings: "",
    };

    let cancelled = false;
    setReady({ situationMonitor: false, warMap: false });

    const situationMonitorCacheKey = buildCacheKey("situation-monitor", orgId, userId);
    const warMapCacheKey = buildCacheKey("war-map", orgId, userId);

    hydratingRef.current = true;
    try {
      useSituationMonitorMonitorsStore.getState().reset();
      useSituationMonitorLayoutStore.getState().reset();
      useSituationMonitorSettingsStore.getState().reset();
      useWarMapSettingsStore.getState().resetLayers();

      const smCache = readCacheEnvelope<SituationMonitorCachePayload>(situationMonitorCacheKey);
      if (smCache) {
        const payload = smCache.payload;
        if (payload.monitors) {
          useSituationMonitorMonitorsStore.getState().hydrateFromRemote(payload.monitors);
        }
        if (payload.layout) {
          useSituationMonitorLayoutStore.getState().hydrateFromRemote(payload.layout);
        }
        if (payload.settings) {
          useSituationMonitorSettingsStore.getState().hydrateFromRemote(payload.settings);
        }
      } else {
        const legacyMonitorsState = readLegacyZustandPersistState(LEGACY_STORAGE_KEY_SITUATION_MONITOR_MONITORS);
        const legacyLayoutState = readLegacyZustandPersistState(LEGACY_STORAGE_KEY_SITUATION_MONITOR_LAYOUT);
        const legacySettingsState = readLegacyZustandPersistState(LEGACY_STORAGE_KEY_SITUATION_MONITOR_SETTINGS);

        if (legacyMonitorsState?.monitors) {
          useSituationMonitorMonitorsStore.getState().hydrateFromRemote(legacyMonitorsState.monitors);
        }
        if (legacyLayoutState) {
          useSituationMonitorLayoutStore.getState().hydrateFromRemote(legacyLayoutState);
        }
        if (legacySettingsState) {
          useSituationMonitorSettingsStore.getState().hydrateFromRemote(legacySettingsState);
        }
      }

      const warMapCache = readCacheEnvelope<WarMapCachePayload>(warMapCacheKey);
      if (warMapCache?.payload?.settings) {
        useWarMapSettingsStore.getState().hydrateFromRemote(warMapCache.payload.settings);
      } else {
        const legacyWarMapState = readLegacyZustandPersistState(LEGACY_STORAGE_KEY_WAR_MAP_SETTINGS);
        if (legacyWarMapState) {
          useWarMapSettingsStore.getState().hydrateFromRemote(legacyWarMapState);
        }
      }
    } finally {
      hydratingRef.current = false;
    }

    void (async () => {
      try {
        const [smResult, warMapResult] = await Promise.allSettled([
          apiClient.get<RemoteSituationMonitorUiSettings>("user-settings/ui/situation-monitor"),
          apiClient.get<RemoteWarMapUiSettings>("user-settings/ui/war-map"),
        ]);
        if (cancelled) return;
        hydratingRef.current = true;
        try {
          if (smResult.status === "fulfilled") {
            const data = smResult.value.data;
            const remoteHasMonitors = Boolean(data) && data.monitors !== null;
            const remoteHasLayout = Boolean(data) && data.layout !== null;
            const remoteHasSettings = Boolean(data) && data.settings !== null;

            if (remoteHasMonitors && data?.monitors) {
              useSituationMonitorMonitorsStore.getState().hydrateFromRemote(data.monitors);
            }
            const remoteLayoutFingerprint = remoteHasLayout && data?.layout ? fingerprintLayout(data.layout) : "";
            const layoutRepaired =
              remoteHasLayout && data?.layout
                ? useSituationMonitorLayoutStore.getState().hydrateFromRemote(data.layout)
                : false;
            if (remoteHasSettings && data?.settings) {
              useSituationMonitorSettingsStore.getState().hydrateFromRemote(data.settings);
            }

            const currentMonitors = useSituationMonitorMonitorsStore.getState().monitors;
            const currentLayout = {
              layout: useSituationMonitorLayoutStore.getState().layout,
              visibility: useSituationMonitorLayoutStore.getState().visibility,
            };
            const currentSettings = {
              windowHours: useSituationMonitorSettingsStore.getState().windowHours,
              scope: useSituationMonitorSettingsStore.getState().scope,
              autoRefresh: useSituationMonitorSettingsStore.getState().autoRefresh,
              resetLayoutOnPreset: useSituationMonitorSettingsStore.getState().resetLayoutOnPreset,
              translateToZh: useSituationMonitorSettingsStore.getState().translateToZh,
            };

            const currentMonitorsFingerprint = fingerprintMonitors(currentMonitors);
            const currentLayoutFingerprint = fingerprintLayout(currentLayout);
            const currentSettingsFingerprint = fingerprintSettings(currentSettings);

            const shouldMigrateMonitors = !remoteHasMonitors && currentMonitors.length > 0;
            const shouldMigrateLayout = !remoteHasLayout && currentLayoutFingerprint !== defaultLayoutFingerprint;
            const shouldMigrateSettings = !remoteHasSettings && currentSettingsFingerprint !== defaultSettingsFingerprint;

            if (shouldMigrateMonitors || shouldMigrateLayout || shouldMigrateSettings) {
              useUserUiSyncStatusStore.getState().beginSave("situation-monitor");
              const payload: Record<string, unknown> = {};
              if (shouldMigrateMonitors) {
                payload.monitors = currentMonitors;
              }
              if (shouldMigrateLayout) {
                payload.layout = currentLayout;
              }
              if (shouldMigrateSettings) {
                payload.settings = currentSettings;
              }

              try {
                await apiClient.put("user-settings/ui/situation-monitor", payload);
                useUserUiSyncStatusStore.getState().endSaveSuccess("situation-monitor");

                lastSentRef.current.monitors = currentMonitorsFingerprint;
                lastSentRef.current.layout = currentLayoutFingerprint;
                lastSentRef.current.settings = currentSettingsFingerprint;

                removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_MONITORS);
                removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_LAYOUT);
                removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_SETTINGS);
              } catch (error) {
                captureClientError("Failed to migrate legacy UI settings", error);
                useUserUiSyncStatusStore
                  .getState()
                  .endSaveError("situation-monitor", getErrorMessage(error, "Failed to migrate settings."));

                lastSentRef.current.monitors = currentMonitorsFingerprint;
                lastSentRef.current.layout = currentLayoutFingerprint;
                lastSentRef.current.settings = currentSettingsFingerprint;
              }
            } else {
              lastSentRef.current.monitors = currentMonitorsFingerprint;
              lastSentRef.current.layout = layoutRepaired ? remoteLayoutFingerprint : currentLayoutFingerprint;
              lastSentRef.current.settings = currentSettingsFingerprint;

              useUserUiSyncStatusStore.getState().markIdle("situation-monitor");

              removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_MONITORS);
              removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_LAYOUT);
              removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_SETTINGS);
            }

            writeJsonToStorage(situationMonitorCacheKey, {
              version: 1,
              updatedAt: Date.now(),
              payload: {
                monitors: currentMonitors,
                layout: currentLayout,
                settings: currentSettings,
              },
            } satisfies UiCacheEnvelope<SituationMonitorCachePayload>);

            setReady((prev) => ({ ...prev, situationMonitor: true }));
          } else {
            captureClientError("Failed to load situation monitor UI settings", smResult.reason);
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
              useWarMapSettingsStore.getState().hydrateFromRemote(data.settings);
            }

            const currentSettings = { layerVisibility: useWarMapSettingsStore.getState().layerVisibility };
            const currentFingerprint = fingerprintWarMapSettings(currentSettings);

            const shouldMigrateSettings = !remoteHasSettings && currentFingerprint !== defaultWarMapFingerprint;
            if (shouldMigrateSettings) {
              useUserUiSyncStatusStore.getState().beginSave("war-map");
              try {
                await apiClient.put("user-settings/ui/war-map", { settings: currentSettings });
                useUserUiSyncStatusStore.getState().endSaveSuccess("war-map");
                lastSentRef.current.warMapSettings = currentFingerprint;
                removeStorageKey(LEGACY_STORAGE_KEY_WAR_MAP_SETTINGS);
              } catch (error) {
                captureClientError("Failed to migrate legacy WarMap settings", error);
                useUserUiSyncStatusStore
                  .getState()
                  .endSaveError("war-map", getErrorMessage(error, "Failed to migrate settings."));

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
            captureClientError("Failed to load WarMap UI settings", warMapResult.reason);
            useUserUiSyncStatusStore
              .getState()
              .markError("war-map", getErrorMessage(warMapResult.reason, "Failed to load settings."));
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
    if (!ready.situationMonitor || hydratingRef.current || !accessToken || !orgId || !userId) {
      return;
    }
    if (monitorsFingerprint === lastSentRef.current.monitors) {
      return;
    }

    if (!pendingRef.current.monitors) {
      pendingRef.current.monitors = true;
      useUserUiSyncStatusStore.getState().beginSave("situation-monitor");
    }
    scheduleSave("monitors", () => {
      void apiClient
        .put("user-settings/ui/situation-monitor", { monitors })
        .then(() => {
          lastSentRef.current.monitors = fingerprintMonitors(monitors);
          pendingRef.current.monitors = false;
          useUserUiSyncStatusStore.getState().endSaveSuccess("situation-monitor");

          writeSituationMonitorCache(orgId, userId);
          removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_MONITORS);
        })
        .catch((error) => {
          captureClientError("Failed to save monitor settings", error);
          pendingRef.current.monitors = false;
          useUserUiSyncStatusStore
            .getState()
            .endSaveError("situation-monitor", getErrorMessage(error, "Failed to save settings."));
        });
    });
  }, [accessToken, apiClient, monitors, monitorsFingerprint, orgId, ready.situationMonitor, userId]);

  useEffect(() => {
    if (!ready.situationMonitor || hydratingRef.current || !accessToken || !orgId || !userId) {
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
        .put("user-settings/ui/situation-monitor", { layout: { layout, visibility } })
        .then(() => {
          lastSentRef.current.layout = fingerprintLayout({ layout, visibility });
          pendingRef.current.layout = false;
          useUserUiSyncStatusStore.getState().endSaveSuccess("situation-monitor");

          writeSituationMonitorCache(orgId, userId);
          removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_LAYOUT);
        })
        .catch((error) => {
          captureClientError("Failed to save layout settings", error);
          pendingRef.current.layout = false;
          useUserUiSyncStatusStore
            .getState()
            .endSaveError("situation-monitor", getErrorMessage(error, "Failed to save settings."));
        });
    });
  }, [accessToken, apiClient, layout, layoutFingerprint, orgId, ready.situationMonitor, userId, visibility]);

  useEffect(() => {
    if (!ready.situationMonitor || hydratingRef.current || !accessToken || !orgId || !userId) {
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
          useUserUiSyncStatusStore.getState().endSaveSuccess("situation-monitor");

          writeSituationMonitorCache(orgId, userId);
          removeStorageKey(LEGACY_STORAGE_KEY_SITUATION_MONITOR_SETTINGS);
        })
        .catch((error) => {
          captureClientError("Failed to save view settings", error);
          pendingRef.current.settings = false;
          useUserUiSyncStatusStore
            .getState()
            .endSaveError("situation-monitor", getErrorMessage(error, "Failed to save settings."));
        });
    });
  }, [accessToken, apiClient, orgId, ready.situationMonitor, settings, settingsFingerprint, userId]);

  useEffect(() => {
    if (!ready.warMap || hydratingRef.current || !accessToken || !orgId || !userId) {
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
        .put("user-settings/ui/war-map", { settings: { layerVisibility: warMapLayerVisibility } })
        .then(() => {
          lastSentRef.current.warMapSettings = fingerprintWarMapSettings({ layerVisibility: warMapLayerVisibility });
          pendingRef.current.warMapSettings = false;
          useUserUiSyncStatusStore.getState().endSaveSuccess("war-map");

          writeWarMapCache(orgId, userId);
          removeStorageKey(LEGACY_STORAGE_KEY_WAR_MAP_SETTINGS);
        })
        .catch((error) => {
          captureClientError("Failed to save WarMap settings", error);
          pendingRef.current.warMapSettings = false;
          useUserUiSyncStatusStore.getState().endSaveError("war-map", getErrorMessage(error, "Failed to save settings."));
        });
    });
  }, [accessToken, apiClient, orgId, ready.warMap, userId, warMapLayerVisibility, warMapSettingsFingerprint]);

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
