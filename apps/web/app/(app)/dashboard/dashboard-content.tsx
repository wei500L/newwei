"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  Col,
  Row,
  Skeleton,
  Space,
  Statistic,
  Switch,
  Tag,
  message,
} from "antd";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { TimeRangeControls } from "@/components/time-range-controls";
import { TimeGranularity, useDashboardHeroMetricsQuery, useQueueStatsQuery } from "@/graphql/generated";
import dayjs from "@/lib/dayjs";
import { classifyRequestError } from "@/lib/request-error";
import { resolveDefaultGranularityForRangePreset, UiTimeGranularity } from "@/lib/time-granularity";
import { useDashboardFiltersStore } from "@/store/dashboard-filters";
import { useDashboardRangeStore } from "@/store/time-range";

import { LiveAlertsToasts } from "./live-alerts";
import { useDashboardStream, type DashboardStreamStatus } from "./use-dashboard-stream";
import { useDashboardUrlSync } from "./use-dashboard-url-sync";
import { useQueueEvents } from "./use-queue-events";

const AlertPanel = dynamic(() => import("./alert-panel").then((mod) => mod.AlertPanel), {
  loading: () => <Skeleton active paragraph={{ rows: 4 }} />
});

const AnalysisPanel = dynamic(() => import("./analysis-panel").then((mod) => mod.AnalysisPanel), {
  loading: () => <Skeleton active paragraph={{ rows: 4 }} />
});

const AnalysisStream = dynamic(
  () => import("./components/analysis-stream").then((mod) => mod.AnalysisStream),
  {
    loading: () => <Skeleton active paragraph={{ rows: 6 }} />
  }
);

const GlobalSentimentTrend = dynamic(
  () => import("./components/global-sentiment-trend").then((mod) => mod.GlobalSentimentTrend),
  {
    loading: () => <Skeleton active paragraph={{ rows: 4 }} />
  }
);

const SectorHeatmap = dynamic(
  () => import("./charts/sector-heatmap").then((mod) => mod.SectorHeatmap),
  {
    loading: () => <Skeleton active paragraph={{ rows: 6 }} />
  }
);

const WarMap = dynamic(() => import("./charts/war-map").then((mod) => mod.WarMap), {
  loading: () => <Skeleton active paragraph={{ rows: 6 }} />
});

const FinancialCandlestick = dynamic(
  () => import("./charts/financial-candlestick").then((mod) => mod.FinancialCandlestick),
  {
    loading: () => <Skeleton active paragraph={{ rows: 6 }} />
  }
);

const EntityImpactGraph = dynamic(
  () => import("./charts/entity-impact-graph").then((mod) => mod.EntityImpactGraph),
  {
    loading: () => <Skeleton active paragraph={{ rows: 6 }} />
  }
);

const KnowledgeGraph = dynamic(
  () => import("./charts/knowledge-graph").then((mod) => mod.KnowledgeGraph),
  {
    loading: () => <Skeleton active paragraph={{ rows: 6 }} />
  }
);

const SpacetimeViz = dynamic(
  () => import("./spacetime-viz").then((mod) => mod.SpacetimeViz),
  {
    loading: () => <Skeleton active paragraph={{ rows: 10 }} />
  }
);

const MarketPulse = dynamic(
  () => import("./components/market-pulse").then((mod) => mod.MarketPulse),
  { loading: () => <Skeleton active paragraph={{ rows: 2 }} /> }
);

const MetricDrillDown = dynamic(
  () => import("./metric-drilldown").then((mod) => mod.MetricDrillDown)
);

const QueueChart = dynamic(
  () => import("./queue-chart").then((mod) => mod.QueueChart),
  { loading: () => <Skeleton active paragraph={{ rows: 4 }} /> }
);

