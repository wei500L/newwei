"use client";

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Divider,
  Grid,
  InputNumber,
  Popover,
  Progress,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
  theme,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { io, type Socket } from "socket.io-client";

import { buildAdminLogsHref } from "@/lib/admin-logs";
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { env } from "@/lib/env";
import { formatRealtimeSocketError } from "@/lib/realtime-socket-errors";

const REALTIME_SOCKET_TIMEOUT_MS = 10_000;

type TaskLogStatus = "pending" | "processing" | "completed" | "failed";

type LiveEventSource =
  | "pipeline"
  | "crawl"
  | "analysis"
  | "assistant"
  | "alerts";

interface QualityLiveEvent {
  orgId: string;
  source: LiveEventSource;
  event: string;
  jobId: string;
  timestamp: string;
}

const LIVE_EVENT_SOURCES: LiveEventSource[] = [
  "pipeline",
  "crawl",
  "analysis",
  "assistant",
  "alerts",
];
const LIVE_EVENT_SOURCE_SET = new Set<LiveEventSource>(LIVE_EVENT_SOURCES);
const TASK_LOG_SUMMARY_WINDOW_MINUTES = 60;

const createEmptyLiveEventCounts = (): Record<LiveEventSource, number> => ({
  pipeline: 0,
  crawl: 0,
  analysis: 0,
  assistant: 0,
  alerts: 0,
});

const createEmptyLiveDirtySources = (): Record<LiveEventSource, boolean> => ({
  pipeline: false,
  crawl: false,
  analysis: false,
  assistant: false,
  alerts: false,
});

const createDefaultLiveRefreshSources = (): Record<
  LiveEventSource,
  boolean
> => ({
  pipeline: false,
  crawl: false,
  analysis: false,
  assistant: false,
  alerts: false,
});

interface PipelineQualitySummary {
  windowMinutes: number;
  totals: {
    total: number;
    completed: number;
    failed: number;
    processing: number;
    pending: number;
  };
  successRate: number | null;
  averageLatencyMs: number | null;
  ingestionLatencyMs?: {
    sampleSize: number;
    averageMs: number | null;
    p50Ms: number | null;
    p90Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
  };
  failureTypes: { stage: string; errorName: string; count: number }[];
  llmModels?: {
    model: string;
    count: number;
    avgLatencyMs: number | null;
    avgCostUsd: number | null;
    avgTotalTokens: number | null;
  }[];
  outbox?: {
    totals: {
      total: number;
      pending: number;
      processing: number;
      failed: number;
      dead: number;
      staleProcessing: number;
    };
    oldestAgeMinutes: number | null;
  };
}

interface TaskLogRecord {
  id: string;
  queue: string;
  jobId: string;
  orgId: string;
  stage: string;
  status: TaskLogStatus;
  message?: string | null;
  data?: unknown;
  error?: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

interface TaskLogsSummary {
  totals: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
  byStage: { stage: string; count: number }[];
  topErrors: {
    queue: string;
    stage: string;
    errorName: string;
    sampleMessage: string | null;
    count: number;
  }[];
}

interface NewsSourceQualitySummary {
  windowHours: number;
  totals: {
    total: number;
    active: number;
    failing: number;
    circuitOpen: number;
  };
  topFailingSources: {
    sourceId: string;
    name: string;
    url: string;
    failedJobs: number;
    consecutiveFailures: number;
    lastFailureAt: string | null;
    circuitOpenUntil: string | null;
    nextRunAt: string | null;
  }[];
}

interface QualityOverviewResponse {
  generatedAt: string;
  pipeline: PipelineQualitySummary;
  newsSources: NewsSourceQualitySummary;
  taskLogs: {
    sinceMinutes: number;
    items: TaskLogRecord[];
    summary: TaskLogsSummary;
  };
}

type ClassificationWindow = "1h" | "24h" | "7d";
type QualityTab = "overview" | "classification";

interface ClassificationQualitySummary {
  window: ClassificationWindow;
  from: string;
  to: string;
  totalItems: number;
  methodDistribution: {
    group: "llm_embedding_rerank" | "rule_fallback";
    count: number;
    share: number;
  }[];
  confidenceHistogram: {
    bucket: string;
    min: number;
    max: number;
    count: number;
  }[];
  confidenceTrend: {
    bucketStart: string;
    total: number;
    avgConfidence: number | null;
    lowConfidenceCount: number;
  }[];
  lowConfidenceSources: {
    sourceId: string;
    sourceName: string;
    sourceUrl: string;
    total: number;
    lowConfidenceCount: number;
    lowConfidenceRate: number;
    avgConfidence: number | null;
  }[];
  latencyPercentiles: {
    llm: {
      sampleSize: number;
      p50Ms: number | null;
      p95Ms: number | null;
      p99Ms: number | null;
    };
    embedding: {
      sampleSize: number;
      p50Ms: number | null;
      p95Ms: number | null;
      p99Ms: number | null;
    };
    rerank: {
      sampleSize: number;
      p50Ms: number | null;
      p95Ms: number | null;
      p99Ms: number | null;
    };
  };
  categoryGate: {
    reject: number;
    penalized: number;
    total: number;
    rejectRate: number;
    penalizedRate: number;
  };
  sourceCategoryBreakdown: {
    sourceType: "authoritative" | "blog" | "unknown";
    categoryPrefix: string;
    count: number;
  }[];
  pendingReviewCount: number;
  alertStatus: {
    stage: "llm" | "embedding" | "rerank";
    thresholdMs: number;
    p95Ms: number | null;
    triggered: boolean;
  }[];
  gateAlertStatus: {
    metric: "reject_rate" | "penalized_rate";
    threshold: number;
    value: number;
    triggered: boolean;
  }[];
  sampling?: {
    classifiedItems: {
      matched: number;
      scanned: number;
      limit: number;
      truncated: boolean;
      coverage: number;
    };
    latencyLogs: {
      matched: number;
      scanned: number;
      limit: number;
      truncated: boolean;
      coverage: number;
    };
    gateLogs: {
      matched: number;
      scanned: number;
      limit: number;
      truncated: boolean;
      coverage: number;
    };
  };
}

interface ClassificationSourceItemsResponse {
  sourceId: string;
  from: string;
  to: string;
  items: {
    processedItemId: string;
    itemMetaId: string | null;
    articleUrl: string | null;
    articleTitle: string | null;
    articleSummary: string | null;
    categoryPath: string | null;
    confidence: number | null;
    method: string | null;
    createdAt: string;
  }[];
  nextCursor: string | null;
}

interface ClassificationReviewItem {
  id: string;
  evidenceId: string | null;
  processedItemId: string | null;
  itemMetaId: string | null;
  sourceId: string | null;
  sourceType: string | null;
  articleUrl: string | null;
  articleTitle: string | null;
  articleSummary: string | null;
  predictedCategoryPath: string | null;
  predictedLegacyCategory: string | null;
  predictedConfidence: number | null;
  predictedMethod: string | null;
  candidatePaths: {
    path?: string;
    score?: number;
    legacy_category?: string | null;
    reason?: string | null;
  }[];
  status: "pending" | "approved" | "rejected" | "corrected";
  correctedCategoryPath: string | null;
  note: string | null;
  quickTags: string[];
  reviewerId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const msToSeconds = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(value / 100) / 10
    : undefined;

const toPercent = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 1000) / 10
    : undefined;

function extractErrorSummary(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const message =
      typeof record.message === "string" ? record.message.trim() : "";
    if (name && message) {
      return `${name}: ${message}`;
    }
    if (message) {
      return message;
    }
    if (name) {
      return name;
    }
    try {
      const json = JSON.stringify(record);
      return json.length > 0 ? json : null;
    } catch {
      return "Unknown error";
    }
  }
  return String(error);
}

