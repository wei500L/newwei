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
import dayjs from "dayjs";

import {
  AlertSeverity,
  AlertStatus,
  AnalysisType,
  useAlertRulesQuery,
  useAnalysisResultsQuery,
  useDashboardHeroMetricsQuery,
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
import { HeroSection } from "./hero-section";
import { LiveAlertsToasts } from "./live-alerts";
import { MetricDrillDown } from "./metric-drilldown";
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

  // Hero Metrics Query
  const heroDateRange = useMemo(() => ({
    start: dayjs().subtract(30, 'day').startOf('day').toISOString(),
    end: dayjs().endOf('day').toISOString()
  }), []);

  const { data: heroData, loading: heroLoading } = useDashboardHeroMetricsQuery({
    variables: heroDateRange,
    fetchPolicy: "cache-and-network"
  });

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
  const [activeDrillDownKey, setActiveDrillDownKey] = useState<string | null>(null);

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
      <div className="flex justify-center mt-12">
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
    <div className="space-y-6 pb-8">
      <LiveAlertsToasts />
      <HeroSection 
        loading={heroLoading}
        conflictData={heroData?.conflict ?? []}
        marketData={heroData?.market ?? []}
        resourceData={heroData?.resource ?? []}
        supplyData={heroData?.supply ?? []}
        onMetricClick={setActiveDrillDownKey} 
      />
      <MetricDrillDown 
        visible={!!activeDrillDownKey} 
        metricKey={activeDrillDownKey} 
        onClose={() => setActiveDrillDownKey(null)} 
      />
      <Row gutter={[20, 20]}>
        <Col xs={24} md={12} lg={8}>
          <Card className="content-card h-full flex flex-col justify-center">
            <Statistic title={t("dashboard.stats.totalItems")} value={itemCount} />
          </Card>
        </Col>
        <Col xs={24} md={12} lg={8}>
          <Card className="content-card h-full flex flex-col justify-center">
            <Statistic title={t("dashboard.stats.processedItems")} value={processedCount} />
          </Card>
        </Col>
        <Col xs={24} md={24} lg={8}>
          <Card
            className="content-card h-full"
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
      <Row gutter={[20, 20]}>
        <Col xs={24} md={12}>
          <Card title={t("dashboard.queue.recentActivity")} className="content-card h-full">
            <List
              rowKey={(item) => item.jobId}
              dataSource={parsedLogs}
              renderItem={(item) => (
                <List.Item className="!px-0">
                  <List.Item.Meta
                    title={<span className="font-medium text-sm">{`${item.event} • ${item.jobId}`}</span>}
                    description={
                      <div className="text-xs text-gray-500">
                        {formatDateTime(item.timestamp, locale, {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit"
                        })}
                        {item.payload?.message
                          ? <div className="mt-1">{t("dashboard.queue.payloadMessage", { message: item.payload?.message })}</div>
                          : ""}
                      </div>
                    }
                  />
                </List.Item>
              )}
            />
            {parsedLogs.length === 0 && (
              <Empty description={t("dashboard.queue.noRecentLogs")} className="my-8" />
            )}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title={t("dashboard.nextActions.title")} className="content-card h-full">
            <Typography.Paragraph className="mb-6 text-gray-600">
              {t("dashboard.nextActions.description")}
            </Typography.Paragraph>
            <Row gutter={[16, 16]}>
              <Col xs={24} md={12}>
                <Typography.Text strong className="block mb-2">
                  {t("dashboard.nextActions.anomalies")}
                </Typography.Text>
                <List
                  size="small"
                  loading={analysisLoading}
                  dataSource={recentAnomalies}
                  locale={{ emptyText: t("dashboard.nextActions.noAnomalies") }}
                  renderItem={(item) => (
                    <List.Item className="!px-0">
                      <List.Item.Meta
                        title={
                          <Space size={4}>
                            <Tag className="mr-0">{item.status}</Tag>
                            <span className="text-xs text-gray-500">
                              {formatDateTime(item.createdAt, locale, {
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit"
                              })}
                            </span>
                          </Space>
                        }
                        description={
                          <div className="text-xs text-gray-500 line-clamp-2 mt-1">
                            {item.summary ?? t("dashboard.nextActions.pendingSummary")}
                          </div>
                        }
                      />
                    </List.Item>
                  )}
                />
              </Col>
              <Col xs={24} md={12}>
                <Typography.Text strong className="block mb-2">{t("dashboard.nextActions.alertRouting")}</Typography.Text>
                <List
                  size="small"
                  loading={alertRulesLoading}
                  dataSource={activeAlertRules.slice(0, 3)}
                  locale={{ emptyText: t("dashboard.nextActions.noAlertRules") }}
                  renderItem={(rule) => (
                    <List.Item className="!px-0">
                      <List.Item.Meta
                        title={
                          <Space size={4} wrap>
                            <span className="font-medium text-sm">{rule.name}</span>
                            <Tag color={severityColor[rule.severity]} className="mr-0">
                              {rule.severity}
                            </Tag>
                          </Space>
                        }
                        description={
                          <div className="text-xs text-gray-500 mt-1">
                            {t("dashboard.nextActions.alertRoutingSummary", {
                              metric: rule.metricSlug,
                              channels:
                                rule.channels.map((c) => c.name).join(", ") ||
                                t("dashboard.nextActions.noneConfigured")
                            })}
                          </div>
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
      <Row>
        <Col span={24}>
          <Card title={t("dashboard.editor.title")} className="content-card">
            <Space direction="vertical" className="w-full" size="middle">
              <div className="flex flex-wrap items-center gap-4">
                <Typography.Text type="secondary" className="hidden sm:inline">
                  {t("dashboard.editor.description")}
                </Typography.Text>
                <div className="flex items-center gap-2 ml-auto">
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
                    className="w-[100px]"
                  />
                  <Select
                    placeholder={t("dashboard.editor.selectDashboard")}
                    className="min-w-[200px]"
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
                </div>
              </div>
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
      <Row gutter={[20, 20]}>
        <Col xs={24} lg={12}>
          <Card title={t("dashboard.panels.smartAlerts")} className="content-card h-full">
            <AlertPanel />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={t("dashboard.panels.aiAnalysis")} className="content-card h-full">
            <AnalysisPanel />
          </Card>
        </Col>
      </Row>
      <Row gutter={[20, 20]}>
        <Col xs={24} lg={24}>
          <DrilldownChart
            category="economic-short"
            title={t("dashboard.drilldown.title")}
          />
        </Col>
      </Row>
      <Row gutter={[20, 20]}>
        <Col xs={24} lg={24}>
          <Card title={t("dashboard.alertConfig.title")} className="content-card">
            <AlertConfigForm />
          </Card>
        </Col>
      </Row>
    </div>
  );
}