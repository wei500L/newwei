"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  Col,
  Empty,
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

import { useDashboardHeroMetricsQuery, useQueueStatsQuery } from "@/graphql/generated";
import dayjs from "@/lib/dayjs";
import { type QueueStatusKey, useDashboardFiltersStore } from "@/store/dashboard-filters";
import { useDashboardRangeStore } from "@/store/time-range";

import { LiveAlertsToasts } from "./live-alerts";
import { useDashboardStream, type DashboardStreamStatus } from "./use-dashboard-stream";
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
  const { data, loading, error, refetch } = useQueueStatsQuery();

  // Hero Metrics Query
  const heroDateRange = useMemo(() => ({
    start: dayjs.utc().subtract(30, "day").startOf("day").toISOString(),
    end: dayjs.utc().endOf("day").toISOString()
  }), []);

  const { data: heroData, loading: heroLoading } = useDashboardHeroMetricsQuery({
    variables: heroDateRange,
    fetchPolicy: "cache-and-network"
  });

  const { start, end } = useDashboardRangeStore();
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

  if (loading) {
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
