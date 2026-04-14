"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  List,
  Modal,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { classifyHeadedIssue } from "@/lib/crawl-runtime";
import {
  getCrawl4aiSsrfProxyStatus,
  parseCrawl4aiSsrfProxyRuntimeState,
} from "@/lib/crawl4ai-ssrf-proxy";

interface CrawlMonitorContentProps {
  dashboardUrl: string;
}

type TransportMode = "ws" | "polling";

type WsStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error";
const WS_CONNECT_TIMEOUT_MS = 10_000;

type MonitorField =
  | "health"
  | "requests"
  | "browsers"
  | "endpointsStats"
  | "timeline"
  | "janitor"
  | "errors";

type MonitorErrorKind =
  | "notFound"
  | "baseUrlMissing"
  | "timeout"
  | "upstreamUnavailable"
  | "forbidden"
  | "unauthorized"
  | "unknown";

interface MonitorErrorInfo {
  kind: MonitorErrorKind;
  message: string;
  raw: string;
}

interface MonitorState {
  receivedAt: number;
  source: TransportMode;
  payloadTimestamp?: string | number;
  health?: unknown;
  requests?: unknown;
  browsers?: unknown;
  endpointsStats?: unknown;
  timeline?: unknown;
  janitor?: unknown;
  errors?: unknown;
}

interface Crawl4aiRuntimeProbeResult {
  ok: boolean;
  durationMs: number;
  status?: number;
  error?: string;
}

interface Crawl4aiRuntimeProbeState {
  checkedAt: string;
  baseUrl: string;
  headless: Crawl4aiRuntimeProbeResult;
  headed: Crawl4aiRuntimeProbeResult;
  xvfb?: { supported?: boolean; reason?: string };
  xvfbEnv?: { enabled?: string; displayNum?: string; screen?: string };
  ssrfProxy?: {
    enabled?: boolean;
    url?: string;
    probe?: Crawl4aiRuntimeProbeResult;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readPath(value: unknown, path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function readNumber(value: unknown, path: string[]): number | undefined {
  return asNumber(readPath(value, path));
}

function readArray(value: unknown, path: string[]): unknown[] {
  const v = readPath(value, path);
  return Array.isArray(v) ? v : [];
}

function getRecordValue(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function deriveWsUrl(dashboardUrl: string): string | null {
  try {
    const base = new URL(dashboardUrl);
    const ws = new URL("../monitor/ws", base);
    if (ws.protocol === "http:") ws.protocol = "ws:";
    else if (ws.protocol === "https:") ws.protocol = "wss:";
    else return null;
    return ws.toString();
  } catch {
    return null;
  }
}

function isDocumentVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

async function fetchMonitorJson(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
) {
  const url = new URL(`/api/crawl4ai/monitor/${path}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, { cache: "no-store" });
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(rawText || `HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return rawText ? (JSON.parse(rawText) as unknown) : null;
  }
  return rawText;
}

async function postMonitorJson(path: string, body?: unknown) {
  const response = await fetch(`/api/crawl4ai/monitor/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
    cache: "no-store",
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(rawText || `HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return rawText ? (JSON.parse(rawText) as unknown) : null;
  }
  return rawText;
}

async function fetchRuntimeProbeJson() {
  const response = await fetch("/api/crawl4ai/runtime", { cache: "no-store" });
  const rawText = await response.text();
  if (!response.ok) {
    try {
      const payload = rawText ? (JSON.parse(rawText) as unknown) : null;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const error = (payload as { error?: unknown }).error;
        if (typeof error === "string" && error.trim()) {
          throw new Error(error.trim());
        }
      }
    } catch {
      // ignore json parsing errors
    }
    throw new Error(rawText || `HTTP ${response.status}`);
  }
  if (!rawText) {
    throw new Error("Empty runtime probe response");
  }
  return JSON.parse(rawText) as unknown;
}

function formatReceivedAt(ts: number): string {
  return dayjs(ts).format("HH:mm:ss");
}

function normalizeTimelineSeries(
  input: unknown,
): { labels: string[]; values: number[] } | null {
  if (!input) return null;

  if (Array.isArray(input)) {
    const values = input.map((entry) => {
      if (typeof entry === "number") return entry;
      if (Array.isArray(entry) && entry.length >= 2) return asNumber(entry[1]);
      if (isRecord(entry))
        return asNumber(getRecordValue(entry, ["value", "v", "y"]));
      return undefined;
    });
    if (values.some((v) => typeof v === "number")) {
      return {
        labels: values.map((_, idx) => String(idx)),
        values: values.map((v) => v ?? 0),
      };
    }
  }

  if (isRecord(input)) {
    const timestamps = getRecordValue(input, ["timestamps", "ts", "t", "x"]);
    const values = getRecordValue(input, ["values", "data", "v", "y"]);

    if (Array.isArray(timestamps) && Array.isArray(values)) {
      const parsedValues = values.map((v) => asNumber(v) ?? 0);
      const labels = timestamps.map((t) => {
        const s = asString(t);
        if (s) return dayjs(s).format("HH:mm:ss");
        const n = asNumber(t);
        if (typeof n === "number") return dayjs(n * 1000).format("HH:mm:ss");
        return "";
      });
      return { labels, values: parsedValues };
    }

    const points = getRecordValue(input, ["points", "items"]);
    if (Array.isArray(points)) {
      const labels: string[] = [];
      const parsedValues: number[] = [];
      for (const point of points) {
        if (!isRecord(point)) continue;
        const v = asNumber(getRecordValue(point, ["value", "v", "y"]));
        if (typeof v !== "number") continue;
        const ts = getRecordValue(point, ["timestamp", "t", "x"]);
        const label = (() => {
          const s = asString(ts);
          if (s) return dayjs(s).format("HH:mm:ss");
          const n = asNumber(ts);
          if (typeof n === "number") return dayjs(n * 1000).format("HH:mm:ss");
          return "";
        })();
        labels.push(label);
        parsedValues.push(v);
      }
      if (parsedValues.length > 0) {
        return { labels, values: parsedValues };
      }
    }
  }

  return null;
}

function normalizeBrowserTimelineSeries(input: unknown): {
  labels: string[];
  permanent: number[];
  hot: number[];
  cold: number[];
} | null {
  if (!input) return null;

  if (Array.isArray(input)) {
    const labels: string[] = [];
    const permanent: number[] = [];
    const hot: number[] = [];
    const cold: number[] = [];

    for (const entry of input) {
      if (!isRecord(entry)) continue;
      const ts = getRecordValue(entry, ["timestamp", "t", "x"]);
      const label = (() => {
        const s = asString(ts);
        if (s) return dayjs(s).format("HH:mm:ss");
        const n = asNumber(ts);
        if (typeof n === "number") return dayjs(n * 1000).format("HH:mm:ss");
        return "";
      })();

      const per = asNumber(getRecordValue(entry, ["permanent", "perm"])) ?? 0;
      const h = asNumber(getRecordValue(entry, ["hot"])) ?? 0;
      const c = asNumber(getRecordValue(entry, ["cold"])) ?? 0;
      labels.push(label);
      permanent.push(per);
      hot.push(h);
      cold.push(c);
    }

    if (labels.length > 0) {
      return { labels, permanent, hot, cold };
    }
  }

  if (isRecord(input)) {
    const timestamps = getRecordValue(input, ["timestamps", "ts", "t", "x"]);
    const values = getRecordValue(input, ["values", "data", "v", "y"]);

    if (
      Array.isArray(timestamps) &&
      Array.isArray(values) &&
      values.some((entry) => isRecord(entry))
    ) {
      const labels = timestamps.map((t) => {
        const s = asString(t);
        if (s) return dayjs(s).format("HH:mm:ss");
        const n = asNumber(t);
        if (typeof n === "number") return dayjs(n * 1000).format("HH:mm:ss");
        return "";
      });
      return {
        labels,
        permanent: values.map((entry) => {
          if (!isRecord(entry)) return 0;
          return asNumber(getRecordValue(entry, ["permanent", "perm"])) ?? 0;
        }),
        hot: values.map((entry) => {
          if (!isRecord(entry)) return 0;
          return asNumber(getRecordValue(entry, ["hot"])) ?? 0;
        }),
        cold: values.map((entry) => {
          if (!isRecord(entry)) return 0;
          return asNumber(getRecordValue(entry, ["cold"])) ?? 0;
        }),
      };
    }

    if (Array.isArray(timestamps)) {
      const permanent = getRecordValue(input, ["permanent", "perm"]);
      const hot = getRecordValue(input, ["hot"]);
      const cold = getRecordValue(input, ["cold"]);
      if (
        Array.isArray(permanent) &&
        Array.isArray(hot) &&
        Array.isArray(cold)
      ) {
        const labels = timestamps.map((t) => {
          const s = asString(t);
          if (s) return dayjs(s).format("HH:mm:ss");
          const n = asNumber(t);
          if (typeof n === "number") return dayjs(n * 1000).format("HH:mm:ss");
          return "";
        });
        return {
          labels,
          permanent: permanent.map((v) => asNumber(v) ?? 0),
          hot: hot.map((v) => asNumber(v) ?? 0),
          cold: cold.map((v) => asNumber(v) ?? 0),
        };
      }
    }
  }

  const series = normalizeTimelineSeries(input);
  if (series) {
    return {
      labels: series.labels,
      permanent: series.values,
      hot: series.values.map(() => 0),
      cold: series.values.map(() => 0),
    };
  }

  return null;
}

function buildLineOption(
  title: string,
  labels: string[],
  values: number[],
  color: string,
  axisColor: string,
): EChartsOption {
  return {
    title: {
      text: title,
      left: 8,
      top: 8,
      textStyle: { fontSize: 12, fontWeight: 600 },
    },
    tooltip: { trigger: "axis" },
    grid: { left: 40, right: 16, top: 40, bottom: 30 },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: { color: axisColor, fontSize: 10 },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: axisColor, fontSize: 10 },
      splitLine: { show: true },
    },
    series: [
      {
        type: "line",
        data: values,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color },
        areaStyle: { color },
      },
    ],
  };
}

function buildBrowserOption(
  title: string,
  labels: string[],
  data: { permanent: number[]; hot: number[]; cold: number[] },
  colors: { permanent: string; hot: string; cold: string },
  axisColor: string,
): EChartsOption {
  return {
    title: {
      text: title,
      left: 8,
      top: 8,
      textStyle: { fontSize: 12, fontWeight: 600 },
    },
    tooltip: { trigger: "axis" },
    legend: { top: 24, left: 8, textStyle: { fontSize: 10 } },
    grid: { left: 40, right: 16, top: 56, bottom: 30 },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: { color: axisColor, fontSize: 10 },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: axisColor, fontSize: 10 },
      splitLine: { show: true },
    },
    series: [
      {
        name: "permanent",
        type: "line",
        data: data.permanent,
        stack: "total",
        smooth: true,
        showSymbol: false,
        areaStyle: { opacity: 0.2, color: colors.permanent },
        lineStyle: { width: 2, color: colors.permanent },
      },
      {
        name: "hot",
        type: "line",
        data: data.hot,
        stack: "total",
        smooth: true,
        showSymbol: false,
        areaStyle: { opacity: 0.2, color: colors.hot },
        lineStyle: { width: 2, color: colors.hot },
      },
      {
        name: "cold",
        type: "line",
        data: data.cold,
        stack: "total",
        smooth: true,
        showSymbol: false,
        areaStyle: { opacity: 0.2, color: colors.cold },
        lineStyle: { width: 2, color: colors.cold },
      },
    ],
  };
}

