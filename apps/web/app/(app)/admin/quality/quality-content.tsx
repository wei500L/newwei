"use client";

import { Alert, Button, Card, Checkbox, Col, Divider, Grid, Input, InputNumber, Popover, Row, Select, Space, Spin, Statistic, Switch, Table, Tag, Tooltip, Typography, message } from "antd";
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

const msToSeconds = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value / 100) / 10 : undefined;

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
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
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
  const [windowMinutes, setWindowMinutes] = useState(60);
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
  const screens = Grid.useBreakpoint();

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

  const load = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    if (!silent) {
      setLoading(true);
    }
    try {
      const currentFilters = taskLogFiltersRef.current;
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
      setPipeline(pipelineRes.data ?? null);
      setSources(sourcesRes.data ?? null);
      setTaskLogs(Array.isArray(taskLogsRes.data) ? taskLogsRes.data : []);
      setTaskLogsSummary(taskLogSummaryRes.data ?? null);
      setLastUpdatedAt(new Date().toISOString());
    } catch (error) {
      captureClientError("Failed to load quality dashboard", error);
      if (!silent) {
        messageApi.error(t("quality.errors.loadFailed", { defaultValue: "Failed to load quality dashboard." }));
      }
      if (!silent) {
        setTaskLogsSummary(null);
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
      loadingRef.current = false;
    }
  }, [
    apiClient,
    messageApi,
    t,
    windowMinutes
  ]);

  const applyTaskLogFilters = useCallback((next: Partial<(typeof taskLogFiltersRef)["current"]>) => {
    const merged = { ...taskLogFiltersRef.current, ...next };
    taskLogFiltersRef.current = merged;
    setTaskLogsQueue(merged.queue);
    setTaskLogsStage(merged.stage);
    setTaskLogsStatus(merged.status);
    setTaskLogsLimit(merged.limit);
    setTaskLogsSinceMinutes(merged.sinceMinutes);
    void load();
  }, [load]);

  useEffect(() => {
    if (canView) {
      void load();
    }
  }, [canView, load]);

  useEffect(() => {
    if (!canView || !autoRefreshEnabled) {
      return;
    }
    const intervalMs = Math.max(5, Math.min(300, autoRefreshSeconds)) * 1000;
    const id = window.setInterval(() => {
      void load({ silent: true });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [autoRefreshEnabled, autoRefreshSeconds, canView, load]);

  const scheduleLiveRefresh = useCallback(() => {
    if (liveRefreshTimerRef.current) {
      return;
    }
    liveRefreshTimerRef.current = window.setTimeout(() => {
      liveRefreshTimerRef.current = null;
      void load({ silent: true });
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

      if (liveRefreshSourcesRef.current[source]) {
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
              <Button onClick={() => void load()} loading={loading}>
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
      </div>
    </>
  );
}
