"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { usePendingAction } from "@/hooks/use-pending-action";
import { createApiClient } from "@/lib/api-client";
import { extractApiError } from "@/lib/api-error";
import { captureClientError } from "@/lib/client-telemetry";
import { useSituationMonitorLayoutStore } from "@/store/situation-monitor-layout";

import {
  TELEGRAM_TOPIC_PRESETS,
  type SituationMonitorCatalogResponse,
  type SituationMonitorInsightsResponse,
} from "../types/situation-monitor-content";
import type {
  SituationOrefAlertsResponse,
  SituationOrefHistoryResponse,
  SituationOrefRealtimePayload,
  SituationTelegramFeedResponse,
  SituationTelegramRealtimePayload,
} from "../types/situation-monitor-signals";
import {
  getSituationMonitorMonitorsUpdatedSource,
  SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
} from "../utils/monitor-events";
import {
  DEFAULT_SITUATION_MONITOR_TELEGRAM_FEED_LIMIT,
  mergeOrefAlertsRealtime,
  mergeOrefHistoryRealtime,
  mergeTelegramFeedRealtime,
} from "../utils/realtime-signals";
import {
  getHttpStatus,
  mergeTranslationStatus,
} from "../utils/situation-monitor-format";
import { buildTelegramFeedQueryParams } from "../utils/telegram-feed";

import { useSituationMonitorStream } from "./use-situation-monitor-stream";

export interface UseSituationMonitorDataOptions {
  accessToken: string | undefined;
  canReadItems: boolean;
  hasSignalSession: boolean;
  windowHours: number;
  scope: "tagged" | "all";
  translateToZh: boolean;
  autoRefresh: boolean;
}

