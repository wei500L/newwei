"use client";

import { ReloadOutlined } from "@ant-design/icons";
import {
  Button,
  Card,
  Col,
  Collapse,
  Empty,
  List,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Tag,
  Timeline,
  Typography,
  message,
} from "antd";
import dayjs from "dayjs";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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
import { createApiClient } from "@/lib/api-client";
import { captureClientError } from "@/lib/client-telemetry";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import {
  useDashboardRangeStore,
  type DashboardRangePreset,
} from "@/store/time-range";
import {
  QUEUE_STATUS_KEYS,
  type QueueStatusKey,
  useDashboardFiltersStore
} from "@/store/dashboard-filters";

import { AlertConfigForm } from "./alert-config-form";
import { AlertPanel } from "./alert-panel";
import { AnalysisPanel } from "./analysis-panel";
import { BreakingNewsStream } from "./components/breaking-news-stream";
import { GlobalSentimentTrend } from "./components/global-sentiment-trend";
import { MarketPulse } from "./components/market-pulse";
import { DashboardEditor } from "./dashboard-editor";
import { DrilldownChart } from "./drilldown-chart";
import { HeroSection } from "./hero-section";
import { LiveAlertsToasts } from "./live-alerts";
import { MetricDrillDown } from "./metric-drilldown";
import { QueueChart } from "./queue-chart";
import { useQueueEvents } from "./use-queue-events";
import { useDashboardStream, type DashboardStreamStatus } from "./use-dashboard-stream";
import { useDashboardUrlSync } from "./use-dashboard-url-sync";
import { SectorHeatmap } from "./charts/sector-heatmap";
import { WarMap } from "./charts/war-map";
import { FinancialCandlestick } from "./charts/financial-candlestick";

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
const QUEUE_STATUS_SET = new Set<QueueStatusKey>(QUEUE_STATUS_KEYS);

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

const extractQueueStatus = (event: string): QueueStatusKey | null => {
  const normalized = event.trim().toLowerCase();
  if (!normalized) return null;
  const parts = normalized.split(":");
  const candidate = (parts[parts.length - 1] ?? "").trim();
  return QUEUE_STATUS_SET.has(candidate as QueueStatusKey)
    ? (candidate as QueueStatusKey)
    : null;
};

