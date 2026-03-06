"use client";

import { Alert, Button, Card, Checkbox, Col, Divider, Grid, Input, InputNumber, Popover, Progress, Row, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { io, type Socket } from "socket.io-client";

import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { env } from "@/lib/env";

type TaskLogStatus = "pending" | "processing" | "completed" | "failed";

type LiveEventSource = "pipeline" | "crawl" | "analysis" | "assistant" | "alerts";

interface QualityLiveEvent {
  orgId: string;
  source: LiveEventSource;
  event: string;
  jobId: string;
  timestamp: string;
}

const LIVE_EVENT_SOURCES: LiveEventSource[] = ["pipeline", "crawl", "analysis", "assistant", "alerts"];
const LIVE_EVENT_SOURCE_SET = new Set<LiveEventSource>(LIVE_EVENT_SOURCES);

const createEmptyLiveEventCounts = (): Record<LiveEventSource, number> => ({
  pipeline: 0,
  crawl: 0,
  analysis: 0,
  assistant: 0,
  alerts: 0
});

const createDefaultLiveRefreshSources = (): Record<LiveEventSource, boolean> => ({
  pipeline: true,
  crawl: true,
  analysis: true,
  assistant: true,
  alerts: true
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
      staleProcessing: number;
    };
    oldestAgeMinutes: number | null;
  };
}

interface TaskLogRecord {
  _id?: string;
  queue: string;
  jobId: string;
  orgId: string;
  stage: string;
  status: TaskLogStatus;
  message?: string | null;
  data?: unknown;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
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

type ClassificationWindow = "1h" | "24h" | "7d";
type QualityTab = "overview" | "classification";

interface ClassificationQualitySummary {
  window: ClassificationWindow;
  from: string;
  to: string;
  totalItems: number;
  methodDistribution: Array<{
    group: "llm_embedding_rerank" | "rule_fallback";
    count: number;
    share: number;
  }>;
  confidenceHistogram: Array<{
    bucket: string;
    min: number;
    max: number;
    count: number;
  }>;
  confidenceTrend: Array<{
    bucketStart: string;
    total: number;
    avgConfidence: number | null;
    lowConfidenceCount: number;
  }>;
  lowConfidenceSources: Array<{
    sourceId: string;
    sourceName: string;
    sourceUrl: string;
    total: number;
    lowConfidenceCount: number;
    lowConfidenceRate: number;
    avgConfidence: number | null;
  }>;
  latencyPercentiles: {
    llm: { sampleSize: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null };
    embedding: { sampleSize: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null };
    rerank: { sampleSize: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null };
  };
  categoryGate: {
    reject: number;
    penalized: number;
    total: number;
    rejectRate: number;
    penalizedRate: number;
  };
  sourceCategoryBreakdown: Array<{
    sourceType: "authoritative" | "blog" | "unknown";
    categoryPrefix: string;
    count: number;
  }>;
  pendingReviewCount: number;
  alertStatus: Array<{
    stage: "llm" | "embedding" | "rerank";
    thresholdMs: number;
    p95Ms: number | null;
    triggered: boolean;
  }>;
  gateAlertStatus: Array<{
    metric: "reject_rate" | "penalized_rate";
    threshold: number;
    value: number;
    triggered: boolean;
  }>;
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
  items: Array<{
    processedItemId: string;
    itemMetaId: string | null;
    articleUrl: string | null;
    articleTitle: string | null;
    articleSummary: string | null;
    categoryPath: string | null;
    confidence: number | null;
    method: string | null;
    createdAt: string;
  }>;
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
  candidatePaths: Array<{
    path?: string;
    score?: number;
    legacy_category?: string | null;
    reason?: string | null;
  }>;
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
  typeof value === "number" && Number.isFinite(value) ? Math.round(value / 100) / 10 : undefined;

const toPercent = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 10 : undefined;

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
    const message = typeof record.message === "string" ? record.message.trim() : "";
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
  const { data: session, status } = useSession();
  const [messageApi, contextHolder] = message.useMessage();
  const canView = session?.permissions?.includes("settings.manage") ?? false;
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [classificationLoading, setClassificationLoading] = useState(false);
  const overviewLoadingRef = useRef(false);
  const classificationLoadingRef = useRef(false);
  const taskLogFiltersRef = useRef<{
    queue: string;
    stage: string;
    status: TaskLogStatus | "all";
    limit: number;
    sinceMinutes: number;
  }>({
    queue: "",
    stage: "",
    status: "failed",
    limit: 80,
    sinceMinutes: 60
  });
  const [pipeline, setPipeline] = useState<PipelineQualitySummary | null>(null);
  const [sources, setSources] = useState<NewsSourceQualitySummary | null>(null);
  const [classification, setClassification] = useState<ClassificationQualitySummary | null>(null);
  const [activeTab, setActiveTab] = useState<QualityTab>("overview");
  const [overviewLoaded, setOverviewLoaded] = useState(false);
  const [classificationLoaded, setClassificationLoaded] = useState(false);
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [classificationWindow, setClassificationWindow] = useState<ClassificationWindow>("24h");
  const [classificationFilterSourceId, setClassificationFilterSourceId] = useState<string | null>(null);
  const [classificationFilterCategoryPrefix, setClassificationFilterCategoryPrefix] = useState<string | null>(null);
  const [classificationDrilldownSourceId, setClassificationDrilldownSourceId] = useState<string | null>(null);
  const [classificationDrilldownSourceName, setClassificationDrilldownSourceName] = useState<string | null>(null);
  const [classificationSourceItems, setClassificationSourceItems] = useState<
    ClassificationSourceItemsResponse["items"]
  >([]);
  const [classificationSourceItemsCursor, setClassificationSourceItemsCursor] = useState<string | null>(null);
  const [classificationSourceItemsLoading, setClassificationSourceItemsLoading] = useState(false);
  const [classificationReviewQueue, setClassificationReviewQueue] = useState<ClassificationReviewItem[]>([]);
  const [classificationReviewOnlyPending, setClassificationReviewOnlyPending] = useState(true);
  const [classificationSelectedReviewIds, setClassificationSelectedReviewIds] = useState<string[]>([]);
  const [classificationReviewSubmitting, setClassificationReviewSubmitting] = useState(false);
  const [taskLogs, setTaskLogs] = useState<TaskLogRecord[]>([]);
  const [taskLogsSummary, setTaskLogsSummary] = useState<TaskLogsSummary | null>(null);
  const [taskLogsQueue, setTaskLogsQueue] = useState("");
  const [taskLogsStage, setTaskLogsStage] = useState("");
  const [taskLogsStatus, setTaskLogsStatus] = useState<TaskLogStatus | "all">("failed");
  const [taskLogsLimit, setTaskLogsLimit] = useState(80);
  const [taskLogsSinceMinutes, setTaskLogsSinceMinutes] = useState(60);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(30);
  const [liveUpdatesEnabled, setLiveUpdatesEnabled] = useState(true);
  const [liveStatus, setLiveStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveLastEventAt, setLiveLastEventAt] = useState<string | null>(null);
  const [liveLastEvent, setLiveLastEvent] = useState<QualityLiveEvent | null>(null);
  const [liveEventCount, setLiveEventCount] = useState(0);
  const [liveEventCountsBySource, setLiveEventCountsBySource] = useState<Record<LiveEventSource, number>>(() =>
    createEmptyLiveEventCounts()
  );
  const [liveRefreshSources, setLiveRefreshSources] = useState<Record<LiveEventSource, boolean>>(() =>
    createDefaultLiveRefreshSources()
  );
  const liveRefreshSourcesRef = useRef(liveRefreshSources);
  const liveRefreshTimerRef = useRef<number | null>(null);
  const liveSocketRef = useRef<Socket | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const pendingOverviewLoadRef = useRef<{ silent: boolean } | null>(null);
  const pendingClassificationLoadRef = useRef<{ silent: boolean } | null>(null);
  const activeTabRef = useRef(activeTab);
  const overviewRequestKeyRef = useRef("");
  const classificationRequestKeyRef = useRef("");
  const screens = Grid.useBreakpoint();
  const loading = activeTab === "classification" ? classificationLoading : overviewLoading;

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  useEffect(() => {
    taskLogFiltersRef.current = {
      queue: taskLogsQueue,
      stage: taskLogsStage,
      status: taskLogsStatus,
      limit: taskLogsLimit,
      sinceMinutes: taskLogsSinceMinutes
    };
  }, [taskLogsLimit, taskLogsQueue, taskLogsSinceMinutes, taskLogsStage, taskLogsStatus]);

