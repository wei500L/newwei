"use client";

import { DashboardOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Row, Space, Statistic, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useState } from "react";
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

async function fetchHealth(): Promise<unknown> {
  const response = await fetch("/api/crawl4ai/monitor/health", { cache: "no-store" });
  const text = await response.text();
  if (!response.ok) {
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

  const poolPermanent = getNumber(payload, ["pool", "permanent", "active"]);
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

  const load = useCallback(async () => {
    if (refreshing) return;
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
    } catch (err) {
      setStatus("unreachable");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), pollIntervalMs);
    return () => window.clearInterval(id);
  }, [load, pollIntervalMs]);

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
      {status === "unreachable" && error ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("crawl.monitor.quickStatus.unreachable", { defaultValue: "Unreachable" })}
          description={<Typography.Text style={{ whiteSpace: "pre-wrap" }}>{error}</Typography.Text>}
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

