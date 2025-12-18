"use client";

import {
  Button,
  Card,
  Col,
  Empty,
  List,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect, useMemo, useState } from "react";

import {
  AlertSeverity,
  AlertStatus,
  AnalysisType,
  useAlertRulesQuery,
  useAnalysisResultsQuery,
  useDashboardsQuery,
  useDeleteDashboardMutation,
  useQueueStatsQuery,
  useUpsertDashboardMutation,
} from "@/graphql/generated";
import {
  useDashboardRangeStore,
  type DashboardRangePreset,
} from "@/store/time-range";

import { AlertConfigForm } from "./alert-config-form";
import { AlertPanel } from "./alert-panel";
import { AnalysisPanel } from "./analysis-panel";
import { DashboardEditor } from "./dashboard-editor";
import { DrilldownChart } from "./drilldown-chart";
import { LiveAlertsToasts } from "./live-alerts";
import { QueueChart } from "./queue-chart";
import { useQueueEvents } from "./use-queue-events";

interface QueueLog {
  event: string;
  jobId: string;
  data?: string | null;
  timestamp: string;
}

const severityColor: Record<AlertSeverity, string> = {
  [AlertSeverity.Low]: "green",
  [AlertSeverity.Medium]: "orange",
  [AlertSeverity.High]: "red",
};

const LIVE_LOGS_LIMIT = 50;
const DISPLAY_LOG_LIMIT = 15;