function normalizeTimestamp(input: unknown): string | undefined {
  const s = asString(input);
  if (s) return s;

  const n = asNumber(input);
  if (typeof n !== "number") return undefined;

  // Crawl4AI's monitoring payload may emit:
  // - unix seconds (e.g. 1769652909)
  // - unix milliseconds (e.g. 1769652909000)
  // - monotonic seconds (e.g. 105313.04) -> not convertible to an absolute timestamp
  if (n > 10_000_000_000) return dayjs(n).toISOString();
  if (n > 1_000_000_000) return dayjs(n * 1000).toISOString();

  return undefined;
}

function getLastNumericValue(values: unknown[]): number | undefined {
  for (let idx = values.length - 1; idx >= 0; idx -= 1) {
    const n = asNumber(values[idx]);
    if (typeof n === "number") return n;
  }
  return undefined;
}

function deriveTimelineTimestamp(timeline: unknown): number | undefined {
  const memory = getLastNumericValue(
    readArray(timeline, ["memory", "timestamps"]),
  );
  const requests = getLastNumericValue(
    readArray(timeline, ["requests", "timestamps"]),
  );
  const browsers = getLastNumericValue(
    readArray(timeline, ["browsers", "timestamps"]),
  );

  const candidates = [memory, requests, browsers].filter(
    (value): value is number => typeof value === "number",
  );
  if (candidates.length === 0) return undefined;
  return Math.max(...candidates);
}

function normalizeLogList(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (isRecord(input)) {
    const items = getRecordValue(input, [
      "items",
      "logs",
      "events",
      "errors",
      "data",
    ]);
    if (Array.isArray(items)) return items;
  }
  return [];
}

function getRequestSuccess(item: unknown): boolean | undefined {
  if (!isRecord(item)) return undefined;
  const success = asBoolean(getRecordValue(item, ["success"]));
  if (success !== undefined) return success;
  const status = asString(getRecordValue(item, ["status"]))?.toLowerCase();
  if (!status) return undefined;
  if (status === "success" || status === "ok" || status === "completed")
    return true;
  if (status === "error" || status === "failed" || status === "fail")
    return false;
  return undefined;
}

function normalizeBrowserSigForAction(sig: string): string {
  const trimmed = sig.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "permanent") return trimmed;
  return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
}

function getRequestRowKey(item: unknown, fallback: string): string {
  if (!isRecord(item)) return fallback;
  const requestId = asString(
    getRecordValue(item, ["request_id", "requestId", "id"]),
  );
  if (requestId) return requestId;
  const endpoint = asString(
    getRecordValue(item, ["endpoint", "path", "route"]),
  );
  const url = asString(getRecordValue(item, ["url"]));
  if (endpoint && url) return `${endpoint}:${url}`;
  if (url) return url;
  return fallback;
}

