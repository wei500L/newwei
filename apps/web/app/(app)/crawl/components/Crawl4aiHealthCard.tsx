"use client";

import { DashboardOutlined, ReloadOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import dayjs from "dayjs";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { classifyHeadedIssue } from "@/lib/crawl-runtime";
import {
  getCrawl4aiSsrfProxyStatus,
  parseCrawl4aiSsrfProxyRuntimeState,
  type Crawl4aiSsrfProxyRuntimeState,
} from "@/lib/crawl4ai-ssrf-proxy";

type HealthStatus = "loading" | "healthy" | "unreachable";

interface Crawl4aiHealthSnapshot {
  receivedAt: number;
  cpuPercent?: number;
  memoryPercent?: number;
  uptimeSeconds?: number;
  poolPermanent?: number;
  poolHot?: number;
  poolCold?: number;
  totalRequests?: number;
  successRatePercent?: number;
  avgLatencyMs?: number;
}

interface Crawl4aiRuntimeSnapshot {
  receivedAt: number;
  headlessOk: boolean;
  headedOk: boolean;
  headlessDurationMs?: number;
  headedDurationMs?: number;
  headedError?: string;
  xvfbReason?: string;
  xvfbSupported?: boolean;
  ssrfProxy: Crawl4aiSsrfProxyRuntimeState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getPath(value: unknown, path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function getNumber(value: unknown, path: string[]): number | undefined {
  return asNumber(getPath(value, path));
}

function getBoolean(value: unknown, path: string[]): boolean | undefined {
  return asBoolean(getPath(value, path));
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function normalizeMonitorError(raw: string): {
  kind:
    | "notFound"
    | "baseUrlMissing"
    | "timeout"
    | "upstreamUnavailable"
    | "unauthorized"
    | "forbidden"
    | "unknown";
  message: string;
} {
  const trimmed = raw.trim();
  const parsed = tryParseJson(trimmed);

  let message = trimmed || "Unknown error";
  if (isRecord(parsed)) {
    const extracted = asString(parsed.error ?? parsed.message ?? parsed.detail);
    if (extracted) {
      message = extracted;
    }
    const details = asString(parsed.details);
    if (details) {
      message = `${message}\n${details}`;
    }
  }

  const lower = message.toLowerCase();
  if (message === "Not Found" || trimmed.includes('"detail":"Not Found"')) {
    return { kind: "notFound", message };
  }
  if (lower.includes("crawl4ai_base_url") || lower.includes("not configured")) {
    return { kind: "baseUrlMissing", message };
  }
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("abort")
  ) {
    return { kind: "timeout", message };
  }
  if (lower.includes("unauthorized") || lower.includes("http 401")) {
    return { kind: "unauthorized", message };
  }
  if (lower.includes("forbidden") || lower.includes("http 403")) {
    return { kind: "forbidden", message };
  }
  if (
    lower.includes("monitor request failed") ||
    lower.includes("bad gateway") ||
    lower.includes("fetch failed") ||
    lower.includes("http 502") ||
    lower.includes("enotfound") ||
    lower.includes("econnrefused")
  ) {
    return { kind: "upstreamUnavailable", message };
  }

  return { kind: "unknown", message };
}

async function fetchHealth(): Promise<unknown> {
  const response = await fetch("/api/crawl4ai/monitor/health", {
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") && text) {
      const normalized = normalizeMonitorError(text);
      throw new Error(normalized.message);
    }
    throw new Error(text || `HTTP ${response.status}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

async function fetchRuntime(): Promise<unknown> {
  const response = await fetch("/api/crawl4ai/runtime", { cache: "no-store" });
  const text = await response.text();
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json") && text) {
      const normalized = normalizeMonitorError(text);
      throw new Error(normalized.message);
    }
    throw new Error(text || `HTTP ${response.status}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

function parseHealthSnapshot(payload: unknown): Crawl4aiHealthSnapshot | null {
  if (!isRecord(payload)) return null;
  const receivedAt = Date.now();

  const cpuPercent = getNumber(payload, ["container", "cpu_percent"]);
  const memoryPercent = getNumber(payload, ["container", "memory_percent"]);
  const uptimeSeconds = getNumber(payload, ["container", "uptime_seconds"]);

  const permanentActive = getBoolean(payload, ["pool", "permanent", "active"]);
  const poolPermanent =
    typeof permanentActive === "boolean"
      ? permanentActive
        ? 1
        : 0
      : getNumber(payload, ["pool", "permanent", "active"]);
  const poolHot = getNumber(payload, ["pool", "hot", "count"]);
  const poolCold = getNumber(payload, ["pool", "cold", "count"]);

  const totalRequests = getNumber(payload, ["stats", "total_requests"]);
  const successRatePercent = getNumber(payload, [
    "stats",
    "success_rate_percent",
  ]);
  const avgLatencyMs = getNumber(payload, ["stats", "avg_latency_ms"]);

  return {
    receivedAt,
    cpuPercent,
    memoryPercent,
    uptimeSeconds,
    poolPermanent,
    poolHot,
    poolCold,
    totalRequests,
    successRatePercent,
    avgLatencyMs,
  };
}

function parseRuntimeSnapshot(
  payload: unknown,
): Crawl4aiRuntimeSnapshot | null {
  if (!isRecord(payload)) return null;
  const receivedAt = Date.now();
  const headlessOk = getBoolean(payload, ["headless", "ok"]) ?? false;
  const headedOk = getBoolean(payload, ["headed", "ok"]) ?? false;
  const headlessDurationMs = getNumber(payload, ["headless", "durationMs"]);
  const headedDurationMs = getNumber(payload, ["headed", "durationMs"]);
  const headedError = asString(getPath(payload, ["headed", "error"]));
  const xvfbReason = asString(getPath(payload, ["xvfb", "reason"]));
  const xvfbSupported = getBoolean(payload, ["xvfb", "supported"]);
  const ssrfProxy = parseCrawl4aiSsrfProxyRuntimeState(payload);

  return {
    receivedAt,
    headlessOk,
    headedOk,
    headlessDurationMs,
    headedDurationMs,
    headedError,
    xvfbReason,
    xvfbSupported,
    ssrfProxy,
  };
}

export interface Crawl4aiHealthCardProps {
  pollIntervalMs?: number;
  runtimePollIntervalMs?: number;
  onOpenMonitor?: () => void;
  className?: string;
  style?: CSSProperties;
}

function isDocumentVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

export function Crawl4aiHealthCard({
  pollIntervalMs = 30_000,
  runtimePollIntervalMs = 60_000,
  onOpenMonitor,
  className,
  style,
}: Crawl4aiHealthCardProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HealthStatus>("loading");
  const [snapshot, setSnapshot] = useState<Crawl4aiHealthSnapshot | null>(null);
  const [runtime, setRuntime] = useState<Crawl4aiRuntimeSnapshot | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [failureCount, setFailureCount] = useState(0);
  const [documentVisible, setDocumentVisible] = useState(isDocumentVisible);
  const healthInFlightRef = useRef(false);
  const runtimeInFlightRef = useRef(false);

  const poolTotal = useMemo(() => {
    const permanent = snapshot?.poolPermanent ?? 0;
    const hot = snapshot?.poolHot ?? 0;
    const cold = snapshot?.poolCold ?? 0;
    const sum = permanent + hot + cold;
    return sum > 0 ? sum : undefined;
  }, [snapshot?.poolCold, snapshot?.poolHot, snapshot?.poolPermanent]);

  const poolBreakdown = useMemo(() => {
    if (!snapshot) return null;
    if (
      snapshot.poolPermanent == null &&
      snapshot.poolHot == null &&
      snapshot.poolCold == null
    )
      return null;
    const permanent = snapshot.poolPermanent ?? 0;
    const hot = snapshot.poolHot ?? 0;
    const cold = snapshot.poolCold ?? 0;
    return `P/H/C: ${permanent}/${hot}/${cold}`;
  }, [snapshot]);

  const errorInfo = useMemo(() => {
    if (!error) return null;
    return normalizeMonitorError(error);
  }, [error]);

  const errorHelp: ReactNode = useMemo(() => {
    if (!errorInfo) return null;

    if (errorInfo.kind === "notFound") {
      return (
        <Space direction="vertical" size={2}>
          <Typography.Text type="secondary">
            {t("crawl.monitor.troubleshoot.notFound")}
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

    if (errorInfo.kind === "baseUrlMissing") {
      return (
        <Space direction="vertical" size={2}>
          <Typography.Text type="secondary">
            {t("crawl.monitor.troubleshoot.baseUrlMissing")}
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

    if (errorInfo.kind === "upstreamUnavailable") {
      return (
        <Space direction="vertical" size={2}>
          <Typography.Text type="secondary">
            {t("crawl.monitor.troubleshoot.upstreamUnavailable")}
          </Typography.Text>
          <Typography.Text code>
            pnpm docker:up:extras -d crawl4ai
          </Typography.Text>
          <Typography.Text code>pnpm docker:logs</Typography.Text>
        </Space>
      );
    }

    if (errorInfo.kind === "timeout") {
      return (
        <Typography.Text type="secondary">
          {t("crawl.monitor.troubleshoot.timeout")}
        </Typography.Text>
      );
    }

    if (errorInfo.kind === "unauthorized" || errorInfo.kind === "forbidden") {
      return (
        <Typography.Text type="secondary">
          {t("crawl.monitor.troubleshoot.auth")}
        </Typography.Text>
      );
    }

    return null;
  }, [errorInfo, t]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setDocumentVisible(isDocumentVisible());
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const loadHealth = useCallback(async () => {
    if (healthInFlightRef.current) return;
    healthInFlightRef.current = true;
    try {
      const payload = await fetchHealth();
      const parsed = parseHealthSnapshot(payload);
      if (!parsed) {
        throw new Error("Invalid /monitor/health response");
      }
      setSnapshot(parsed);
      setStatus("healthy");
      setError(null);
      setFailureCount(0);
    } catch (err) {
      setStatus("unreachable");
      setError(err instanceof Error ? err.message : String(err));
      setFailureCount((prev) => Math.min(prev + 1, 6));
    } finally {
      healthInFlightRef.current = false;
    }
  }, []);

  const loadRuntime = useCallback(async () => {
    if (runtimeInFlightRef.current) return;
    runtimeInFlightRef.current = true;
    try {
      const payload = await fetchRuntime();
      const parsedRuntime = parseRuntimeSnapshot(payload);
      if (!parsedRuntime) {
        setRuntime(null);
        setRuntimeError("Invalid /api/crawl4ai/runtime response");
        return;
      }
      setRuntime(parsedRuntime);
      setRuntimeError(null);
    } catch (err) {
      setRuntime(null);
      setRuntimeError(err instanceof Error ? err.message : String(err));
    } finally {
      runtimeInFlightRef.current = false;
    }
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.allSettled([loadHealth(), loadRuntime()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadHealth, loadRuntime]);

  const effectiveHealthPollIntervalMs = useMemo(() => {
    if (status === "healthy") return pollIntervalMs;
    if (status === "loading") return pollIntervalMs;
    const factor = Math.pow(2, Math.min(5, failureCount));
    return Math.min(60_000, pollIntervalMs * factor);
  }, [failureCount, pollIntervalMs, status]);

  useEffect(() => {
    if (!documentVisible) {
      return;
    }
    void load();
  }, [documentVisible, load]);

  useEffect(() => {
    if (!documentVisible) {
      return;
    }
    const id = window.setInterval(
      () => void loadHealth(),
      effectiveHealthPollIntervalMs,
    );
    return () => window.clearInterval(id);
  }, [documentVisible, effectiveHealthPollIntervalMs, loadHealth]);

  useEffect(() => {
    if (!documentVisible) {
      return;
    }
    const id = window.setInterval(
      () => void loadRuntime(),
      runtimePollIntervalMs,
    );
    return () => window.clearInterval(id);
  }, [documentVisible, loadRuntime, runtimePollIntervalMs]);

  const statusTag =
    status === "healthy" ? (
      <Tag color="green">
        {t("crawl.monitor.quickStatus.healthy")}
      </Tag>
    ) : status === "unreachable" ? (
      <Tag color="red">
        {t("crawl.monitor.quickStatus.unreachable")}
      </Tag>
    ) : (
      <Tag color="blue">
        {t("common.loading")}
      </Tag>
    );

  const headedTag =
    runtime?.headedOk === true ? (
      <Tag color="green">
        {t("crawl.monitor.runtime.headedOk")}
      </Tag>
    ) : runtime?.headedOk === false ? (
      <Tag color="red">
        {t("crawl.monitor.runtime.headedFailed")}
      </Tag>
    ) : null;

  const ssrfProxyStatus = getCrawl4aiSsrfProxyStatus(runtime?.ssrfProxy);
  const ssrfProxyTag =
    ssrfProxyStatus === "healthy" ? (
      <Tag color="green">
        {t("crawl.monitor.runtime.ssrfProxyOk")}
      </Tag>
    ) : ssrfProxyStatus === "failing" ? (
      <Tag color="red">
        {t("crawl.monitor.runtime.ssrfProxyFailed")}
      </Tag>
    ) : ssrfProxyStatus === "disabled" ? (
      <Tag color="orange">
        {t("crawl.monitor.runtime.ssrfProxyDisabled")}
      </Tag>
    ) : null;

  const updatedText = snapshot?.receivedAt
    ? t("crawl.monitor.quickStatus.updatedAt", {
        time: dayjs(snapshot.receivedAt).format("HH:mm:ss"),
      })
    : null;
  const runtimeHeadedReason =
    runtime && !runtime.headedOk
      ? (runtime.xvfbReason ?? runtime.headedError ?? runtimeError)
      : null;
  const runtimeHeadedIssue = classifyHeadedIssue(
    runtimeHeadedReason ?? undefined,
  );

  return (
    <Card
      size="small"
      className={className}
      style={{ marginBottom: 16, ...style }}
      title={
        <Space size={8}>
          <Typography.Text>
            {t("crawl.monitor.quickStatus.title")}
          </Typography.Text>
          {statusTag}
          {headedTag}
          {ssrfProxyTag}
          {updatedText ? (
            <Typography.Text type="secondary">{updatedText}</Typography.Text>
          ) : null}
        </Space>
      }
      extra={
        <Space>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={load}
            loading={refreshing}
          >
            {t("common.refresh")}
          </Button>
          {onOpenMonitor ? (
            <Button
              size="small"
              icon={<DashboardOutlined />}
              onClick={onOpenMonitor}
            >
              {t("crawl.monitor.open")}
            </Button>
          ) : null}
        </Space>
      }
    >
      {status === "unreachable" && errorInfo ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("crawl.monitor.quickStatus.unreachable")}
          description={
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
              <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                {errorInfo.message}
              </Typography.Text>
              {errorHelp}
            </Space>
          }
        />
      ) : null}

      <Row gutter={[16, 12]}>
        <Col xs={12} sm={8} md={4}>
          <Statistic
            title="CPU"
            value={snapshot?.cpuPercent ?? "-"}
            suffix={typeof snapshot?.cpuPercent === "number" ? "%" : undefined}
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic
            title="Memory"
            value={snapshot?.memoryPercent ?? "-"}
            suffix={
              typeof snapshot?.memoryPercent === "number" ? "%" : undefined
            }
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic
            title={t("crawl.monitor.overview.totalBrowsers")}
            value={poolTotal ?? "-"}
          />
          {poolBreakdown ? (
            <Typography.Text type="secondary">{poolBreakdown}</Typography.Text>
          ) : null}
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic
            title={t("crawl.monitor.overview.successRate")}
            value={snapshot?.successRatePercent ?? "-"}
            suffix={
              typeof snapshot?.successRatePercent === "number" ? "%" : undefined
            }
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic
            title={t("crawl.monitor.overview.avgLatency")}
            value={snapshot?.avgLatencyMs ?? "-"}
            suffix={
              typeof snapshot?.avgLatencyMs === "number" ? "ms" : undefined
            }
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic
            title={t("crawl.monitor.overview.totalRequests")}
            value={snapshot?.totalRequests ?? "-"}
          />
        </Col>
      </Row>

      {status === "healthy" && runtime ? (
        <Space direction="vertical" size={4} style={{ marginTop: 12 }}>
          <Typography.Text type="secondary">
            {t("crawl.monitor.runtime.summary", {
              headless: runtime.headlessOk ? "OK" : "FAILED",
              headed: runtime.headedOk ? "OK" : "FAILED",
              proxy:
                ssrfProxyStatus === "healthy"
                  ? "OK"
                  : ssrfProxyStatus === "disabled"
                    ? "OFF"
                    : ssrfProxyStatus === "failing"
                      ? "FAILED"
                      : "UNKNOWN",
            })}
            {typeof runtime.headedDurationMs === "number"
              ? ` (${runtime.headedDurationMs}ms)`
              : null}
          </Typography.Text>
          {ssrfProxyStatus === "disabled" ? (
            <Alert
              type="warning"
              showIcon
              message={t("crawl.monitor.runtime.ssrfProxyRiskTitle")}
              description={
                <Space direction="vertical" size={2}>
                  <Typography.Text>
                    {t("crawl.monitor.runtime.ssrfProxyRiskBody")}
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
              message={t("crawl.monitor.runtime.ssrfProxyFailedTitle")}
              description={
                <Space direction="vertical" size={2}>
                  {runtime.ssrfProxy.error ? (
                    <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                      {runtime.ssrfProxy.error}
                    </Typography.Text>
                  ) : null}
                  {runtime.ssrfProxy.url ? (
                    <Typography.Text code>
                      CRAWL4AI_SSRF_PROXY_URL={runtime.ssrfProxy.url}
                    </Typography.Text>
                  ) : null}
                  <Typography.Text type="secondary">
                    {t("crawl.monitor.runtime.ssrfProxyFailedBody")}
                  </Typography.Text>
                </Space>
              }
            />
          ) : null}
          {!runtime.headedOk && runtimeHeadedReason ? (
            <Alert
              type={runtimeHeadedIssue === "unknown" ? "info" : "warning"}
              showIcon
              message={
                runtimeHeadedIssue === "display"
                  ? t("crawl.runtimeGuide.displayIssueTitle")
                  : runtimeHeadedIssue === "timeout"
                    ? t("crawl.runtimeGuide.timeoutIssueTitle")
                    : t("crawl.monitor.runtime.headedFailed")
              }
              description={
                <Space direction="vertical" size={2}>
                  <Typography.Text style={{ whiteSpace: "pre-wrap" }}>
                    {runtimeHeadedReason}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {runtimeHeadedIssue === "display"
                      ? t("crawl.runtimeGuide.displayIssueHint")
                      : runtimeHeadedIssue === "timeout"
                        ? t("crawl.runtimeGuide.timeoutIssueHint")
                        : t("crawl.runtimeGuide.noAutoBootstrap")}
                  </Typography.Text>
                </Space>
              }
            />
          ) : null}
        </Space>
      ) : status === "healthy" && runtimeError ? (
        <Typography.Text
          type="secondary"
          style={{ marginTop: 12, display: "block", whiteSpace: "pre-wrap" }}
        >
          {runtimeError}
        </Typography.Text>
      ) : null}
    </Card>
  );
}