export function QualityContent() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { data: session, status } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const canView = session?.permissions?.includes("settings.manage") ?? false;
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [classificationLoading, setClassificationLoading] = useState(false);
  const overviewLoadingRef = useRef(false);
  const classificationLoadingRef = useRef(false);
  const [pipeline, setPipeline] = useState<PipelineQualitySummary | null>(null);
  const [sources, setSources] = useState<NewsSourceQualitySummary | null>(null);
  const [classification, setClassification] =
    useState<ClassificationQualitySummary | null>(null);
  const [activeTab, setActiveTab] = useState<QualityTab>("overview");
  const [overviewLoaded, setOverviewLoaded] = useState(false);
  const [classificationLoaded, setClassificationLoaded] = useState(false);
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [classificationWindow, setClassificationWindow] =
    useState<ClassificationWindow>("24h");
  const [classificationFilterSourceId, setClassificationFilterSourceId] =
    useState<string | null>(null);
  const [
    classificationFilterCategoryPrefix,
    setClassificationFilterCategoryPrefix,
  ] = useState<string | null>(null);
  const [classificationDrilldownSourceId, setClassificationDrilldownSourceId] =
    useState<string | null>(null);
  const [
    classificationDrilldownSourceName,
    setClassificationDrilldownSourceName,
  ] = useState<string | null>(null);
  const [classificationSourceItems, setClassificationSourceItems] = useState<
    ClassificationSourceItemsResponse["items"]
  >([]);
  const [classificationSourceItemsCursor, setClassificationSourceItemsCursor] =
    useState<string | null>(null);
  const [
    classificationSourceItemsLoading,
    setClassificationSourceItemsLoading,
  ] = useState(false);
  const [classificationReviewQueue, setClassificationReviewQueue] = useState<
    ClassificationReviewItem[]
  >([]);
  const [classificationReviewOnlyPending, setClassificationReviewOnlyPending] =
    useState(true);
  const [classificationSelectedReviewIds, setClassificationSelectedReviewIds] =
    useState<string[]>([]);
  const [classificationReviewSubmitting, setClassificationReviewSubmitting] =
    useState(false);
  const [taskLogs, setTaskLogs] = useState<TaskLogRecord[]>([]);
  const [taskLogsSummary, setTaskLogsSummary] =
    useState<TaskLogsSummary | null>(null);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(30);
  const [liveUpdatesEnabled, setLiveUpdatesEnabled] = useState(true);
  const [liveStatus, setLiveStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [, setLiveLastEventAt] = useState<string | null>(null);
  const [liveLastEvent, setLiveLastEvent] = useState<QualityLiveEvent | null>(
    null,
  );
  const [liveEventCount, setLiveEventCount] = useState(0);
  const [liveEventCountsBySource, setLiveEventCountsBySource] = useState<
    Record<LiveEventSource, number>
  >(() => createEmptyLiveEventCounts());
  const [liveDirtySources, setLiveDirtySources] = useState<
    Record<LiveEventSource, boolean>
  >(() => createEmptyLiveDirtySources());
  const [liveRefreshSources, setLiveRefreshSources] = useState<
    Record<LiveEventSource, boolean>
  >(() => createDefaultLiveRefreshSources());
  const liveRefreshSourcesRef = useRef(liveRefreshSources);
  const liveRefreshTimerRef = useRef<number | null>(null);
  const liveSocketRef = useRef<Socket | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const pendingOverviewLoadRef = useRef<{ silent: boolean } | null>(null);
  const pendingClassificationLoadRef = useRef<{ silent: boolean } | null>(null);
  const overviewRequestKeyRef = useRef("");
  const classificationRequestKeyRef = useRef("");
  const screens = Grid.useBreakpoint();
  const loading =
    activeTab === "classification" ? classificationLoading : overviewLoading;
  const dirtyLiveSources = useMemo(
    () => LIVE_EVENT_SOURCES.filter((source) => liveDirtySources[source]),
    [liveDirtySources],
  );

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken],
  );

  const buildQualityTaskLogsHref = useCallback(
    (overrides?: {
      queue?: string;
      stage?: string;
      status?: TaskLogStatus | "all";
    }) => {
      const now = new Date();
      return buildAdminLogsHref({
        tab: "task",
        query: {
          taskQueue: overrides?.queue?.trim() || undefined,
          taskStage: overrides?.stage?.trim() || undefined,
          taskStatus:
            overrides?.status && overrides.status !== "all"
              ? overrides.status
              : "failed",
          taskStart: new Date(
            now.getTime() - TASK_LOG_SUMMARY_WINDOW_MINUTES * 60 * 1000,
          ).toISOString(),
          taskEnd: now.toISOString(),
          taskPage: 1,
          taskPageSize: 20,
        },
      });
    },
    [],
  );

  const openTaskLogsHref = useMemo(
    () => buildQualityTaskLogsHref({ status: "failed" }),
    [buildQualityTaskLogsHref],
  );

  useEffect(() => {
    liveRefreshSourcesRef.current = liveRefreshSources;
  }, [liveRefreshSources]);

  useEffect(() => {
    overviewRequestKeyRef.current = JSON.stringify({
      windowMinutes,
    });
  }, [windowMinutes]);

  useEffect(() => {
    classificationRequestKeyRef.current = JSON.stringify({
      window: classificationWindow,
      sourceId: classificationFilterSourceId,
      categoryPrefix: classificationFilterCategoryPrefix,
      onlyPending: classificationReviewOnlyPending,
    });
  }, [
    classificationFilterCategoryPrefix,
    classificationFilterSourceId,
    classificationReviewOnlyPending,
    classificationWindow,
  ]);

  const loadOverview = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (overviewLoadingRef.current) {
        const pending = pendingOverviewLoadRef.current;
        pendingOverviewLoadRef.current = {
          silent: pending ? pending.silent && silent : silent,
        };
        return;
      }
      overviewLoadingRef.current = true;
      if (!silent) {
        setOverviewLoading(true);
      }
      try {
        const requestKey = JSON.stringify({
          windowMinutes,
        });
        const overviewResponse = await apiClient.get<QualityOverviewResponse>(
          "admin/quality/overview",
          { params: { windowMinutes } },
        );

        if (overviewRequestKeyRef.current !== requestKey) {
          return;
        }

        setPipeline(overviewResponse.data?.pipeline ?? null);
        setSources(overviewResponse.data?.newsSources ?? null);
        setTaskLogs(
          Array.isArray(overviewResponse.data?.taskLogs?.items)
            ? overviewResponse.data.taskLogs.items
            : [],
        );
        setTaskLogsSummary(overviewResponse.data?.taskLogs?.summary ?? null);
        setOverviewLoaded(true);
        setLiveDirtySources(createEmptyLiveDirtySources());
        setLastUpdatedAt(
          overviewResponse.data?.generatedAt ?? new Date().toISOString(),
        );
      } catch (error) {
        captureClientError("Failed to load quality overview", error);
        if (!silent) {
          messageApi.error(
            t("quality.errors.loadFailed"),
          );
          setTaskLogsSummary(null);
        }
      } finally {
        if (!silent) {
          setOverviewLoading(false);
        }
        overviewLoadingRef.current = false;
        const pending = pendingOverviewLoadRef.current;
        pendingOverviewLoadRef.current = null;
        if (pending) {
          void loadOverview(pending);
        }
      }
    },
    [apiClient, messageApi, t, windowMinutes],
  );

  const loadClassification = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (classificationLoadingRef.current) {
        const pending = pendingClassificationLoadRef.current;
        pendingClassificationLoadRef.current = {
          silent: pending ? pending.silent && silent : silent,
        };
        return;
      }
      classificationLoadingRef.current = true;
      if (!silent) {
        setClassificationLoading(true);
      }
      try {
        const requestKey = JSON.stringify({
          window: classificationWindow,
          sourceId: classificationFilterSourceId,
          categoryPrefix: classificationFilterCategoryPrefix,
          onlyPending: classificationReviewOnlyPending,
        });
        const classificationParams: Record<string, unknown> = {
          window: classificationWindow,
        };
        if (classificationFilterSourceId) {
          classificationParams.sourceId = classificationFilterSourceId;
        }
        if (classificationFilterCategoryPrefix) {
          classificationParams.categoryPrefix =
            classificationFilterCategoryPrefix;
        }

        const [classificationRes, classificationReviewsRes] = await Promise.all(
          [
            apiClient.get<ClassificationQualitySummary>(
              "admin/quality/classification/summary",
              {
                params: classificationParams,
              },
            ),
            apiClient.get<ClassificationReviewItem[]>(
              "admin/quality/classification/reviews/queue",
              {
                params: {
                  window: classificationWindow,
                  onlyUnreviewed: classificationReviewOnlyPending,
                  limit: 50,
                },
              },
            ),
          ],
        );

        if (classificationRequestKeyRef.current !== requestKey) {
          return;
        }

        setClassification(classificationRes.data ?? null);
        setClassificationReviewQueue(
          Array.isArray(classificationReviewsRes.data)
            ? classificationReviewsRes.data
            : [],
        );
        setClassificationLoaded(true);
        setLastUpdatedAt(new Date().toISOString());
      } catch (error) {
        captureClientError("Failed to load classification quality", error);
        if (!silent) {
          messageApi.error(
            t("quality.classification.errors.loadFailed"),
          );
        }
      } finally {
        if (!silent) {
          setClassificationLoading(false);
        }
        classificationLoadingRef.current = false;
        const pending = pendingClassificationLoadRef.current;
        pendingClassificationLoadRef.current = null;
        if (pending) {
          void loadClassification(pending);
        }
      }
    },
    [
      apiClient,
      classificationFilterCategoryPrefix,
      classificationFilterSourceId,
      classificationReviewOnlyPending,
      classificationWindow,
      messageApi,
      t,
    ],
  );

  const load = useCallback(
    async (options?: { silent?: boolean; tab?: QualityTab }) => {
      const targetTab = options?.tab ?? activeTab;
      if (targetTab === "classification") {
        await loadClassification({ silent: options?.silent });
        return;
      }
      await loadOverview({ silent: options?.silent });
    },
    [activeTab, loadClassification, loadOverview],
  );

  useEffect(() => {
    setClassificationDrilldownSourceId(null);
    setClassificationDrilldownSourceName(null);
    setClassificationSourceItems([]);
    setClassificationSourceItemsCursor(null);
  }, [
    classificationFilterCategoryPrefix,
    classificationFilterSourceId,
    classificationWindow,
  ]);

  useEffect(() => {
    setClassificationSelectedReviewIds([]);
  }, [classificationReviewQueue]);

  const loadClassificationSourceItems = useCallback(
    async (
      sourceId: string,
      sourceName?: string,
      options?: { append?: boolean },
    ) => {
      const normalizedSourceId = sourceId.trim();
      if (!normalizedSourceId) {
        return;
      }

      const append = options?.append === true;
      const nextCursor = append ? classificationSourceItemsCursor : null;
      const params: Record<string, unknown> = {
        window: classificationWindow,
        limit: 20,
      };
      if (nextCursor) {
        params.cursor = nextCursor;
      }

      setClassificationSourceItemsLoading(true);
      try {
        const response = await apiClient.get<ClassificationSourceItemsResponse>(
          `admin/quality/classification/sources/${normalizedSourceId}/items`,
          { params },
        );
        const payload = response.data;
        const nextItems = Array.isArray(payload?.items) ? payload.items : [];
        setClassificationDrilldownSourceId(normalizedSourceId);
        setClassificationDrilldownSourceName(
          sourceName?.trim() ? sourceName.trim() : normalizedSourceId,
        );
        setClassificationSourceItems((prev) => {
          if (!append) {
            return nextItems;
          }
          const seen = new Set(prev.map((entry) => entry.processedItemId));
          const merged = prev.slice();
          for (const item of nextItems) {
            if (!seen.has(item.processedItemId)) {
              merged.push(item);
            }
          }
          return merged;
        });
        setClassificationSourceItemsCursor(
          typeof payload?.nextCursor === "string" && payload.nextCursor.trim()
            ? payload.nextCursor
            : null,
        );
      } catch (error) {
        captureClientError("Failed to load classification source items", error);
        messageApi.error(
          t("quality.classification.errors.sourceItems"),
        );
      } finally {
        setClassificationSourceItemsLoading(false);
      }
    },
    [
      apiClient,
      classificationSourceItemsCursor,
      classificationWindow,
      messageApi,
      t,
    ],
  );

  const submitClassificationReviewDecision = useCallback(
    async (
      reviewId: string,
      status: "approved" | "rejected" | "corrected",
      correctedCategoryPath?: string,
    ) => {
      const normalizedReviewId = reviewId.trim();
      if (!normalizedReviewId) {
        return;
      }

      setClassificationReviewSubmitting(true);
      try {
        await apiClient.post(
          `admin/quality/classification/reviews/${normalizedReviewId}/decision`,
          {
            status,
            correctedCategoryPath: correctedCategoryPath?.trim()
              ? correctedCategoryPath.trim()
              : undefined,
          },
        );
        messageApi.success(
          t("quality.classification.review.success"),
        );
        await load({ silent: true, tab: "classification" });
      } catch (error) {
        captureClientError(
          "Failed to submit classification review decision",
          error,
        );
        messageApi.error(
          t("quality.classification.review.error"),
        );
      } finally {
        setClassificationReviewSubmitting(false);
      }
    },
    [apiClient, load, messageApi, t],
  );

  const submitClassificationBatchDecision = useCallback(
    async (
      status: "approved" | "rejected" | "corrected",
      correctedCategoryPath?: string,
    ) => {
      if (classificationSelectedReviewIds.length === 0) {
        return;
      }
      setClassificationReviewSubmitting(true);
      try {
        await apiClient.post("admin/quality/classification/reviews/batch", {
          reviewIds: classificationSelectedReviewIds,
          status,
          correctedCategoryPath: correctedCategoryPath?.trim()
            ? correctedCategoryPath.trim()
            : undefined,
        });
        messageApi.success(
          t("quality.classification.review.batchSuccess"),
        );
        setClassificationSelectedReviewIds([]);
        await load({ silent: true, tab: "classification" });
      } catch (error) {
        captureClientError(
          "Failed to submit classification batch decision",
          error,
        );
        messageApi.error(
          t("quality.classification.review.batchError"),
        );
      } finally {
        setClassificationReviewSubmitting(false);
      }
    },
    [apiClient, classificationSelectedReviewIds, load, messageApi, t],
  );

  useEffect(() => {
    if (!canView) {
      return;
    }
    if (activeTab === "overview" && !overviewLoaded) {
      void load({ tab: "overview" });
      return;
    }
    if (activeTab === "classification" && !classificationLoaded) {
      void load({ tab: "classification" });
    }
  }, [activeTab, canView, classificationLoaded, load, overviewLoaded]);

  useEffect(() => {
    if (!canView || activeTab !== "overview" || !overviewLoaded) {
      return;
    }
    void load({ silent: true, tab: "overview" });
  }, [activeTab, canView, load, windowMinutes]);

  useEffect(() => {
    if (!canView || activeTab !== "classification" || !classificationLoaded) {
      return;
    }
    void load({ silent: true, tab: "classification" });
  }, [
    activeTab,
    canView,
    classificationFilterCategoryPrefix,
    classificationFilterSourceId,
    classificationReviewOnlyPending,
    classificationWindow,
    load,
  ]);

  useEffect(() => {
    if (!canView || !autoRefreshEnabled) {
      return;
    }
    const intervalMs = Math.max(5, Math.min(300, autoRefreshSeconds)) * 1000;
    const id = window.setInterval(() => {
      void load({ silent: true, tab: activeTab });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [activeTab, autoRefreshEnabled, autoRefreshSeconds, canView, load]);

  const scheduleLiveRefresh = useCallback(() => {
    if (liveRefreshTimerRef.current) {
      return;
    }
    liveRefreshTimerRef.current = window.setTimeout(() => {
      liveRefreshTimerRef.current = null;
      void loadOverview({ silent: true });
    }, 1200);
  }, [loadOverview]);

  const resetLiveCounters = useCallback(() => {
    setLiveEventCount(0);
    setLiveEventCountsBySource(createEmptyLiveEventCounts());
    setLiveLastEventAt(null);
    setLiveLastEvent(null);
  }, []);

  useEffect(() => {
    if (!canView || !liveUpdatesEnabled || !session?.accessToken) {
      setLiveStatus("disconnected");
      return;
    }

    setLiveStatus("connecting");
    setLiveError(null);

    const socket = io(`${env.apiRoot}/quality`, {
      auth: { token: session.accessToken },
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
    };
    const handleDisconnect = () => setLiveStatus("disconnected");
    const getLocalizedError = (
      payload:
        | { code?: string; message?: string; retryAfterMs?: number }
        | undefined,
      fallbackKind: "socket" | "connect",
    ) =>
      formatRealtimeSocketError(payload, t, {
        keyPrefix: "quality.liveUpdates.connectionError",
        fallbackKind,
        defaults: {
          unauthorized:
            "Quality realtime access expired. Please sign in again.",
          tooManyConnections:
            "Quality realtime connections are at capacity. Please try again later.",
          tooManyConnectionAttempts:
            "Too many quality realtime connection attempts. Please try again later.",
          rateLimitExceeded:
            "Quality realtime connection attempts are too frequent. Please try again later.",
          tooManyFailedAttempts:
            "Too many failed quality realtime sign-in attempts. Please try again later.",
          timeout: "Connecting to quality realtime timed out. Please try again.",
          network:
            "Unable to connect to quality realtime. Please check the network and try again.",
          connect:
            "Unable to connect to quality realtime right now. Please try again later.",
          socket:
            "Quality realtime connection is unstable. Please try again later.",
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
      const timestamp =
        typeof record.timestamp === "string"
          ? record.timestamp
          : new Date().toISOString();

      setLiveLastEvent({ orgId, source, event, jobId, timestamp });
      setLiveLastEventAt(timestamp);
      setLiveEventCount((prev) => prev + 1);
      setLiveEventCountsBySource((prev) => ({
        ...prev,
        [source]: (prev[source] ?? 0) + 1,
      }));

      if (event !== "PROGRESS") {
        if (liveRefreshSourcesRef.current[source]) {
          scheduleLiveRefresh();
        } else {
          setLiveDirtySources((prev) =>
            prev[source]
              ? prev
              : {
                  ...prev,
                  [source]: true,
                },
          );
        }
      }
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("quality:error", handleServerError);
    socket.on("quality:event", handleEvent);

    return () => {
      window.clearTimeout(connectTimer);
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("quality:error", handleServerError);
      socket.off("quality:event", handleEvent);
      socket.disconnect();
      if (liveSocketRef.current === socket) {
        liveSocketRef.current = null;
      }
      if (liveRefreshTimerRef.current) {
        window.clearTimeout(liveRefreshTimerRef.current);
        liveRefreshTimerRef.current = null;
      }
      pendingOverviewLoadRef.current = null;
      pendingClassificationLoadRef.current = null;
    };
  }, [canView, liveUpdatesEnabled, scheduleLiveRefresh, session?.accessToken]);

  const failureColumns: ColumnsType<
    PipelineQualitySummary["failureTypes"][number]
  > = [
    {
      title: t("quality.columns.stage"),
      dataIndex: "stage",
      key: "stage",
    },
    {
      title: t("quality.columns.error"),
      dataIndex: "errorName",
      key: "errorName",
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: t("quality.columns.count"),
      dataIndex: "count",
      key: "count",
    },
  ];

  const llmColumns: ColumnsType<
    NonNullable<PipelineQualitySummary["llmModels"]>[number]
  > = [
    {
      title: t("quality.llm.columns.model"),
      dataIndex: "model",
      key: "model",
      render: (value: string) => (
        <Typography.Text code copyable>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: t("quality.llm.columns.count"),
      dataIndex: "count",
      key: "count",
      width: 120,
    },
    {
      title: t("quality.llm.columns.avgLatency"),
      dataIndex: "avgLatencyMs",
      key: "avgLatencyMs",
      render: (value: number | null) =>
        typeof value === "number" ? `${msToSeconds(value)}s` : "-",
    },
    {
      title: t("quality.llm.columns.avgCost"),
      dataIndex: "avgCostUsd",
      key: "avgCostUsd",
      render: (value: number | null) =>
        typeof value === "number" ? `$${value.toFixed(3)}` : "-",
    },
    {
      title: t("quality.llm.columns.avgTokens"),
      dataIndex: "avgTotalTokens",
      key: "avgTotalTokens",
      render: (value: number | null) =>
        typeof value === "number" ? Math.round(value) : "-",
    },
  ];

  const taskLogStatusColors: Record<TaskLogStatus, string> = {
    pending: "gold",
    processing: "blue",
    completed: "green",
    failed: "red",
  };

  const taskLogColumns: ColumnsType<TaskLogRecord> = [
    {
      title: t("quality.taskLogs.columns.time"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => {
        const parsed = new Date(value);
        return (
          <Typography.Text type="secondary">
            {Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()}
          </Typography.Text>
        );
      },
    },
    {
      title: t("quality.taskLogs.columns.queue"),
      dataIndex: "queue",
      key: "queue",
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: t("quality.taskLogs.columns.stage"),
      dataIndex: "stage",
      key: "stage",
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: t("quality.taskLogs.columns.status"),
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (value: TaskLogStatus) => (
        <Tag color={taskLogStatusColors[value]}>{value}</Tag>
      ),
    },
    {
      title: t("quality.taskLogs.columns.message"),
      dataIndex: "message",
      key: "message",
      render: (_: unknown, record) => {
        const fallback = extractErrorSummary(record.error);
        const text = record.message?.trim() ? record.message.trim() : fallback;
        return (
          <Typography.Text
            type={record.status === "failed" ? "danger" : undefined}
            ellipsis={{ tooltip: text ?? "-" }}
          >
            {text ?? "-"}
          </Typography.Text>
        );
      },
    },
    {
      title: t("quality.taskLogs.columns.jobId"),
      dataIndex: "jobId",
      key: "jobId",
      width: 220,
      render: (value: string) => (
        <Typography.Text code copyable ellipsis={{ tooltip: value }}>
          {value}
        </Typography.Text>
      ),
    },
  ];

  const taskLogTopErrorColumns: ColumnsType<
    TaskLogsSummary["topErrors"][number]
  > = [
    {
      title: t("quality.taskLogs.summary.columns.queue"),
      dataIndex: "queue",
      key: "queue",
      render: (value: string, record) => (
        <Tag>
          <a
            href={buildQualityTaskLogsHref({
              queue: record.queue,
              status: "failed",
            })}
          >
            {value}
          </a>
        </Tag>
      ),
    },
    {
      title: t("quality.taskLogs.summary.columns.stage"),
      dataIndex: "stage",
      key: "stage",
      render: (value: string, record) => (
        <Tag>
          <a
            href={buildQualityTaskLogsHref({
              queue: record.queue,
              stage: record.stage,
              status: "failed",
            })}
          >
            {value}
          </a>
        </Tag>
      ),
    },
    {
      title: t("quality.taskLogs.summary.columns.error"),
      dataIndex: "errorName",
      key: "errorName",
      render: (value: string) => <Tag color="red">{value}</Tag>,
    },
    {
      title: t("quality.taskLogs.summary.columns.count"),
      dataIndex: "count",
      key: "count",
      width: 120,
    },
    {
      title: t("quality.taskLogs.summary.columns.sample"),
      dataIndex: "sampleMessage",
      key: "sampleMessage",
      render: (value: string | null) => (
        <Typography.Text type="secondary" ellipsis={{ tooltip: value ?? "-" }}>
          {value ?? "-"}
        </Typography.Text>
      ),
    },
  ];

  const sourceColumns: ColumnsType<
    NewsSourceQualitySummary["topFailingSources"][number]
  > = [
    {
      title: t("quality.sources.columns.name"),
      dataIndex: "name",
      key: "name",
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" ellipsis={{ tooltip: record.url }}>
            {record.url}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("quality.sources.columns.failedJobs"),
      dataIndex: "failedJobs",
      key: "failedJobs",
    },
    {
      title: t("quality.sources.columns.streak"),
      dataIndex: "consecutiveFailures",
      key: "consecutiveFailures",
    },
    {
      title: t("quality.sources.columns.circuit"),
      dataIndex: "circuitOpenUntil",
      key: "circuitOpenUntil",
      render: (value: string | null) =>
        value ? (
          <Tag color="orange">
            {t("quality.sources.circuitOpen")}
          </Tag>
        ) : (
          <Tag>OK</Tag>
        ),
    },
  ];

  const histogramMax = useMemo(() => {
    if (!classification || classification.confidenceHistogram.length === 0) {
      return 0;
    }
    return classification.confidenceHistogram.reduce(
      (max, entry) => Math.max(max, entry.count),
      0,
    );
  }, [classification]);

  const classificationMethodColumns: ColumnsType<
    ClassificationQualitySummary["methodDistribution"][number]
  > = [
    {
      title: t("quality.classification.methods.columns.group"),
      dataIndex: "group",
      key: "group",
      render: (value: "llm_embedding_rerank" | "rule_fallback") => (
        <Tag color={value === "llm_embedding_rerank" ? "blue" : "gold"}>
          {value === "llm_embedding_rerank"
            ? "LLM + Embedding + Rerank"
            : "Rule / Fallback"}
        </Tag>
      ),
    },
    {
      title: t("quality.classification.methods.columns.count"),
      dataIndex: "count",
      key: "count",
      width: 120,
    },
    {
      title: t("quality.classification.methods.columns.share"),
      dataIndex: "share",
      key: "share",
      width: 160,
      render: (value: number) => `${toPercent(value) ?? 0}%`,
    },
  ];

  const classificationHistogramColumns: ColumnsType<
    ClassificationQualitySummary["confidenceHistogram"][number]
  > = [
    {
      title: t("quality.classification.histogram.columns.bucket"),
      dataIndex: "bucket",
      key: "bucket",
      width: 160,
    },
    {
      title: t("quality.classification.histogram.columns.count"),
      dataIndex: "count",
      key: "count",
      width: 120,
    },
    {
      title: t("quality.classification.histogram.columns.distribution"),
      key: "distribution",
      render: (_, record) => (
        <Progress
          percent={
            histogramMax > 0
              ? Math.round((record.count / histogramMax) * 1000) / 10
              : 0
          }
          size="small"
          showInfo={false}
          strokeColor={token.colorPrimary}
        />
      ),
    },
  ];

  const classificationTrendColumns: ColumnsType<
    ClassificationQualitySummary["confidenceTrend"][number]
  > = [
    {
      title: t("quality.classification.trend.columns.time"),
      dataIndex: "bucketStart",
      key: "bucketStart",
      render: (value: string) => {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
      },
    },
    {
      title: t("quality.classification.trend.columns.total"),
      dataIndex: "total",
      key: "total",
      width: 100,
    },
    {
      title: t("quality.classification.trend.columns.avgConfidence"),
      dataIndex: "avgConfidence",
      key: "avgConfidence",
      width: 150,
      render: (value: number | null) =>
        typeof value === "number" ? value.toFixed(3) : "-",
    },
    {
      title: t("quality.classification.trend.columns.lowConfidence"),
      dataIndex: "lowConfidenceCount",
      key: "lowConfidenceCount",
      width: 150,
    },
  ];

  const classificationLowSourceColumns: ColumnsType<
    ClassificationQualitySummary["lowConfidenceSources"][number]
  > = [
    {
      title: t("quality.classification.sources.columns.source"),
      dataIndex: "sourceName",
      key: "sourceName",
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Button
            type="link"
            style={{ padding: 0, height: "auto" }}
            onClick={() => setClassificationFilterSourceId(record.sourceId)}
          >
            {record.sourceName}
          </Button>
          <Typography.Text
            type="secondary"
            ellipsis={{ tooltip: record.sourceUrl || record.sourceId }}
          >
            {record.sourceUrl || record.sourceId}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("quality.classification.sources.columns.lowCount"),
      dataIndex: "lowConfidenceCount",
      key: "lowConfidenceCount",
      width: 140,
    },
    {
      title: t("quality.classification.sources.columns.total"),
      dataIndex: "total",
      key: "total",
      width: 100,
    },
    {
      title: t("quality.classification.sources.columns.lowRate"),
      dataIndex: "lowConfidenceRate",
      key: "lowConfidenceRate",
      width: 120,
      render: (value: number) => `${toPercent(value) ?? 0}%`,
    },
    {
      title: t("quality.classification.sources.columns.avg"),
      dataIndex: "avgConfidence",
      key: "avgConfidence",
      width: 140,
      render: (value: number | null) =>
        typeof value === "number" ? value.toFixed(3) : "-",
    },
    {
      title: t("quality.classification.sources.columns.actions"),
      key: "actions",
      width: 140,
      render: (_, record) => (
        <Button
          size="small"
          onClick={() =>
            void loadClassificationSourceItems(
              record.sourceId,
              record.sourceName,
            )
          }
        >
          {t("quality.classification.sources.actions.drilldown")}
        </Button>
      ),
    },
  ];

  const classificationSourceItemColumns: ColumnsType<
    ClassificationSourceItemsResponse["items"][number]
  > = [
    {
      title: t("quality.classification.drilldown.columns.time"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
      },
    },
    {
      title: t("quality.classification.drilldown.columns.title"),
      dataIndex: "articleTitle",
      key: "articleTitle",
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          {record.articleUrl ? (
            <Typography.Link
              href={record.articleUrl}
              target="_blank"
              rel="noreferrer"
            >
              {record.articleTitle || record.articleUrl}
            </Typography.Link>
          ) : (
            <Typography.Text>{record.articleTitle || "-"}</Typography.Text>
          )}
          {record.articleSummary ? (
            <Typography.Text
              type="secondary"
              ellipsis={{ tooltip: record.articleSummary }}
            >
              {record.articleSummary}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("quality.classification.drilldown.columns.path"),
      dataIndex: "categoryPath",
      key: "categoryPath",
      width: 180,
      render: (value: string | null) => <Tag>{value || "unknown"}</Tag>,
    },
    {
      title: t("quality.classification.drilldown.columns.confidence"),
      dataIndex: "confidence",
      key: "confidence",
      width: 120,
      render: (value: number | null) =>
        typeof value === "number" ? value.toFixed(3) : "-",
    },
    {
      title: t("quality.classification.drilldown.columns.method"),
      dataIndex: "method",
      key: "method",
      width: 150,
      render: (value: string | null) => <Tag>{value || "unknown"}</Tag>,
    },
  ];

  const classificationSourceCategoryColumns: ColumnsType<
    ClassificationQualitySummary["sourceCategoryBreakdown"][number]
  > = [
    {
      title: t("quality.classification.sourceCategory.columns.sourceType"),
      dataIndex: "sourceType",
      key: "sourceType",
      width: 140,
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: t("quality.classification.sourceCategory.columns.categoryPrefix"),
      dataIndex: "categoryPrefix",
      key: "categoryPrefix",
      render: (value: string) => (
        <Button
          type="link"
          style={{ padding: 0, height: "auto" }}
          onClick={() => setClassificationFilterCategoryPrefix(value)}
        >
          {value}
        </Button>
      ),
    },
    {
      title: t("quality.classification.sourceCategory.columns.count"),
      dataIndex: "count",
      key: "count",
      width: 120,
    },
  ];

  const classificationReviewStatusColors: Record<
    ClassificationReviewItem["status"],
    string
  > = {
    pending: "gold",
    approved: "green",
    rejected: "red",
    corrected: "blue",
  };

  const classificationReviewColumns: ColumnsType<ClassificationReviewItem> = [
    {
      title: t("quality.classification.review.columns.time"),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
      },
    },
    {
      title: t("quality.classification.review.columns.article"),
      key: "article",
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          {record.articleUrl ? (
            <Typography.Link
              href={record.articleUrl}
              target="_blank"
              rel="noreferrer"
            >
              {record.articleTitle || record.articleUrl}
            </Typography.Link>
          ) : (
            <Typography.Text>{record.articleTitle || "-"}</Typography.Text>
          )}
          {record.articleSummary ? (
            <Typography.Text
              type="secondary"
              ellipsis={{ tooltip: record.articleSummary }}
            >
              {record.articleSummary}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t("quality.classification.review.columns.predicted"),
      key: "predicted",
      width: 220,
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Tag>{record.predictedCategoryPath || "unknown"}</Tag>
          <Typography.Text type="secondary">
            {typeof record.predictedConfidence === "number"
              ? record.predictedConfidence.toFixed(3)
              : "-"}
            {" · "}
            {record.predictedMethod || "unknown"}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t("quality.classification.review.columns.candidates"),
      key: "candidates",
      width: 280,
      render: (_, record) => (
        <Space wrap>
          {record.candidatePaths.slice(0, 3).map((candidate, index) => (
            <Tag key={`${record.id}-candidate-${index}`}>
              {(candidate.path || "unknown").slice(0, 48)}
              {typeof candidate.score === "number"
                ? ` (${candidate.score.toFixed(2)})`
                : ""}
            </Tag>
          ))}
          {record.candidatePaths.length === 0 ? "-" : null}
        </Space>
      ),
    },
    {
      title: t("quality.classification.review.columns.status"),
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (value: ClassificationReviewItem["status"]) => (
        <Tag color={classificationReviewStatusColors[value]}>{value}</Tag>
      ),
    },
    {
      title: t("quality.classification.review.columns.actions"),
      key: "actions",
      width: 250,
      render: (_, record) => (
        <Space wrap>
          <Button
            size="small"
            onClick={() =>
              void submitClassificationReviewDecision(record.id, "approved")
            }
            loading={classificationReviewSubmitting}
          >
            {t("quality.classification.review.actions.approve")}
          </Button>
          <Button
            size="small"
            danger
            onClick={() =>
              void submitClassificationReviewDecision(record.id, "rejected")
            }
            loading={classificationReviewSubmitting}
          >
            {t("quality.classification.review.actions.reject")}
          </Button>
          <Button
            size="small"
            type="dashed"
            onClick={() => {
              const correctedPath = window.prompt(
                t("quality.classification.review.correct.prompt"),
                record.predictedCategoryPath || "",
              );
              if (!correctedPath || !correctedPath.trim()) {
                return;
              }
              void submitClassificationReviewDecision(
                record.id,
                "corrected",
                correctedPath,
              );
            }}
            loading={classificationReviewSubmitting}
          >
            {t("quality.classification.review.actions.correct")}
          </Button>
        </Space>
      ),
    },
  ];

  const livePopoverContent = (
    <div style={{ maxWidth: 420 }}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        {liveError ? (
          <Alert
            type="error"
            showIcon
            message={t("quality.liveUpdates.error")}
            description={liveError}
          />
        ) : null}

        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">
            {t("quality.liveUpdates.details.lastEvent")}
          </Typography.Text>
          {liveLastEvent ? (
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              <Space wrap>
                <Tag>{liveLastEvent.source}</Tag>
                <Tag color="blue">{liveLastEvent.event}</Tag>
              </Space>
              {liveLastEvent.jobId ? (
                <Typography.Text
                  code
                  copyable
                  ellipsis={{ tooltip: liveLastEvent.jobId }}
                >
                  {liveLastEvent.jobId}
                </Typography.Text>
              ) : null}
              <Typography.Text type="secondary">
                {new Date(liveLastEvent.timestamp).toLocaleString()}
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">
              {t("common.noData")}
            </Typography.Text>
          )}
        </Space>

        <Divider style={{ margin: "4px 0" }} />

        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("quality.liveUpdates.details.refreshOn")}
          </Typography.Text>
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            {LIVE_EVENT_SOURCES.map((source) => (
              <div
                key={source}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <Checkbox
                  checked={liveRefreshSources[source]}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setLiveRefreshSources((prev) => ({
                      ...prev,
                      [source]: checked,
                    }));
                    if (checked && liveDirtySources[source]) {
                      scheduleLiveRefresh();
                    }
                  }}
                >
                  {source}
                </Checkbox>
                <Typography.Text type="secondary">
                  {liveEventCountsBySource[source]}
                </Typography.Text>
              </div>
            ))}
          </Space>
          <Space>
            <Button size="small" onClick={resetLiveCounters}>
              {t("quality.liveUpdates.details.resetCounters")}
            </Button>
          </Space>
        </Space>
      </Space>
    </div>
  );

  if (status === "loading") {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (!canView) {
    return (
      <Card
        className="content-card"
        title={t("quality.title")}
      >
        <Alert
          type="warning"
          message={t("settings.adminOnly.title")}
          description={t("settings.adminOnly.description")}
        />
      </Card>
    );
  }

  return (
    <>
      {contextHolder}
      <div className="flex flex-col gap-6">
        <Space
          direction={screens.md ? "horizontal" : "vertical"}
          style={{ width: "100%", justifyContent: "space-between" }}
        >
          <Space direction="vertical" size={2}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t("quality.title")}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t("quality.subtitle")}
            </Typography.Text>
          </Space>
          <Space>
            <Select
              value={windowMinutes}
              onChange={(value) => setWindowMinutes(value)}
              options={[
                {
                  value: 60,
                  label: t("quality.windows.60m"),
                },
                {
                  value: 240,
                  label: t("quality.windows.4h"),
                },
                {
                  value: 1440,
                  label: t("quality.windows.24h"),
                },
              ]}
              style={{ minWidth: 160 }}
            />
            <Button onClick={() => void load()} loading={loading}>
              {t("common.refresh")}
            </Button>
            <Space size={6} wrap>
              <Typography.Text type="secondary">
                {t("quality.autoRefresh.label")}
              </Typography.Text>
              <Switch
                checked={autoRefreshEnabled}
                onChange={(checked) => setAutoRefreshEnabled(checked)}
              />
              <InputNumber
                min={5}
                max={300}
                step={5}
                value={autoRefreshSeconds}
                onChange={(value) =>
                  setAutoRefreshSeconds(typeof value === "number" ? value : 30)
                }
                style={{ width: 88 }}
              />
              <Typography.Text type="secondary">s</Typography.Text>
            </Space>
            <Space size={6} wrap>
              <Typography.Text type="secondary">
                {t("quality.liveUpdates.label")}
              </Typography.Text>
              <Switch
                checked={liveUpdatesEnabled}
                onChange={(checked) => setLiveUpdatesEnabled(checked)}
              />
              {liveUpdatesEnabled ? (
                <Popover
                  content={livePopoverContent}
                  trigger="click"
                  placement="bottomRight"
                >
                  <Tag
                    style={{ cursor: "pointer" }}
                    color={
                      liveError
                        ? "red"
                        : liveStatus === "connected"
                          ? "green"
                          : liveStatus === "connecting"
                            ? "blue"
                            : undefined
                    }
                  >
                    {liveError
                      ? t("quality.liveUpdates.error")
                      : liveStatus === "connected"
                        ? t("quality.liveUpdates.connected")
                        : liveStatus === "connecting"
                          ? t("quality.liveUpdates.connecting")
                          : t("quality.liveUpdates.disconnected")}
                    {liveStatus === "connected" && liveEventCount > 0
                      ? ` · ${liveEventCount}`
                      : ""}
                  </Tag>
                </Popover>
              ) : null}
            </Space>
          </Space>
        </Space>

        {lastUpdatedAt ? (
          <Typography.Text type="secondary">
            {t("quality.updatedAt", {
              time: new Date(lastUpdatedAt).toLocaleString(),
            })}
          </Typography.Text>
        ) : null}

        {dirtyLiveSources.length > 0 ? (
          <Alert
            showIcon
            type="info"
            message={t("quality.liveUpdates.stale.title")}
            description={t("quality.liveUpdates.stale.description", {
              sources: dirtyLiveSources.join(", "),
            })}
            action={
              <Button size="small" onClick={() => void load()}>
                {t("common.refresh")}
              </Button>
            }
          />
        ) : null}

        <Tabs
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as QualityTab)}
        >
          <Tabs.TabPane
            tab={t("quality.tabs.overview")}
            key="overview"
          >
            <Space direction="vertical" style={{ width: "100%" }} size="large">
              <Card
                className="content-card"
                title={t("quality.pipeline.title")}
                loading={loading}
              >
                {pipeline ? (
                  <Space
                    direction="vertical"
                    size="small"
                    style={{ display: "flex" }}
                  >
                    <Row gutter={[16, 16]}>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.total")}
                          value={pipeline.totals.total}
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.completed")}
                          value={pipeline.totals.completed}
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.failed")}
                          value={pipeline.totals.failed}
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.successRate")}
                          value={
                            pipeline.successRate !== null
                              ? Math.round(pipeline.successRate * 1000) / 10
                              : undefined
                          }
                          suffix={
                            pipeline.successRate !== null ? "%" : undefined
                          }
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.llmLatency")}
                          value={
                            pipeline.averageLatencyMs !== null
                              ? Math.round(pipeline.averageLatencyMs / 100) / 10
                              : undefined
                          }
                          suffix={
                            pipeline.averageLatencyMs !== null ? "s" : undefined
                          }
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.ingestP50")}
                          value={msToSeconds(
                            pipeline.ingestionLatencyMs?.p50Ms,
                          )}
                          suffix={
                            pipeline.ingestionLatencyMs?.p50Ms != null
                              ? "s"
                              : undefined
                          }
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.ingestP90")}
                          value={msToSeconds(
                            pipeline.ingestionLatencyMs?.p90Ms,
                          )}
                          suffix={
                            pipeline.ingestionLatencyMs?.p90Ms != null
                              ? "s"
                              : undefined
                          }
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.outboxOldest")}
                          value={pipeline.outbox?.oldestAgeMinutes ?? undefined}
                          suffix={
                            pipeline.outbox?.oldestAgeMinutes != null
                              ? "m"
                              : undefined
                          }
                        />
                      </Col>
                    </Row>

                    {pipeline.outbox ? (
                      <Space wrap>
                        <Tag>
                          {t("quality.pipeline.outbox.pending")}
                          : {pipeline.outbox.totals.pending}
                        </Tag>
                        <Tag>
                          {t("quality.pipeline.outbox.processing")}
                          : {pipeline.outbox.totals.processing}
                        </Tag>
                        <Tag
                          color={
                            pipeline.outbox.totals.failed > 0
                              ? "red"
                              : "default"
                          }
                        >
                          {t("quality.pipeline.outbox.failed")}
                          : {pipeline.outbox.totals.failed}
                        </Tag>
                        <Tag
                          color={
                            pipeline.outbox.totals.dead > 0
                              ? "volcano"
                              : "default"
                          }
                        >
                          {t("quality.pipeline.outbox.dead")}
                          : {pipeline.outbox.totals.dead}
                        </Tag>
                        <Tag
                          color={
                            pipeline.outbox.totals.staleProcessing > 0
                              ? "orange"
                              : "default"
                          }
                        >
                          {t("quality.pipeline.outbox.stale")}
                          : {pipeline.outbox.totals.staleProcessing}
                        </Tag>
                      </Space>
                    ) : null}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">
                    {t("common.empty")}
                  </Typography.Text>
                )}
              </Card>

              <Card
                className="content-card"
                title={t("quality.pipeline.failures")}
                loading={loading}
              >
                <Table
                  rowKey={(row) => `${row.stage}:${row.errorName}`}
                  columns={failureColumns}
                  dataSource={pipeline?.failureTypes ?? []}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  size={screens.md ? "middle" : "small"}
                />
              </Card>

              <Card
                className="content-card"
                title={t("quality.llm.title")}
                loading={loading}
              >
                <Table
                  rowKey="model"
                  columns={llmColumns}
                  dataSource={pipeline?.llmModels ?? []}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  size={screens.md ? "middle" : "small"}
                />
              </Card>

              <Card
                className="content-card"
                title={t("quality.taskLogs.title")}
                loading={loading}
                extra={
                  <Space>
                    <Button href={openTaskLogsHref}>
                      {t("adminLogs.openTaskLogs")}
                    </Button>
                    <Button
                      onClick={() => void load({ tab: "overview" })}
                      loading={loading}
                    >
                      {t("common.refresh")}
                    </Button>
                  </Space>
                }
              >
                <Space
                  direction="vertical"
                  style={{ width: "100%" }}
                  size="middle"
                >
                  <Typography.Paragraph
                    type="secondary"
                    style={{ marginBottom: 0 }}
                  >
                    {t("adminLogs.task.summaryCardDescription")}
                  </Typography.Paragraph>

                  {taskLogsSummary ? (
                    <Space
                      direction="vertical"
                      style={{ width: "100%" }}
                      size="small"
                    >
                      <Row gutter={[16, 16]}>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.total")}
                            value={taskLogsSummary.totals.total}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t(
                              "quality.taskLogs.summary.totals.pending",
                            )}
                            value={taskLogsSummary.totals.pending}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t(
                              "quality.taskLogs.summary.totals.processing",
                            )}
                            value={taskLogsSummary.totals.processing}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t(
                              "quality.taskLogs.summary.totals.completed",
                            )}
                            value={taskLogsSummary.totals.completed}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.failed")}
                            value={taskLogsSummary.totals.failed}
                            valueStyle={
                              taskLogsSummary.totals.failed > 0
                                ? { color: token.colorError }
                                : undefined
                            }
                          />
                        </Col>
                      </Row>

                      {taskLogsSummary.topErrors.length > 0 ? (
                        <Table
                          rowKey={(row) =>
                            `${row.queue}:${row.stage}:${row.errorName}`
                          }
                          columns={taskLogTopErrorColumns}
                          dataSource={taskLogsSummary.topErrors}
                          pagination={{ pageSize: 5, showSizeChanger: false }}
                          size={screens.md ? "middle" : "small"}
                          title={() =>
                            t("quality.taskLogs.summary.title")
                          }
                        />
                      ) : null}
                    </Space>
                  ) : null}

                  <Table
                    rowKey={(row) => row.id}
                    columns={taskLogColumns}
                    dataSource={taskLogs}
                    pagination={false}
                    size={screens.md ? "middle" : "small"}
                    locale={{
                      emptyText: t("adminLogs.task.summary.empty"),
                    }}
                  />
                </Space>
              </Card>

              <Card
                className="content-card"
                title={t("quality.sources.title")}
                loading={loading}
              >
                {sources ? (
                  <Space
                    direction="vertical"
                    style={{ width: "100%" }}
                    size="middle"
                  >
                    <Row gutter={[16, 16]}>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.sources.total")}
                          value={sources.totals.total}
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.sources.active")}
                          value={sources.totals.active}
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.sources.failing")}
                          value={sources.totals.failing}
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.sources.circuitOpen")}
                          value={sources.totals.circuitOpen}
                        />
                      </Col>
                    </Row>
                    <Table
                      rowKey="sourceId"
                      columns={sourceColumns}
                      dataSource={sources.topFailingSources}
                      pagination={{ pageSize: 5, showSizeChanger: false }}
                      size={screens.md ? "middle" : "small"}
                    />
                  </Space>
                ) : (
                  <Typography.Text type="secondary">
                    {t("common.empty")}
                  </Typography.Text>
                )}
              </Card>
            </Space>
          </Tabs.TabPane>

          <Tabs.TabPane
            tab={t("quality.tabs.classification")}
            key="classification"
          >
            <Space direction="vertical" style={{ width: "100%" }} size="large">
              <Card
                className="content-card"
                title={t("quality.classification.title")}
                loading={loading}
              >
                <Space
                  direction="vertical"
                  style={{ width: "100%" }}
                  size="middle"
                >
                  <Space wrap>
                    <Typography.Text type="secondary">
                      {t("quality.classification.window.label")}
                    </Typography.Text>
                    <Select
                      value={classificationWindow}
                      onChange={(value: ClassificationWindow) =>
                        setClassificationWindow(value)
                      }
                      options={[
                        {
                          value: "1h",
                          label: t("quality.classification.window.1h"),
                        },
                        {
                          value: "24h",
                          label: t("quality.classification.window.24h"),
                        },
                        {
                          value: "7d",
                          label: t("quality.classification.window.7d"),
                        },
                      ]}
                      style={{ width: 160 }}
                    />
                    <Button
                      onClick={() => void load({ tab: "classification" })}
                      loading={loading}
                    >
                      {t("common.refresh")}
                    </Button>
                  </Space>

                  {classificationFilterSourceId ||
                  classificationFilterCategoryPrefix ? (
                    <Space wrap>
                      <Typography.Text type="secondary">
                        {t("quality.classification.filters.active")}
                        :
                      </Typography.Text>
                      {classificationFilterSourceId ? (
                        <Tag
                          closable
                          onClose={() => setClassificationFilterSourceId(null)}
                        >
                          {t("quality.classification.filters.source")}
                          : {classificationFilterSourceId}
                        </Tag>
                      ) : null}
                      {classificationFilterCategoryPrefix ? (
                        <Tag
                          closable
                          onClose={() =>
                            setClassificationFilterCategoryPrefix(null)
                          }
                        >
                          {t("quality.classification.filters.category")}
                          : {classificationFilterCategoryPrefix}
                        </Tag>
                      ) : null}
                      <Button
                        size="small"
                        onClick={() => {
                          setClassificationFilterSourceId(null);
                          setClassificationFilterCategoryPrefix(null);
                        }}
                      >
                        {t("quality.classification.filters.clear")}
                      </Button>
                    </Space>
                  ) : null}

                  {classification ? (
                    <>
                      <Row gutter={[16, 16]}>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t("quality.classification.stats.total")}
                            value={classification.totalItems}
                          />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t(
                              "quality.classification.stats.pendingReviews",
                            )}
                            value={classification.pendingReviewCount}
                          />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t(
                              "quality.classification.stats.gateRejectRate",
                            )}
                            value={toPercent(
                              classification.categoryGate.rejectRate,
                            )}
                            suffix="%"
                          />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t(
                              "quality.classification.stats.gatePenalizedRate",
                            )}
                            value={toPercent(
                              classification.categoryGate.penalizedRate,
                            )}
                            suffix="%"
                          />
                        </Col>
                      </Row>
                      {classification.sampling ? (
                        <Space wrap>
                          <Tag
                            color={
                              classification.sampling.classifiedItems.truncated
                                ? "orange"
                                : "green"
                            }
                          >
                            items coverage{" "}
                            {toPercent(
                              classification.sampling.classifiedItems.coverage,
                            ) ?? 0}
                            % ({classification.sampling.classifiedItems.scanned}
                            /{classification.sampling.classifiedItems.matched})
                          </Tag>
                          <Tag
                            color={
                              classification.sampling.latencyLogs.truncated
                                ? "orange"
                                : "green"
                            }
                          >
                            latency logs coverage{" "}
                            {toPercent(
                              classification.sampling.latencyLogs.coverage,
                            ) ?? 0}
                            % ({classification.sampling.latencyLogs.scanned}/
                            {classification.sampling.latencyLogs.matched})
                          </Tag>
                          <Tag
                            color={
                              classification.sampling.gateLogs.truncated
                                ? "orange"
                                : "green"
                            }
                          >
                            gate logs coverage{" "}
                            {toPercent(
                              classification.sampling.gateLogs.coverage,
                            ) ?? 0}
                            % ({classification.sampling.gateLogs.scanned}/
                            {classification.sampling.gateLogs.matched})
                          </Tag>
                        </Space>
                      ) : null}
                      <Table
                        rowKey="group"
                        columns={classificationMethodColumns}
                        dataSource={classification.methodDistribution}
                        pagination={false}
                        size={screens.md ? "middle" : "small"}
                      />
                    </>
                  ) : (
                    <Typography.Text type="secondary">
                      {t("common.empty")}
                    </Typography.Text>
                  )}
                </Space>
              </Card>

              <Row gutter={[16, 16]}>
                <Col xs={24} xl={12}>
                  <Card
                    className="content-card"
                    title={t("quality.classification.histogram.title")}
                    loading={loading}
                  >
                    <Table
                      rowKey={(row) => row.bucket}
                      columns={classificationHistogramColumns}
                      dataSource={classification?.confidenceHistogram ?? []}
                      pagination={false}
                      size={screens.md ? "middle" : "small"}
                    />
                  </Card>
                </Col>
                <Col xs={24} xl={12}>
                  <Card
                    className="content-card"
                    title={t("quality.classification.trend.title")}
                    loading={loading}
                  >
                    <Table
                      rowKey={(row) => row.bucketStart}
                      columns={classificationTrendColumns}
                      dataSource={classification?.confidenceTrend ?? []}
                      pagination={{ pageSize: 10, showSizeChanger: false }}
                      size={screens.md ? "middle" : "small"}
                    />
                  </Card>
                </Col>
              </Row>

              <Card
                className="content-card"
                title={t("quality.classification.latency.title")}
                loading={loading}
              >
                {classification ? (
                  <Space
                    direction="vertical"
                    style={{ width: "100%" }}
                    size="middle"
                  >
                    <Row gutter={[16, 16]}>
                      <Col xs={24} md={8}>
                        <Card size="small" title="LLM">
                          <Space direction="vertical" size={4}>
                            <Typography.Text>
                              p50:{" "}
                              {classification.latencyPercentiles.llm.p50Ms ??
                                "-"}{" "}
                              ms
                            </Typography.Text>
                            <Typography.Text>
                              p95:{" "}
                              {classification.latencyPercentiles.llm.p95Ms ??
                                "-"}{" "}
                              ms
                            </Typography.Text>
                            <Typography.Text>
                              p99:{" "}
                              {classification.latencyPercentiles.llm.p99Ms ??
                                "-"}{" "}
                              ms
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              sample:{" "}
                              {classification.latencyPercentiles.llm.sampleSize}
                            </Typography.Text>
                          </Space>
                        </Card>
                      </Col>
                      <Col xs={24} md={8}>
                        <Card size="small" title="Embedding">
                          <Space direction="vertical" size={4}>
                            <Typography.Text>
                              p50:{" "}
                              {classification.latencyPercentiles.embedding
                                .p50Ms ?? "-"}{" "}
                              ms
                            </Typography.Text>
                            <Typography.Text>
                              p95:{" "}
                              {classification.latencyPercentiles.embedding
                                .p95Ms ?? "-"}{" "}
                              ms
                            </Typography.Text>
                            <Typography.Text>
                              p99:{" "}
                              {classification.latencyPercentiles.embedding
                                .p99Ms ?? "-"}{" "}
                              ms
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              sample:{" "}
                              {
                                classification.latencyPercentiles.embedding
                                  .sampleSize
                              }
                            </Typography.Text>
                          </Space>
                        </Card>
                      </Col>
                      <Col xs={24} md={8}>
                        <Card size="small" title="Rerank">
                          <Space direction="vertical" size={4}>
                            <Typography.Text>
                              p50:{" "}
                              {classification.latencyPercentiles.rerank.p50Ms ??
                                "-"}{" "}
                              ms
                            </Typography.Text>
                            <Typography.Text>
                              p95:{" "}
                              {classification.latencyPercentiles.rerank.p95Ms ??
                                "-"}{" "}
                              ms
                            </Typography.Text>
                            <Typography.Text>
                              p99:{" "}
                              {classification.latencyPercentiles.rerank.p99Ms ??
                                "-"}{" "}
                              ms
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              sample:{" "}
                              {
                                classification.latencyPercentiles.rerank
                                  .sampleSize
                              }
                            </Typography.Text>
                          </Space>
                        </Card>
                      </Col>
                    </Row>
                    <Space wrap>
                      <Tag
                        color={
                          classification.categoryGate.reject > 0
                            ? "red"
                            : "default"
                        }
                      >
                        reject: {classification.categoryGate.reject}
                      </Tag>
                      <Tag
                        color={
                          classification.categoryGate.penalized > 0
                            ? "orange"
                            : "default"
                        }
                      >
                        penalized: {classification.categoryGate.penalized}
                      </Tag>
                      <Tag>total: {classification.categoryGate.total}</Tag>
                      {classification.alertStatus.map((alert) => (
                        <Tag
                          key={alert.stage}
                          color={alert.triggered ? "red" : "green"}
                        >
                          {alert.stage} p95 {alert.p95Ms ?? "-"} /{" "}
                          {alert.thresholdMs} ms
                        </Tag>
                      ))}
                      {classification.gateAlertStatus.map((alert) => (
                        <Tag
                          key={`gate-${alert.metric}`}
                          color={alert.triggered ? "red" : "green"}
                        >
                          {alert.metric} {toPercent(alert.value) ?? 0}% /{" "}
                          {toPercent(alert.threshold) ?? 0}%
                        </Tag>
                      ))}
                    </Space>
                    <Table
                      rowKey={(row) =>
                        `${row.sourceType}:${row.categoryPrefix}`
                      }
                      columns={classificationSourceCategoryColumns}
                      dataSource={classification.sourceCategoryBreakdown}
                      pagination={{ pageSize: 10, showSizeChanger: false }}
                      size={screens.md ? "middle" : "small"}
                      title={() =>
                        t("quality.classification.sourceCategory.title")
                      }
                    />
                  </Space>
                ) : (
                  <Typography.Text type="secondary">
                    {t("common.empty")}
                  </Typography.Text>
                )}
              </Card>

              <Card
                className="content-card"
                title={t("quality.classification.review.title")}
                loading={loading}
              >
                <Space
                  direction="vertical"
                  style={{ width: "100%" }}
                  size="middle"
                >
                  <Space wrap>
                    <Typography.Text type="secondary">
                      {t("quality.classification.review.onlyPending")}
                    </Typography.Text>
                    <Switch
                      checked={classificationReviewOnlyPending}
                      onChange={(checked) =>
                        setClassificationReviewOnlyPending(checked)
                      }
                    />
                    <Button
                      onClick={() => void load({ tab: "classification" })}
                      loading={loading}
                    >
                      {t("common.refresh")}
                    </Button>
                  </Space>
                  <Space wrap>
                    <Button
                      disabled={classificationSelectedReviewIds.length === 0}
                      loading={classificationReviewSubmitting}
                      onClick={() =>
                        void submitClassificationBatchDecision("approved")
                      }
                    >
                      {t("quality.classification.review.batch.approve")}
                    </Button>
                    <Button
                      danger
                      disabled={classificationSelectedReviewIds.length === 0}
                      loading={classificationReviewSubmitting}
                      onClick={() =>
                        void submitClassificationBatchDecision("rejected")
                      }
                    >
                      {t("quality.classification.review.batch.reject")}
                    </Button>
                    <Button
                      type="dashed"
                      disabled={classificationSelectedReviewIds.length === 0}
                      loading={classificationReviewSubmitting}
                      onClick={() => {
                        const correctedPath = window.prompt(
                          t(
                            "quality.classification.review.correct.batchPrompt",
                          ),
                          "",
                        );
                        if (!correctedPath || !correctedPath.trim()) {
                          return;
                        }
                        void submitClassificationBatchDecision(
                          "corrected",
                          correctedPath,
                        );
                      }}
                    >
                      {t("quality.classification.review.batch.correct")}
                    </Button>
                  </Space>
                  <Table
                    rowKey="id"
                    columns={classificationReviewColumns}
                    dataSource={classificationReviewQueue}
                    rowSelection={{
                      selectedRowKeys: classificationSelectedReviewIds,
                      onChange: (keys) =>
                        setClassificationSelectedReviewIds(
                          keys
                            .map((entry) => String(entry))
                            .filter((entry) => entry.length > 0),
                        ),
                    }}
                    pagination={{ pageSize: 10, showSizeChanger: false }}
                    size={screens.md ? "middle" : "small"}
                  />
                </Space>
              </Card>

              <Card
                className="content-card"
                title={t("quality.classification.sources.title")}
                loading={loading}
              >
                <Table
                  rowKey="sourceId"
                  columns={classificationLowSourceColumns}
                  dataSource={classification?.lowConfidenceSources ?? []}
                  pagination={false}
                  size={screens.md ? "middle" : "small"}
                />
              </Card>

              {classificationDrilldownSourceId ? (
                <Card
                  className="content-card"
                  title={t("quality.classification.drilldown.title")}
                  extra={
                    <Typography.Text type="secondary">
                      {classificationDrilldownSourceName ||
                        classificationDrilldownSourceId}
                    </Typography.Text>
                  }
                  loading={classificationSourceItemsLoading}
                >
                  <Space
                    direction="vertical"
                    style={{ width: "100%" }}
                    size="middle"
                  >
                    <Table
                      rowKey={(row) => row.processedItemId}
                      columns={classificationSourceItemColumns}
                      dataSource={classificationSourceItems}
                      pagination={{ pageSize: 10, showSizeChanger: false }}
                      size={screens.md ? "middle" : "small"}
                    />
                    <Space>
                      <Button
                        onClick={() =>
                          classificationDrilldownSourceId
                            ? void loadClassificationSourceItems(
                                classificationDrilldownSourceId,
                                classificationDrilldownSourceName ?? undefined,
                                { append: true },
                              )
                            : undefined
                        }
                        disabled={!classificationSourceItemsCursor}
                        loading={classificationSourceItemsLoading}
                      >
                        {t("quality.classification.drilldown.loadMore")}
                      </Button>
                      <Button
                        onClick={() => {
                          setClassificationDrilldownSourceId(null);
                          setClassificationDrilldownSourceName(null);
                          setClassificationSourceItems([]);
                          setClassificationSourceItemsCursor(null);
                        }}
                      >
                        {t("quality.classification.drilldown.close")}
                      </Button>
                    </Space>
                  </Space>
                </Card>
              ) : null}
            </Space>
          </Tabs.TabPane>
        </Tabs>
      </div>
    </>
  );
}
