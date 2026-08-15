"use client";

import type { message } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { useTranslation } from "react-i18next";
import { io, type Socket } from "socket.io-client";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { env } from "@/lib/env";
import { resolveSeedSchedulerRuntimeSettings } from "@/lib/news-source-seed";
import { formatRealtimeSocketError } from "@/lib/realtime-socket-errors";

import {
  createDefaultLiveRefreshSources,
  createEmptyLiveEventCounts,
  extractApiErrorMessage,
  LIVE_EVENT_SOURCE_SET,
  mapNewsSourceRecord,
  REALTIME_SOCKET_TIMEOUT_MS,
} from "./news-sources.helpers";
import type {
  Crawl4aiQualitySnapshot,
  Crawl4aiQueueStats,
  CrawlTemplateRecord,
  LiveEventSource,
  NewsSourceListResponse,
  NewsSourceReadinessSummary,
  NewsSourceRecord,
  NewsSourceSchedulerSettingsResponse,
  NewsSourcesUiBusy,
  OpsLiveEvent,
  RefreshAllOptions,
} from "./news-sources.types";

export function useNewsSourcesData(params: {
  canView: boolean;
  canManage: boolean;
  accessToken: string | undefined;
  sessionStatus: string;
  t: ReturnType<typeof useTranslation>["t"];
  messageApi: ReturnType<typeof message.useMessage>[0];
  modalOpen: boolean;
  uiBusy: NewsSourcesUiBusy;
}) {
  const {
    canView,
    canManage,
    accessToken,
    sessionStatus,
    t,
    messageApi,
    modalOpen,
    uiBusy,
  } = params;

  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<NewsSourceRecord[]>([]);
  const [sourceTotal, setSourceTotal] = useState(0);
  const [sourcePage, setSourcePage] = useState(1);
  const [sourcePageSize, setSourcePageSize] = useState(10);
  const [sourceIndex, setSourceIndex] = useState<
    Record<string, NewsSourceRecord>
  >({});
  const [templates, setTemplates] = useState<CrawlTemplateRecord[]>([]);
  const [workflowOptions, setWorkflowOptions] = useState<
    { label: string; value: string }[]
  >([]);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [crawlQueueStats, setCrawlQueueStats] =
    useState<Crawl4aiQueueStats | null>(null);
  const [crawlQueueLoading, setCrawlQueueLoading] = useState(false);
  const [crawlQueueError, setCrawlQueueError] = useState<string | null>(null);
  const [crawlQualityStats, setCrawlQualityStats] =
    useState<Crawl4aiQualitySnapshot | null>(null);
  const [crawlQualityLoading, setCrawlQualityLoading] = useState(false);
  const [crawlQualityError, setCrawlQualityError] = useState<string | null>(
    null,
  );
  const [readinessSummary, setReadinessSummary] =
    useState<NewsSourceReadinessSummary | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [seedSchedulerSettings, setSeedSchedulerSettings] =
    useState<NewsSourceSchedulerSettingsResponse | null>(null);
  const [seedSchedulerSettingsLoadFailed, setSeedSchedulerSettingsLoadFailed] =
    useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(30);
  const [liveUpdatesEnabled, setLiveUpdatesEnabled] = useState(true);
  const [liveStatus, setLiveStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveLastEvent, setLiveLastEvent] = useState<OpsLiveEvent | null>(null);
  const [liveEventCount, setLiveEventCount] = useState(0);
  const [liveEventCountsBySource, setLiveEventCountsBySource] = useState<
    Record<LiveEventSource, number>
  >(() => createEmptyLiveEventCounts());
  const [liveRefreshSources, setLiveRefreshSources] = useState<
    Record<LiveEventSource, boolean>
  >(() => createDefaultLiveRefreshSources());
  const liveRefreshSourcesRef = useRef(liveRefreshSources);
  const liveRefreshTimerRef = useRef<number | null>(null);
  const liveSocketRef = useRef<Socket | null>(null);
  const liveUiBusyRef = useRef(false);
  const visibleSourceIdSetRef = useRef<Set<string>>(new Set());
  const refreshAllRef = useRef<((options?: RefreshAllOptions) => Promise<void>) | null>(
    null,
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const refreshRef = useRef(false);
  const pendingRefreshRef = useRef<{
    silent: boolean;
    includeQueue: boolean;
    includeQuality: boolean;
  } | null>(null);

  const visibleSourceIdSet = useMemo(
    () => new Set(sources.map((source) => source.id)),
    [sources],
  );
  const resolvedSeedRuntimeSettings = useMemo(
    () =>
      resolveSeedSchedulerRuntimeSettings(seedSchedulerSettings ?? undefined),
    [seedSchedulerSettings],
  );
  const uniqueGroups = useMemo(
    () =>
      Array.from(
        new Set([
          ...groups,
          ...sources.map((s) => s.group).filter((g): g is string => Boolean(g)),
        ]),
      ).sort(),
    [groups, sources],
  );
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );

  useEffect(() => {
    liveRefreshSourcesRef.current = liveRefreshSources;
  }, [liveRefreshSources]);

  useEffect(() => {
    visibleSourceIdSetRef.current = visibleSourceIdSet;
  }, [visibleSourceIdSet]);

  const loadSources = useCallback(
    async (options?: {
      silent?: boolean;
      page?: number;
      pageSize?: number;
      search?: string;
    }): Promise<boolean> => {
      const silent = options?.silent === true;
      const page = options?.page ?? sourcePage;
      const pageSize = options?.pageSize ?? sourcePageSize;
      const search = options?.search ?? searchQuery;
      if (!silent) {
        setLoading(true);
      }
      try {
        const response = await apiClient.get<NewsSourceListResponse>(
          "admin/news-sources",
          {
            params: {
              page,
              pageSize,
              search: search || undefined,
            },
          },
        );
        const payload = response.data ?? {
          sources: [],
          total: 0,
          page,
          pageSize,
        };
        const nextSources = (payload.sources ?? []).map(mapNewsSourceRecord);
        setSources(nextSources);
        setSourceIndex((prev) => {
          const next = { ...prev };
          for (const source of nextSources) {
            next[source.id] = source;
          }
          return next;
        });
        setSourceTotal(payload.total ?? 0);
        setSourcePage(payload.page ?? page);
        setSourcePageSize(payload.pageSize ?? pageSize);
        return true;
      } catch (error) {
        captureClientError("Failed to load news sources", error);
        if (!silent) {
          messageApi.error(
            t("newsSources.errors.loadFailed"),
          );
        }
        return false;
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [apiClient, messageApi, searchQuery, sourcePage, sourcePageSize, t],
  );

  const loadReadinessSummary = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!accessToken || !canView) {
        setReadinessSummary(null);
        setReadinessError(null);
        return;
      }

      if (!silent) {
        setReadinessLoading(true);
      }

      try {
        const pageSize = 50;
        const maxPages = 100;
        const allSources: NewsSourceRecord[] = [];
        let total = Number.POSITIVE_INFINITY;
        let page = 1;

        while (page <= maxPages && allSources.length < total) {
          const response = await apiClient.get<NewsSourceListResponse>(
            "admin/news-sources",
            {
              params: {
                page,
                pageSize,
              },
            },
          );
          const payload = response.data ?? {
            sources: [],
            total: 0,
            page,
            pageSize,
          };
          const pageSources = (payload.sources ?? []).map(mapNewsSourceRecord);
          allSources.push(...pageSources);
          total = Math.max(payload.total ?? 0, allSources.length);
          if (pageSources.length < pageSize) {
            break;
          }
          page += 1;
        }

        const now = Date.now();
        const summary = allSources.reduce<NewsSourceReadinessSummary>(
          (acc, source) => {
            acc.total += 1;
            if (source.isActive) {
              acc.active += 1;
            } else {
              acc.inactive += 1;
            }
            if (
              source.circuitOpenUntil &&
              new Date(source.circuitOpenUntil).getTime() > now
            ) {
              acc.circuitOpen += 1;
            }
            if (Number(source.consecutiveFailures ?? 0) > 0) {
              acc.failing += 1;
            }
            return acc;
          },
          {
            total: 0,
            active: 0,
            inactive: 0,
            circuitOpen: 0,
            failing: 0,
          },
        );

        setReadinessSummary(summary);
        setReadinessError(null);
      } catch (error) {
        captureClientError(
          "Failed to load news source readiness summary",
          error,
        );
        setReadinessSummary(null);
        setReadinessError(
          t("newsSources.readiness.loadFailed"),
        );
      } finally {
        if (!silent) {
          setReadinessLoading(false);
        }
      }
    },
    [apiClient, canView, accessToken, t],
  );

  const loadTemplates = useCallback(async () => {
    try {
      const response = await apiClient.get<CrawlTemplateRecord[]>(
        "admin/crawl-templates",
      );
      setTemplates(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load crawl templates", error);
    }
  }, [apiClient]);

  const loadWorkflowOptions = useCallback(async () => {
    try {
      const response = await apiClient.get<{ id: string; name: string }[]>(
        "admin/crawl-frontier/workflows",
      );
      setWorkflowOptions(
        (response.data ?? []).map((workflow) => ({
          label: workflow.name,
          value: workflow.id,
        })),
      );
    } catch (error) {
      captureClientError("Failed to load crawl strategy workflows", error);
    }
  }, [apiClient]);

  const loadGroups = useCallback(async () => {
    try {
      const response = await apiClient.get<string[]>(
        "admin/news-sources/groups",
      );
      setGroups(response.data ?? []);
    } catch (error) {
      captureClientError("Failed to load news source groups", error);
    }
  }, [apiClient]);

  const loadSeedSchedulerSettings = useCallback(async () => {
    try {
      const response = await apiClient.get<NewsSourceSchedulerSettingsResponse>(
        "system-settings/news-source-scheduler",
      );
      const data = response.data ?? {};
      const runtimeSettings = resolveSeedSchedulerRuntimeSettings(data);
      setSeedSchedulerSettings({
        source: data.source === "db" ? "db" : "default",
        ...runtimeSettings,
      });
      setSeedSchedulerSettingsLoadFailed(false);
    } catch (error) {
      captureClientError(
        "Failed to load news source scheduler settings",
        error,
      );
      setSeedSchedulerSettings(null);
      setSeedSchedulerSettingsLoadFailed(true);
    }
  }, [apiClient]);

  const loadCrawlQueueStats = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!silent) {
        setCrawlQueueLoading(true);
      }
      setCrawlQueueError(null);
      try {
        const response = await apiClient.get<Crawl4aiQueueStats>(
          "admin/crawl4ai/queue",
        );
        setCrawlQueueStats(response.data ?? null);
      } catch (error) {
        captureClientError("Failed to load crawl queue stats", error);
        setCrawlQueueError(
          extractApiErrorMessage(error) ??
            (error instanceof Error
              ? error.message
              : "Failed to load crawl queue stats."),
        );
        if (!silent) {
          setCrawlQueueStats(null);
        }
      } finally {
        if (!silent) {
          setCrawlQueueLoading(false);
        }
      }
    },
    [apiClient],
  );

  const loadCrawlQualityStats = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!silent) {
        setCrawlQualityLoading(true);
      }
      setCrawlQualityError(null);
      try {
        const response = await apiClient.get<Crawl4aiQualitySnapshot>(
          "admin/crawl4ai/quality",
        );
        setCrawlQualityStats(response.data ?? null);
      } catch (error) {
        captureClientError("Failed to load crawl quality stats", error);
        setCrawlQualityError(
          extractApiErrorMessage(error) ??
            (error instanceof Error
              ? error.message
              : "Failed to load crawl quality stats."),
        );
        if (!silent) {
          setCrawlQualityStats(null);
        }
      } finally {
        if (!silent) {
          setCrawlQualityLoading(false);
        }
      }
    },
    [apiClient],
  );

  const refreshAll = useCallback(
    async (options?: RefreshAllOptions) => {
      const silent = options?.silent === true;
      const includeQueue = options?.includeQueue !== false;
      const includeQuality = options?.includeQuality !== false;
      if (refreshRef.current) {
        const pending = pendingRefreshRef.current;
        pendingRefreshRef.current = {
          silent: pending ? pending.silent && silent : silent,
          includeQueue: pending ? pending.includeQueue || includeQueue : includeQueue,
          includeQuality: pending
            ? pending.includeQuality || includeQuality
            : includeQuality,
        };
        return;
      }
      refreshRef.current = true;
      try {
        const [sourcesOk] = await Promise.all([
          loadSources({ silent }),
          loadReadinessSummary({ silent }),
          includeQueue
            ? loadCrawlQueueStats({ silent })
            : Promise.resolve(undefined),
          includeQuality
            ? loadCrawlQualityStats({ silent })
            : Promise.resolve(undefined),
        ]);
        if (sourcesOk) {
          setLastUpdatedAt(new Date().toISOString());
        }
      } finally {
        refreshRef.current = false;
        const pending = pendingRefreshRef.current;
        pendingRefreshRef.current = null;
        if (pending) {
          void refreshAll(pending);
        }
      }
    },
    [
      loadCrawlQualityStats,
      loadCrawlQueueStats,
      loadReadinessSummary,
      loadSources,
    ],
  );

  useEffect(() => {
    refreshAllRef.current = refreshAll;
  }, [refreshAll]);

  useEffect(() => {
    if (canView) {
      void loadTemplates();
      void loadWorkflowOptions();
      void loadGroups();
      if (canManage) {
        void loadSeedSchedulerSettings();
      }
    }
  }, [
    canManage,
    canView,
    loadTemplates,
    loadWorkflowOptions,
    loadGroups,
    loadSeedSchedulerSettings,
  ]);

  useEffect(() => {
    if (!canView) {
      return;
    }
    void refreshAll();
  }, [canView, refreshAll]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      const nextSearchQuery = searchInput.trim();
      setSearchQuery((previousSearchQuery) => {
        if (previousSearchQuery === nextSearchQuery) {
          return previousSearchQuery;
        }
        setSourcePage(1);
        return nextSearchQuery;
      });
    }, 300);

    return () => window.clearTimeout(id);
  }, [searchInput]);

  useEffect(() => {
    if (modalOpen && canManage) {
      void loadSeedSchedulerSettings();
    }
  }, [canManage, loadSeedSchedulerSettings, modalOpen]);

  const liveFallbackPollingEnabled =
    canView &&
    sessionStatus === "authenticated" &&
    liveUpdatesEnabled &&
    liveStatus !== "connected";
  const intervalRefreshEnabled =
    liveFallbackPollingEnabled || (!liveUpdatesEnabled && autoRefreshEnabled);

  useEffect(() => {
    if (!intervalRefreshEnabled) {
      return;
    }
    const intervalMs = Math.max(5, Math.min(300, autoRefreshSeconds)) * 1000;
    const id = window.setInterval(() => {
      if (uiBusy.modalOpen || uiBusy.createDrawerOpen || uiBusy.previewOpen || uiBusy.scheduleOpen) {
        return;
      }
      if (uiBusy.saving || uiBusy.scheduleLoading || uiBusy.previewLoading || uiBusy.previewRunNowLoading) {
        return;
      }
      if (uiBusy.batchRunLoading || uiBusy.batchToggleLoading) {
        return;
      }
      if (uiBusy.dispatchingCount > 0 || uiBusy.opsLoadingCount > 0) {
        return;
      }
      void refreshAll({
        silent: true,
        includeQueue: false,
        includeQuality: false,
      });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [
    autoRefreshEnabled,
    autoRefreshSeconds,
    uiBusy.batchRunLoading,
    uiBusy.batchToggleLoading,
    uiBusy.createDrawerOpen,
    uiBusy.dispatchingCount,
    intervalRefreshEnabled,
    uiBusy.modalOpen,
    uiBusy.opsLoadingCount,
    uiBusy.previewLoading,
    uiBusy.previewOpen,
    uiBusy.previewRunNowLoading,
    refreshAll,
    uiBusy.saving,
    uiBusy.scheduleLoading,
    uiBusy.scheduleOpen,
  ]);

  useEffect(() => {
    liveUiBusyRef.current =
      uiBusy.modalOpen ||
      uiBusy.createDrawerOpen ||
      uiBusy.previewOpen ||
      uiBusy.scheduleOpen ||
      uiBusy.saving ||
      uiBusy.scheduleLoading ||
      uiBusy.previewLoading ||
      uiBusy.previewRunNowLoading ||
      uiBusy.batchRunLoading ||
      uiBusy.batchToggleLoading ||
      uiBusy.dispatchingCount > 0 ||
      uiBusy.opsLoadingCount > 0;
  }, [
    uiBusy.batchRunLoading,
    uiBusy.batchToggleLoading,
    uiBusy.createDrawerOpen,
    uiBusy.dispatchingCount,
    uiBusy.modalOpen,
    uiBusy.opsLoadingCount,
    uiBusy.previewLoading,
    uiBusy.previewOpen,
    uiBusy.previewRunNowLoading,
    uiBusy.saving,
    uiBusy.scheduleLoading,
    uiBusy.scheduleOpen,
  ]);

  const scheduleLiveRefresh = useCallback(() => {
    if (liveRefreshTimerRef.current) {
      return;
    }
    liveRefreshTimerRef.current = window.setTimeout(() => {
      liveRefreshTimerRef.current = null;
      if (liveUiBusyRef.current) {
        return;
      }
      void refreshAllRef.current?.({
        silent: true,
        includeQueue: false,
        includeQuality: false,
      });
    }, 1200);
  }, []);

  const resetLiveCounters = useCallback(() => {
    setLiveEventCount(0);
    setLiveEventCountsBySource(createEmptyLiveEventCounts());
    setLiveLastEvent(null);
  }, []);

  useEffect(() => {
    if (!canView || !liveUpdatesEnabled || !accessToken) {
      setLiveStatus("disconnected");
      return;
    }

    setLiveStatus("connecting");
    setLiveError(null);

    const socket = io(`${env.apiRoot}/ops`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      withCredentials: true,
      autoConnect: false,
      timeout: REALTIME_SOCKET_TIMEOUT_MS,
    });

    liveSocketRef.current = socket;
    const connectTimer = window.setTimeout(() => {
      socket.connect();
    }, 0);

    const handleConnect = () => {
      setLiveStatus("connected");
      setLiveError(null);
      void refreshAllRef.current?.({ silent: true });
    };
    const handleDisconnect = () => setLiveStatus("disconnected");
    const getLocalizedError = (
      payload:
        | { code?: string; message?: string; retryAfterMs?: number }
        | undefined,
      fallbackKind: "socket" | "connect",
    ) =>
      formatRealtimeSocketError(payload, t, {
        keyPrefix: "newsSources.liveUpdates.connectionError",
        fallbackKind,
        defaults: {
          unauthorized:
            "News source realtime access expired. Please sign in again.",
          tooManyConnections:
            "News source realtime connections are at capacity. Please try again later.",
          tooManyConnectionAttempts:
            "Too many news source realtime connection attempts. Please try again later.",
          rateLimitExceeded:
            "News source realtime connection attempts are too frequent. Please try again later.",
          tooManyFailedAttempts:
            "Too many failed news source realtime sign-in attempts. Please try again later.",
          timeout:
            "Connecting to news source realtime timed out. Please try again.",
          network:
            "Unable to connect to news source realtime. Please check the network and try again.",
          connect:
            "Unable to connect to news source realtime right now. Please try again later.",
          socket:
            "News source realtime connection is unstable. Please try again later.",
        },
      });
    const handleConnectError = (
      error: { code?: string; message?: string; retryAfterMs?: number },
    ) => {
      setLiveStatus("disconnected");
      setLiveError(getLocalizedError(error, "connect"));
    };
    const handleServerError = (payload: unknown) => {
      const candidate =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as {
              code?: string;
              message?: string;
              retryAfterMs?: number;
            })
          : undefined;
      setLiveError(getLocalizedError(candidate, "socket"));
    };
    const handleEvent = (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return;
      }
      const record = payload as Record<string, unknown>;
      const sourceRaw = record.source;
      if (
        typeof sourceRaw !== "string" ||
        !LIVE_EVENT_SOURCE_SET.has(sourceRaw as LiveEventSource)
      ) {
        return;
      }
      const source = sourceRaw as LiveEventSource;
      const event = typeof record.event === "string" ? record.event : "EVENT";
      const jobId = typeof record.jobId === "string" ? record.jobId : "";
      const orgId = typeof record.orgId === "string" ? record.orgId : "";
      const sourceId =
        typeof record.sourceId === "string" ? record.sourceId : undefined;
      const timestamp =
        typeof record.timestamp === "string"
          ? record.timestamp
          : new Date().toISOString();

      setLiveLastEvent({ orgId, source, event, jobId, sourceId, timestamp });
      setLiveEventCount((prev) => prev + 1);
      setLiveEventCountsBySource((prev) => ({
        ...prev,
        [source]: (prev[source] ?? 0) + 1,
      }));

      const isPageScopedSource = source === "pipeline" || source === "crawl";
      if (
        isPageScopedSource &&
        (!sourceId || !visibleSourceIdSetRef.current.has(sourceId))
      ) {
        return;
      }

      if (event !== "PROGRESS" && liveRefreshSourcesRef.current[source]) {
        scheduleLiveRefresh();
      }
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("ops:error", handleServerError);
    socket.on("ops:event", handleEvent);

    return () => {
      window.clearTimeout(connectTimer);
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("ops:error", handleServerError);
      socket.off("ops:event", handleEvent);
      socket.disconnect();
      if (liveSocketRef.current === socket) {
        liveSocketRef.current = null;
      }
      if (liveRefreshTimerRef.current) {
        window.clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
      pendingRefreshRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is only used for error copy
  }, [
    canView,
    liveUpdatesEnabled,
    accessToken,
    scheduleLiveRefresh,
  ]);

  return {
    apiClient,
    loading,
    sources,
    sourceTotal,
    sourcePage,
    sourcePageSize,
    setSourcePage,
    setSourcePageSize,
    sourceIndex,
    templates,
    workflowOptions,
    searchInput,
    setSearchInput,
    searchQuery,
    crawlQueueStats,
    crawlQueueLoading,
    crawlQueueError,
    crawlQualityStats,
    crawlQualityLoading,
    crawlQualityError,
    readinessSummary,
    readinessLoading,
    readinessError,
    groups,
    uniqueGroups,
    seedSchedulerSettings,
    seedSchedulerSettingsLoadFailed,
    resolvedSeedRuntimeSettings,
    autoRefreshEnabled,
    setAutoRefreshEnabled,
    autoRefreshSeconds,
    setAutoRefreshSeconds,
    liveUpdatesEnabled,
    setLiveUpdatesEnabled,
    liveStatus,
    liveError,
    liveLastEvent,
    liveEventCount,
    liveEventCountsBySource,
    liveRefreshSources,
    setLiveRefreshSources,
    lastUpdatedAt,
    loadSources,
    loadReadinessSummary,
    loadTemplates,
    loadWorkflowOptions,
    loadGroups,
    loadSeedSchedulerSettings,
    loadCrawlQueueStats,
    loadCrawlQualityStats,
    refreshAll,
    resetLiveCounters,
  };
}
