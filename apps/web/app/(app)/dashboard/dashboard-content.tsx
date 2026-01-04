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
  Skeleton,
  Space,
  Statistic,
  Switch,
  Tag,
  Timeline,
  Typography,
  message,
} from "antd";
import dayjs from "@/lib/dayjs";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
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
  const searchParams = useSearchParams();
  const isAnalysisFocused = searchParams.get("panel") === "analysis";
  const [messageApi, messageContext] = message.useMessage();
  const { data, loading, error, refetch } = useQueueStatsQuery();
  const {
    data: dashboardsData,
    loading: dashboardsLoading,
    refetch: refetchDashboards,
  } = useDashboardsQuery();

  // Hero Metrics Query
  const heroDateRange = useMemo(() => ({
    start: dayjs.utc().subtract(30, "day").startOf("day").toISOString(),
    end: dayjs.utc().endOf("day").toISOString()
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
  const analysisPanelRef = useRef<HTMLDivElement | null>(null);

  const streamStatusMeta = useMemo(() => {
    const status = streamState.status;
    if (status === "live") {
      return {
        label: t("dashboard.stream.status.live", { defaultValue: "Live" }),
        dotClass: "bg-emerald-500",
        pulse: true
      };
    }
    if (status === "polling") {
      return {
        label: t("dashboard.stream.status.polling", { defaultValue: "Polling" }),
        dotClass: "bg-amber-500",
        pulse: false
      };
    }
    return {
      label: t("dashboard.stream.status.offline", { defaultValue: "Offline" }),
      dotClass: "bg-red-500",
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

  useEffect(() => {
    if (searchParams.get("panel") === "analysis" && analysisPanelRef.current) {
      analysisPanelRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [searchParams]);

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
      <div className="flex flex-col gap-6">
        <Skeleton active paragraph={{ rows: 2 }} />
        <Skeleton active paragraph={{ rows: 6 }} />
        <Skeleton active paragraph={{ rows: 6 }} />
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
    <div className="flex gap-6 h-full items-start">
      {messageContext}
      <LiveAlertsToasts />
      
      {/* Center Column: Market Feed & Visuals */}
      <div className="flex-1 flex flex-col gap-6 min-w-0">
        
        {/* Status Bar */}
        <div className="flex items-center justify-between">
           <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
             <span
               className={`h-2 w-2 rounded-full ${streamStatusMeta.dotClass} ${streamStatusMeta.pulse ? "animate-pulse" : ""}`}
               aria-hidden="true"
             />
             <span>{streamStatusMeta.label}</span>
             <span className="text-slate-600">|</span>
             <span>Last Update: {dayjs().format('HH:mm:ss')}</span>
           </div>
           <Space>
             {process.env.NODE_ENV !== "production" && (
                <Button
                  icon={<ReloadOutlined />}
                  size="small"
                  type="text"
                  loading={refreshingDemoData}
                  onClick={handleRefreshDemoData}
                  className="text-slate-500 hover:text-[var(--primary)]"
                >
                </Button>
             )}
             <span className="text-xs text-slate-500">System Status</span>
             <Switch size="small" checked={showSystemStats} onChange={setShowSystemStats} />
           </Space>
        </div>

        {/* Hero / Market Pulse */}
        <div className="relative">
          <MarketPulse 
            loading={heroLoading}
            conflictData={heroData?.conflict ?? []}
            marketData={heroData?.market ?? []}
            resourceData={heroData?.resource ?? []}
            supplyData={heroData?.supply ?? []}
            onMetricClick={setActiveDrillDownKey} 
          />
        </div>

        <MetricDrillDown 
          visible={!!activeDrillDownKey} 
          metricKey={activeDrillDownKey} 
          onClose={() => setActiveDrillDownKey(null)} 
        />

        {/* Charts Section - Immersive Map & Analytics */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
           {/* War Map - Dominant Central Feature */}
           <div className="xl:col-span-2 h-[500px] glass-panel border border-[var(--border)] relative overflow-hidden">
             <div className="absolute top-4 left-4 z-10">
               <h3 className="text-lg text-slate-700">
                 {t("dashboard.charts.warMap.title", { defaultValue: "Indicator Situation Map" })}
               </h3>
             </div>
             <WarMap />
           </div>

           {/* Sector Heatmap - Side Panel */}
           <Card title={t("dashboard.charts.sectorHeatmap", { defaultValue: "Sector Performance" })} className="glass-card h-[500px]" bordered={false}>
             <SectorHeatmap />
           </Card>
        </div>

        {/* Financial Candlestick & Sentiment */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
           <div className="xl:col-span-2">
             <GlobalSentimentTrend 
               loading={heroLoading} 
               data={heroData?.market ?? []} 
             />
           </div>
           <div className="xl:col-span-1">
             <Card className="glass-card h-full" bordered={false}>
               <FinancialCandlestick />
             </Card>
           </div>
        </div>

        {/* System Stats (Hidden by default) */}
        {showSystemStats && (
          <div className="animate-in fade-in slide-in-from-top-4 duration-300">
            <Row gutter={[20, 20]} className="mb-6">
              <Col xs={24} md={12} lg={8}>
                <Card className="content-card h-full flex flex-col justify-center">
                  <Statistic title={t("dashboard.stats.totalItems")} value={itemCount} valueStyle={{ color: '#1f2933', fontFamily: 'var(--font-mono)' }} />
                </Card>
              </Col>
              <Col xs={24} md={12} lg={8}>
                <Card className="content-card h-full flex flex-col justify-center">
                  <Statistic title={t("dashboard.stats.processedItems")} value={processedCount} valueStyle={{ color: '#1f2933', fontFamily: 'var(--font-mono)' }} />
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
          </div>
        )}

      </div>

      {/* Right Column: Data Board & Intelligence */}
      <div className="w-[400px] flex-shrink-0 flex flex-col gap-6 hidden 2xl:flex sticky top-0 h-fit">
         {/* Live News Feed */}
         <div className="h-[600px]">
            <BreakingNewsStream />
         </div>

         {/* AI Analysis */}
         <div ref={analysisPanelRef}>
           <Card
             title={t("dashboard.panels.aiAnalysis")}
             className={`content-card flex-1 border-none shadow-sm min-h-[300px]${
               isAnalysisFocused ? " ring-1 ring-[var(--primary)]" : ""
             }`}
           >
             <AnalysisPanel />
           </Card>
         </div>

         {/* Alerts */}
         <Card title={t("dashboard.panels.smartAlerts")} className="content-card flex-1 border-none shadow-sm min-h-[200px]">
            <AlertPanel />
         </Card>
      </div>
    </div>
  );
}
