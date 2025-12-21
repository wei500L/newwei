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
import { useTranslation } from "react-i18next";

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
import { formatDateTime, resolveLocale } from "@/lib/i18n";
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
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
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
      message.error(t("dashboard.queue.connectionFailed", { error: connectionError }));
    }
  }, [connectionError, t]);

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
      message.error(t("dashboard.queue.jobFailed", { jobId: lastEvent.jobId }));
    } else if (lastEvent.event === "COMPLETED") {
      message.success(t("dashboard.queue.jobCompleted", { jobId: lastEvent.jobId }));
    } else if (lastEvent.event === "ACTIVE") {
      message.info(t("dashboard.queue.jobStarted", { jobId: lastEvent.jobId }));
    }
  }, [lastEvent, refetch, t]);

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
    return <Empty description={t("dashboard.errors.metricsUnavailable")} />;
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
            <Statistic title={t("dashboard.stats.totalItems")} value={itemCount} />
          </Card>
        </Col>
        <Col xs={24} md={12} lg={8}>
          <Card className="content-card">
            <Statistic title={t("dashboard.stats.processedItems")} value={processedCount} />
          </Card>
        </Col>
        <Col xs={24} md={24} lg={8}>
          <Card
            className="content-card"
            title={
              <Space size="small" align="center">
                <span>{t("dashboard.queue.snapshot")}</span>
                <Tag color={queueLive ? "green" : "default"}>
                  {queueLive ? t("dashboard.queue.live") : t("dashboard.queue.offline")}
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
          <Card title={t("dashboard.queue.recentActivity")} className="content-card">
            <List
              rowKey={(item) => item.jobId}
              dataSource={parsedLogs}
              renderItem={(item) => (
                <List.Item>
                  <List.Item.Meta
                    title={`${item.event} • ${item.jobId}`}
                    description={
                      <Typography.Text type="secondary">
                        {formatDateTime(item.timestamp, locale, {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit"
                        })}
                        {item.payload?.message
                          ? t("dashboard.queue.payloadMessage", {
                              message: item.payload?.message
                            })
                          : ""}
                      </Typography.Text>
                    }
                  />
                </List.Item>
              )}
            />
            {parsedLogs.length === 0 && (
              <Empty description={t("dashboard.queue.noRecentLogs")} />
            )}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title={t("dashboard.nextActions.title")} className="content-card">
            <Typography.Paragraph>
              {t("dashboard.nextActions.description")}
            </Typography.Paragraph>
            <Row gutter={[12, 12]}>
              <Col xs={24} md={12}>
                <Typography.Text strong>
                  {t("dashboard.nextActions.anomalies")}
                </Typography.Text>
                <List
                  size="small"
                  loading={analysisLoading}
                  dataSource={recentAnomalies}
                  locale={{ emptyText: t("dashboard.nextActions.noAnomalies") }}
                  renderItem={(item) => (
                    <List.Item>
                      <List.Item.Meta
                        title={
                          <Space>
                            <Tag>{item.status}</Tag>
                            <Typography.Text>
                              {formatDateTime(item.createdAt, locale, {
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit"
                              })}
                            </Typography.Text>
                          </Space>
                        }
                        description={
                          <Typography.Text type="secondary">
                            {item.summary ?? t("dashboard.nextActions.pendingSummary")}
                          </Typography.Text>
                        }
                      />
                    </List.Item>
                  )}
                />
              </Col>
              <Col xs={24} md={12}>
                <Typography.Text strong>{t("dashboard.nextActions.alertRouting")}</Typography.Text>
                <List
                  size="small"
                  loading={alertRulesLoading}
                  dataSource={activeAlertRules.slice(0, 3)}
                  locale={{ emptyText: t("dashboard.nextActions.noAlertRules") }}
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
                            {t("dashboard.nextActions.alertRoutingSummary", {
                              metric: rule.metricSlug,
                              channels:
                                rule.channels.map((c) => c.name).join(", ") ||
                                t("dashboard.nextActions.noneConfigured")
                            })}
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
          <Card title={t("dashboard.editor.title")} className="content-card">
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space align="center">
                <Typography.Text type="secondary">
                  {t("dashboard.editor.description")}
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
                  placeholder={t("dashboard.editor.selectDashboard")}
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
                  {t("dashboard.editor.newDashboard")}
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
                        message.success(t("dashboard.editor.deleted"));
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
          <Card title={t("dashboard.panels.smartAlerts")} className="content-card">
            <AlertPanel />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={t("dashboard.panels.aiAnalysis")} className="content-card">
            <AnalysisPanel />
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: "1.5rem" }}>
        <Col xs={24} lg={24}>
          <DrilldownChart
            category="economic-short"
            title={t("dashboard.drilldown.title")}
          />
        </Col>
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: "1.5rem" }}>
        <Col xs={24} lg={24}>
          <Card title={t("dashboard.alertConfig.title")} className="content-card">
            <AlertConfigForm />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