function getBrowserRowKey(item: unknown, fallback: string): string {
  if (!isRecord(item)) return fallback;
  const signature = asString(getRecordValue(item, ["signature", "sig"]));
  if (signature) return signature;
  const browserId = asString(
    getRecordValue(item, ["browser_id", "browserId", "id"]),
  );
  if (browserId) return browserId;
  return fallback;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function normalizeMonitorError(raw: string): MonitorErrorInfo {
  const trimmed = raw.trim();
  const parsed = tryParseJson(trimmed);

  let message = trimmed || "Unknown error";
  if (isRecord(parsed)) {
    const errorMessage = asString(
      getRecordValue(parsed, ["message", "error", "detail"]),
    );
    if (errorMessage) {
      message = errorMessage;
    }
    const details = asString(getRecordValue(parsed, ["details"]));
    if (details) {
      message = `${message}\n${details}`;
    }
  }

  const lower = message.toLowerCase();
  let kind: MonitorErrorKind = "unknown";

  if (message === "Not Found" || trimmed.includes('"detail":"Not Found"')) {
    kind = "notFound";
  } else if (lower.includes("crawl4ai_base_url")) {
    kind = "baseUrlMissing";
  } else if (lower.includes("timed out")) {
    kind = "timeout";
  } else if (lower.includes("unauthorized") || lower.includes("http 401")) {
    kind = "unauthorized";
  } else if (lower.includes("forbidden") || lower.includes("http 403")) {
    kind = "forbidden";
  } else if (
    lower.includes("monitor request failed") ||
    lower.includes("bad gateway") ||
    lower.includes("fetch failed") ||
    lower.includes("http 502") ||
    lower.includes("enotfound") ||
    lower.includes("econnrefused")
  ) {
    kind = "upstreamUnavailable";
  }

  return { kind, message, raw: trimmed };
}

export function CrawlMonitorContent({
  dashboardUrl,
}: CrawlMonitorContentProps) {
  const { t } = useTranslation();
  const { data: session, status } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canView =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");
  const canManage = permissions.includes("crawl.write");
  const [messageApi, contextHolder] = message.useMessage();
  const chartTheme = useChartTheme();

  const normalizedDashboardUrl = dashboardUrl?.trim();
  const wsUrl = useMemo(
    () => (normalizedDashboardUrl ? deriveWsUrl(normalizedDashboardUrl) : null),
    [normalizedDashboardUrl],
  );

  const [mode, setMode] = useState<TransportMode>(() =>
    wsUrl ? "ws" : "polling",
  );
  const [wsStatus, setWsStatus] = useState<WsStatus>("idle");
  const [wsError, setWsError] = useState<string | null>(null);
  const [monitor, setMonitor] = useState<MonitorState | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [runtimeProbe, setRuntimeProbe] =
    useState<Crawl4aiRuntimeProbeState | null>(null);
  const [runtimeProbeError, setRuntimeProbeError] = useState<string | null>(
    null,
  );
  const [completedFilter, setCompletedFilter] = useState<
    "all" | "success" | "error"
  >("all");
  const [refreshing, setRefreshing] = useState(false);
  const [detailModal, setDetailModal] = useState<{
    title: string;
    payload: unknown;
  } | null>(null);
  const [documentVisible, setDocumentVisible] = useState(isDocumentVisible);

  const modeRef = useRef<TransportMode>(mode);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutId = useRef<number | null>(null);
  const wsConnectTimeoutId = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setDocumentVisible(isDocumentVisible());
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const pollErrorInfo = useMemo(() => {
    if (!pollError) return null;
    return normalizeMonitorError(pollError);
  }, [pollError]);

  const pollErrorHelp = useMemo(() => {
    if (!pollErrorInfo) return null;

    if (pollErrorInfo.kind === "notFound") {
      return (
        <Space direction="vertical" size={2}>
          <Typography.Text type="secondary">
            {t("crawl.monitor.troubleshoot.notFound", {
              defaultValue:
                "Crawl4AI monitoring endpoints are missing. This usually means the crawl4ai image tag is wrong/too old (Docker Hub :latest is a common culprit). Prefer the floating Docker Hub tag :0 or a recent release tag.",
            })}
          </Typography.Text>
          <Typography.Text code>
            CRAWL4AI_IMAGE=unclecode/crawl4ai:0
          </Typography.Text>
          <Typography.Text code>
            pnpm docker:up:extras -d --force-recreate crawl4ai
          </Typography.Text>
        </Space>
      );
    }

    if (pollErrorInfo.kind === "baseUrlMissing") {
      return (
        <Space direction="vertical" size={2}>
          <Typography.Text type="secondary">
            {t("crawl.monitor.troubleshoot.baseUrlMissing", {
              defaultValue:
                "CRAWL4AI_BASE_URL is not configured for the web runtime. Set it and restart the web server.",
            })}
          </Typography.Text>
          <Typography.Text code>
            CRAWL4AI_BASE_URL=http://crawl4ai:11235
          </Typography.Text>
          <Typography.Text code>
            CRAWL4AI_BASE_URL=http://localhost:8082
          </Typography.Text>
        </Space>
      );
    }

    if (pollErrorInfo.kind === "upstreamUnavailable") {
      return (
        <Space direction="vertical" size={2}>
          <Typography.Text type="secondary">
            {t("crawl.monitor.troubleshoot.upstreamUnavailable", {
              defaultValue:
                "Crawl4AI is not reachable from the web server. Ensure the extras profile is running, then check the crawl4ai container logs.",
            })}
          </Typography.Text>
          <Typography.Text code>
            pnpm docker:up:extras -d crawl4ai
          </Typography.Text>
          <Typography.Text code>pnpm docker:logs</Typography.Text>
        </Space>
      );
    }

    if (pollErrorInfo.kind === "timeout") {
      return (
        <Typography.Text type="secondary">
          {t("crawl.monitor.troubleshoot.timeout", {
            defaultValue:
              "Monitor request timed out. Crawl4AI may be overloaded or starting up. Check container health and try again.",
          })}
        </Typography.Text>
      );
    }

    if (
      pollErrorInfo.kind === "unauthorized" ||
      pollErrorInfo.kind === "forbidden"
    ) {
      return (
        <Typography.Text type="secondary">
          {t("crawl.monitor.troubleshoot.auth", {
            defaultValue:
              "Access denied. Make sure you are logged in and have crawl.read/crawl.write permissions.",
          })}
        </Typography.Text>
      );
    }

    return null;
  }, [pollErrorInfo, t]);

  const handleOpen = () => {
    if (!normalizedDashboardUrl) return;
    window.open(normalizedDashboardUrl, "_blank", "noopener,noreferrer");
  };

  const handleCopy = async () => {
    if (!normalizedDashboardUrl) return;
    try {
      await navigator.clipboard.writeText(normalizedDashboardUrl);
      messageApi.success(
        t("crawl.monitor.copied", { defaultValue: "Copied dashboard URL." }),
      );
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("crawl.monitor.copyFailed", { defaultValue: "Copy failed." }),
      );
    }
  };

  const handleCopyApi = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/api/crawl4ai/monitor/health`,
      );
      messageApi.success(
        t("crawl.monitor.apiCopied", { defaultValue: "Copied API base URL." }),
      );
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("crawl.monitor.copyFailed", { defaultValue: "Copy failed." }),
      );
    }
  };

  const handleCopyWs = async () => {
    if (!wsUrl) return;
    try {
      await navigator.clipboard.writeText(wsUrl);
      messageApi.success(
        t("crawl.monitor.wsCopied", { defaultValue: "Copied WebSocket URL." }),
      );
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("crawl.monitor.copyFailed", { defaultValue: "Copy failed." }),
      );
    }
  };

  const handleRefreshNow = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const runtimePromise = fetchRuntimeProbeJson()
        .then((payload) => {
          setRuntimeProbeError(null);
          return payload;
        })
        .catch((error) => {
          setRuntimeProbeError(
            error instanceof Error ? error.message : String(error),
          );
          return null;
        });

      const [
        health,
        requests,
        browsers,
        endpointsStats,
        timelineMemory,
        timelineRequests,
        timelineBrowsers,
        janitor,
        errors,
      ] = await Promise.all([
        fetchMonitorJson("health"),
        fetchMonitorJson("requests", { status: "all", limit: 200 }),
        fetchMonitorJson("browsers"),
        fetchMonitorJson("endpoints/stats"),
        fetchMonitorJson("timeline", { metric: "memory", window: "5m" }),
        fetchMonitorJson("timeline", { metric: "requests", window: "5m" }),
        fetchMonitorJson("timeline", { metric: "browsers", window: "5m" }),
        fetchMonitorJson("logs/janitor", { limit: 100 }),
        fetchMonitorJson("logs/errors", { limit: 100 }),
      ]);

      const timeline = {
        memory: timelineMemory,
        requests: timelineRequests,
        browsers: timelineBrowsers,
      };
      const derivedTimestamp = normalizeTimestamp(
        deriveTimelineTimestamp(timeline),
      );

      setMonitor((prev) => ({
        receivedAt: Date.now(),
        source: mode,
        payloadTimestamp: derivedTimestamp ?? prev?.payloadTimestamp,
        health,
        requests,
        browsers,
        endpointsStats,
        timeline,
        janitor,
        errors,
      }));

      const runtime = await runtimePromise;
      if (runtime && isRecord(runtime)) {
        setRuntimeProbe(runtime as unknown as Crawl4aiRuntimeProbeState);
      }

      messageApi.success(
        t("crawl.monitor.refresh.success", { defaultValue: "Refreshed." }),
      );
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("crawl.monitor.refresh.failed", {
              defaultValue: "Refresh failed.",
            }),
      );
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!canView) return;
    if (status !== "authenticated") return;

    fetchRuntimeProbeJson()
      .then((payload) => {
        if (isRecord(payload)) {
          setRuntimeProbe(payload as unknown as Crawl4aiRuntimeProbeState);
          setRuntimeProbeError(null);
        }
      })
      .catch((error) => {
        setRuntimeProbeError(
          error instanceof Error ? error.message : String(error),
        );
      });
  }, [canView, status]);

  const updateMonitorField = useCallback(
    (field: MonitorField, value: unknown) => {
      setMonitor((prev) => {
        const next: MonitorState = {
          receivedAt: Date.now(),
          source: mode,
          ...(prev ?? {}),
        };
        next[field] = value;
        return next;
      });
    },
    [mode],
  );

  const refreshPollingSnapshot = useCallback(
    async (kind: "core" | "extended") => {
      if (kind === "core") {
        const [health, requests, browsers] = await Promise.all([
          fetchMonitorJson("health"),
          fetchMonitorJson("requests"),
          fetchMonitorJson("browsers"),
        ]);
        setMonitor((prev) => ({
          receivedAt: Date.now(),
          source: "polling",
          payloadTimestamp: prev?.payloadTimestamp,
          health,
          requests,
          browsers,
          endpointsStats: prev?.endpointsStats,
          timeline: prev?.timeline,
          janitor: prev?.janitor,
          errors: prev?.errors,
        }));
        return;
      }

      const [
        endpointsStats,
        timelineMemory,
        timelineRequests,
        timelineBrowsers,
        janitor,
        errors,
      ] = await Promise.allSettled([
        fetchMonitorJson("endpoints/stats"),
        fetchMonitorJson("timeline", { metric: "memory", window: "5m" }),
        fetchMonitorJson("timeline", { metric: "requests", window: "5m" }),
        fetchMonitorJson("timeline", { metric: "browsers", window: "5m" }),
        fetchMonitorJson("logs/janitor", { limit: 100 }),
        fetchMonitorJson("logs/errors", { limit: 100 }),
      ]);

      if (endpointsStats.status === "fulfilled")
        updateMonitorField("endpointsStats", endpointsStats.value);
      if (
        timelineMemory.status === "fulfilled" ||
        timelineRequests.status === "fulfilled" ||
        timelineBrowsers.status === "fulfilled"
      ) {
        setMonitor((prev) => {
          const prevTimeline = prev?.timeline;
          const nextTimeline: Record<string, unknown> = isRecord(prevTimeline)
            ? { ...prevTimeline }
            : {};
          if (timelineMemory.status === "fulfilled")
            nextTimeline.memory = timelineMemory.value;
          if (timelineRequests.status === "fulfilled")
            nextTimeline.requests = timelineRequests.value;
          if (timelineBrowsers.status === "fulfilled")
            nextTimeline.browsers = timelineBrowsers.value;
          const derivedTimestamp = normalizeTimestamp(
            deriveTimelineTimestamp(nextTimeline),
          );
          return {
            receivedAt: Date.now(),
            source: "polling",
            ...(prev ?? {}),
            payloadTimestamp: derivedTimestamp ?? prev?.payloadTimestamp,
            timeline: nextTimeline,
          };
        });
      }
      if (janitor.status === "fulfilled")
        updateMonitorField("janitor", janitor.value);
      if (errors.status === "fulfilled")
        updateMonitorField("errors", errors.value);
    },
    [updateMonitorField],
  );

  const connectWebSocket = useCallback(() => {
    if (!wsUrl) {
      setWsStatus("error");
      setWsError(
        t("crawl.monitor.ws.missingUrl", {
          defaultValue: "WebSocket URL not available.",
        }),
      );
      return;
    }

    if (reconnectTimeoutId.current) {
      window.clearTimeout(reconnectTimeoutId.current);
      reconnectTimeoutId.current = null;
    }
    if (wsConnectTimeoutId.current) {
      window.clearTimeout(wsConnectTimeoutId.current);
      wsConnectTimeoutId.current = null;
    }

    try {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setWsStatus((prev) =>
        prev === "connected" ? "connected" : "connecting",
      );
      setWsError(null);

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      wsConnectTimeoutId.current = window.setTimeout(() => {
        if (wsRef.current !== ws || ws.readyState !== WebSocket.CONNECTING) {
          return;
        }
        setWsStatus("error");
        setWsError(
          t("crawl.monitor.ws.timeout", {
            defaultValue:
              "WebSocket connection timed out. Retrying automatically...",
          }),
        );
        ws.close();
      }, WS_CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        if (wsConnectTimeoutId.current) {
          window.clearTimeout(wsConnectTimeoutId.current);
          wsConnectTimeoutId.current = null;
        }
        reconnectAttempts.current = 0;
        setWsStatus("connected");
        setWsError(null);
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        try {
          const parsed = JSON.parse(String(event.data)) as unknown;
          if (!isRecord(parsed)) return;
          const derivedTimestamp =
            normalizeTimestamp(parsed.timestamp) ??
            normalizeTimestamp(deriveTimelineTimestamp(parsed.timeline));
          setMonitor((prev) => ({
            receivedAt: Date.now(),
            source: "ws",
            payloadTimestamp: derivedTimestamp ?? prev?.payloadTimestamp,
            health: parsed.health ?? prev?.health,
            requests: parsed.requests ?? prev?.requests,
            browsers: parsed.browsers ?? prev?.browsers,
            endpointsStats:
              parsed.endpointsStats ?? parsed.endpoints ?? prev?.endpointsStats,
            timeline: parsed.timeline ?? prev?.timeline,
            janitor: parsed.janitor ?? prev?.janitor,
            errors: parsed.errors ?? prev?.errors,
          }));
        } catch {
          // ignore malformed payloads
        }
      };

      ws.onerror = () => {
        if (wsRef.current !== ws) return;
        if (wsConnectTimeoutId.current) {
          window.clearTimeout(wsConnectTimeoutId.current);
          wsConnectTimeoutId.current = null;
        }
        setWsStatus("error");
        setWsError(
          t("crawl.monitor.ws.error", { defaultValue: "WebSocket error." }),
        );
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        if (wsConnectTimeoutId.current) {
          window.clearTimeout(wsConnectTimeoutId.current);
          wsConnectTimeoutId.current = null;
        }
        wsRef.current = null;
        if (modeRef.current !== "ws") return;
        const attempt = reconnectAttempts.current + 1;
        reconnectAttempts.current = attempt;
        const delayMs = Math.min(
          30_000,
          1_000 * Math.pow(2, Math.min(attempt, 5)),
        );
        setWsStatus("reconnecting");
        setWsError(
          t("crawl.monitor.ws.reconnecting", {
            defaultValue: "Disconnected. Reconnecting...",
          }),
        );
        reconnectTimeoutId.current = window.setTimeout(
          () => connectWebSocket(),
          delayMs,
        );
      };
    } catch (error) {
      setWsStatus("error");
      setWsError(
        error instanceof Error
          ? error.message
          : t("crawl.monitor.ws.error", { defaultValue: "WebSocket error." }),
      );
    }
  }, [t, wsUrl]);

  const openDetailModal = useCallback((title: string, payload: unknown) => {
    setDetailModal({ title, payload });
  }, []);

  const closeDetailModal = useCallback(() => {
    setDetailModal(null);
  }, []);

  const openRequestDetails = useCallback(
    (payload: unknown) => {
      openDetailModal(
        t("crawl.monitor.details.request", {
          defaultValue: "Request details",
        }),
        payload,
      );
    },
    [openDetailModal, t],
  );

  const handleCopyDetail = useCallback(async () => {
    if (!detailModal) return;
    try {
      await navigator.clipboard.writeText(
        safeJsonStringify(detailModal.payload),
      );
      messageApi.success(
        t("crawl.monitor.details.copied", { defaultValue: "Copied." }),
      );
    } catch (error) {
      messageApi.error(
        error instanceof Error
          ? error.message
          : t("crawl.monitor.copyFailed", { defaultValue: "Copy failed." }),
      );
    }
  }, [detailModal, messageApi, t]);

  useEffect(() => {
    if (mode !== "ws") {
      wsRef.current?.close();
      wsRef.current = null;
      if (reconnectTimeoutId.current) {
        window.clearTimeout(reconnectTimeoutId.current);
        reconnectTimeoutId.current = null;
      }
      if (wsConnectTimeoutId.current) {
        window.clearTimeout(wsConnectTimeoutId.current);
        wsConnectTimeoutId.current = null;
      }
      setWsStatus("idle");
      setWsError(null);
      return;
    }

    connectWebSocket();

    return () => {
      wsRef.current?.close();
      wsRef.current = null;
      if (reconnectTimeoutId.current) {
        window.clearTimeout(reconnectTimeoutId.current);
        reconnectTimeoutId.current = null;
      }
      if (wsConnectTimeoutId.current) {
        window.clearTimeout(wsConnectTimeoutId.current);
        wsConnectTimeoutId.current = null;
      }
    };
  }, [connectWebSocket, mode]);

  useEffect(() => {
    if (mode !== "polling" || !documentVisible) {
      setPollError(null);
      return;
    }

    let mounted = true;
    let coreInFlight = false;
    let extendedInFlight = false;
    let pendingCore = false;
    let pendingExtended = false;
    const runCore = async () => {
      if (coreInFlight) {
        pendingCore = true;
        return;
      }
      coreInFlight = true;
      try {
        await refreshPollingSnapshot("core");
        if (mounted) setPollError(null);
      } catch (error) {
        if (!mounted) return;
        setPollError(error instanceof Error ? error.message : "Polling failed");
      } finally {
        coreInFlight = false;
        if (mounted && pendingCore) {
          pendingCore = false;
          void runCore();
        }
      }
    };
    const runExtended = async () => {
      if (extendedInFlight) {
        pendingExtended = true;
        return;
      }
      extendedInFlight = true;
      try {
        await refreshPollingSnapshot("extended");
      } catch {
        // ignore extended errors
      } finally {
        extendedInFlight = false;
        if (mounted && pendingExtended) {
          pendingExtended = false;
          void runExtended();
        }
      }
    };

    void runCore();
    void runExtended();

    const coreId = window.setInterval(runCore, 5_000);
    const extendedId = window.setInterval(runExtended, 30_000);

    return () => {
      mounted = false;
      window.clearInterval(coreId);
      window.clearInterval(extendedId);
    };
  }, [documentVisible, mode, refreshPollingSnapshot]);

  const health = monitor?.health;
  const requests = monitor?.requests;
  const browsers = monitor?.browsers;
  const endpointsStats = monitor?.endpointsStats;
  const timeline = monitor?.timeline;
  const janitor = monitor?.janitor;
  const errors = monitor?.errors;

  const activeRequests = useMemo(
    () => readArray(requests, ["active"]),
    [requests],
  );
  const completedRequests = useMemo(
    () => readArray(requests, ["completed"]),
    [requests],
  );
  const filteredCompletedRequests = useMemo(() => {
    if (completedFilter === "all") return completedRequests;
    return completedRequests.filter((item) => {
      const success = getRequestSuccess(item);
      if (completedFilter === "success") return success === true;
      if (completedFilter === "error") return success === false;
      return true;
    });
  }, [completedFilter, completedRequests]);
  const activeRequestRows = useMemo(
    () =>
      activeRequests.map((item, idx) => ({
        key: getRequestRowKey(item, String(idx)),
        item,
      })),
    [activeRequests],
  );
  const completedRequestRows = useMemo(
    () =>
      filteredCompletedRequests.map((item, idx) => ({
        key: getRequestRowKey(item, String(idx)),
        item,
      })),
    [filteredCompletedRequests],
  );
  const completedCounts = useMemo(() => {
    let success = 0;
    let error = 0;
    let unknown = 0;
    for (const item of completedRequests) {
      const s = getRequestSuccess(item);
      if (s === true) success += 1;
      else if (s === false) error += 1;
      else unknown += 1;
    }
    return { success, error, unknown };
  }, [completedRequests]);

  const browsersSummary = useMemo(() => {
    if (isRecord(browsers)) {
      const summary = readPath(browsers, ["summary"]);
      return isRecord(summary) ? summary : null;
    }
    return null;
  }, [browsers]);

  const browserItems = useMemo(() => {
    if (Array.isArray(browsers)) {
      return browsers;
    }
    if (isRecord(browsers)) {
      const list = readPath(browsers, ["browsers"]);
      if (Array.isArray(list)) return list;
    }
    return [];
  }, [browsers]);

  const endpointStatRows = useMemo(() => {
    if (!isRecord(endpointsStats)) return [];
    return Object.entries(endpointsStats).map(([endpoint, stats]) => ({
      key: endpoint,
      endpoint,
      stats,
    }));
  }, [endpointsStats]);
  const endpointsChartOption = useMemo<EChartsOption | null>(() => {
    if (endpointStatRows.length === 0) return null;
    const parsed = endpointStatRows
      .map((row) => {
        const stats = row.stats;
        const count = isRecord(stats)
          ? asNumber(getRecordValue(stats, ["count"]))
          : undefined;
        const latency = isRecord(stats)
          ? asNumber(getRecordValue(stats, ["avg_latency_ms", "avgLatencyMs"]))
          : undefined;
        const success = isRecord(stats)
          ? asNumber(
              getRecordValue(stats, [
                "success_rate_percent",
                "successRatePercent",
              ]),
            )
          : undefined;
        return {
          endpoint: row.endpoint,
          count: count ?? 0,
          latency: latency ?? 0,
          success: success ?? 0,
        };
      })
      .filter((row) => row.endpoint && Number.isFinite(row.count));

    parsed.sort((a, b) => b.count - a.count);
    const top = parsed.slice(0, 10).reverse();

    return {
      title: {
        text: t("crawl.monitor.endpoints.chartTitle", {
          defaultValue: "Top endpoints (by count)",
        }),
        left: 8,
        top: 8,
        textStyle: { fontSize: 12, fontWeight: 600 },
      },
      tooltip: { trigger: "axis" },
      grid: { left: 120, right: 24, top: 40, bottom: 20 },
      xAxis: { type: "value" },
      yAxis: {
        type: "category",
        data: top.map((row) => row.endpoint),
        axisLabel: { fontSize: 10 },
      },
      series: [
        {
          type: "bar",
          data: top.map((row) => row.count),
          itemStyle: { color: chartTheme.colors.primary },
        },
      ],
    } satisfies EChartsOption;
  }, [chartTheme.colors.primary, endpointStatRows, t]);

  const memorySeries = useMemo(() => {
    const raw = isRecord(timeline) ? readPath(timeline, ["memory"]) : undefined;
    return normalizeTimelineSeries(raw);
  }, [timeline]);

  const requestSeries = useMemo(() => {
    const raw = isRecord(timeline)
      ? readPath(timeline, ["requests"])
      : undefined;
    return normalizeTimelineSeries(raw);
  }, [timeline]);

  const browserSeries = useMemo(() => {
    const raw = isRecord(timeline)
      ? readPath(timeline, ["browsers"])
      : undefined;
    return normalizeBrowserTimelineSeries(raw);
  }, [timeline]);

  const connectionTag = (() => {
    if (mode === "polling") {
      return (
        <Tag color={pollError ? "red" : "green"}>
          {t("crawl.monitor.transport.polling", { defaultValue: "Polling" })}
        </Tag>
      );
    }
    if (wsStatus === "connected") {
      return (
        <Tag color="green">
          {t("crawl.monitor.ws.connected", { defaultValue: "WS connected" })}
        </Tag>
      );
    }
    if (wsStatus === "connecting") {
      return (
        <Tag color="blue">
          {t("crawl.monitor.ws.connecting", { defaultValue: "WS connecting" })}
        </Tag>
      );
    }
    if (wsStatus === "reconnecting") {
      return (
        <Tag color="orange">
          {t("crawl.monitor.ws.reconnectingShort", {
            defaultValue: "WS reconnecting",
          })}
        </Tag>
      );
    }
    if (wsStatus === "error") {
      return (
        <Tag color="red">
          {t("crawl.monitor.ws.errorShort", { defaultValue: "WS error" })}
        </Tag>
      );
    }
    return <Tag>{t("crawl.monitor.ws.idle", { defaultValue: "WS idle" })}</Tag>;
  })();

  const handleCleanup = () => {
    Modal.confirm({
      title: t("crawl.monitor.actions.cleanup.title", {
        defaultValue: "Run cleanup now?",
      }),
      content: t("crawl.monitor.actions.cleanup.description", {
        defaultValue: "This will trigger Crawl4AI janitor cleanup immediately.",
      }),
      okText: t("common.confirm", { defaultValue: "Confirm" }),
      cancelText: t("common.cancel", { defaultValue: "Cancel" }),
      onOk: async () => {
        await postMonitorJson("actions/cleanup");
        messageApi.success(
          t("crawl.monitor.actions.cleanup.success", {
            defaultValue: "Cleanup triggered.",
          }),
        );
      },
    });
  };

  const handleResetStats = () => {
    Modal.confirm({
      title: t("crawl.monitor.actions.reset.title", {
        defaultValue: "Reset monitoring stats?",
      }),
      content: t("crawl.monitor.actions.reset.description", {
        defaultValue: "This will reset accumulated monitoring statistics.",
      }),
      okText: t("common.confirm", { defaultValue: "Confirm" }),
      cancelText: t("common.cancel", { defaultValue: "Cancel" }),
      onOk: async () => {
        await postMonitorJson("stats/reset");
        messageApi.success(
          t("crawl.monitor.actions.reset.success", {
            defaultValue: "Stats reset.",
          }),
        );
      },
    });
  };

  const handleBrowserAction = (
    action: "kill_browser" | "restart_browser",
    target: { signature?: string; browserId?: string },
  ) => {
    const shortSig = target.signature
      ? normalizeBrowserSigForAction(target.signature)
      : "";
    const label =
      [shortSig, target.browserId].filter(Boolean).join(" / ") || "-";
    Modal.confirm({
      title:
        action === "kill_browser"
          ? t("crawl.monitor.actions.kill.title", {
              defaultValue: "Kill browser?",
            })
          : t("crawl.monitor.actions.restart.title", {
              defaultValue: "Restart browser?",
            }),
      content: t("crawl.monitor.actions.targetSig", {
        defaultValue: "Target signature: {{sig}}",
        sig: label,
      }),
      okText: t("common.confirm", { defaultValue: "Confirm" }),
      cancelText: t("common.cancel", { defaultValue: "Cancel" }),
      onOk: async () => {
        await postMonitorJson(`actions/${action}`, {
          sig: shortSig || undefined,
          browser_id: target.browserId || undefined,
        });
        messageApi.success(
          t("crawl.monitor.actions.success", { defaultValue: "Action sent." }),
        );
      },
    });
  };

  const overviewCpu = readNumber(health, ["container", "cpu_percent"]);
  const overviewMemory = readNumber(health, ["container", "memory_percent"]);
  const overviewUptime = readNumber(health, ["container", "uptime_seconds"]);
  const overviewTotalRequests = readNumber(health, ["stats", "total_requests"]);
  const overviewSuccessRate = readNumber(health, [
    "stats",
    "success_rate_percent",
  ]);
  const overviewAvgLatency = readNumber(health, ["stats", "avg_latency_ms"]);

  const poolPermanent = readNumber(health, ["pool", "permanent", "active"]);
  const poolHot = readNumber(health, ["pool", "hot", "count"]);
  const poolCold = readNumber(health, ["pool", "cold", "count"]);

  const browserTotal = asNumber(
    browsersSummary
      ? getRecordValue(browsersSummary, ["total_count", "totalCount"])
      : undefined,
  );
  const browserReuseRate = asNumber(
    browsersSummary
      ? getRecordValue(browsersSummary, [
          "reuse_rate_percent",
          "reuseRatePercent",
        ])
      : undefined,
  );
  const browserMemoryMb = asNumber(
    browsersSummary
      ? getRecordValue(browsersSummary, ["total_memory_mb", "totalMemoryMb"])
      : undefined,
  );

  const receivedAtLabel = monitor?.receivedAt
    ? formatReceivedAt(monitor.receivedAt)
    : "-";

  const completedRequestColumns: ColumnsType<{ key: string; item: unknown }> = [
    {
      title: t("crawl.monitor.requests.columns.endpoint", {
        defaultValue: "Endpoint",
      }),
      dataIndex: "item",
      key: "endpoint",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        return (
          asString(getRecordValue(value, ["endpoint", "path", "route"])) ??
          asString(getRecordValue(value, ["endpoint_name", "endpointName"])) ??
          "-"
        );
      },
    },
    {
      title: t("crawl.monitor.requests.columns.url", { defaultValue: "URL" }),
      dataIndex: "item",
      key: "url",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const url = asString(getRecordValue(value, ["url"])) ?? "-";
        return url !== "-" ? (
          <Typography.Text
            ellipsis={{ tooltip: url }}
            style={{ maxWidth: 320, display: "inline-block" }}
          >
            {url}
          </Typography.Text>
        ) : (
          "-"
        );
      },
    },
    {
      title: t("crawl.monitor.requests.columns.status", {
        defaultValue: "Status",
      }),
      dataIndex: "item",
      key: "status",
      width: 110,
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const status = asString(
          getRecordValue(value, ["status"]),
        )?.toLowerCase();
        const success = asBoolean(getRecordValue(value, ["success"]));
        const isOk =
          success ??
          (status ? status === "success" || status === "ok" : undefined);
        if (isOk === true) return <Tag color="green">success</Tag>;
        if (isOk === false) return <Tag color="red">error</Tag>;
        return <Tag>unknown</Tag>;
      },
    },
    {
      title: t("crawl.monitor.requests.columns.latency", {
        defaultValue: "Latency (ms)",
      }),
      dataIndex: "item",
      key: "latency",
      width: 140,
      align: "right",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const latency =
          asNumber(
            getRecordValue(value, [
              "latency_ms",
              "latencyMs",
              "total_time_ms",
              "totalTimeMs",
            ]),
          ) ?? undefined;
        return typeof latency === "number" ? latency.toFixed(0) : "-";
      },
    },
    {
      title: t("crawl.monitor.requests.columns.http", { defaultValue: "HTTP" }),
      dataIndex: "item",
      key: "http",
      width: 90,
      align: "right",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const statusCode =
          asNumber(
            getRecordValue(value, [
              "http_status",
              "httpStatus",
              "status_code",
              "statusCode",
            ]),
          ) ?? undefined;
        return typeof statusCode === "number" ? statusCode : "-";
      },
    },
    {
      title: t("crawl.monitor.requests.columns.poolHit", {
        defaultValue: "Pool hit",
      }),
      dataIndex: "item",
      key: "poolHit",
      width: 110,
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const hit = asBoolean(getRecordValue(value, ["pool_hit", "poolHit"]));
        if (hit === true) return <Tag color="blue">yes</Tag>;
        if (hit === false) return <Tag>no</Tag>;
        return "-";
      },
    },
    {
      title: t("crawl.monitor.requests.columns.memory", {
        defaultValue: "Memory Δ (MB)",
      }),
      dataIndex: "item",
      key: "memory",
      width: 140,
      align: "right",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const delta = asNumber(
          getRecordValue(value, [
            "memory_delta_mb",
            "memoryDeltaMb",
            "memory_usage_mb",
            "memoryUsageMb",
          ]),
        );
        return typeof delta === "number" ? delta.toFixed(1) : "-";
      },
    },
    {
      title: t("common.view", { defaultValue: "View" }),
      key: "view",
      width: 90,
      render: (_: unknown, record) => (
        <Button
          size="small"
          type="link"
          aria-haspopup="dialog"
          aria-label={t("crawl.monitor.details.openRequest", {
            defaultValue: "Open request details",
          })}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openRequestDetails(record.item);
          }}
        >
          {t("common.view", { defaultValue: "View" })}
        </Button>
      ),
    },
  ];
  const requestRowProps = useCallback(
    (record: { item: unknown }) => ({
      onClick: () => openRequestDetails(record.item),
      style: { cursor: "pointer" },
    }),
    [openRequestDetails],
  );

  const browserColumns: ColumnsType<{ key: string; item: unknown }> = [
    {
      title: t("crawl.monitor.browsers.columns.type", { defaultValue: "Type" }),
      dataIndex: "item",
      key: "type",
      width: 120,
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const type = asString(getRecordValue(value, ["type", "tier"])) ?? "";
        const normalized = type.toLowerCase();
        const color =
          normalized === "permanent"
            ? "purple"
            : normalized === "hot"
              ? "orange"
              : normalized === "cold"
                ? "cyan"
                : undefined;
        return type ? <Tag color={color}>{type}</Tag> : "-";
      },
    },
    {
      title: t("crawl.monitor.browsers.columns.signature", {
        defaultValue: "Signature",
      }),
      dataIndex: "item",
      key: "signature",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const signature = asString(getRecordValue(value, ["signature", "sig"]));
        const browserId = asString(
          getRecordValue(value, ["browser_id", "browserId", "id"]),
        );
        const displayed = signature ?? browserId ?? "-";
        const short = signature
          ? normalizeBrowserSigForAction(signature)
          : displayed;
        return signature ? (
          <Space size={6}>
            <Typography.Text code>{short}</Typography.Text>
            {browserId ? (
              <Typography.Text type="secondary">{browserId}</Typography.Text>
            ) : null}
          </Space>
        ) : (
          <Typography.Text code>{displayed}</Typography.Text>
        );
      },
    },
    {
      title: t("crawl.monitor.browsers.columns.age", { defaultValue: "Age" }),
      dataIndex: "item",
      key: "age",
      width: 140,
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        return (
          asString(getRecordValue(value, ["age"])) ??
          asString(getRecordValue(value, ["created_at", "createdAt"])) ??
          "-"
        );
      },
    },
    {
      title: t("crawl.monitor.browsers.columns.hits", { defaultValue: "Hits" }),
      dataIndex: "item",
      key: "hits",
      width: 90,
      align: "right",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const hits =
          asNumber(
            getRecordValue(value, ["hits", "reuse_count", "reuseCount"]),
          ) ?? undefined;
        return typeof hits === "number" ? hits : "-";
      },
    },
    {
      title: t("crawl.monitor.browsers.columns.idle", {
        defaultValue: "Idle (s)",
      }),
      dataIndex: "item",
      key: "idle",
      width: 110,
      align: "right",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const idle =
          asNumber(
            getRecordValue(value, ["idle_time_seconds", "idleTimeSeconds"]),
          ) ?? undefined;
        return typeof idle === "number" ? idle.toFixed(0) : "-";
      },
    },
    {
      title: t("crawl.monitor.browsers.columns.memory", {
        defaultValue: "Memory (MB)",
      }),
      dataIndex: "item",
      key: "memory",
      width: 130,
      align: "right",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const mem =
          asNumber(
            getRecordValue(value, ["memory_mb", "memoryMb", "memory"]),
          ) ?? undefined;
        return typeof mem === "number" ? mem.toFixed(0) : "-";
      },
    },
    {
      title: t("crawl.monitor.browsers.columns.lastUsed", {
        defaultValue: "Last used",
      }),
      dataIndex: "item",
      key: "lastUsed",
      width: 140,
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        return (
          asString(getRecordValue(value, ["last_used", "lastUsed"])) ?? "-"
        );
      },
    },
    {
      title: t("crawl.monitor.browsers.columns.actions", {
        defaultValue: "Actions",
      }),
      dataIndex: "item",
      key: "actions",
      width: 220,
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const signature = asString(getRecordValue(value, ["signature", "sig"]));
        const browserId = asString(
          getRecordValue(value, ["browser_id", "browserId", "id"]),
        );
        return (
          <Space size={4}>
            <Button
              size="small"
              type="link"
              onClick={() =>
                openDetailModal(
                  t("crawl.monitor.details.browser", {
                    defaultValue: "Browser details",
                  }),
                  value,
                )
              }
            >
              {t("common.view", { defaultValue: "View" })}
            </Button>
            {canManage && (signature || browserId) ? (
              <>
                <Button
                  size="small"
                  onClick={() =>
                    handleBrowserAction("restart_browser", {
                      signature,
                      browserId,
                    })
                  }
                >
                  {t("crawl.monitor.actions.restart.button", {
                    defaultValue: "Restart",
                  })}
                </Button>
                <Button
                  danger
                  size="small"
                  onClick={() =>
                    handleBrowserAction("kill_browser", {
                      signature,
                      browserId,
                    })
                  }
                >
                  {t("crawl.monitor.actions.kill.button", {
                    defaultValue: "Kill",
                  })}
                </Button>
              </>
            ) : null}
          </Space>
        );
      },
    },
  ];

  const endpointColumns: ColumnsType<{
    key: string;
    endpoint: string;
    stats: unknown;
  }> = [
    {
      title: t("crawl.monitor.endpoints.columns.endpoint", {
        defaultValue: "Endpoint",
      }),
      dataIndex: "endpoint",
      key: "endpoint",
    },
    {
      title: t("crawl.monitor.endpoints.columns.count", {
        defaultValue: "Count",
      }),
      dataIndex: "stats",
      key: "count",
      width: 110,
      align: "right",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const count = asNumber(getRecordValue(value, ["count"])) ?? undefined;
        return typeof count === "number" ? count : "-";
      },
    },
    {
      title: t("crawl.monitor.endpoints.columns.latency", {
        defaultValue: "Avg latency (ms)",
      }),
      dataIndex: "stats",
      key: "avg_latency_ms",
      width: 150,
      align: "right",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const latency =
          asNumber(getRecordValue(value, ["avg_latency_ms", "avgLatencyMs"])) ??
          undefined;
        return typeof latency === "number" ? latency.toFixed(0) : "-";
      },
    },
    {
      title: t("crawl.monitor.endpoints.columns.success", {
        defaultValue: "Success %",
      }),
      dataIndex: "stats",
      key: "success_rate_percent",
      width: 130,
      align: "right",
      render: (value: unknown) => {
        if (!isRecord(value)) return "-";
        const rate =
          asNumber(
            getRecordValue(value, [
              "success_rate_percent",
              "successRatePercent",
            ]),
          ) ?? undefined;
        return typeof rate === "number" ? `${rate.toFixed(1)}%` : "-";
      },
    },
  ];
  const runtimeHeadedError =
    runtimeProbe && !runtimeProbe.headed.ok
      ? (runtimeProbe.xvfb?.reason ?? runtimeProbe.headed.error ?? null)
      : null;
  const runtimeHeadedIssue = classifyHeadedIssue(
    runtimeHeadedError ?? undefined,
  );
  const ssrfProxyState = useMemo(
    () => parseCrawl4aiSsrfProxyRuntimeState(runtimeProbe),
    [runtimeProbe],
  );
  const ssrfProxyStatus = getCrawl4aiSsrfProxyStatus(ssrfProxyState);

  if (status === "loading") {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
        <Typography.Text type="secondary">
          {t("common.loading", { defaultValue: "Loading..." })}
        </Typography.Text>
      </div>
    );
  }

  if (!canView) {
    return (
      <Card
        className="content-card"
        title={t("crawl.monitor.title", { defaultValue: "Crawl Monitor" })}
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
    <div className="flex flex-col gap-6">
      {contextHolder}
      <Modal
        open={Boolean(detailModal)}
        onCancel={closeDetailModal}
        footer={null}
        width={860}
        title={
          <Space>
            <Typography.Text>{detailModal?.title}</Typography.Text>
            <Button size="small" onClick={handleCopyDetail}>
              {t("crawl.monitor.details.copyJson", {
                defaultValue: "Copy JSON",
              })}
            </Button>
          </Space>
        }
      >
        <pre
          style={{
            maxHeight: 540,
            overflow: "auto",
            padding: 12,
            background: chartTheme.colors.tooltipBg,
            color: chartTheme.colors.tooltipText,
            borderRadius: 8,
          }}
        >
          {detailModal ? safeJsonStringify(detailModal.payload) : ""}
        </pre>
      </Modal>
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("crawl.monitor.title", { defaultValue: "Crawl4AI Monitor" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("crawl.monitor.subtitle", {
            defaultValue:
              "Interactive dashboard with live system metrics and browser pool visibility.",
          })}
        </Typography.Text>
      </Space>

      <Card
        className="content-card"
        title={t("crawl.monitor.dashboardTitle", {
          defaultValue: "Monitoring Dashboard",
        })}
        extra={
          <Space>
            <Button onClick={handleRefreshNow} loading={refreshing}>
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
            <Segmented
              value={mode}
              onChange={(value) => setMode(value as TransportMode)}
              options={[
                {
                  label: t("crawl.monitor.transport.ws", {
                    defaultValue: "WebSocket",
                  }),
                  value: "ws",
                  disabled: !wsUrl,
                },
                {
                  label: t("crawl.monitor.transport.polling", {
                    defaultValue: "Polling",
                  }),
                  value: "polling",
                },
              ]}
            />
            {connectionTag}
            <Button onClick={handleCopyApi}>
              {t("crawl.monitor.copyApi", { defaultValue: "Copy API" })}
            </Button>
            <Button onClick={handleCopyWs} disabled={!wsUrl}>
              {t("crawl.monitor.copyWs", { defaultValue: "Copy WS" })}
            </Button>
            <Button onClick={handleCopy} disabled={!normalizedDashboardUrl}>
              {t("crawl.monitor.copyLink", { defaultValue: "Copy link" })}
            </Button>
            <Button
              type="primary"
              onClick={handleOpen}
              disabled={!normalizedDashboardUrl}
            >
              {t("crawl.monitor.openInNewTab", {
                defaultValue: "Open in new tab",
              })}
            </Button>
          </Space>
        }
      >
        {!normalizedDashboardUrl ? (
          <Alert
            type="warning"
            message={t("crawl.monitor.missingUrl.title", {
              defaultValue: "Dashboard URL not configured",
            })}
            description={t("crawl.monitor.missingUrl.description", {
              defaultValue:
                "Set CRAWL4AI_DASHBOARD_URL (recommended in Docker) or CRAWL4AI_BASE_URL, then reload this page.",
            })}
          />
        ) : null}

        {mode === "ws" && wsError ? (
          <Alert
            type="warning"
            showIcon
            message={t("crawl.monitor.ws.warningTitle", {
              defaultValue: "WebSocket connection issue",
            })}
            description={
              <Space direction="vertical" size={2}>
                <div>{wsError}</div>
                <Typography.Text type="secondary">
                  {t("crawl.monitor.ws.fallbackHint", {
                    defaultValue:
                      "Tip: Polling uses the authenticated server-side proxy and often works even when WebSocket is blocked by CORS/origin rules.",
                  })}
                </Typography.Text>
                <Space>
                  <Button onClick={() => connectWebSocket()}>
                    {t("crawl.monitor.ws.reconnectNow", {
                      defaultValue: "Reconnect now",
                    })}
                  </Button>
                  <Button onClick={() => setMode("polling")}>
                    {t("crawl.monitor.ws.switchToPolling", {
                      defaultValue: "Switch to Polling",
                    })}
                  </Button>
                </Space>
              </Space>
            }
          />
        ) : null}

        {mode === "polling" && pollError ? (
          <Alert
            type="warning"
            showIcon
            message={t("crawl.monitor.polling.warningTitle", {
              defaultValue: "Polling failed",
            })}
            description={
              <Space direction="vertical" size={2}>
                <div>{pollErrorInfo?.message ?? pollError}</div>
                {pollErrorInfo?.raw &&
                pollErrorInfo.raw !== pollErrorInfo.message ? (
                  <Typography.Text code>{pollErrorInfo.raw}</Typography.Text>
                ) : null}
                {pollErrorHelp}
              </Space>
            }
          />
        ) : null}

        <Typography.Paragraph style={{ marginBottom: 12, marginTop: 12 }}>
          <Typography.Text type="secondary">
            {t("crawl.monitor.lastUpdate", { defaultValue: "Last update:" })}{" "}
            {receivedAtLabel}
          </Typography.Text>
          {monitor?.payloadTimestamp ? (
            <>
              {" "}
              <Typography.Text type="secondary">
                (
                {t("crawl.monitor.payloadTimestamp", {
                  defaultValue: "server:",
                })}{" "}
                {String(monitor.payloadTimestamp)})
              </Typography.Text>
            </>
          ) : null}
        </Typography.Paragraph>

        <Tabs
          defaultActiveKey="overview"
          items={[
            {
              key: "overview",
              label: t("crawl.monitor.tabs.overview", {
                defaultValue: "Overview",
              }),
              children: (
                <Space direction="vertical" size={16} style={{ width: "100%" }}>
                  <Row gutter={[16, 16]}>
                    <Col xs={24} md={8}>
                      <Card
                        size="small"
                        title={t("crawl.monitor.overview.container", {
                          defaultValue: "Container",
                        })}
                      >
                        <Row gutter={[16, 12]}>
                          <Col span={12}>
                            <Statistic
                              title="CPU"
                              value={overviewCpu ?? "-"}
                              suffix={
                                typeof overviewCpu === "number"
                                  ? "%"
                                  : undefined
                              }
                            />
                          </Col>
                          <Col span={12}>
                            <Statistic
                              title="Memory"
                              value={overviewMemory ?? "-"}
                              suffix={
                                typeof overviewMemory === "number"
                                  ? "%"
                                  : undefined
                              }
                            />
                          </Col>
                          <Col span={12}>
                            <Statistic
                              title="Uptime (s)"
                              value={overviewUptime ?? "-"}
                            />
                          </Col>
                        </Row>
                      </Card>
                    </Col>
                    <Col xs={24} md={8}>
                      <Card
                        size="small"
                        title={t("crawl.monitor.overview.pool", {
                          defaultValue: "Browser pool",
                        })}
                      >
                        <Row gutter={[16, 12]}>
                          <Col span={8}>
                            <Statistic
                              title="Permanent"
                              value={poolPermanent ?? "-"}
                            />
                          </Col>
                          <Col span={8}>
                            <Statistic title="Hot" value={poolHot ?? "-"} />
                          </Col>
                          <Col span={8}>
                            <Statistic title="Cold" value={poolCold ?? "-"} />
                          </Col>
                          <Col span={12}>
                            <Statistic
                              title={t("crawl.monitor.overview.totalBrowsers", {
                                defaultValue: "Total",
                              })}
                              value={browserTotal ?? "-"}
                            />
                          </Col>
                          <Col span={12}>
                            <Statistic
                              title={t("crawl.monitor.overview.reuseRate", {
                                defaultValue: "Reuse rate",
                              })}
                              value={browserReuseRate ?? "-"}
                              suffix={
                                typeof browserReuseRate === "number"
                                  ? "%"
                                  : undefined
                              }
                            />
                          </Col>
                        </Row>
                      </Card>
                    </Col>
                    <Col xs={24} md={8}>
                      <Card
                        size="small"
                        title={t("crawl.monitor.overview.requests", {
                          defaultValue: "Requests",
                        })}
                      >
                        <Row gutter={[16, 12]}>
                          <Col span={8}>
                            <Statistic
                              title={t("crawl.monitor.overview.active", {
                                defaultValue: "Active",
                              })}
                              value={activeRequests.length}
                            />
                          </Col>
                          <Col span={8}>
                            <Statistic
                              title={t("crawl.monitor.overview.completed", {
                                defaultValue: "Completed",
                              })}
                              value={completedRequests.length}
                            />
                          </Col>
                          <Col span={8}>
                            <Statistic
                              title={t("crawl.monitor.overview.errors", {
                                defaultValue: "Errors",
                              })}
                              value={
                                errors === undefined
                                  ? "-"
                                  : normalizeLogList(errors).length
                              }
                            />
                          </Col>
                          <Col span={12}>
                            <Statistic
                              title={t("crawl.monitor.overview.totalRequests", {
                                defaultValue: "Total requests",
                              })}
                              value={overviewTotalRequests ?? "-"}
                            />
                          </Col>
                          <Col span={12}>
                            <Statistic
                              title={t("crawl.monitor.overview.avgLatency", {
                                defaultValue: "Avg latency",
                              })}
                              value={overviewAvgLatency ?? "-"}
                              suffix={
                                typeof overviewAvgLatency === "number"
                                  ? "ms"
                                  : undefined
                              }
                            />
                          </Col>
                          <Col span={12}>
                            <Statistic
                              title={t("crawl.monitor.overview.successRate", {
                                defaultValue: "Success rate",
                              })}
                              value={overviewSuccessRate ?? "-"}
                              suffix={
                                typeof overviewSuccessRate === "number"
                                  ? "%"
                                  : undefined
                              }
                            />
                          </Col>
                          <Col span={12}>
                            <Statistic
                              title={t("crawl.monitor.overview.browserMemory", {
                                defaultValue: "Pool memory",
                              })}
                              value={browserMemoryMb ?? "-"}
                              suffix={
                                typeof browserMemoryMb === "number"
                                  ? "MB"
                                  : undefined
                              }
                            />
                          </Col>
                        </Row>
                      </Card>
                    </Col>
                  </Row>

                  <Card
                    size="small"
                    title={t("crawl.monitor.overview.runtime", {
                      defaultValue: "Browser runtime (Xvfb)",
                    })}
                    extra={
                      runtimeProbe?.xvfb?.supported === true ? (
                        <Tag color="green">
                          {t("crawl.monitor.runtime.headedOk", {
                            defaultValue: "Headed OK",
                          })}
                        </Tag>
                      ) : runtimeProbe?.headed ? (
                        <Tag color="red">
                          {t("crawl.monitor.runtime.headedFailed", {
                            defaultValue: "Headed failed",
                          })}
                        </Tag>
                      ) : null
                    }
                  >
                    {runtimeProbeError ? (
                      <Alert
                        type="warning"
                        showIcon
                        message={t("crawl.monitor.runtime.unavailable", {
                          defaultValue: "Runtime probe unavailable",
                        })}
                        description={runtimeProbeError}
                      />
                    ) : runtimeProbe ? (
                      <Space
                        direction="vertical"
                        size={8}
                        style={{ width: "100%" }}
                      >
                        <Row gutter={[16, 12]}>
                          <Col xs={24} md={8}>
                            <Statistic
                              title={t("crawl.monitor.runtime.headless", {
                                defaultValue: "Headless (headless=true)",
                              })}
                              value={runtimeProbe.headless.ok ? "OK" : "FAILED"}
                              suffix={`${runtimeProbe.headless.durationMs}ms`}
                            />
                          </Col>
                          <Col xs={24} md={8}>
                            <Statistic
                              title={t("crawl.monitor.runtime.headed", {
                                defaultValue: "Headed (headless=false)",
                              })}
                              value={runtimeProbe.headed.ok ? "OK" : "FAILED"}
                              suffix={
                                typeof runtimeProbe.headed.durationMs ===
                                "number"
                                  ? `${runtimeProbe.headed.durationMs}ms`
                                  : undefined
                              }
                            />
                          </Col>
                          <Col xs={24} md={8}>
                            <Statistic
                              title={t("crawl.monitor.runtime.ssrfProxy", {
                                defaultValue: "Worker SSRF proxy",
                              })}
                              value={
                                ssrfProxyStatus === "healthy"
                                  ? "OK"
                                  : ssrfProxyStatus === "disabled"
                                    ? "OFF"
                                    : ssrfProxyStatus === "failing"
                                      ? "FAILED"
                                      : "-"
                              }
                              suffix={
                                typeof ssrfProxyState.durationMs === "number"
                                  ? `${ssrfProxyState.durationMs}ms`
                                  : undefined
                              }
                            />
                          </Col>
                        </Row>

                        {runtimeProbe.xvfbEnv?.enabled ? (
                          <Typography.Text type="secondary">
                            {t("crawl.monitor.runtime.env", {
                              defaultValue: "Env:",
                            })}{" "}
                            <Typography.Text code>
                              CRAWL4AI_XVFB_ENABLED=
                              {runtimeProbe.xvfbEnv.enabled}
                            </Typography.Text>{" "}
                            {runtimeProbe.xvfbEnv.displayNum ? (
                              <Typography.Text code>
                                CRAWL4AI_XVFB_DISPLAY_NUM=
                                {runtimeProbe.xvfbEnv.displayNum}
                              </Typography.Text>
                            ) : null}{" "}
                            {runtimeProbe.xvfbEnv.screen ? (
                              <Typography.Text code>
                                CRAWL4AI_XVFB_SCREEN=
                                {runtimeProbe.xvfbEnv.screen}
                              </Typography.Text>
                            ) : null}
                          </Typography.Text>
                        ) : null}

                        {ssrfProxyState.url ? (
                          <Typography.Text type="secondary">
                            {t("crawl.monitor.runtime.proxyEnv", {
                              defaultValue: "Proxy:",
                            })}{" "}
                            <Typography.Text code>
                              CRAWL4AI_SSRF_PROXY_URL={ssrfProxyState.url}
                            </Typography.Text>
                          </Typography.Text>
                        ) : null}

                        {ssrfProxyStatus === "disabled" ? (
                          <Alert
                            type="warning"
                            showIcon
                            message={t("crawl.monitor.runtime.ssrfProxyRiskTitle", {
                              defaultValue: "Worker-side SSRF proxy is disabled",
                            })}
                            description={
                              <Space direction="vertical" size={2}>
                                <Typography.Text>
                                  {t("crawl.monitor.runtime.ssrfProxyRiskBody", {
                                    defaultValue:
                                      "CRAWL4AI_SSRF_PROXY_URL is not configured. API-side URL validation still runs, but the worker no longer pins/blocks DNS resolution at fetch time, so DNS rebinding protection is incomplete.",
                                  })}
                                </Typography.Text>
                                <Typography.Text code>
                                  CRAWL4AI_SSRF_PROXY_URL=http://127.0.0.1:18080
                                </Typography.Text>
                              </Space>
                            }
                          />
                        ) : ssrfProxyStatus === "failing" ? (
                          <Alert
                            type="warning"
                            showIcon
                            message={t("crawl.monitor.runtime.ssrfProxyFailedTitle", {
                              defaultValue:
                                "Worker-side SSRF proxy is configured but unreachable",
                            })}
                            description={
                              <Space direction="vertical" size={2}>
                                {ssrfProxyState.error ? (
                                  <Typography.Text
                                    style={{ whiteSpace: "pre-wrap" }}
                                  >
                                    {ssrfProxyState.error}
                                  </Typography.Text>
                                ) : null}
                                <Typography.Text type="secondary">
                                  {t("crawl.monitor.runtime.ssrfProxyFailedBody", {
                                    defaultValue:
                                      "Crawl4AI accepted the proxy configuration, but the browser could not use it. Verify the local proxy process is started inside the crawl4ai container and recreate the service if needed.",
                                  })}
                                </Typography.Text>
                              </Space>
                            }
                          />
                        ) : null}

                        {!runtimeProbe.headed.ok ? (
                          <Alert
                            type={
                              runtimeHeadedIssue === "unknown"
                                ? "info"
                                : "warning"
                            }
                            showIcon
                            message={
                              runtimeHeadedIssue === "display"
                                ? t("crawl.runtimeGuide.displayIssueTitle", {
                                    defaultValue:
                                      "Detected DISPLAY/Xvfb dependency issue",
                                  })
                                : runtimeHeadedIssue === "timeout"
                                  ? t("crawl.runtimeGuide.timeoutIssueTitle", {
                                      defaultValue: "Headed runtime timed out",
                                    })
                                  : t("crawl.monitor.runtime.headedFailed", {
                                      defaultValue: "Headed failed",
                                    })
                            }
                            description={
                              <Space direction="vertical" size={2}>
                                {runtimeHeadedError ? (
                                  <Typography.Text
                                    style={{ whiteSpace: "pre-wrap" }}
                                  >
                                    {runtimeHeadedError}
                                  </Typography.Text>
                                ) : null}
                                <Typography.Text type="secondary">
                                  {runtimeHeadedIssue === "display"
                                    ? t("crawl.runtimeGuide.displayIssueHint", {
                                        defaultValue:
                                          "Headed runtime failed because DISPLAY/Xvfb is unavailable. Enable Xvfb in crawl4ai or switch this task to Headless.",
                                      })
                                    : runtimeHeadedIssue === "timeout"
                                      ? t(
                                          "crawl.runtimeGuide.timeoutIssueHint",
                                          {
                                            defaultValue:
                                              "Display may be ready, but browser startup/navigation timed out. Check crawl4ai load and timeout settings.",
                                          },
                                        )
                                      : t("crawl.monitor.runtime.hint", {
                                          defaultValue:
                                            "If headed mode fails with DISPLAY/Xvfb errors, enable Xvfb in docker-compose or switch sources to Headless.",
                                        })}
                                </Typography.Text>
                                <details>
                                  <summary>
                                    {t("crawl.runtimeGuide.stepsTitle", {
                                      defaultValue: "Recommended checks",
                                    })}
                                  </summary>
                                  <Space
                                    direction="vertical"
                                    size={2}
                                    style={{ marginTop: 6 }}
                                  >
                                    <Typography.Text type="secondary">
                                      {t("crawl.runtimeGuide.noAutoBootstrap", {
                                        defaultValue:
                                          "This console only provides guidance and does not auto-start Xvfb for you.",
                                      })}
                                    </Typography.Text>
                                    <Typography.Text type="secondary">
                                      {t("crawl.runtimeGuide.principleBody", {
                                        defaultValue:
                                          "When headless=false, Chromium needs a display server. Xvfb provides a virtual X11 display (for example :99) so headed rendering can run in containers without a physical monitor.",
                                      })}
                                    </Typography.Text>
                                    <Typography.Text type="secondary">
                                      {`1. ${t("crawl.runtimeGuide.step1", {
                                        defaultValue:
                                          "Prefer Headless for routine crawls, and use Headed only when anti-bot scenarios need it.",
                                      })}`}
                                    </Typography.Text>
                                    <Typography.Text type="secondary">
                                      {`2. ${t("crawl.runtimeGuide.step2", {
                                        defaultValue:
                                          "When using Headed, ensure Xvfb/DISPLAY are configured in the crawl4ai container.",
                                      })}`}
                                    </Typography.Text>
                                    <Typography.Text type="secondary">
                                      {`3. ${t("crawl.runtimeGuide.step3", {
                                        defaultValue:
                                          "If display errors persist, switch this task back to Headless first, then verify container env settings.",
                                      })}`}
                                    </Typography.Text>
                                  </Space>
                                </details>
                              </Space>
                            }
                          />
                        ) : null}
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">
                        {t("crawl.monitor.runtime.loading", {
                          defaultValue: "Loading...",
                        })}
                      </Typography.Text>
                    )}
                  </Card>

                  {canManage ? (
                    <Card
                      size="small"
                      title={t("crawl.monitor.actions.title", {
                        defaultValue: "Actions",
                      })}
                    >
                      <Space wrap>
                        <Button onClick={handleCleanup}>
                          {t("crawl.monitor.actions.cleanup.button", {
                            defaultValue: "Cleanup",
                          })}
                        </Button>
                        <Button
                          onClick={() =>
                            handleBrowserAction("restart_browser", {
                              signature: "permanent",
                            })
                          }
                        >
                          {t("crawl.monitor.actions.restartPermanent.button", {
                            defaultValue: "Restart permanent",
                          })}
                        </Button>
                        <Button onClick={handleResetStats}>
                          {t("crawl.monitor.actions.reset.button", {
                            defaultValue: "Reset stats",
                          })}
                        </Button>
                      </Space>
                    </Card>
                  ) : null}

                  {normalizedDashboardUrl ? (
                    <Alert
                      type="info"
                      showIcon
                      message={t("crawl.monitor.dashboardHint.title", {
                        defaultValue: "Built-in dashboard",
                      })}
                      description={
                        <Typography.Text type="secondary">
                          {t("crawl.monitor.dashboardHint.description", {
                            defaultValue:
                              "Use the Built-in tab to view Crawl4AI's original dashboard UI.",
                          })}
                        </Typography.Text>
                      }
                    />
                  ) : null}
                </Space>
              ),
            },
            {
              key: "requests",
              label: t("crawl.monitor.tabs.requests", {
                defaultValue: "Requests",
              }),
              children: (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Card
                    size="small"
                    title={t("crawl.monitor.requests.activeTitle", {
                      defaultValue: "Active requests",
                    })}
                  >
                    <Table
                      size="small"
                      pagination={false}
                      dataSource={activeRequestRows}
                      onRow={requestRowProps}
                      columns={[
                        {
                          title: t("crawl.monitor.requests.columns.endpoint", {
                            defaultValue: "Endpoint",
                          }),
                          dataIndex: "item",
                          key: "endpoint",
                          render: (value: unknown) => {
                            if (!isRecord(value)) return "-";
                            return (
                              asString(
                                getRecordValue(value, [
                                  "endpoint",
                                  "path",
                                  "route",
                                ]),
                              ) ?? "-"
                            );
                          },
                        },
                        {
                          title: t("crawl.monitor.requests.columns.url", {
                            defaultValue: "URL",
                          }),
                          dataIndex: "item",
                          key: "url",
                          render: (value: unknown) => {
                            if (!isRecord(value)) return "-";
                            return (
                              asString(getRecordValue(value, ["url"])) ?? "-"
                            );
                          },
                        },
                        {
                          title: t("crawl.monitor.requests.columns.elapsed", {
                            defaultValue: "Elapsed",
                          }),
                          dataIndex: "item",
                          key: "elapsed",
                          width: 140,
                          render: (value: unknown) => {
                            if (!isRecord(value)) return "-";
                            return (
                              asString(
                                getRecordValue(value, [
                                  "elapsed_time",
                                  "elapsedTime",
                                ]),
                              ) ?? "-"
                            );
                          },
                        },
                        {
                          title: t("crawl.monitor.requests.columns.memory", {
                            defaultValue: "Memory Δ (MB)",
                          }),
                          dataIndex: "item",
                          key: "memory",
                          width: 140,
                          align: "right",
                          render: (value: unknown) => {
                            if (!isRecord(value)) return "-";
                            const mem =
                              asNumber(
                                getRecordValue(value, [
                                  "memory_usage_mb",
                                  "memoryUsageMb",
                                ]),
                              ) ?? undefined;
                            return typeof mem === "number"
                              ? mem.toFixed(1)
                              : "-";
                          },
                        },
                        {
                          title: t("common.view", { defaultValue: "View" }),
                          key: "view",
                          width: 90,
                          render: (_: unknown, record: { item: unknown }) => (
                            <Button
                              size="small"
                              type="link"
                              aria-haspopup="dialog"
                              aria-label={t(
                                "crawl.monitor.details.openRequest",
                                {
                                  defaultValue: "Open request details",
                                },
                              )}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                openRequestDetails(record.item);
                              }}
                            >
                              {t("common.view", { defaultValue: "View" })}
                            </Button>
                          ),
                        },
                      ]}
                    />
                  </Card>

                  <Card
                    size="small"
                    title={t("crawl.monitor.requests.completedTitle", {
                      defaultValue: "Completed requests",
                    })}
                    extra={
                      <Segmented
                        value={completedFilter}
                        onChange={(value) =>
                          setCompletedFilter(
                            value as "all" | "success" | "error",
                          )
                        }
                        options={[
                          {
                            label: `${t("crawl.monitor.requests.filters.all", { defaultValue: "All" })} (${completedRequests.length})`,
                            value: "all",
                          },
                          {
                            label: `${t("crawl.monitor.requests.filters.success", { defaultValue: "Success" })} (${completedCounts.success})`,
                            value: "success",
                          },
                          {
                            label: `${t("crawl.monitor.requests.filters.error", { defaultValue: "Error" })} (${completedCounts.error})`,
                            value: "error",
                          },
                        ]}
                      />
                    }
                  >
                    <Table
                      size="small"
                      pagination={{ pageSize: 10 }}
                      dataSource={completedRequestRows}
                      columns={completedRequestColumns}
                      onRow={requestRowProps}
                    />
                  </Card>
                </Space>
              ),
            },
            {
              key: "browsers",
              label: t("crawl.monitor.tabs.browsers", {
                defaultValue: "Browsers",
              }),
              children: (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Alert
                    type="info"
                    showIcon
                    message={t("crawl.monitor.browsers.hint.title", {
                      defaultValue: "Browser pool visibility",
                    })}
                    description={t("crawl.monitor.browsers.hint.description", {
                      defaultValue:
                        "Shows permanent/hot/cold pools and lets admins restart/kill browsers.",
                    })}
                  />
                  <Table
                    size="small"
                    pagination={{ pageSize: 10 }}
                    dataSource={browserItems.map((item, idx) => ({
                      key: getBrowserRowKey(item, String(idx)),
                      item,
                    }))}
                    columns={browserColumns}
                  />
                </Space>
              ),
            },
            {
              key: "endpoints",
              label: t("crawl.monitor.tabs.endpoints", {
                defaultValue: "Endpoints",
              }),
              children: (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Alert
                    type="info"
                    showIcon
                    message={t("crawl.monitor.endpoints.hint.title", {
                      defaultValue: "Per-endpoint stats",
                    })}
                    description={t("crawl.monitor.endpoints.hint.description", {
                      defaultValue:
                        "Counts, average latency, and success rate per Crawl4AI API endpoint.",
                    })}
                  />
                  {endpointsChartOption ? (
                    <Card size="small">
                      <DashboardChart
                        option={endpointsChartOption}
                        height={320}
                        theme={chartTheme.echartsTheme}
                      />
                    </Card>
                  ) : null}
                  <Table
                    size="small"
                    pagination={{ pageSize: 12 }}
                    dataSource={endpointStatRows}
                    columns={endpointColumns}
                  />
                </Space>
              ),
            },
            {
              key: "timeline",
              label: t("crawl.monitor.tabs.timeline", {
                defaultValue: "Timeline",
              }),
              children: (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  {memorySeries ? (
                    <Card size="small">
                      <DashboardChart
                        option={buildLineOption(
                          t("crawl.monitor.timeline.memory", {
                            defaultValue: "Memory",
                          }),
                          memorySeries.labels,
                          memorySeries.values,
                          chartTheme.colors.accent,
                          chartTheme.colors.foreground,
                        )}
                        height={280}
                        theme={chartTheme.echartsTheme}
                      />
                    </Card>
                  ) : (
                    <Alert
                      type="warning"
                      showIcon
                      message={t("crawl.monitor.timeline.missing", {
                        defaultValue: "Timeline data not available.",
                      })}
                    />
                  )}

                  {requestSeries ? (
                    <Card size="small">
                      <DashboardChart
                        option={buildLineOption(
                          t("crawl.monitor.timeline.requests", {
                            defaultValue: "Requests rate",
                          }),
                          requestSeries.labels,
                          requestSeries.values,
                          chartTheme.colors.bullish,
                          chartTheme.colors.foreground,
                        )}
                        height={280}
                        theme={chartTheme.echartsTheme}
                      />
                    </Card>
                  ) : null}

                  {browserSeries ? (
                    <Card size="small">
                      <DashboardChart
                        option={buildBrowserOption(
                          t("crawl.monitor.timeline.browsers", {
                            defaultValue: "Browser pool",
                          }),
                          browserSeries.labels,
                          {
                            permanent: browserSeries.permanent,
                            hot: browserSeries.hot,
                            cold: browserSeries.cold,
                          },
                          {
                            permanent: chartTheme.colors.primary,
                            hot: chartTheme.colors.accent,
                            cold: chartTheme.colors.secondary,
                          },
                          chartTheme.colors.foreground,
                        )}
                        height={280}
                        theme={chartTheme.echartsTheme}
                      />
                    </Card>
                  ) : null}
                </Space>
              ),
            },
            {
              key: "logs",
              label: t("crawl.monitor.tabs.logs", { defaultValue: "Logs" }),
              children: (
                <Row gutter={[16, 16]}>
                  <Col xs={24} md={12}>
                    <Card
                      size="small"
                      title={t("crawl.monitor.logs.errors", {
                        defaultValue: "Recent errors",
                      })}
                    >
                      <List
                        size="small"
                        dataSource={normalizeLogList(errors)}
                        locale={{
                          emptyText: t("common.empty", {
                            defaultValue: "Empty",
                          }),
                        }}
                        renderItem={(item) => (
                          <List.Item>
                            <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                              {typeof item === "string"
                                ? item
                                : JSON.stringify(item)}
                            </Typography.Text>
                          </List.Item>
                        )}
                      />
                    </Card>
                  </Col>
                  <Col xs={24} md={12}>
                    <Card
                      size="small"
                      title={t("crawl.monitor.logs.janitor", {
                        defaultValue: "Janitor events",
                      })}
                    >
                      <List
                        size="small"
                        dataSource={normalizeLogList(janitor)}
                        locale={{
                          emptyText: t("common.empty", {
                            defaultValue: "Empty",
                          }),
                        }}
                        renderItem={(item) => (
                          <List.Item>
                            <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                              {typeof item === "string"
                                ? item
                                : JSON.stringify(item)}
                            </Typography.Text>
                          </List.Item>
                        )}
                      />
                    </Card>
                  </Col>
                </Row>
              ),
            },
            {
              key: "builtin",
              label: t("crawl.monitor.tabs.builtin", {
                defaultValue: "Built-in",
              }),
              children: normalizedDashboardUrl ? (
                <>
                  <Typography.Paragraph style={{ marginBottom: 12 }}>
                    <Typography.Text type="secondary">
                      {t("crawl.monitor.currentUrl", {
                        defaultValue: "Current dashboard URL:",
                      })}{" "}
                    </Typography.Text>
                    <Typography.Link
                      href={normalizedDashboardUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {normalizedDashboardUrl}
                    </Typography.Link>
                  </Typography.Paragraph>
                  <iframe
                    title="crawl4ai-monitor-dashboard"
                    src={normalizedDashboardUrl}
                    style={{
                      width: "100%",
                      height: "78vh",
                      border: `1px solid ${chartTheme.colors.border}`,
                      borderRadius: 8,
                    }}
                    referrerPolicy="no-referrer"
                  />
                </>
              ) : (
                <Alert
                  type="warning"
                  message={t("crawl.monitor.missingUrl.title", {
                    defaultValue: "Dashboard URL not configured",
                  })}
                  description={t("crawl.monitor.missingUrl.description", {
                    defaultValue:
                      "Set CRAWL4AI_DASHBOARD_URL (recommended in Docker) or CRAWL4AI_BASE_URL, then reload this page.",
                  })}
                />
              ),
            },
            {
              key: "raw",
              label: t("crawl.monitor.tabs.raw", { defaultValue: "Raw" }),
              children: (
                <Card size="small">
                  <Typography.Paragraph
                    type="secondary"
                    style={{ marginBottom: 12 }}
                  >
                    {t("crawl.monitor.raw.description", {
                      defaultValue:
                        "Raw monitoring payload for debugging (best-effort normalization).",
                    })}
                  </Typography.Paragraph>
                  <pre
                    style={{
                      maxHeight: 520,
                      overflow: "auto",
                      padding: 12,
                      background: chartTheme.colors.tooltipBg,
                      color: chartTheme.colors.tooltipText,
                      borderRadius: 8,
                    }}
                  >
                    {JSON.stringify(
                      {
                        mode,
                        wsUrl,
                        wsStatus,
                        pollError,
                        monitor,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </Card>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