export function useSituationMonitorData(options: UseSituationMonitorDataOptions) {
  const {
    accessToken,
    canReadItems,
    hasSignalSession,
    windowHours,
    scope,
    translateToZh,
    autoRefresh,
  } = options;
  const { t } = useTranslation();

  const [refreshStage, setRefreshStage] = useState<
    "idle" | "core" | "external"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SituationMonitorInsightsResponse | null>(
    null,
  );
  const [telegramFeed, setTelegramFeed] =
    useState<SituationTelegramFeedResponse | null>(null);
  const [orefAlerts, setOrefAlerts] =
    useState<SituationOrefAlertsResponse | null>(null);
  const [orefHistory, setOrefHistory] =
    useState<SituationOrefHistoryResponse | null>(null);
  const [telegramTopicFilter, setTelegramTopicFilter] = useState<string>("all");
  const [telegramChannelFilter, setTelegramChannelFilter] =
    useState<string>("all");
  const [signalsLoading, setSignalsLoading] = useState<{
    telegram: boolean;
    oref: boolean;
  }>({
    telegram: false,
    oref: false,
  });
  const [signalErrors, setSignalErrors] = useState<{
    telegram: string | null;
    oref: string | null;
  }>({
    telegram: null,
    oref: null,
  });
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [signalCatalog, setSignalCatalog] =
    useState<SituationMonitorCatalogResponse | null>(null);
  const [pageVisible, setPageVisible] = useState(
    typeof document === "undefined" ? true : !document.hidden,
  );
  const refreshIdRef = useRef(0);
  const telegramFeedLoadingRef = useRef(false);
  const pendingTelegramFeedLoadRef = useRef<{ silent: boolean } | null>(null);
  const loadTelegramFeedRef = useRef<
    (options?: { silent?: boolean }) => Promise<void>
  >(async () => undefined);
  const telegramFeedRequestKeyRef = useRef(
    JSON.stringify({
      topic: telegramTopicFilter,
      channel: telegramChannelFilter,
    }),
  );
  const orefSignalsLoadingRef = useRef(false);
  const pendingOrefSignalsLoadRef = useRef<{ silent: boolean } | null>(null);
  const loadOrefSignalsRef = useRef<
    (options?: { silent?: boolean }) => Promise<void>
  >(async () => undefined);
  const loading = refreshStage !== "idle";

  const telegramPanelVisible = useSituationMonitorLayoutStore(
    (state) => state.visibility["telegram-feed"],
  );
  const orefPanelVisible = useSituationMonitorLayoutStore(
    (state) => state.visibility["oref-alerts"],
  );

  const telegramSignalActive = Boolean(
    hasSignalSession && canReadItems && pageVisible && telegramPanelVisible,
  );
  const orefSignalActive = Boolean(
    hasSignalSession && canReadItems && pageVisible && orefPanelVisible,
  );

  const apiClient = useMemo(
    () => createApiClient({ accessToken: accessToken }),
    [accessToken],
  );

  useEffect(() => {
    telegramFeedRequestKeyRef.current = JSON.stringify({
      topic: telegramTopicFilter,
      channel: telegramChannelFilter,
    });
  }, [telegramChannelFilter, telegramTopicFilter]);

  const loadSignalCatalog = useCallback(async () => {
    if (!accessToken || !canReadItems) {
      return null;
    }
    if (signalCatalog) {
      return signalCatalog;
    }
    if (catalogLoading) {
      return null;
    }
    setCatalogLoading(true);
    try {
      const response = await apiClient.get<SituationMonitorCatalogResponse>(
        "situation-monitor/catalog",
      );
      const nextCatalog = response.data ?? null;
      setSignalCatalog(nextCatalog);
      return nextCatalog;
    } catch (err) {
      captureClientError("Failed to load situation monitor catalog", err);
      return null;
    } finally {
      setCatalogLoading(false);
    }
  }, [
    apiClient,
    canReadItems,
    catalogLoading,
    accessToken,
    signalCatalog,
  ]);

  useEffect(() => {
    void loadSignalCatalog();
  }, [loadSignalCatalog]);

  const loadTelegramFeed = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!accessToken || !canReadItems) {
        return;
      }

      const silent = options?.silent ?? false;
      if (telegramFeedLoadingRef.current) {
        const pending = pendingTelegramFeedLoadRef.current;
        pendingTelegramFeedLoadRef.current = {
          silent: pending ? pending.silent && silent : silent,
        };
        return;
      }

      telegramFeedLoadingRef.current = true;
      const requestKey = JSON.stringify({
        topic: telegramTopicFilter,
        channel: telegramChannelFilter,
      });
      if (!silent) {
        setSignalsLoading((prev) => ({ ...prev, telegram: true }));
      }
      setSignalErrors((prev) => ({ ...prev, telegram: null }));

      try {
        const response = await apiClient.get<SituationTelegramFeedResponse>(
          "situation-monitor/telegram-feed",
          {
            params: buildTelegramFeedQueryParams(
              {
                topic: telegramTopicFilter,
                channel: telegramChannelFilter,
              },
              { limit: DEFAULT_SITUATION_MONITOR_TELEGRAM_FEED_LIMIT },
            ),
          },
        );
        if (telegramFeedRequestKeyRef.current != requestKey) {
          return;
        }
        setTelegramFeed(response.data ?? null);
        setSignalErrors((prev) => ({ ...prev, telegram: null }));
      } catch (err) {
        captureClientError(
          "Failed to load situation monitor telegram feed",
          err,
        );
        const statusCode = getHttpStatus(err);
        if (statusCode === 401 || statusCode === 403) {
          setTelegramFeed(null);
        }
        setSignalErrors((prev) => ({
          ...prev,
          telegram:
            extractApiError(err).message || "Failed to load Telegram signals.",
        }));
      } finally {
        telegramFeedLoadingRef.current = false;
        if (!silent) {
          setSignalsLoading((prev) => ({ ...prev, telegram: false }));
        }
        const pending = pendingTelegramFeedLoadRef.current;
        pendingTelegramFeedLoadRef.current = null;
        if (pending) {
          void loadTelegramFeedRef.current(pending);
        }
      }
    },
    [
      apiClient,
      canReadItems,
      accessToken,
      telegramChannelFilter,
      telegramTopicFilter,
    ],
  );

  const loadOrefSignals = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!accessToken || !canReadItems) {
        return;
      }

      const silent = options?.silent ?? false;
      if (orefSignalsLoadingRef.current) {
        const pending = pendingOrefSignalsLoadRef.current;
        pendingOrefSignalsLoadRef.current = {
          silent: pending ? pending.silent && silent : silent,
        };
        return;
      }

      orefSignalsLoadingRef.current = true;
      if (!silent) {
        setSignalsLoading((prev) => ({ ...prev, oref: true }));
      }
      setSignalErrors((prev) => ({ ...prev, oref: null }));

      try {
        const [alertsResponse, historyResponse] = await Promise.all([
          apiClient.get<SituationOrefAlertsResponse>(
            "situation-monitor/oref-alerts",
          ),
          apiClient.get<SituationOrefHistoryResponse>(
            "situation-monitor/oref-history",
          ),
        ]);

        setOrefAlerts(alertsResponse.data ?? null);
        setOrefHistory(historyResponse.data ?? null);
        setSignalErrors((prev) => ({ ...prev, oref: null }));
      } catch (err) {
        captureClientError(
          "Failed to load situation monitor OREF signals",
          err,
        );
        const statusCode = getHttpStatus(err);
        if (statusCode === 401 || statusCode === 403) {
          setOrefAlerts(null);
          setOrefHistory(null);
        }
        setSignalErrors((prev) => ({
          ...prev,
          oref: extractApiError(err).message || "Failed to load OREF signals.",
        }));
      } finally {
        orefSignalsLoadingRef.current = false;
        if (!silent) {
          setSignalsLoading((prev) => ({ ...prev, oref: false }));
        }
        const pending = pendingOrefSignalsLoadRef.current;
        pendingOrefSignalsLoadRef.current = null;
        if (pending) {
          void loadOrefSignalsRef.current(pending);
        }
      }
    },
    [apiClient, canReadItems, accessToken],
  );

  useEffect(() => {
    loadTelegramFeedRef.current = loadTelegramFeed;
  }, [loadTelegramFeed]);

  useEffect(() => {
    loadOrefSignalsRef.current = loadOrefSignals;
  }, [loadOrefSignals]);

  const load = useCallback(
    async (options?: {
      includeExternal?: boolean;
      scopeOverride?: "tagged" | "all";
    }) => {
      if (!accessToken) {
        return;
      }
      const includeExternal = options?.includeExternal ?? true;
      const requestedScope = options?.scopeOverride ?? scope;
      const refreshId = (refreshIdRef.current += 1);
      setRefreshStage("core");
      setError(null);
      try {
        const coreResponse =
          await apiClient.get<SituationMonitorInsightsResponse>(
            "situation-monitor/insights",
            {
              params: {
                windowHours,
                maxItems: 400,
                sections: "core",
                scope: requestedScope,
                translate: translateToZh ? "zh-CN" : undefined,
              },
            },
          );

        if (refreshIdRef.current !== refreshId) {
          return;
        }

        const coreData = coreResponse.data ?? null;
        if (coreData) {
          setData((prev) => {
            if (!prev) {
              return {
                ...coreData,
                warnings: coreData.warnings ?? [],
              };
            }
            return {
              ...prev,
              ...coreData,
              warnings: coreData.warnings ?? [],
              translation: coreData.translation,
            };
          });
        }

        if (!includeExternal) {
          return;
        }

        setRefreshStage("external");

        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (refreshIdRef.current !== refreshId) {
          return;
        }

        const externalResponse =
          await apiClient.get<SituationMonitorInsightsResponse>(
            "situation-monitor/insights",
            {
              params: {
                windowHours,
                maxItems: 400,
                sections: "external",
                scope: requestedScope,
                translate: translateToZh ? "zh-CN" : undefined,
              },
            },
          );

        if (refreshIdRef.current !== refreshId) {
          return;
        }

        const externalData = externalResponse.data ?? null;
        if (externalData) {
          setData((prev) => {
            if (!prev) {
              return externalData;
            }

            const merged: SituationMonitorInsightsResponse = { ...prev };
            if (externalData.crypto !== undefined) {
              merged.crypto = externalData.crypto;
            }
            if (externalData.markets !== undefined) {
              merged.markets = externalData.markets;
            }
            if (externalData.fed !== undefined) {
              merged.fed = externalData.fed;
            }

            // External refresh always has `analyzedItems: 0`; keep core counters and window/maxItems.
            merged.windowHours = prev.windowHours;
            merged.maxItems = prev.maxItems;
            merged.analyzedItems = prev.analyzedItems;
            merged.monitorMatches = prev.monitorMatches;

            // Still surface the latest refresh timestamp so the header reflects the most recent load.
            if (externalData.generatedAt) {
              merged.generatedAt = externalData.generatedAt;
            }

            merged.translation = mergeTranslationStatus(
              prev.translation,
              externalData.translation,
            );
            return merged;
          });
        }
      } catch (err) {
        captureClientError("Failed to load situation monitor insights", err);
        if (refreshIdRef.current === refreshId) {
          setError(
            extractApiError(err).message ||
              "Failed to load situation monitor insights.",
          );
        }
      } finally {
        if (refreshIdRef.current === refreshId) {
          setRefreshStage("idle");
        }
      }
    },
    [apiClient, scope, accessToken, translateToZh, windowHours],
  );

  const { pending: manualRefreshPending, run: runManualRefresh } =
    usePendingAction(async () => {
      if (!accessToken) {
        return;
      }

      await Promise.allSettled([
        load(),
        telegramSignalActive
          ? loadTelegramFeedRef.current()
          : Promise.resolve(undefined),
        orefSignalActive
          ? loadOrefSignalsRef.current()
          : Promise.resolve(undefined),
      ]);
    });

  const handleRealtimeTelegramUpdate = useCallback(
    (payload: SituationTelegramRealtimePayload) => {
      if (!telegramSignalActive) {
        return;
      }
      setSignalErrors((prev) =>
        prev.telegram ? { ...prev, telegram: null } : prev,
      );
      setTelegramFeed((prev) =>
        mergeTelegramFeedRealtime(
          prev,
          payload,
          {
            topic: telegramTopicFilter,
            channel: telegramChannelFilter,
          },
          { limit: DEFAULT_SITUATION_MONITOR_TELEGRAM_FEED_LIMIT },
        ),
      );
    },
    [telegramChannelFilter, telegramSignalActive, telegramTopicFilter],
  );

  const handleRealtimeOrefUpdate = useCallback(
    (payload: SituationOrefRealtimePayload) => {
      if (!orefSignalActive) {
        return;
      }
      setSignalErrors((prev) => (prev.oref ? { ...prev, oref: null } : prev));
      setOrefAlerts((prev) => mergeOrefAlertsRealtime(prev, payload));
      setOrefHistory((prev) => mergeOrefHistoryRealtime(prev, payload));
    },
    [orefSignalActive],
  );

  const realtimeState = useSituationMonitorStream({
    enabled: telegramSignalActive || orefSignalActive,
    onTelegramUpdate: handleRealtimeTelegramUpdate,
    onOrefUpdate: handleRealtimeOrefUpdate,
  });

  // The socket does not replay history, and polling stops while connected —
  // so events emitted while the connection was down would be permanently
  // lost. On every reconnect, refresh the feeds once to compensate.
  const wasRealtimeConnectedRef = useRef(false);
  useEffect(() => {
    if (!realtimeState.connected) {
      wasRealtimeConnectedRef.current = false;
      return;
    }
    if (wasRealtimeConnectedRef.current) {
      return;
    }
    wasRealtimeConnectedRef.current = true;
    if (telegramSignalActive) {
      void loadTelegramFeed({ silent: true });
    }
    if (orefSignalActive) {
      void loadOrefSignals({ silent: true });
    }
  }, [
    realtimeState.connected,
    telegramSignalActive,
    orefSignalActive,
    loadTelegramFeed,
    loadOrefSignals,
  ]);

  const telegramPollingActive =
    telegramSignalActive && !realtimeState.connected;
  const orefPollingActive = orefSignalActive && !realtimeState.connected;

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const onVisibilityChange = () => {
      setPageVisible(!document.hidden);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!telegramSignalActive) {
      return;
    }
    void loadTelegramFeed();
  }, [loadTelegramFeed, telegramSignalActive]);

  useEffect(() => {
    if (!orefSignalActive) {
      return;
    }
    void loadOrefSignals();
  }, [loadOrefSignals, orefSignalActive]);

  useEffect(() => {
    if (!autoRefresh || !pageVisible) {
      return;
    }
    const timer = setInterval(() => void load(), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, load, pageVisible]);

  useEffect(() => {
    if (!telegramPollingActive) {
      return;
    }
    const timer = setInterval(() => {
      void loadTelegramFeed({ silent: true });
    }, 60_000);
    return () => clearInterval(timer);
  }, [loadTelegramFeed, telegramPollingActive]);

  useEffect(() => {
    if (!orefPollingActive) {
      return;
    }
    const timer = setInterval(() => {
      void loadOrefSignals({ silent: true });
    }, 120_000);
    return () => clearInterval(timer);
  }, [loadOrefSignals, orefPollingActive]);

  useEffect(() => {
    return () => {
      pendingTelegramFeedLoadRef.current = null;
      pendingOrefSignalsLoadRef.current = null;
    };
  }, []);

  const telegramTopicOptions = useMemo(() => {
    const dynamicTopics = new Set<string>(TELEGRAM_TOPIC_PRESETS);
    for (const item of telegramFeed?.items ?? []) {
      const topic = typeof item.topic === "string" ? item.topic.trim() : "";
      if (topic) {
        dynamicTopics.add(topic);
      }
    }
    if (telegramTopicFilter !== "all") {
      dynamicTopics.add(telegramTopicFilter);
    }

    return [
      {
        label: t("situationMonitor.telegram.filters.allTopics"),
        value: "all",
      },
      ...Array.from(dynamicTopics)
        .sort((a, b) => a.localeCompare(b))
        .map((topic) => ({ label: topic, value: topic })),
    ];
  }, [telegramFeed?.items, telegramTopicFilter, t]);

  const telegramChannelOptions = useMemo(() => {
    const channels = new Set<string>();
    for (const item of telegramFeed?.items ?? []) {
      const channel =
        typeof item.channel === "string" ? item.channel.trim() : "";
      if (channel) {
        channels.add(channel);
      }
    }
    if (telegramChannelFilter !== "all") {
      channels.add(telegramChannelFilter);
    }

    return [
      {
        label: t("situationMonitor.telegram.filters.allChannels"),
        value: "all",
      },
      ...Array.from(channels)
        .sort((a, b) => a.localeCompare(b))
        .map((channel) => ({ label: channel, value: channel })),
    ];
  }, [telegramChannelFilter, telegramFeed?.items, t]);

  const handleMonitorsChanged = useCallback(async () => {
    await load();
    await Promise.all([
      loadTelegramFeedRef.current({ silent: true }),
      loadOrefSignalsRef.current({ silent: true }),
    ]);
  }, [load]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleMonitorUpdate = (event: Event) => {
      if (
        getSituationMonitorMonitorsUpdatedSource(event) === "monitors-panel"
      ) {
        return;
      }
      void handleMonitorsChanged();
    };
    window.addEventListener(
      SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
      handleMonitorUpdate,
    );
    return () => {
      window.removeEventListener(
        SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
        handleMonitorUpdate,
      );
    };
  }, [handleMonitorsChanged]);

  return {
    apiClient,
    refreshStage,
    error,
    data,
    loading,
    manualRefreshPending,
    runManualRefresh,
    telegramFeed,
    orefAlerts,
    orefHistory,
    telegramTopicFilter,
    setTelegramTopicFilter,
    telegramChannelFilter,
    setTelegramChannelFilter,
    signalsLoading,
    signalErrors,
    catalogLoading,
    signalCatalog,
    loadSignalCatalog,
    loadTelegramFeed,
    loadOrefSignals,
    load,
    realtimeState,
    telegramTopicOptions,
    telegramChannelOptions,
    handleMonitorsChanged,
  };
}
