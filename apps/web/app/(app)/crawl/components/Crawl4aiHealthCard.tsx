"use client";

import { DashboardOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Row, Space, Statistic, Tag, Typography } from "antd";
import dayjs from "dayjs";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
  kind: "notFound" | "baseUrlMissing" | "timeout" | "upstreamUnavailable" | "unauthorized" | "forbidden" | "unknown";
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
  if (message === "Not Found" || trimmed.includes("\"detail\":\"Not Found\"")) {
    return { kind: "notFound", message };
  }
  if (lower.includes("crawl4ai_base_url") || lower.includes("not configured")) {
    return { kind: "baseUrlMissing", message };
  }
  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("abort")) {
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
  const response = await fetch("/api/crawl4ai/monitor/health", { cache: "no-store" });
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
  const successRatePercent = getNumber(payload, ["stats", "success_rate_percent"]);
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
    avgLatencyMs
  };
}

export interface Crawl4aiHealthCardProps {
  pollIntervalMs?: number;
  onOpenMonitor?: () => void;
}

export function Crawl4aiHealthCard({ pollIntervalMs = 10_000, onOpenMonitor }: Crawl4aiHealthCardProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HealthStatus>("loading");
  const [snapshot, setSnapshot] = useState<Crawl4aiHealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [failureCount, setFailureCount] = useState(0);
  const inFlightRef = useRef(false);

  const poolTotal = useMemo(() => {
    const permanent = snapshot?.poolPermanent ?? 0;
    const hot = snapshot?.poolHot ?? 0;
    const cold = snapshot?.poolCold ?? 0;
    const sum = permanent + hot + cold;
    return sum > 0 ? sum : undefined;
  }, [snapshot?.poolCold, snapshot?.poolHot, snapshot?.poolPermanent]);

  const poolBreakdown = useMemo(() => {
    if (!snapshot) return null;
    if (snapshot.poolPermanent == null && snapshot.poolHot == null && snapshot.poolCold == null) return null;
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
            {t("crawl.monitor.troubleshoot.notFound", {
              defaultValue:
                "Crawl4AI monitoring endpoints are missing. This usually means the crawl4ai image tag is wrong/too old (Docker Hub :latest is a common culprit). Prefer the floating Docker Hub tag :0 or a recent release tag."
            })}
          </Typography.Text>
          <Typography.Text code>CRAWL4AI_IMAGE=unclecode/crawl4ai:0</Typography.Text>
          <Typography.Text code>pnpm docker:up:extras -d --force-recreate crawl4ai</Typography.Text>
        </Space>
      );
    }

    if (errorInfo.kind === "baseUrlMissing") {
      return (
        <Space direction="vertical" size={2}>
          <Typography.Text type="secondary">
            {t("crawl.monitor.troubleshoot.baseUrlMissing", {
              defaultValue:
                "CRAWL4AI_BASE_URL is not configured for the web runtime. Set it and restart the web server."
            })}
          </Typography.Text>
          <Typography.Text code>CRAWL4AI_BASE_URL=http://crawl4ai:11235</Typography.Text>
          <Typography.Text code>CRAWL4AI_BASE_URL=http://localhost:8082</Typography.Text>
        </Space>
      );
    }

    if (errorInfo.kind === "upstreamUnavailable") {
      return (
        <Space direction="vertical" size={2}>
          <Typography.Text type="secondary">
            {t("crawl.monitor.troubleshoot.upstreamUnavailable", {
              defaultValue:
                "Crawl4AI is not reachable from the web server. Ensure the extras profile is running, then check the crawl4ai container logs."
            })}
          </Typography.Text>
          <Typography.Text code>pnpm docker:up:extras -d crawl4ai</Typography.Text>
          <Typography.Text code>pnpm docker:logs</Typography.Text>
        </Space>
      );
    }

    if (errorInfo.kind === "timeout") {
      return (
        <Typography.Text type="secondary">
          {t("crawl.monitor.troubleshoot.timeout", {
            defaultValue:
              "Monitor request timed out. Crawl4AI may be overloaded or starting up. Check container health and try again."
          })}
        </Typography.Text>
      );
    }

    if (errorInfo.kind === "unauthorized" || errorInfo.kind === "forbidden") {
      return (
        <Typography.Text type="secondary">
          {t("crawl.monitor.troubleshoot.auth", {
            defaultValue:
              "Access denied. Make sure you are logged in and have crawl.read/crawl.write permissions."
          })}
        </Typography.Text>
      );
    }

    return null;
  }, [errorInfo, t]);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
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
      setRefreshing(false);
      inFlightRef.current = false;
    }
  }, []);

  const effectivePollIntervalMs = useMemo(() => {
    if (status === "healthy") return pollIntervalMs;
    if (status === "loading") return pollIntervalMs;
    const factor = Math.pow(2, Math.min(5, failureCount));
    return Math.min(60_000, pollIntervalMs * factor);
  }, [failureCount, pollIntervalMs, status]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), effectivePollIntervalMs);
    return () => window.clearInterval(id);
  }, [effectivePollIntervalMs, load]);

  const statusTag =
    status === "healthy" ? (
      <Tag color="green">{t("crawl.monitor.quickStatus.healthy", { defaultValue: "Healthy" })}</Tag>
    ) : status === "unreachable" ? (
      <Tag color="red">{t("crawl.monitor.quickStatus.unreachable", { defaultValue: "Unreachable" })}</Tag>
    ) : (
      <Tag color="blue">{t("common.loading", { defaultValue: "Loading..." })}</Tag>
    );

  const updatedText =
    snapshot?.receivedAt
      ? t("crawl.monitor.quickStatus.updatedAt", {
          defaultValue: "Updated {{time}}",
          time: dayjs(snapshot.receivedAt).format("HH:mm:ss")
        })
      : null;

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space size={8}>
          <Typography.Text>{t("crawl.monitor.quickStatus.title", { defaultValue: "Crawl4AI status" })}</Typography.Text>
          {statusTag}
          {updatedText ? <Typography.Text type="secondary">{updatedText}</Typography.Text> : null}
        </Space>
      }
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={refreshing}>
            {t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
          {onOpenMonitor ? (
            <Button size="small" icon={<DashboardOutlined />} onClick={onOpenMonitor}>
              {t("crawl.monitor.open", { defaultValue: "Monitor" })}
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
          message={t("crawl.monitor.quickStatus.unreachable", { defaultValue: "Unreachable" })}
          description={
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
              <Typography.Text style={{ whiteSpace: "pre-wrap" }}>{errorInfo.message}</Typography.Text>
              {errorHelp}
            </Space>
          }
        />
      ) : null}

      <Row gutter={[16, 12]}>
        <Col xs={12} sm={8} md={4}>
          <Statistic title="CPU" value={snapshot?.cpuPercent ?? "-"} suffix={typeof snapshot?.cpuPercent === "number" ? "%" : undefined} />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic title="Memory" value={snapshot?.memoryPercent ?? "-"} suffix={typeof snapshot?.memoryPercent === "number" ? "%" : undefined} />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic title={t("crawl.monitor.overview.totalBrowsers", { defaultValue: "Total" })} value={poolTotal ?? "-"} />
          {poolBreakdown ? <Typography.Text type="secondary">{poolBreakdown}</Typography.Text> : null}
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic title={t("crawl.monitor.overview.successRate", { defaultValue: "Success rate" })} value={snapshot?.successRatePercent ?? "-"} suffix={typeof snapshot?.successRatePercent === "number" ? "%" : undefined} />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic title={t("crawl.monitor.overview.avgLatency", { defaultValue: "Avg latency" })} value={snapshot?.avgLatencyMs ?? "-"} suffix={typeof snapshot?.avgLatencyMs === "number" ? "ms" : undefined} />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic title={t("crawl.monitor.overview.totalRequests", { defaultValue: "Total requests" })} value={snapshot?.totalRequests ?? "-"} />
        </Col>
      </Row>
    </Card>
  );
}