export function DashboardContent() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const isAnalysisFocused = searchParams.get("panel") === "analysis";
  const [, messageContext] = message.useMessage();
  const { resetFilters, hasActiveFilters } = useDashboardUrlSync();
  const { data, loading, error, refetch } = useQueueStatsQuery();
  const { start, end, range } = useDashboardRangeStore();

  // Hero Metrics Query
  const heroGranularity = useMemo(() => {
    const uiGranularity = resolveDefaultGranularityForRangePreset(range, start, end);
    switch (uiGranularity) {
      case UiTimeGranularity.Year:
        return TimeGranularity.Year;
      case UiTimeGranularity.Quarter:
        return TimeGranularity.Quarter;
      case UiTimeGranularity.Month:
        return TimeGranularity.Month;
      case UiTimeGranularity.Week:
        return TimeGranularity.Week;
      case UiTimeGranularity.Day:
      default:
        return TimeGranularity.Day;
    }
  }, [end, range, start]);

  const heroDateRange = useMemo(
    () => ({
      start: start.toISOString(),
      end: end.toISOString(),
      granularity: heroGranularity
    }),
    [heroGranularity, start, end]
  );

  const { data: heroData, loading: heroLoading } = useDashboardHeroMetricsQuery({
    variables: heroDateRange,
    fetchPolicy: "cache-and-network"
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
  const queueFilterMounted = useRef(false);
  const [activeDrillDownKey, setActiveDrillDownKey] = useState<string | null>(null);
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

  useEffect(() => {
    if (!lastEvent) return;
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
  const queueStats = data?.queueStats ?? null;

  return (
    <div className="flex gap-6 h-full items-start">
      {messageContext}
      <LiveAlertsToasts />
      
      {/* Center Column: Market Feed & Visuals */}
      <div className="flex-1 flex flex-col gap-6 min-w-0">

        {/* Time Range */}
        <div className="glass-panel border border-[var(--border)] px-4 py-3">
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="text-xs text-slate-600 font-medium">
              {t("dashboard.timeRange.title", { defaultValue: "Time Range" })}
            </span>
            {hasActiveFilters ? (
              <Button type="link" size="small" onClick={resetFilters} className="px-0">
                {t("common.reset", { defaultValue: "Reset" })}
              </Button>
            ) : null}
          </div>
          <TimeRangeControls />
        </div>
        
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
             <span className="text-slate-600">|</span>
             <span>
               Window: {range} ({dayjs(start).format("YYYY-MM-DD")} to {dayjs(end).format("YYYY-MM-DD")})
             </span>
           </div>
           <Space>
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

        {activeDrillDownKey ? (
          <MetricDrillDown 
            visible 
            metricKey={activeDrillDownKey} 
            onClose={() => setActiveDrillDownKey(null)} 
          />
        ) : null}

        {/* Charts Section - Immersive Map & Analytics */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
           {/* Indicator Map - Dominant Central Feature */}
           <div className="xl:col-span-2 h-[500px] glass-panel border border-[var(--border)] relative overflow-hidden">
             <div className="absolute top-4 left-4 z-10">
               <h3 className="text-lg text-slate-700">
                 {t("dashboard.charts.warMap.title", { defaultValue: "Indicator Situation Map" })}
               </h3>
             </div>
             <WarMap className="h-full" />
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

        {/* Entity Impact Graph */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
           <div className="xl:col-span-3">
             <Card title={t("dashboard.charts.entityImpactGraph", { defaultValue: "Entity Impact Graph" })} className="glass-card" bordered={false}>
               <EntityImpactGraph />
             </Card>
           </div>
        </div>

        {/* Knowledge Graph */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
           <div className="xl:col-span-3">
             <Card title={t("dashboard.charts.knowledgeGraph", { defaultValue: "Knowledge Graph" })} className="glass-card" bordered={false}>
               <KnowledgeGraph />
             </Card>
           </div>
        </div>

        {/* Spacetime Visualization */}
        <SpacetimeViz />

        {/* System Stats (Hidden by default) */}
        {showSystemStats && (
          <div className="animate-in fade-in slide-in-from-top-4 duration-300">
            {loading && !queueStats ? (
              <Row gutter={[20, 20]} className="mb-6">
                <Col xs={24} md={12} lg={8}>
                  <Card className="content-card h-full">
                    <Skeleton active paragraph={{ rows: 1 }} />
                  </Card>
                </Col>
                <Col xs={24} md={12} lg={8}>
                  <Card className="content-card h-full">
                    <Skeleton active paragraph={{ rows: 1 }} />
                  </Card>
                </Col>
                <Col xs={24} md={24} lg={8}>
                  <Card className="content-card h-full">
                    <Skeleton active paragraph={{ rows: 2 }} />
                  </Card>
                </Col>
              </Row>
            ) : error ? (
              <div className="mb-6 h-[220px]">
                {(() => {
                  const classification = classifyRequestError(error);
                  const detailText = [
                    classification.status ? `HTTP ${classification.status}` : null,
                    error.message || null
                  ]
                    .filter(Boolean)
                    .join(" • ");

                  const baseDescription =
                    classification.kind === "network"
                      ? t("dashboard.dataOffline.description", {
                          defaultValue:
                            "Cannot reach the service. Check your connection and retry."
                        })
                      : classification.kind === "permission"
                        ? t("common.accessDeniedDescription", {
                            defaultValue:
                              "You don't have permission to view this data. Contact an administrator if you need access."
                          })
                        : classification.kind === "service"
                          ? t("common.serviceUnavailable", {
                              defaultValue: "Service is unavailable. Please try again."
                            })
                          : t("common.unexpectedError", { defaultValue: "Unexpected error" });

                  const title =
                    classification.kind === "network"
                      ? t("dashboard.dataOffline.title", { defaultValue: "Offline" })
                      : classification.kind === "permission"
                        ? t("common.accessDenied", { defaultValue: "Access denied" })
                        : t("common.requestFailed", { defaultValue: "Request failed" });

                  const variant =
                    classification.kind === "network"
                      ? "offline"
                      : classification.kind === "permission"
                        ? "permission"
                        : "error";

                  return (
                    <ChartEmptyState
                      variant={variant}
                      title={title}
                      description={
                        detailText ? (
                          <div className="flex flex-col items-center gap-1">
                            <span>{baseDescription}</span>
                            <span className="font-mono text-[10px] opacity-80">
                              {detailText}
                            </span>
                          </div>
                        ) : (
                          baseDescription
                        )
                      }
                      actionLabel={classification.kind === "permission" ? undefined : t("common.retry")}
                      onAction={classification.kind === "permission" ? undefined : () => refetch()}
                    />
                  );
                })()}
              </div>
            ) : !queueStats ? (
              <div className="mb-6 h-[220px]">
                <ChartEmptyState
                  title={t("dashboard.ticker.empty", { defaultValue: "No metrics yet" })}
                  description={t("dashboard.errors.metricsUnavailableHint", {
                    defaultValue:
                      "No system metrics were returned. Try refreshing, or contact an administrator if this persists."
                  })}
                  actionLabel={t("common.refresh")}
                  onAction={() => refetch()}
                />
              </div>
            ) : (
              <Row gutter={[20, 20]} className="mb-6">
                <Col xs={24} md={12} lg={8}>
                  <Card className="content-card h-full flex flex-col justify-center">
                    <Statistic
                      title={t("dashboard.stats.totalItems")}
                      value={queueStats.itemCount}
                      valueStyle={{ color: "#1f2933", fontFamily: "var(--font-mono)" }}
                    />
                  </Card>
                </Col>
                <Col xs={24} md={12} lg={8}>
                  <Card className="content-card h-full flex flex-col justify-center">
                    <Statistic
                      title={t("dashboard.stats.processedItems")}
                      value={queueStats.processedCount}
                      valueStyle={{ color: "#1f2933", fontFamily: "var(--font-mono)" }}
                    />
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
                      data={{
                        waiting: queueStats.counts.waiting,
                        active: queueStats.counts.active,
                        completed: queueStats.counts.completed,
                        failed: queueStats.counts.failed,
                        delayed: queueStats.counts.delayed,
                      }}
                      activeStatus={queueStatus}
                      onFilterChange={setQueueStatus}
                    />
                  </Card>
                </Col>
              </Row>
            )}
          </div>
        )}

      </div>

      {/* Right Column: Data Board & Intelligence */}
      <div className="w-[400px] flex-shrink-0 flex flex-col gap-6 hidden 2xl:flex sticky top-0 h-fit">
         {/* Live News Feed */}
         <div className="h-[600px]">
            <AnalysisStream />
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