export function DashboardContent() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [messageApi, messageContext] = message.useMessage();
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

  const { data: heroData, loading: heroLoading, refetch: refetchHero } = useDashboardHeroMetricsQuery({
    variables: heroDateRange,
    fetchPolicy: "cache-and-network"
  });

  const [saveDashboard, { loading: savingDashboard }] =
    useUpsertDashboardMutation();
  const [deleteDashboard] = useDeleteDashboardMutation();
  const { range, setRange, start, end } = useDashboardRangeStore();
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
  const { queueStatus, selectedSector, setQueueStatus } =
    useDashboardFiltersStore();
  const streamState = useDashboardStream({
    accessToken: session?.accessToken,
    start,
    end,
    queueStatus,
    selectedSector,
    enabled: Boolean(session?.accessToken)
  });
  const { resetFilters, hasActiveFilters } = useDashboardUrlSync();
  const queueFilterMounted = useRef(false);
  const [liveLogs, setLiveLogs] = useState<QueueLog[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [activeDrillDownKey, setActiveDrillDownKey] = useState<string | null>(null);
  const [refreshingDemoData, setRefreshingDemoData] = useState(false);
  const [showSystemStats, setShowSystemStats] = useState(false);
  const lastStreamStatusRef = useRef<DashboardStreamStatus | null>(null);

  const streamStatusMeta = useMemo(() => {
    const status = streamState.status;
    if (status === "live") {
      return {
        label: t("dashboard.stream.status.live", { defaultValue: "Live" }),
        dotClass: "bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.7)]",
        pulse: true
      };
    }
    if (status === "polling") {
      return {
        label: t("dashboard.stream.status.polling", { defaultValue: "Polling" }),
        dotClass: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]",
        pulse: false
      };
    }
    return {
      label: t("dashboard.stream.status.offline", { defaultValue: "Offline" }),
      dotClass: "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]",
      pulse: false
    };
  }, [streamState.status, t]);

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

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
    if (!session?.accessToken) return;
    const prevStatus = lastStreamStatusRef.current;
    if (prevStatus === streamState.status) return;
    lastStreamStatusRef.current = streamState.status;
    if (prevStatus === null) return;
    if (streamState.status === "polling") {
      toast.error(
        t("dashboard.stream.fallback", {
          defaultValue: "Live updates interrupted; using polling"
        })
      );
    } else if (streamState.status === "offline") {
      toast.error(
        t("dashboard.stream.offline", {
          defaultValue: "Live updates unavailable"
        })
      );
    }
  }, [session?.accessToken, streamState.status, t]);

  const handleRefreshDemoData = useCallback(async () => {
    if (refreshingDemoData) return;
    setRefreshingDemoData(true);
    try {
      await apiClient.post("dashboard/demo-metrics/refresh", {}, { timeout: 10_000 });
      messageApi.success(t("dashboard.demoData.refreshed"));
      await refetchHero();
    } catch (error) {
      captureClientError("Failed to refresh demo dashboard metrics", error);
      messageApi.error(t("dashboard.demoData.refreshFailed"));
    } finally {
      setRefreshingDemoData(false);
    }
  }, [apiClient, messageApi, refetchHero, refreshingDemoData, t]);

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

  useEffect(() => {
    if (!queueFilterMounted.current) {
      queueFilterMounted.current = true;
      return;
    }
    void refetch();
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }, [queueStatus, queryClient, refetch]);

  const recentLogs = data?.queueStats?.recentLogs;
  const combinedLogs = useMemo(
    () =>
      dedupeLogs(
        [...(liveLogs ?? []), ...(recentLogs ?? [])],
        DISPLAY_LOG_LIMIT,
      ),
    [liveLogs, recentLogs],
  );
  const filteredLogs = useMemo(() => {
    if (!queueStatus) return combinedLogs;
    return combinedLogs.filter(
      (log) => extractQueueStatus(log.event) === queueStatus,
    );
  }, [combinedLogs, queueStatus]);
  const parsedLogs = useMemo(
    () =>
      filteredLogs.map((log) => {
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
    [filteredLogs],
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

  const chartData: Record<QueueStatusKey, number> = {
    waiting: counts.waiting,
    active: counts.active,
    completed: counts.completed,
    failed: counts.failed,
    delayed: counts.delayed,
  };

  return (
    <div className="space-y-10 pb-12">
      {messageContext}
      <LiveAlertsToasts />
      
      {/* View Toggle */}
      <div className="flex items-center justify-between mb-2">
         <div className="flex items-center gap-2 text-xs text-slate-400" role="status" aria-live="polite">
           <span
             className={`h-2 w-2 rounded-full ${streamStatusMeta.dotClass} ${streamStatusMeta.pulse ? "animate-pulse" : ""}`}
             aria-hidden="true"
           />
           <span>{streamStatusMeta.label}</span>
         </div>
         <Space>
           <span className="text-xs text-gray-500">System Status</span>
           <Switch size="small" checked={showSystemStats} onChange={setShowSystemStats} />
         </Space>
      </div>

      <div className="relative">
        <MarketPulse 
          loading={heroLoading}
          conflictData={heroData?.conflict ?? []}
          marketData={heroData?.market ?? []}
          resourceData={heroData?.resource ?? []}
          supplyData={heroData?.supply ?? []}
          onMetricClick={setActiveDrillDownKey} 
        />
        {process.env.NODE_ENV !== "production" && (
          <div className="absolute -top-6 right-0 opacity-20 hover:opacity-100 transition-opacity">
            <Button
              icon={<ReloadOutlined />}
              size="small"
              type="text"
              loading={refreshingDemoData}
              onClick={handleRefreshDemoData}
            >
              <span className="text-[10px]">{t("dashboard.demoData.refresh")}</span>
            </Button>
          </div>
        )}
      </div>

      <MetricDrillDown 
        visible={!!activeDrillDownKey} 
        metricKey={activeDrillDownKey} 
        onClose={() => setActiveDrillDownKey(null)} 
      />

      {/* Bento Grid Layout */}
      <Row gutter={[20, 20]}>
        {/* Left Column: Sentiment Trend (Dominant) */}
        <Col xs={24} lg={16}>
           <GlobalSentimentTrend 
             loading={heroLoading} 
             data={heroData?.market ?? []} // Using market data as proxy for sentiment trend
           />
        </Col>

        {/* Right Column: News Stream */}
        <Col xs={24} lg={8}>
           <BreakingNewsStream />
        </Col>
      </Row>

      <Row gutter={[20, 20]}>
        <Col xs={24} md={12}>
          <Card title={t("dashboard.nextActions.title")} className="content-card h-full border-none shadow-sm">
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

        {/* AI & Alerts */}
        <Col xs={24} lg={12}>
          <div className="flex flex-col gap-5 h-full">
            <Card title={t("dashboard.panels.smartAlerts")} className="content-card flex-1 border-none shadow-sm">
              <AlertPanel />
            </Card>
            <Card title={t("dashboard.panels.aiAnalysis")} className="content-card flex-1 border-none shadow-sm">
              <AnalysisPanel />
            </Card>
          </div>
        </Col>
      </Row>

      {/* System Stats (Hidden by default) */}
      <div style={{ display: showSystemStats ? 'block' : 'none' }}>
        <Row gutter={[20, 20]} className="mb-6">
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
              <QueueChart
                data={chartData}
                activeStatus={queueStatus}
                onFilterChange={setQueueStatus}
              />
            </Card>
          </Col>
        </Row>
        <Row gutter={[20, 20]}>
          <Col xs={24} md={12}>
            <Card
              title={t("dashboard.queue.recentActivity")}
              className="content-card h-full"
              extra={
                hasActiveFilters ? (
                  <Space size={6} wrap>
                    {queueStatus ? (
                      <Tag color="blue" closable onClose={resetFilters}>
                        {t(`dashboard.queue.states.${queueStatus}`, {
                          defaultValue: queueStatus
                        })}
                      </Tag>
                    ) : null}
                    <Tag
                      color="cyan"
                      onClick={resetFilters}
                      className="cursor-pointer !rounded-full !px-3"
                    >
                      {t("dashboard.filters.resetAll", { defaultValue: "Reset All Filters" })}
                    </Tag>
                  </Space>
                ) : undefined
              }
            >
              {parsedLogs.length > 0 ? (
                <Timeline
                  mode="left"
                  items={parsedLogs.map((item) => {
                    let color = "blue";
                    if (item.event === "FAILED") color = "red";
                    if (item.event === "COMPLETED") color = "green";
                    if (item.event === "WAITING") color = "gray";

                    const payload = item.payload as Record<string, unknown> | undefined;
                    let errorMessage: string | undefined;

                    if (item.event === "FAILED") {
                      if (typeof payload?.error === "string") {
                        errorMessage = payload.error;
                      } else if (
                        payload?.error &&
                        typeof payload.error === "object" &&
                        "message" in payload.error &&
                        typeof payload.error.message === "string"
                      ) {
                        errorMessage = payload.error.message;
                      } else if (typeof payload?.message === "string") {
                        errorMessage = payload.message;
                      }
                    } else if (typeof payload?.message === "string") {
                      errorMessage = payload.message;
                    }

                    return {
                      color,
                      label: (
                        <span className="text-xs text-gray-400">
                          {formatDateTime(item.timestamp, locale, {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                      ),
                      children: (
                        <div className="mb-4">
                          <Space wrap>
                            <Tag color={color} className="mr-0">
                              {item.event}
                            </Tag>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {item.jobId}
                            </Typography.Text>
                          </Space>
                          
                          {errorMessage && (
                            <div className="mt-1">
                              <Typography.Text type={item.event === "FAILED" ? "danger" : undefined}>
                                {String(errorMessage)}
                              </Typography.Text>
                            </div>
                          )}

                          {payload && (
                            <Collapse
                              ghost
                              size="small"
                              items={[
                                {
                                  key: "1",
                                  label: <span style={{ fontSize: 12 }}>{t("common.details")}</span>,
                                  children: (
                                    <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto max-h-40">
                                      {JSON.stringify(payload, null, 2)}
                                    </pre>
                                  ),
                                },
                              ]}
                            />
                          )}
                        </div>
                      ),
                    };
                  })}
                />
              ) : (
                <Empty description={t("dashboard.queue.noRecentLogs")} className="my-8" />
              )}
            </Card>
          </Col>
        </Row>
      </div>
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
        <Col xs={24} md={12} lg={6}>
          <Card title={t("dashboard.charts.sectorHeatmap", { defaultValue: "Sector Performance" })} className="content-card h-full">
             <SectorHeatmap />
          </Card>
        </Col>
        <Col xs={24} md={24} lg={12}>
           <Card className="content-card h-full" bodyStyle={{ padding: 0 }}>
             <WarMap />
           </Card>
        </Col>
        <Col xs={24} md={12} lg={6}>
           <Card className="content-card h-full">
             <FinancialCandlestick />
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