const dedupeLogs = (logs: QueueLog[], limit: number): QueueLog[] => {
  const seen = new Set<string>();
  const result: QueueLog[] = [];
  for (const log of logs) {
    const key = `${log.event}:${log.jobId}:${log.timestamp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(log);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
};

export function DashboardContent() {
  const { data, loading, error, refetch } = useQueueStatsQuery();
  const {
    data: dashboardsData,
    loading: dashboardsLoading,
    refetch: refetchDashboards,
  } = useDashboardsQuery();
  const [saveDashboard, { loading: savingDashboard }] =
    useUpsertDashboardMutation();
  const [deleteDashboard] = useDeleteDashboardMutation();
  const { range, setRange } = useDashboardRangeStore();
  const { data: alertRulesData, loading: alertRulesLoading } =
    useAlertRulesQuery({
      fetchPolicy: "cache-first",
    });
  const { data: analysisData, loading: analysisLoading } =
    useAnalysisResultsQuery({
      variables: { limit: 5 },
      fetchPolicy: "cache-first",
    });
  const { lastEvent, connected: queueLive, connectionError } = useQueueEvents();
  const [liveLogs, setLiveLogs] = useState<QueueLog[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();

  const dashboards = useMemo(
    () => dashboardsData?.dashboards ?? [],
    [dashboardsData],
  );
  const activeAlertRules = useMemo(
    () =>
      (alertRulesData?.alertRules ?? []).filter(
        (rule) => rule.status === AlertStatus.Active,
      ),
    [alertRulesData],
  );
  const recentAnomalies = useMemo(
    () =>
      (analysisData?.analysisResults ?? [])
        .filter((result) => result.type === AnalysisType.Anomaly)
        .slice(0, 3),
    [analysisData],
  );

  useEffect(() => {
    if (dashboards.length > 0 && !activeId) {
      setActiveId(dashboards[0]?.id);
    }
  }, [dashboards, activeId]);

  useEffect(() => {
    if (connectionError) {
      message.error(`Queue live connection failed: ${connectionError}`);
    }
  }, [connectionError]);

  useEffect(() => {
    if (!lastEvent) return;
    const serializedData = lastEvent.data
      ? JSON.stringify(lastEvent.data)
      : undefined;
    setLiveLogs((prev) =>
      dedupeLogs(
        [
          {
            event: lastEvent.event,
            jobId: lastEvent.jobId,
            data: serializedData,
            timestamp: lastEvent.timestamp,
          },
          ...prev,
        ],
        LIVE_LOGS_LIMIT,
      ),
    );
    void refetch();
    if (lastEvent.event === "FAILED") {
      message.error(`Queue job ${lastEvent.jobId} failed`);
    } else if (lastEvent.event === "COMPLETED") {
      message.success(`Queue job ${lastEvent.jobId} completed`);
    } else if (lastEvent.event === "ACTIVE") {
      message.info(`Queue job ${lastEvent.jobId} started`);
    }
  }, [lastEvent, refetch]);

  const recentLogs = data?.queueStats?.recentLogs;
  const combinedLogs = useMemo(
    () =>
      dedupeLogs(
        [...(liveLogs ?? []), ...(recentLogs ?? [])],
        DISPLAY_LOG_LIMIT,
      ),
    [liveLogs, recentLogs],
  );
  const parsedLogs = useMemo(
    () =>
      combinedLogs.map((log) => {
        let parsedPayload: Record<string, unknown> | undefined;
        if (log.data) {
          try {
            parsedPayload = JSON.parse(log.data);
          } catch {
            parsedPayload = undefined;
          }
        }
        return {
          ...log,
          payload: parsedPayload,
        };
      }),
    [combinedLogs],
  );

  if (loading || dashboardsLoading) {
    return (
      <div
        style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (error || !data?.queueStats) {
    return <Empty description="Unable to load dashboard metrics" />;
  }

  const { counts, processedCount, itemCount } = data.queueStats;
  const activeDashboard =
    dashboards.find((d) => d.id === activeId) ?? dashboards[0] ?? null;

  const chartData: Record<string, number> = {
    waiting: counts.waiting,
    active: counts.active,
    completed: counts.completed,
    failed: counts.failed,
    delayed: counts.delayed,
  };

  return (
    <div>
      <LiveAlertsToasts />
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} lg={8}>
          <Card className="content-card">
            <Statistic title="Total Items" value={itemCount} />
          </Card>
        </Col>
        <Col xs={24} md={12} lg={8}>
          <Card className="content-card">
            <Statistic title="Processed Items" value={processedCount} />
          </Card>
        </Col>
        <Col xs={24} md={24} lg={8}>
          <Card
            className="content-card"
            title={
              <Space size="small" align="center">
                <span>Queue Snapshot</span>
                <Tag color={queueLive ? "green" : "default"}>
                  {queueLive ? "Live" : "Offline"}
                </Tag>
              </Space>
            }
          >
            <QueueChart data={chartData} />
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: "1.5rem" }}>
        <Col xs={24} md={12}>
          <Card title="Recent Queue Activity" className="content-card">
            <List
              rowKey={(item) => item.jobId}
              dataSource={parsedLogs}
              renderItem={(item) => (
                <List.Item>
                  <List.Item.Meta
                    title={`${item.event} • ${item.jobId}`}
                    description={
                      <Typography.Text type="secondary">
                        {new Date(item.timestamp).toLocaleString()}
                        {item.payload?.message
                          ? ` — ${item.payload?.message}`
                          : ""}
                      </Typography.Text>
                    }
                  />
                </List.Item>
              )}
            />
            {parsedLogs.length === 0 && (
              <Empty description="No recent queue logs" />
            )}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="Next Actions" className="content-card">
            <Typography.Paragraph>
              Queue jobs are processed through the dedupe → transform → tag →
              score pipeline. Monitor the queue metrics to ensure SLAs are met.
            </Typography.Paragraph>
            <Row gutter={[12, 12]}>
              <Col xs={24} md={12}>
                <Typography.Text strong>
                  Latest anomaly signals
                </Typography.Text>
                <List
                  size="small"
                  loading={analysisLoading}
                  dataSource={recentAnomalies}
                  locale={{ emptyText: "No anomalies detected" }}
                  renderItem={(item) => (
                    <List.Item>
                      <List.Item.Meta
                        title={
                          <Space>
                            <Tag>{item.status}</Tag>
                            <Typography.Text>
                              {new Date(item.createdAt).toLocaleString()}
                            </Typography.Text>
                          </Space>
                        }
                        description={
                          <Typography.Text type="secondary">
                            {item.summary ?? "Pending analysis summary"}
                          </Typography.Text>
                        }
                      />
                    </List.Item>
                  )}
                />
              </Col>
              <Col xs={24} md={12}>
                <Typography.Text strong>Alert routing</Typography.Text>
                <List
                  size="small"
                  loading={alertRulesLoading}
                  dataSource={activeAlertRules.slice(0, 3)}
                  locale={{ emptyText: "No active alert rules" }}
                  renderItem={(rule) => (
                    <List.Item>
                      <List.Item.Meta
                        title={
                          <Space>
                            <Typography.Text strong>
                              {rule.name}
                            </Typography.Text>
                            <Tag color={severityColor[rule.severity]}>
                              {rule.severity}
                            </Tag>
                            <Tag>{rule.metricProvider}</Tag>
                          </Space>
                        }
                        description={
                          <Typography.Text type="secondary">
                            Metric: {rule.metricSlug} • Channels:{" "}
                            {rule.channels.map((c) => c.name).join(", ") ||
                              "none configured"}
                          </Typography.Text>
                        }
                      />
                    </List.Item>
                  )}
                />
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>
      <Row style={{ marginTop: "2rem" }}>
        <Col span={24}>
          <Card title="Custom Dashboard Editor" className="content-card">
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space align="center">
                <Typography.Text type="secondary">
                  Drag and resize widgets, then persist layout through the
                  dashboard GraphQL mutations. Layouts are stored in MySQL.
                </Typography.Text>
                <Select
                  size="small"
                  value={range !== "custom" ? range : undefined}
                  onChange={(val) => setRange(val as DashboardRangePreset)}
                  options={[
                    { label: "1M", value: "1M" },
                    { label: "3M", value: "3M" },
                    { label: "6M", value: "6M" },
                    { label: "1Y", value: "1Y" },
                  ]}
                  style={{ width: 120 }}
                />
                <Select
                  placeholder="Select dashboard"
                  style={{ minWidth: 220 }}
                  value={activeDashboard?.id}
                  onChange={(val) => setActiveId(val)}
                  options={dashboards.map((d) => ({
                    label: d.name,
                    value: d.id,
                  }))}
                />
                <Button
                  size="small"
                  onClick={() => {
                    setActiveId(undefined);
                  }}
                >
                  New Dashboard
                </Button>
              </Space>
              <DashboardEditor
                dashboard={activeDashboard ?? undefined}
                saving={savingDashboard}
                onSave={async (input) => {
                  await saveDashboard({ variables: { input } });
                  await refetchDashboards();
                }}
                onDelete={
                  activeDashboard?.id
                    ? async (id: string) => {
                        await deleteDashboard({ variables: { id } });
                        await refetchDashboards();
                        message.success("Dashboard deleted");
                        setActiveId(undefined);
                      }
                    : undefined
                }
              />
            </Space>
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: "1.5rem" }}>
        <Col xs={24} lg={12}>
          <Card title="Smart Alerts" className="content-card">
            <AlertPanel />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="AI Analysis" className="content-card">
            <AnalysisPanel />
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: "1.5rem" }}>
        <Col xs={24} lg={24}>
          <DrilldownChart
            category="economic-short"
            title="Economic Drilldown (linked zoom + click to drill)"
          />
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: "1.5rem" }}>
        <Col xs={24} lg={24}>
          <Card title="Alert Configuration" className="content-card">
            <AlertConfigForm />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