  useEffect(() => {
    liveRefreshSourcesRef.current = liveRefreshSources;
  }, [liveRefreshSources]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    overviewRequestKeyRef.current = JSON.stringify({
      windowMinutes,
      queue: taskLogsQueue,
      stage: taskLogsStage,
      status: taskLogsStatus,
      limit: taskLogsLimit,
      sinceMinutes: taskLogsSinceMinutes
    });
  }, [taskLogsLimit, taskLogsQueue, taskLogsSinceMinutes, taskLogsStage, taskLogsStatus, windowMinutes]);

  useEffect(() => {
    classificationRequestKeyRef.current = JSON.stringify({
      window: classificationWindow,
      sourceId: classificationFilterSourceId,
      categoryPrefix: classificationFilterCategoryPrefix,
      onlyPending: classificationReviewOnlyPending
    });
  }, [
    classificationFilterCategoryPrefix,
    classificationFilterSourceId,
    classificationReviewOnlyPending,
    classificationWindow
  ]);

  const loadOverview = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (overviewLoadingRef.current) {
      const pending = pendingOverviewLoadRef.current;
      pendingOverviewLoadRef.current = {
        silent: pending ? pending.silent && silent : silent
      };
      return;
    }
    overviewLoadingRef.current = true;
    if (!silent) {
      setOverviewLoading(true);
    }
    try {
      const currentFilters = taskLogFiltersRef.current;
      const requestKey = JSON.stringify({
        windowMinutes,
        queue: currentFilters.queue,
        stage: currentFilters.stage,
        status: currentFilters.status,
        limit: currentFilters.limit,
        sinceMinutes: currentFilters.sinceMinutes
      });
      const taskLogParams: Record<string, unknown> = {
        limit: currentFilters.limit,
        sinceMinutes: currentFilters.sinceMinutes
      };
      const taskLogSummaryParams: Record<string, unknown> = {
        sinceMinutes: currentFilters.sinceMinutes
      };
      if (currentFilters.queue.trim()) {
        const normalizedQueue = currentFilters.queue.trim();
        taskLogParams.queue = normalizedQueue;
        taskLogSummaryParams.queue = normalizedQueue;
      }
      if (currentFilters.stage.trim()) {
        const normalizedStage = currentFilters.stage.trim();
        taskLogParams.stage = normalizedStage;
        taskLogSummaryParams.stage = normalizedStage;
      }
      if (currentFilters.status !== "all") {
        taskLogParams.status = currentFilters.status;
        taskLogSummaryParams.status = currentFilters.status;
      }

      const [pipelineRes, sourcesRes, taskLogsRes, taskLogSummaryRes] = await Promise.all([
        apiClient.get<PipelineQualitySummary>("admin/quality/pipeline", { params: { windowMinutes } }),
        apiClient.get<NewsSourceQualitySummary>("admin/quality/news-sources", { params: { windowHours: 24 } }),
        apiClient.get<TaskLogRecord[]>("admin/quality/task-logs", { params: taskLogParams }),
        apiClient.get<TaskLogsSummary>("admin/quality/task-logs/summary", { params: taskLogSummaryParams })
      ]);

      if (overviewRequestKeyRef.current !== requestKey) {
        return;
      }

      setPipeline(pipelineRes.data ?? null);
      setSources(sourcesRes.data ?? null);
      setTaskLogs(Array.isArray(taskLogsRes.data) ? taskLogsRes.data : []);
      setTaskLogsSummary(taskLogSummaryRes.data ?? null);
      setOverviewLoaded(true);
      setLastUpdatedAt(new Date().toISOString());
    } catch (error) {
      captureClientError("Failed to load quality overview", error);
      if (!silent) {
        messageApi.error(t("quality.errors.loadFailed", { defaultValue: "Failed to load quality dashboard." }));
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
  }, [apiClient, messageApi, t, windowMinutes]);

  const loadClassification = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (classificationLoadingRef.current) {
      const pending = pendingClassificationLoadRef.current;
      pendingClassificationLoadRef.current = {
        silent: pending ? pending.silent && silent : silent
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
        onlyPending: classificationReviewOnlyPending
      });
      const classificationParams: Record<string, unknown> = {
        window: classificationWindow
      };
      if (classificationFilterSourceId) {
        classificationParams.sourceId = classificationFilterSourceId;
      }
      if (classificationFilterCategoryPrefix) {
        classificationParams.categoryPrefix = classificationFilterCategoryPrefix;
      }

      const [classificationRes, classificationReviewsRes] = await Promise.all([
        apiClient.get<ClassificationQualitySummary>("admin/quality/classification/summary", {
          params: classificationParams
        }),
        apiClient.get<ClassificationReviewItem[]>("admin/quality/classification/reviews/queue", {
          params: {
            window: classificationWindow,
            onlyUnreviewed: classificationReviewOnlyPending,
            limit: 50
          }
        })
      ]);

      if (classificationRequestKeyRef.current !== requestKey) {
        return;
      }

      setClassification(classificationRes.data ?? null);
      setClassificationReviewQueue(
        Array.isArray(classificationReviewsRes.data) ? classificationReviewsRes.data : []
      );
      setClassificationLoaded(true);
      setLastUpdatedAt(new Date().toISOString());
    } catch (error) {
      captureClientError("Failed to load classification quality", error);
      if (!silent) {
        messageApi.error(
          t("quality.classification.errors.loadFailed", {
            defaultValue: "Failed to load classification quality."
          })
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
  }, [
    apiClient,
    classificationFilterCategoryPrefix,
    classificationFilterSourceId,
    classificationReviewOnlyPending,
    classificationWindow,
    messageApi,
    t
  ]);

  const load = useCallback(
    async (options?: { silent?: boolean; tab?: QualityTab }) => {
      const targetTab = options?.tab ?? activeTab;
      if (targetTab === "classification") {
        await loadClassification({ silent: options?.silent });
        return;
      }
      await loadOverview({ silent: options?.silent });
    },
    [activeTab, loadClassification, loadOverview]
  );

  const applyTaskLogFilters = useCallback((next: Partial<(typeof taskLogFiltersRef)["current"]>) => {
    const merged = { ...taskLogFiltersRef.current, ...next };
    taskLogFiltersRef.current = merged;
    overviewRequestKeyRef.current = JSON.stringify({
      windowMinutes,
      queue: merged.queue,
      stage: merged.stage,
      status: merged.status,
      limit: merged.limit,
      sinceMinutes: merged.sinceMinutes
    });
    setTaskLogsQueue(merged.queue);
    setTaskLogsStage(merged.stage);
    setTaskLogsStatus(merged.status);
    setTaskLogsLimit(merged.limit);
    setTaskLogsSinceMinutes(merged.sinceMinutes);
    void load({ tab: "overview" });
  }, [load, windowMinutes]);

  useEffect(() => {
    setClassificationDrilldownSourceId(null);
    setClassificationDrilldownSourceName(null);
    setClassificationSourceItems([]);
    setClassificationSourceItemsCursor(null);
  }, [classificationFilterCategoryPrefix, classificationFilterSourceId, classificationWindow]);

  useEffect(() => {
    setClassificationSelectedReviewIds([]);
  }, [classificationReviewQueue]);

  const loadClassificationSourceItems = useCallback(
    async (sourceId: string, sourceName?: string, options?: { append?: boolean }) => {
      const normalizedSourceId = sourceId.trim();
      if (!normalizedSourceId) {
        return;
      }

      const append = options?.append === true;
      const nextCursor = append ? classificationSourceItemsCursor : null;
      const params: Record<string, unknown> = {
        window: classificationWindow,
        limit: 20
      };
      if (nextCursor) {
        params.cursor = nextCursor;
      }

      setClassificationSourceItemsLoading(true);
      try {
        const response = await apiClient.get<ClassificationSourceItemsResponse>(
          `admin/quality/classification/sources/${normalizedSourceId}/items`,
          { params }
        );
        const payload = response.data;
        const nextItems = Array.isArray(payload?.items) ? payload.items : [];
        setClassificationDrilldownSourceId(normalizedSourceId);
        setClassificationDrilldownSourceName(sourceName?.trim() ? sourceName.trim() : normalizedSourceId);
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
            : null
        );
      } catch (error) {
        captureClientError("Failed to load classification source items", error);
        messageApi.error(
          t("quality.classification.errors.sourceItems", {
            defaultValue: "Failed to load source drilldown items."
          })
        );
      } finally {
        setClassificationSourceItemsLoading(false);
      }
    },
    [apiClient, classificationSourceItemsCursor, classificationWindow, messageApi, t]
  );

  const submitClassificationReviewDecision = useCallback(
    async (
      reviewId: string,
      status: "approved" | "rejected" | "corrected",
      correctedCategoryPath?: string
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
              : undefined
          }
        );
        messageApi.success(
          t("quality.classification.review.success", {
            defaultValue: "Review decision submitted."
          })
        );
        await load({ silent: true, tab: "classification" });
      } catch (error) {
        captureClientError("Failed to submit classification review decision", error);
        messageApi.error(
          t("quality.classification.review.error", {
            defaultValue: "Failed to submit review decision."
          })
        );
      } finally {
        setClassificationReviewSubmitting(false);
      }
    },
    [apiClient, load, messageApi, t]
  );

  const submitClassificationBatchDecision = useCallback(
    async (status: "approved" | "rejected" | "corrected", correctedCategoryPath?: string) => {
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
            : undefined
        });
        messageApi.success(
          t("quality.classification.review.batchSuccess", {
            defaultValue: "Batch review submitted."
          })
        );
        setClassificationSelectedReviewIds([]);
        await load({ silent: true, tab: "classification" });
      } catch (error) {
        captureClientError("Failed to submit classification batch decision", error);
        messageApi.error(
          t("quality.classification.review.batchError", {
            defaultValue: "Failed to submit batch review."
          })
        );
      } finally {
        setClassificationReviewSubmitting(false);
      }
    },
    [apiClient, classificationSelectedReviewIds, load, messageApi, t]
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
    load
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
      void load({ silent: true, tab: activeTabRef.current });
    }, 1200);
  }, [load]);

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
      transports: ["websocket"]
    });

    liveSocketRef.current = socket;

    const handleConnect = () => {
      setLiveStatus("connected");
      setLiveError(null);
    };
    const handleDisconnect = () => setLiveStatus("disconnected");
    const handleConnectError = (error: Error) => {
      setLiveStatus("disconnected");
      setLiveError(error.message);
    };
    const handleServerError = (payload: unknown) => {
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const message = (payload as { message?: unknown }).message;
        if (typeof message === "string" && message.trim()) {
          setLiveError(message.trim());
        }
      }
    };
    const handleEvent = (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return;
      }
      const record = payload as Record<string, unknown>;
      const sourceRaw = record.source;
      if (typeof sourceRaw !== "string" || !LIVE_EVENT_SOURCE_SET.has(sourceRaw as LiveEventSource)) {
        return;
      }
      const source = sourceRaw as LiveEventSource;
      const event = typeof record.event === "string" ? record.event : "EVENT";
      const jobId = typeof record.jobId === "string" ? record.jobId : "";
      const orgId = typeof record.orgId === "string" ? record.orgId : "";
      const timestamp = typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();

      setLiveLastEvent({ orgId, source, event, jobId, timestamp });
      setLiveLastEventAt(timestamp);
      setLiveEventCount((prev) => prev + 1);
      setLiveEventCountsBySource((prev) => ({ ...prev, [source]: (prev[source] ?? 0) + 1 }));

      if (event !== "PROGRESS" && liveRefreshSourcesRef.current[source]) {
        scheduleLiveRefresh();
      }
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("quality:error", handleServerError);
    socket.on("quality:event", handleEvent);

    return () => {
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

  const failureColumns: ColumnsType<PipelineQualitySummary["failureTypes"][number]> = [
    {
      title: t("quality.columns.stage", { defaultValue: "Stage" }),
      dataIndex: "stage",
      key: "stage"
    },
    {
      title: t("quality.columns.error", { defaultValue: "Error" }),
      dataIndex: "errorName",
      key: "errorName",
      render: (value: string) => <Tag>{value}</Tag>
    },
    {
      title: t("quality.columns.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count"
    }
  ];

  const llmColumns: ColumnsType<NonNullable<PipelineQualitySummary["llmModels"]>[number]> = [
    {
      title: t("quality.llm.columns.model", { defaultValue: "Model" }),
      dataIndex: "model",
      key: "model",
      render: (value: string) => (
        <Typography.Text code copyable>
          {value}
        </Typography.Text>
      )
    },
    {
      title: t("quality.llm.columns.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count",
      width: 120
    },
    {
      title: t("quality.llm.columns.avgLatency", { defaultValue: "Avg latency" }),
      dataIndex: "avgLatencyMs",
      key: "avgLatencyMs",
      render: (value: number | null) => (typeof value === "number" ? `${msToSeconds(value)}s` : "-")
    },
    {
      title: t("quality.llm.columns.avgCost", { defaultValue: "Avg cost" }),
      dataIndex: "avgCostUsd",
      key: "avgCostUsd",
      render: (value: number | null) => (typeof value === "number" ? `$${value.toFixed(3)}` : "-")
    },
    {
      title: t("quality.llm.columns.avgTokens", { defaultValue: "Avg tokens" }),
      dataIndex: "avgTotalTokens",
      key: "avgTotalTokens",
      render: (value: number | null) => (typeof value === "number" ? Math.round(value) : "-")
    }
  ];

  const taskLogStatusColors: Record<TaskLogStatus, string> = {
    pending: "gold",
    processing: "blue",
    completed: "green",
    failed: "red"
  };

  const taskLogColumns: ColumnsType<TaskLogRecord> = [
    {
      title: t("quality.taskLogs.columns.time", { defaultValue: "Time" }),
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
      }
    },
    {
      title: t("quality.taskLogs.columns.queue", { defaultValue: "Queue" }),
      dataIndex: "queue",
      key: "queue",
      render: (value: string) => <Tag>{value}</Tag>
    },
    {
      title: t("quality.taskLogs.columns.stage", { defaultValue: "Stage" }),
      dataIndex: "stage",
      key: "stage",
      render: (value: string) => <Tag>{value}</Tag>
    },
    {
      title: t("quality.taskLogs.columns.status", { defaultValue: "Status" }),
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (value: TaskLogStatus) => <Tag color={taskLogStatusColors[value]}>{value}</Tag>
    },
    {
      title: t("quality.taskLogs.columns.message", { defaultValue: "Message" }),
      dataIndex: "message",
      key: "message",
      render: (_: unknown, record) => {
        const fallback = extractErrorSummary(record.error);
        const text = record.message?.trim() ? record.message.trim() : fallback;
        return (
          <Typography.Text type={record.status === "failed" ? "danger" : undefined} ellipsis={{ tooltip: text ?? "-" }}>
            {text ?? "-"}
          </Typography.Text>
        );
      }
    },
    {
      title: t("quality.taskLogs.columns.jobId", { defaultValue: "Job" }),
      dataIndex: "jobId",
      key: "jobId",
      width: 220,
      render: (value: string) => (
        <Typography.Text code copyable ellipsis={{ tooltip: value }}>
          {value}
        </Typography.Text>
      )
    }
  ];

  const taskLogTopErrorColumns: ColumnsType<TaskLogsSummary["topErrors"][number]> = [
    {
      title: t("quality.taskLogs.summary.columns.queue", { defaultValue: "Queue" }),
      dataIndex: "queue",
      key: "queue",
      render: (value: string, record) => (
        <Tag
          style={{ cursor: "pointer" }}
          onClick={() => applyTaskLogFilters({ queue: record.queue, stage: "", status: "failed" })}
        >
          {value}
        </Tag>
      )
    },
    {
      title: t("quality.taskLogs.summary.columns.stage", { defaultValue: "Stage" }),
      dataIndex: "stage",
      key: "stage",
      render: (value: string, record) => (
        <Tag
          style={{ cursor: "pointer" }}
          onClick={() => applyTaskLogFilters({ queue: record.queue, stage: record.stage, status: "failed" })}
        >
          {value}
        </Tag>
      )
    },
    {
      title: t("quality.taskLogs.summary.columns.error", { defaultValue: "Error" }),
      dataIndex: "errorName",
      key: "errorName",
      render: (value: string) => <Tag color="red">{value}</Tag>
    },
    {
      title: t("quality.taskLogs.summary.columns.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count",
      width: 120
    },
    {
      title: t("quality.taskLogs.summary.columns.sample", { defaultValue: "Sample" }),
      dataIndex: "sampleMessage",
      key: "sampleMessage",
      render: (value: string | null) => (
        <Typography.Text type="secondary" ellipsis={{ tooltip: value ?? "-" }}>
          {value ?? "-"}
        </Typography.Text>
      )
    }
  ];

  const sourceColumns: ColumnsType<NewsSourceQualitySummary["topFailingSources"][number]> = [
    {
      title: t("quality.sources.columns.name", { defaultValue: "Source" }),
      dataIndex: "name",
      key: "name",
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" ellipsis={{ tooltip: record.url }}>
            {record.url}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: t("quality.sources.columns.failedJobs", { defaultValue: "Failed jobs" }),
      dataIndex: "failedJobs",
      key: "failedJobs"
    },
    {
      title: t("quality.sources.columns.streak", { defaultValue: "Failure streak" }),
      dataIndex: "consecutiveFailures",
      key: "consecutiveFailures"
    },
    {
      title: t("quality.sources.columns.circuit", { defaultValue: "Circuit" }),
      dataIndex: "circuitOpenUntil",
      key: "circuitOpenUntil",
      render: (value: string | null) =>
        value ? <Tag color="orange">{t("quality.sources.circuitOpen", { defaultValue: "OPEN" })}</Tag> : <Tag>OK</Tag>
    }
  ];

  const histogramMax = useMemo(() => {
    if (!classification || classification.confidenceHistogram.length === 0) {
      return 0;
    }
    return classification.confidenceHistogram.reduce((max, entry) => Math.max(max, entry.count), 0);
  }, [classification]);

  const classificationMethodColumns: ColumnsType<ClassificationQualitySummary["methodDistribution"][number]> = [
    {
      title: t("quality.classification.methods.columns.group", { defaultValue: "Method group" }),
      dataIndex: "group",
      key: "group",
      render: (value: "llm_embedding_rerank" | "rule_fallback") => (
        <Tag color={value === "llm_embedding_rerank" ? "blue" : "gold"}>
          {value === "llm_embedding_rerank" ? "LLM + Embedding + Rerank" : "Rule / Fallback"}
        </Tag>
      )
    },
    {
      title: t("quality.classification.methods.columns.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count",
      width: 120
    },
    {
      title: t("quality.classification.methods.columns.share", { defaultValue: "Share" }),
      dataIndex: "share",
      key: "share",
      width: 160,
      render: (value: number) => `${toPercent(value) ?? 0}%`
    }
  ];

  const classificationHistogramColumns: ColumnsType<ClassificationQualitySummary["confidenceHistogram"][number]> = [
    {
      title: t("quality.classification.histogram.columns.bucket", { defaultValue: "Confidence bucket" }),
      dataIndex: "bucket",
      key: "bucket",
      width: 160
    },
    {
      title: t("quality.classification.histogram.columns.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count",
      width: 120
    },
    {
      title: t("quality.classification.histogram.columns.distribution", { defaultValue: "Distribution" }),
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
          strokeColor="#1677ff"
        />
      )
    }
  ];

  const classificationTrendColumns: ColumnsType<ClassificationQualitySummary["confidenceTrend"][number]> = [
    {
      title: t("quality.classification.trend.columns.time", { defaultValue: "Bucket" }),
      dataIndex: "bucketStart",
      key: "bucketStart",
      render: (value: string) => {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
      }
    },
    {
      title: t("quality.classification.trend.columns.total", { defaultValue: "Total" }),
      dataIndex: "total",
      key: "total",
      width: 100
    },
    {
      title: t("quality.classification.trend.columns.avgConfidence", { defaultValue: "Avg confidence" }),
      dataIndex: "avgConfidence",
      key: "avgConfidence",
      width: 150,
      render: (value: number | null) => (typeof value === "number" ? value.toFixed(3) : "-")
    },
    {
      title: t("quality.classification.trend.columns.lowConfidence", { defaultValue: "Low confidence" }),
      dataIndex: "lowConfidenceCount",
      key: "lowConfidenceCount",
      width: 150
    }
  ];

  const classificationLowSourceColumns: ColumnsType<ClassificationQualitySummary["lowConfidenceSources"][number]> = [
    {
      title: t("quality.classification.sources.columns.source", { defaultValue: "Source" }),
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
          <Typography.Text type="secondary" ellipsis={{ tooltip: record.sourceUrl || record.sourceId }}>
            {record.sourceUrl || record.sourceId}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: t("quality.classification.sources.columns.lowCount", { defaultValue: "Low confidence" }),
      dataIndex: "lowConfidenceCount",
      key: "lowConfidenceCount",
      width: 140
    },
    {
      title: t("quality.classification.sources.columns.total", { defaultValue: "Total" }),
      dataIndex: "total",
      key: "total",
      width: 100
    },
    {
      title: t("quality.classification.sources.columns.lowRate", { defaultValue: "Low rate" }),
      dataIndex: "lowConfidenceRate",
      key: "lowConfidenceRate",
      width: 120,
      render: (value: number) => `${toPercent(value) ?? 0}%`
    },
    {
      title: t("quality.classification.sources.columns.avg", { defaultValue: "Avg confidence" }),
      dataIndex: "avgConfidence",
      key: "avgConfidence",
      width: 140,
      render: (value: number | null) => (typeof value === "number" ? value.toFixed(3) : "-")
    },
    {
      title: t("quality.classification.sources.columns.actions", { defaultValue: "Actions" }),
      key: "actions",
      width: 140,
      render: (_, record) => (
        <Button
          size="small"
          onClick={() => void loadClassificationSourceItems(record.sourceId, record.sourceName)}
        >
          {t("quality.classification.sources.actions.drilldown", { defaultValue: "Drilldown" })}
        </Button>
      )
    }
  ];

  const classificationSourceItemColumns: ColumnsType<ClassificationSourceItemsResponse["items"][number]> = [
    {
      title: t("quality.classification.drilldown.columns.time", { defaultValue: "Time" }),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
      }
    },
    {
      title: t("quality.classification.drilldown.columns.title", { defaultValue: "Article" }),
      dataIndex: "articleTitle",
      key: "articleTitle",
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          {record.articleUrl ? (
            <Typography.Link href={record.articleUrl} target="_blank" rel="noreferrer">
              {record.articleTitle || record.articleUrl}
            </Typography.Link>
          ) : (
            <Typography.Text>{record.articleTitle || "-"}</Typography.Text>
          )}
          {record.articleSummary ? (
            <Typography.Text type="secondary" ellipsis={{ tooltip: record.articleSummary }}>
              {record.articleSummary}
            </Typography.Text>
          ) : null}
        </Space>
      )
    },
    {
      title: t("quality.classification.drilldown.columns.path", { defaultValue: "Category path" }),
      dataIndex: "categoryPath",
      key: "categoryPath",
      width: 180,
      render: (value: string | null) => <Tag>{value || "unknown"}</Tag>
    },
    {
      title: t("quality.classification.drilldown.columns.confidence", { defaultValue: "Confidence" }),
      dataIndex: "confidence",
      key: "confidence",
      width: 120,
      render: (value: number | null) => (typeof value === "number" ? value.toFixed(3) : "-")
    },
    {
      title: t("quality.classification.drilldown.columns.method", { defaultValue: "Method" }),
      dataIndex: "method",
      key: "method",
      width: 150,
      render: (value: string | null) => <Tag>{value || "unknown"}</Tag>
    }
  ];

  const classificationSourceCategoryColumns: ColumnsType<
    ClassificationQualitySummary["sourceCategoryBreakdown"][number]
  > = [
    {
      title: t("quality.classification.sourceCategory.columns.sourceType", { defaultValue: "Source type" }),
      dataIndex: "sourceType",
      key: "sourceType",
      width: 140,
      render: (value: string) => <Tag>{value}</Tag>
    },
    {
      title: t("quality.classification.sourceCategory.columns.categoryPrefix", { defaultValue: "Category prefix" }),
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
      )
    },
    {
      title: t("quality.classification.sourceCategory.columns.count", { defaultValue: "Count" }),
      dataIndex: "count",
      key: "count",
      width: 120
    }
  ];

  const classificationReviewStatusColors: Record<ClassificationReviewItem["status"], string> = {
    pending: "gold",
    approved: "green",
    rejected: "red",
    corrected: "blue"
  };

  const classificationReviewColumns: ColumnsType<ClassificationReviewItem> = [
    {
      title: t("quality.classification.review.columns.time", { defaultValue: "Time" }),
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (value: string) => {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
      }
    },
    {
      title: t("quality.classification.review.columns.article", { defaultValue: "Article" }),
      key: "article",
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          {record.articleUrl ? (
            <Typography.Link href={record.articleUrl} target="_blank" rel="noreferrer">
              {record.articleTitle || record.articleUrl}
            </Typography.Link>
          ) : (
            <Typography.Text>{record.articleTitle || "-"}</Typography.Text>
          )}
          {record.articleSummary ? (
            <Typography.Text type="secondary" ellipsis={{ tooltip: record.articleSummary }}>
              {record.articleSummary}
            </Typography.Text>
          ) : null}
        </Space>
      )
    },
    {
      title: t("quality.classification.review.columns.predicted", { defaultValue: "Predicted" }),
      key: "predicted",
      width: 220,
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Tag>{record.predictedCategoryPath || "unknown"}</Tag>
          <Typography.Text type="secondary">
            {(typeof record.predictedConfidence === "number" ? record.predictedConfidence.toFixed(3) : "-")}
            {" · "}
            {record.predictedMethod || "unknown"}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: t("quality.classification.review.columns.candidates", { defaultValue: "Candidates" }),
      key: "candidates",
      width: 280,
      render: (_, record) => (
        <Space wrap>
          {record.candidatePaths.slice(0, 3).map((candidate, index) => (
            <Tag key={`${record.id}-candidate-${index}`}>
              {(candidate.path || "unknown").slice(0, 48)}
              {typeof candidate.score === "number" ? ` (${candidate.score.toFixed(2)})` : ""}
            </Tag>
          ))}
          {record.candidatePaths.length === 0 ? "-" : null}
        </Space>
      )
    },
    {
      title: t("quality.classification.review.columns.status", { defaultValue: "Status" }),
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (value: ClassificationReviewItem["status"]) => (
        <Tag color={classificationReviewStatusColors[value]}>{value}</Tag>
      )
    },
    {
      title: t("quality.classification.review.columns.actions", { defaultValue: "Actions" }),
      key: "actions",
      width: 250,
      render: (_, record) => (
        <Space wrap>
          <Button
            size="small"
            onClick={() => void submitClassificationReviewDecision(record.id, "approved")}
            loading={classificationReviewSubmitting}
          >
            {t("quality.classification.review.actions.approve", { defaultValue: "Approve" })}
          </Button>
          <Button
            size="small"
            danger
            onClick={() => void submitClassificationReviewDecision(record.id, "rejected")}
            loading={classificationReviewSubmitting}
          >
            {t("quality.classification.review.actions.reject", { defaultValue: "Reject" })}
          </Button>
          <Button
            size="small"
            type="dashed"
            onClick={() => {
              const correctedPath = window.prompt(
                t("quality.classification.review.correct.prompt", {
                  defaultValue: "Input corrected category path"
                }),
                record.predictedCategoryPath || ""
              );
              if (!correctedPath || !correctedPath.trim()) {
                return;
              }
              void submitClassificationReviewDecision(record.id, "corrected", correctedPath);
            }}
            loading={classificationReviewSubmitting}
          >
            {t("quality.classification.review.actions.correct", { defaultValue: "Correct" })}
          </Button>
        </Space>
      )
    }
  ];

  const livePopoverContent = (
    <div style={{ maxWidth: 420 }}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        {liveError ? (
          <Alert
            type="error"
            showIcon
            message={t("quality.liveUpdates.error", { defaultValue: "Error" })}
            description={liveError}
          />
        ) : null}

        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">
            {t("quality.liveUpdates.details.lastEvent", { defaultValue: "Last event" })}
          </Typography.Text>
          {liveLastEvent ? (
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              <Space wrap>
                <Tag>{liveLastEvent.source}</Tag>
                <Tag color="blue">{liveLastEvent.event}</Tag>
              </Space>
              {liveLastEvent.jobId ? (
                <Typography.Text code copyable ellipsis={{ tooltip: liveLastEvent.jobId }}>
                  {liveLastEvent.jobId}
                </Typography.Text>
              ) : null}
              <Typography.Text type="secondary">
                {new Date(liveLastEvent.timestamp).toLocaleString()}
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text type="secondary">{t("common.noData", { defaultValue: "No data" })}</Typography.Text>
          )}
        </Space>

        <Divider style={{ margin: "4px 0" }} />

        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            {t("quality.liveUpdates.details.refreshOn", { defaultValue: "Refresh on" })}
          </Typography.Text>
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            {LIVE_EVENT_SOURCES.map((source) => (
              <div
                key={source}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12
                }}
              >
                <Checkbox
                  checked={liveRefreshSources[source]}
                  onChange={(event) =>
                    setLiveRefreshSources((prev) => ({
                      ...prev,
                      [source]: event.target.checked
                    }))
                  }
                >
                  {source}
                </Checkbox>
                <Typography.Text type="secondary">{liveEventCountsBySource[source]}</Typography.Text>
              </div>
            ))}
          </Space>
          <Space>
            <Button size="small" onClick={resetLiveCounters}>
              {t("quality.liveUpdates.details.resetCounters", { defaultValue: "Reset counters" })}
            </Button>
          </Space>
        </Space>
      </Space>
    </div>
  );

  if (status === "loading") {
    return (
      <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!canView) {
    return (
      <Card className="content-card" title={t("quality.title", { defaultValue: "Data Quality" })}>
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
        <Space direction={screens.md ? "horizontal" : "vertical"} style={{ width: "100%", justifyContent: "space-between" }}>
          <Space direction="vertical" size={2}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t("quality.title", { defaultValue: "Data Quality" })}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t("quality.subtitle", { defaultValue: "Pipeline success, latency, and source reliability." })}
            </Typography.Text>
          </Space>
          <Space>
            <Select
              value={windowMinutes}
              onChange={(value) => setWindowMinutes(value)}
              options={[
                { value: 60, label: t("quality.windows.60m", { defaultValue: "Last 60m" }) },
                { value: 240, label: t("quality.windows.4h", { defaultValue: "Last 4h" }) },
                { value: 1440, label: t("quality.windows.24h", { defaultValue: "Last 24h" }) }
              ]}
              style={{ minWidth: 160 }}
            />
            <Button onClick={() => void load()} loading={loading}>
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
            <Space size={6} wrap>
              <Typography.Text type="secondary">
                {t("quality.autoRefresh.label", { defaultValue: "Auto refresh" })}
              </Typography.Text>
              <Switch checked={autoRefreshEnabled} onChange={(checked) => setAutoRefreshEnabled(checked)} />
              <InputNumber
                min={5}
                max={300}
                step={5}
                value={autoRefreshSeconds}
                onChange={(value) => setAutoRefreshSeconds(typeof value === "number" ? value : 30)}
                style={{ width: 88 }}
              />
              <Typography.Text type="secondary">s</Typography.Text>
            </Space>
            <Space size={6} wrap>
              <Typography.Text type="secondary">
                {t("quality.liveUpdates.label", { defaultValue: "Live updates" })}
              </Typography.Text>
              <Switch checked={liveUpdatesEnabled} onChange={(checked) => setLiveUpdatesEnabled(checked)} />
              {liveUpdatesEnabled ? (
                <Popover content={livePopoverContent} trigger="click" placement="bottomRight">
                  <Tag
                    style={{ cursor: "pointer" }}
                    color={liveError ? "red" : liveStatus === "connected" ? "green" : liveStatus === "connecting" ? "blue" : undefined}
                  >
                    {liveError
                      ? t("quality.liveUpdates.error", { defaultValue: "Error" })
                      : liveStatus === "connected"
                        ? t("quality.liveUpdates.connected", { defaultValue: "Live" })
                        : liveStatus === "connecting"
                          ? t("quality.liveUpdates.connecting", { defaultValue: "Connecting" })
                          : t("quality.liveUpdates.disconnected", { defaultValue: "Disconnected" })}
                    {liveStatus === "connected" && liveEventCount > 0 ? ` · ${liveEventCount}` : ""}
                  </Tag>
                </Popover>
              ) : null}
            </Space>
          </Space>
        </Space>

        {lastUpdatedAt ? (
          <Typography.Text type="secondary">
            {t("quality.updatedAt", {
              defaultValue: "Updated at: {{time}}",
              time: new Date(lastUpdatedAt).toLocaleString()
            })}
          </Typography.Text>
        ) : null}

        <Tabs activeKey={activeTab} onChange={(key) => setActiveTab(key as QualityTab)}>
          <Tabs.TabPane tab={t("quality.tabs.overview", { defaultValue: "Overview" })} key="overview">
            <Space direction="vertical" style={{ width: "100%" }} size="large">
              <Card className="content-card" title={t("quality.pipeline.title", { defaultValue: "Pipeline" })} loading={loading}>
                {pipeline ? (
                  <Space direction="vertical" size="small" style={{ display: "flex" }}>
                    <Row gutter={[16, 16]}>
                      <Col xs={12} md={6}>
                        <Statistic title={t("quality.pipeline.total", { defaultValue: "Total" })} value={pipeline.totals.total} />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic title={t("quality.pipeline.completed", { defaultValue: "Completed" })} value={pipeline.totals.completed} />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic title={t("quality.pipeline.failed", { defaultValue: "Failed" })} value={pipeline.totals.failed} />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.successRate", { defaultValue: "Success rate" })}
                          value={
                            pipeline.successRate !== null ? Math.round(pipeline.successRate * 1000) / 10 : undefined
                          }
                          suffix={pipeline.successRate !== null ? "%" : undefined}
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.llmLatency", { defaultValue: "Avg LLM latency" })}
                          value={
                            pipeline.averageLatencyMs !== null ? Math.round(pipeline.averageLatencyMs / 100) / 10 : undefined
                          }
                          suffix={pipeline.averageLatencyMs !== null ? "s" : undefined}
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.ingestP50", { defaultValue: "Ingest p50" })}
                          value={msToSeconds(pipeline.ingestionLatencyMs?.p50Ms)}
                          suffix={pipeline.ingestionLatencyMs?.p50Ms != null ? "s" : undefined}
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.ingestP90", { defaultValue: "Ingest p90" })}
                          value={msToSeconds(pipeline.ingestionLatencyMs?.p90Ms)}
                          suffix={pipeline.ingestionLatencyMs?.p90Ms != null ? "s" : undefined}
                        />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic
                          title={t("quality.pipeline.outboxOldest", { defaultValue: "Outbox oldest" })}
                          value={pipeline.outbox?.oldestAgeMinutes ?? undefined}
                          suffix={pipeline.outbox?.oldestAgeMinutes != null ? "m" : undefined}
                        />
                      </Col>
                    </Row>

                    {pipeline.outbox ? (
                      <Space wrap>
                        <Tag>
                          {t("quality.pipeline.outbox.pending", { defaultValue: "Outbox pending" })}:{" "}
                          {pipeline.outbox.totals.pending}
                        </Tag>
                        <Tag>
                          {t("quality.pipeline.outbox.processing", { defaultValue: "Outbox processing" })}:{" "}
                          {pipeline.outbox.totals.processing}
                        </Tag>
                        <Tag color={pipeline.outbox.totals.failed > 0 ? "red" : "default"}>
                          {t("quality.pipeline.outbox.failed", { defaultValue: "Outbox failed" })}:{" "}
                          {pipeline.outbox.totals.failed}
                        </Tag>
                        <Tag color={pipeline.outbox.totals.staleProcessing > 0 ? "orange" : "default"}>
                          {t("quality.pipeline.outbox.stale", { defaultValue: "Outbox stale" })}:{" "}
                          {pipeline.outbox.totals.staleProcessing}
                        </Tag>
                      </Space>
                    ) : null}
                  </Space>
                ) : (
                  <Typography.Text type="secondary">{t("common.empty", { defaultValue: "Empty" })}</Typography.Text>
                )}
              </Card>

              <Card className="content-card" title={t("quality.pipeline.failures", { defaultValue: "Top Failures" })} loading={loading}>
                <Table
                  rowKey={(row) => `${row.stage}:${row.errorName}`}
                  columns={failureColumns}
                  dataSource={pipeline?.failureTypes ?? []}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  size={screens.md ? "middle" : "small"}
                />
              </Card>

              <Card className="content-card" title={t("quality.llm.title", { defaultValue: "LLM" })} loading={loading}>
                <Table
                  rowKey="model"
                  columns={llmColumns}
                  dataSource={pipeline?.llmModels ?? []}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  size={screens.md ? "middle" : "small"}
                />
              </Card>

              <Card className="content-card" title={t("quality.taskLogs.title", { defaultValue: "Task logs" })} loading={loading}>
                <Space direction="vertical" style={{ width: "100%" }} size="middle">
                  <Space wrap>
                    <Input
                      value={taskLogsQueue}
                      onChange={(event) => setTaskLogsQueue(event.target.value)}
                      placeholder={t("quality.taskLogs.filters.queue", { defaultValue: "Queue (optional)" })}
                      style={{ width: 220 }}
                      allowClear
                    />
                    <Input
                      value={taskLogsStage}
                      onChange={(event) => setTaskLogsStage(event.target.value)}
                      placeholder={t("quality.taskLogs.filters.stage", { defaultValue: "Stage (optional)" })}
                      style={{ width: 220 }}
                      allowClear
                    />
                    <Select
                      value={taskLogsStatus}
                      onChange={(value) => setTaskLogsStatus(value)}
                      style={{ width: 160 }}
                      options={[
                        { value: "all", label: t("quality.taskLogs.filters.statusAll", { defaultValue: "All statuses" }) },
                        { value: "failed", label: t("quality.taskLogs.status.failed", { defaultValue: "failed" }) },
                        { value: "processing", label: t("quality.taskLogs.status.processing", { defaultValue: "processing" }) },
                        { value: "pending", label: t("quality.taskLogs.status.pending", { defaultValue: "pending" }) },
                        { value: "completed", label: t("quality.taskLogs.status.completed", { defaultValue: "completed" }) }
                      ]}
                    />
                    <Space size={6} wrap>
                      <Typography.Text type="secondary">
                        {t("quality.taskLogs.filters.since", { defaultValue: "Since" })}
                      </Typography.Text>
                      <InputNumber
                        min={1}
                        max={1440}
                        step={5}
                        value={taskLogsSinceMinutes}
                        onChange={(value) => setTaskLogsSinceMinutes(typeof value === "number" ? value : 60)}
                        style={{ width: 120 }}
                      />
                      <Typography.Text type="secondary">
                        {t("quality.taskLogs.filters.minutes", { defaultValue: "min" })}
                      </Typography.Text>
                    </Space>
                    <Space size={6} wrap>
                      <Typography.Text type="secondary">
                        {t("quality.taskLogs.filters.limit", { defaultValue: "Limit" })}
                      </Typography.Text>
                      <InputNumber
                        min={1}
                        max={200}
                        step={10}
                        value={taskLogsLimit}
                        onChange={(value) => setTaskLogsLimit(typeof value === "number" ? value : 80)}
                        style={{ width: 120 }}
                      />
                    </Space>
                    <Button onClick={() => void load({ tab: "overview" })} loading={loading}>
                      {t("common.refresh", { defaultValue: "Refresh" })}
                    </Button>
                  </Space>

                  {taskLogsSummary ? (
                    <Space direction="vertical" style={{ width: "100%" }} size="small">
                      <Row gutter={[16, 16]}>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.total", { defaultValue: "Total logs" })}
                            value={taskLogsSummary.totals.total}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.pending", { defaultValue: "Pending" })}
                            value={taskLogsSummary.totals.pending}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.processing", { defaultValue: "Processing" })}
                            value={taskLogsSummary.totals.processing}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.completed", { defaultValue: "Completed" })}
                            value={taskLogsSummary.totals.completed}
                          />
                        </Col>
                        <Col xs={12} md={4}>
                          <Statistic
                            title={t("quality.taskLogs.summary.totals.failed", { defaultValue: "Failed" })}
                            value={taskLogsSummary.totals.failed}
                            valueStyle={taskLogsSummary.totals.failed > 0 ? { color: "#cf1322" } : undefined}
                          />
                        </Col>
                      </Row>

                      {taskLogsSummary.topErrors.length > 0 ? (
                        <Table
                          rowKey={(row) => `${row.queue}:${row.stage}:${row.errorName}`}
                          columns={taskLogTopErrorColumns}
                          dataSource={taskLogsSummary.topErrors}
                          pagination={{ pageSize: 5, showSizeChanger: false }}
                          size={screens.md ? "middle" : "small"}
                          title={() => t("quality.taskLogs.summary.title", { defaultValue: "Top errors" })}
                        />
                      ) : null}
                    </Space>
                  ) : null}

                  <Table
                    rowKey={(row) => row._id ?? `${row.queue}:${row.jobId}:${row.stage}:${row.createdAt}`}
                    columns={taskLogColumns}
                    dataSource={taskLogs}
                    pagination={{ pageSize: 10, showSizeChanger: false }}
                    size={screens.md ? "middle" : "small"}
                    expandable={{
                      rowExpandable: (record) => Boolean(record.data) || Boolean(record.error),
                      expandedRowRender: (record) => (
                        <pre
                          style={{
                            margin: 0,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            background: "#fafafa",
                            border: "1px solid #f0f0f0",
                            padding: 12,
                            borderRadius: 8
                          }}
                        >
                          {JSON.stringify({ data: record.data, error: record.error }, null, 2)}
                        </pre>
                      )
                    }}
                  />
                </Space>
              </Card>

              <Card className="content-card" title={t("quality.sources.title", { defaultValue: "Source Reliability" })} loading={loading}>
                {sources ? (
                  <Space direction="vertical" style={{ width: "100%" }} size="middle">
                    <Row gutter={[16, 16]}>
                      <Col xs={12} md={6}>
                        <Statistic title={t("quality.sources.total", { defaultValue: "Total sources" })} value={sources.totals.total} />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic title={t("quality.sources.active", { defaultValue: "Active" })} value={sources.totals.active} />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic title={t("quality.sources.failing", { defaultValue: "Failing" })} value={sources.totals.failing} />
                      </Col>
                      <Col xs={12} md={6}>
                        <Statistic title={t("quality.sources.circuitOpen", { defaultValue: "Circuit open" })} value={sources.totals.circuitOpen} />
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
                  <Typography.Text type="secondary">{t("common.empty", { defaultValue: "Empty" })}</Typography.Text>
                )}
              </Card>
            </Space>
          </Tabs.TabPane>

          <Tabs.TabPane tab={t("quality.tabs.classification", { defaultValue: "Classification" })} key="classification">
            <Space direction="vertical" style={{ width: "100%" }} size="large">
              <Card className="content-card" title={t("quality.classification.title", { defaultValue: "Classification Quality" })} loading={loading}>
                <Space direction="vertical" style={{ width: "100%" }} size="middle">
                  <Space wrap>
                    <Typography.Text type="secondary">
                      {t("quality.classification.window.label", { defaultValue: "Time window" })}
                    </Typography.Text>
                    <Select
                      value={classificationWindow}
                      onChange={(value: ClassificationWindow) => setClassificationWindow(value)}
                      options={[
                        { value: "1h", label: t("quality.classification.window.1h", { defaultValue: "Last 1h" }) },
                        { value: "24h", label: t("quality.classification.window.24h", { defaultValue: "Last 24h" }) },
                        { value: "7d", label: t("quality.classification.window.7d", { defaultValue: "Last 7d" }) }
                      ]}
                      style={{ width: 160 }}
                    />
                    <Button onClick={() => void load({ tab: "classification" })} loading={loading}>
                      {t("common.refresh", { defaultValue: "Refresh" })}
                    </Button>
                  </Space>

                  {classificationFilterSourceId || classificationFilterCategoryPrefix ? (
                    <Space wrap>
                      <Typography.Text type="secondary">
                        {t("quality.classification.filters.active", { defaultValue: "Active filters" })}:
                      </Typography.Text>
                      {classificationFilterSourceId ? (
                        <Tag closable onClose={() => setClassificationFilterSourceId(null)}>
                          {t("quality.classification.filters.source", { defaultValue: "Source" })}: {classificationFilterSourceId}
                        </Tag>
                      ) : null}
                      {classificationFilterCategoryPrefix ? (
                        <Tag closable onClose={() => setClassificationFilterCategoryPrefix(null)}>
                          {t("quality.classification.filters.category", { defaultValue: "Category" })}: {classificationFilterCategoryPrefix}
                        </Tag>
                      ) : null}
                      <Button
                        size="small"
                        onClick={() => {
                          setClassificationFilterSourceId(null);
                          setClassificationFilterCategoryPrefix(null);
                        }}
                      >
                        {t("quality.classification.filters.clear", { defaultValue: "Clear filters" })}
                      </Button>
                    </Space>
                  ) : null}

                  {classification ? (
                    <>
                      <Row gutter={[16, 16]}>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t("quality.classification.stats.total", { defaultValue: "Total classified" })}
                            value={classification.totalItems}
                          />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t("quality.classification.stats.pendingReviews", { defaultValue: "Pending review" })}
                            value={classification.pendingReviewCount}
                          />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t("quality.classification.stats.gateRejectRate", { defaultValue: "Gate reject rate" })}
                            value={toPercent(classification.categoryGate.rejectRate)}
                            suffix="%"
                          />
                        </Col>
                        <Col xs={12} md={6}>
                          <Statistic
                            title={t("quality.classification.stats.gatePenalizedRate", { defaultValue: "Gate penalized rate" })}
                            value={toPercent(classification.categoryGate.penalizedRate)}
                            suffix="%"
                          />
                        </Col>
                      </Row>
                      {classification.sampling ? (
                        <Space wrap>
                          <Tag color={classification.sampling.classifiedItems.truncated ? "orange" : "green"}>
                            items coverage {toPercent(classification.sampling.classifiedItems.coverage) ?? 0}% (
                            {classification.sampling.classifiedItems.scanned}/
                            {classification.sampling.classifiedItems.matched})
                          </Tag>
                          <Tag color={classification.sampling.latencyLogs.truncated ? "orange" : "green"}>
                            latency logs coverage {toPercent(classification.sampling.latencyLogs.coverage) ?? 0}% (
                            {classification.sampling.latencyLogs.scanned}/
                            {classification.sampling.latencyLogs.matched})
                          </Tag>
                          <Tag color={classification.sampling.gateLogs.truncated ? "orange" : "green"}>
                            gate logs coverage {toPercent(classification.sampling.gateLogs.coverage) ?? 0}% (
                            {classification.sampling.gateLogs.scanned}/
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
                    <Typography.Text type="secondary">{t("common.empty", { defaultValue: "Empty" })}</Typography.Text>
                  )}
                </Space>
              </Card>

              <Row gutter={[16, 16]}>
                <Col xs={24} xl={12}>
                  <Card
                    className="content-card"
                    title={t("quality.classification.histogram.title", { defaultValue: "Confidence Histogram" })}
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
                    title={t("quality.classification.trend.title", { defaultValue: "Confidence Trend" })}
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
                title={t("quality.classification.latency.title", { defaultValue: "Classification Latency & Gate" })}
                loading={loading}
              >
                {classification ? (
                  <Space direction="vertical" style={{ width: "100%" }} size="middle">
                    <Row gutter={[16, 16]}>
                      <Col xs={24} md={8}>
                        <Card size="small" title="LLM">
                          <Space direction="vertical" size={4}>
                            <Typography.Text>p50: {classification.latencyPercentiles.llm.p50Ms ?? "-" } ms</Typography.Text>
                            <Typography.Text>p95: {classification.latencyPercentiles.llm.p95Ms ?? "-" } ms</Typography.Text>
                            <Typography.Text>p99: {classification.latencyPercentiles.llm.p99Ms ?? "-" } ms</Typography.Text>
                            <Typography.Text type="secondary">
                              sample: {classification.latencyPercentiles.llm.sampleSize}
                            </Typography.Text>
                          </Space>
                        </Card>
                      </Col>
                      <Col xs={24} md={8}>
                        <Card size="small" title="Embedding">
                          <Space direction="vertical" size={4}>
                            <Typography.Text>p50: {classification.latencyPercentiles.embedding.p50Ms ?? "-" } ms</Typography.Text>
                            <Typography.Text>p95: {classification.latencyPercentiles.embedding.p95Ms ?? "-" } ms</Typography.Text>
                            <Typography.Text>p99: {classification.latencyPercentiles.embedding.p99Ms ?? "-" } ms</Typography.Text>
                            <Typography.Text type="secondary">
                              sample: {classification.latencyPercentiles.embedding.sampleSize}
                            </Typography.Text>
                          </Space>
                        </Card>
                      </Col>
                      <Col xs={24} md={8}>
                        <Card size="small" title="Rerank">
                          <Space direction="vertical" size={4}>
                            <Typography.Text>p50: {classification.latencyPercentiles.rerank.p50Ms ?? "-" } ms</Typography.Text>
                            <Typography.Text>p95: {classification.latencyPercentiles.rerank.p95Ms ?? "-" } ms</Typography.Text>
                            <Typography.Text>p99: {classification.latencyPercentiles.rerank.p99Ms ?? "-" } ms</Typography.Text>
                            <Typography.Text type="secondary">
                              sample: {classification.latencyPercentiles.rerank.sampleSize}
                            </Typography.Text>
                          </Space>
                        </Card>
                      </Col>
                    </Row>
                    <Space wrap>
                      <Tag color={classification.categoryGate.reject > 0 ? "red" : "default"}>
                        reject: {classification.categoryGate.reject}
                      </Tag>
                      <Tag color={classification.categoryGate.penalized > 0 ? "orange" : "default"}>
                        penalized: {classification.categoryGate.penalized}
                      </Tag>
                      <Tag>total: {classification.categoryGate.total}</Tag>
                      {classification.alertStatus.map((alert) => (
                        <Tag key={alert.stage} color={alert.triggered ? "red" : "green"}>
                          {alert.stage} p95 {alert.p95Ms ?? "-"} / {alert.thresholdMs} ms
                        </Tag>
                      ))}
                      {classification.gateAlertStatus.map((alert) => (
                        <Tag key={`gate-${alert.metric}`} color={alert.triggered ? "red" : "green"}>
                          {alert.metric} {toPercent(alert.value) ?? 0}% / {toPercent(alert.threshold) ?? 0}%
                        </Tag>
                      ))}
                    </Space>
                    <Table
                      rowKey={(row) => `${row.sourceType}:${row.categoryPrefix}`}
                      columns={classificationSourceCategoryColumns}
                      dataSource={classification.sourceCategoryBreakdown}
                      pagination={{ pageSize: 10, showSizeChanger: false }}
                      size={screens.md ? "middle" : "small"}
                      title={() =>
                        t("quality.classification.sourceCategory.title", {
                          defaultValue: "Source × Category Breakdown"
                        })
                      }
                    />
                  </Space>
                ) : (
                  <Typography.Text type="secondary">{t("common.empty", { defaultValue: "Empty" })}</Typography.Text>
                )}
              </Card>

              <Card
                className="content-card"
                title={t("quality.classification.review.title", { defaultValue: "Review Queue" })}
                loading={loading}
              >
                <Space direction="vertical" style={{ width: "100%" }} size="middle">
                  <Space wrap>
                    <Typography.Text type="secondary">
                      {t("quality.classification.review.onlyPending", { defaultValue: "Only pending" })}
                    </Typography.Text>
                    <Switch
                      checked={classificationReviewOnlyPending}
                      onChange={(checked) => setClassificationReviewOnlyPending(checked)}
                    />
                    <Button
                      onClick={() => void load({ tab: "classification" })}
                      loading={loading}
                    >
                      {t("common.refresh", { defaultValue: "Refresh" })}
                    </Button>
                  </Space>
                  <Space wrap>
                    <Button
                      disabled={classificationSelectedReviewIds.length === 0}
                      loading={classificationReviewSubmitting}
                      onClick={() => void submitClassificationBatchDecision("approved")}
                    >
                      {t("quality.classification.review.batch.approve", { defaultValue: "Batch approve" })}
                    </Button>
                    <Button
                      danger
                      disabled={classificationSelectedReviewIds.length === 0}
                      loading={classificationReviewSubmitting}
                      onClick={() => void submitClassificationBatchDecision("rejected")}
                    >
                      {t("quality.classification.review.batch.reject", { defaultValue: "Batch reject" })}
                    </Button>
                    <Button
                      type="dashed"
                      disabled={classificationSelectedReviewIds.length === 0}
                      loading={classificationReviewSubmitting}
                      onClick={() => {
                        const correctedPath = window.prompt(
                          t("quality.classification.review.correct.batchPrompt", {
                            defaultValue: "Input corrected category path for selected items"
                          }),
                          ""
                        );
                        if (!correctedPath || !correctedPath.trim()) {
                          return;
                        }
                        void submitClassificationBatchDecision("corrected", correctedPath);
                      }}
                    >
                      {t("quality.classification.review.batch.correct", { defaultValue: "Batch correct" })}
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
                          keys.map((entry) => String(entry)).filter((entry) => entry.length > 0)
                        )
                    }}
                    pagination={{ pageSize: 10, showSizeChanger: false }}
                    size={screens.md ? "middle" : "small"}
                  />
                </Space>
              </Card>

              <Card
                className="content-card"
                title={t("quality.classification.sources.title", { defaultValue: "Low Confidence Sources TOP10" })}
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
                  title={t("quality.classification.drilldown.title", {
                    defaultValue: "Source Drilldown"
                  })}
                  extra={<Typography.Text type="secondary">{classificationDrilldownSourceName || classificationDrilldownSourceId}</Typography.Text>}
                  loading={classificationSourceItemsLoading}
                >
                  <Space direction="vertical" style={{ width: "100%" }} size="middle">
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
                            ? void loadClassificationSourceItems(classificationDrilldownSourceId, classificationDrilldownSourceName ?? undefined, { append: true })
                            : undefined
                        }
                        disabled={!classificationSourceItemsCursor}
                        loading={classificationSourceItemsLoading}
                      >
                        {t("quality.classification.drilldown.loadMore", { defaultValue: "Load more" })}
                      </Button>
                      <Button
                        onClick={() => {
                          setClassificationDrilldownSourceId(null);
                          setClassificationDrilldownSourceName(null);
                          setClassificationSourceItems([]);
                          setClassificationSourceItemsCursor(null);
                        }}
                      >
                        {t("quality.classification.drilldown.close", { defaultValue: "Close" })}
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
