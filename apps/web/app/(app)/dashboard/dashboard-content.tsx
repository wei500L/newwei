"use client";

import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Col,
  Row,
  Skeleton,
  Space,
  Statistic,
  Switch,
  Tag,
} from "antd";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { TimeRangeControls } from "@/components/time-range-controls";
import { formatDashboardDate } from "@/lib/dashboard-time";
import dayjs from "@/lib/dayjs";
import { useHeroMetrics } from "@/lib/hero-metrics";
import { buildRequestErrorEmptyState } from "@/lib/request-error-empty-state";
import { useScheduledAction, useTimedValueDeduper } from "@/lib/use-realtime-helpers";
import { useQueueStatsQuery } from "@/graphql/generated";
import { useDashboardFiltersStore } from "@/store/dashboard-filters";
import { useDashboardRangeStore } from "@/store/time-range";

import { LiveAlertsToasts } from "./live-alerts";
import { useDashboardStream, type DashboardStreamStatus } from "./use-dashboard-stream";
import { useDashboardUrlSync } from "./use-dashboard-url-sync";
import { useQueueEvents } from "./use-queue-events";

interface DashboardSkeletonProps {
  className: string;
  rows?: number;
}

function DashboardSkeleton({ className, rows = 6 }: DashboardSkeletonProps) {
  return (
    <div
      className={`flex w-full items-center justify-center ${className} transition-all duration-300`}
    >
      <Skeleton active paragraph={{ rows }} className="w-full" />
    </div>
  );
}

function SpacetimeVizSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2">
          <DashboardSkeleton className="h-[520px]" rows={10} />
        </div>
        <div className="xl:col-span-1">
          <DashboardSkeleton className="h-[520px]" rows={10} />
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2">
          <DashboardSkeleton className="h-[360px]" rows={8} />
        </div>
        <div className="xl:col-span-1">
          <DashboardSkeleton className="h-[420px]" rows={8} />
        </div>
      </div>
    </div>
  );
}

const QUEUE_STATS_CARD_MIN_HEIGHT = 360;
const QUEUE_STATS_CHART_HEIGHT = 260;
const DASHBOARD_STREAM_TOAST_ID = "dashboard-stream-connection";
const DASHBOARD_QUEUE_REFETCH_DEBOUNCE_MS = 1_200;

const AlertPanel = dynamic(() => import("./alert-panel").then((mod) => mod.AlertPanel), {
  loading: () => <DashboardSkeleton className="min-h-[200px]" rows={4} />
});

const AnalysisPanel = dynamic(() => import("./analysis-panel").then((mod) => mod.AnalysisPanel), {
  loading: () => <DashboardSkeleton className="min-h-[300px]" rows={4} />
});

const AnalysisStream = dynamic(
  () => import("./components/analysis-stream").then((mod) => mod.AnalysisStream),
  {
    loading: () => <DashboardSkeleton className="h-full" rows={6} />
  }
);

const GlobalSentimentTrend = dynamic(
  () => import("./components/global-sentiment-trend").then((mod) => mod.GlobalSentimentTrend),
  {
    loading: () => <DashboardSkeleton className="min-h-[320px]" rows={6} />
  }
);

const SectorHeatmap = dynamic(
  () => import("./charts/sector-heatmap").then((mod) => mod.SectorHeatmap),
  {
    loading: () => <DashboardSkeleton className="h-[300px]" rows={6} />
  }
);

const WarMap = dynamic(() => import("./charts/war-map").then((mod) => mod.WarMap), {
  loading: () => <DashboardSkeleton className="h-full" rows={6} />
});

const FinancialCandlestick = dynamic(
  () => import("./charts/financial-candlestick").then((mod) => mod.FinancialCandlestick),
  {
    loading: () => <DashboardSkeleton className="h-[350px]" rows={6} />
  }
);

const EntityImpactGraph = dynamic(
  () => import("./charts/entity-impact-graph").then((mod) => mod.EntityImpactGraph),
  {
    loading: () => <DashboardSkeleton className="h-[400px]" rows={6} />
  }
);

const KnowledgeGraph = dynamic(
  () => import("./charts/knowledge-graph").then((mod) => mod.KnowledgeGraph),
  {
    loading: () => <DashboardSkeleton className="h-[360px]" rows={6} />
  }
);

const SpacetimeViz = dynamic(
  () => import("./spacetime-viz").then((mod) => mod.SpacetimeViz),
  {
    loading: () => <SpacetimeVizSkeleton />
  }
);

const MarketPulse = dynamic(
  () => import("./components/market-pulse").then((mod) => mod.MarketPulse),
  {
    loading: () => (
      <div className="mb-6">
        <DashboardSkeleton className="min-h-[180px]" rows={4} />
      </div>
    )
  }
);

const MetricDrillDown = dynamic(
  () => import("./metric-drilldown").then((mod) => mod.MetricDrillDown)
);

const QueueChart = dynamic(
  () => import("./queue-chart").then((mod) => mod.QueueChart),
  { loading: () => <DashboardSkeleton className="h-[260px]" rows={4} /> }
);

interface DashboardStreamStatusLineProps {
  accessToken?: string;
  start: Date;
  end: Date;
  range: string;
  queueStatus?: string | null;
  selectedSector?: string | null;
  enabled: boolean;
}

function DashboardStreamStatusLine({
  accessToken,
  start,
  end,
  range,
  queueStatus,
  selectedSector,
  enabled
}: DashboardStreamStatusLineProps) {
  const { t } = useTranslation();
  const streamState = useDashboardStream({
    accessToken,
    start,
    end,
    queueStatus,
    selectedSector,
    enabled
  });
  const lastStreamStatusRef = useRef<DashboardStreamStatus | null>(null);

  const streamStatusMeta = useMemo(() => {
    const status = streamState.status;
    if (status === "live") {
      return {
        label: t("dashboard.stream.status.live", { defaultValue: "Live" }),
        dotClass: "bg-emerald-500",
        pulse: true
      };
    }
    return {
      label: t("dashboard.stream.status.offline", { defaultValue: "Offline" }),
      dotClass: "bg-red-500",
      pulse: false
    };
  }, [streamState.status, t]);

  useEffect(() => {
    if (!accessToken) return;
    const prevStatus = lastStreamStatusRef.current;
    if (prevStatus === streamState.status) return;
    lastStreamStatusRef.current = streamState.status;
    if (prevStatus === null) return;
    if (streamState.status === "offline") {
      toast.error(
        t("dashboard.stream.offline", {
          defaultValue: "Live updates unavailable"
        }),
        { id: DASHBOARD_STREAM_TOAST_ID }
      );
      return;
    }
    if (prevStatus === "offline" && streamState.status === "live") {
      toast.success(
        t("dashboard.stream.liveRecovered", {
          defaultValue: "Live updates restored"
        }),
        { id: DASHBOARD_STREAM_TOAST_ID, duration: 4_000 }
      );
    }
  }, [accessToken, streamState.status, t]);

  const lastUpdateLabel = streamState.lastUpdateAt
    ? dayjs(streamState.lastUpdateAt).format("HH:mm:ss")
    : "--";
  const lastUpdateTitle = streamState.lastUpdateAt
    ? dayjs(streamState.lastUpdateAt).format("YYYY-MM-DD HH:mm:ss")
    : undefined;

  const lastMessageLabel = streamState.lastMessageAt
    ? dayjs(streamState.lastMessageAt).format("HH:mm:ss")
    : "--";
  const lastMessageTitle = streamState.lastMessageAt
    ? dayjs(streamState.lastMessageAt).format("YYYY-MM-DD HH:mm:ss")
    : undefined;

  const errorPreview = useMemo(() => {
    if (!streamState.error) return null;
    const trimmed = streamState.error.trim();
    if (!trimmed) return null;
    const maxLen = 96;
    return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}...` : trimmed;
  }, [streamState.error]);

  return (
    <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
      <span
        className={`h-2 w-2 rounded-full ${streamStatusMeta.dotClass} ${streamStatusMeta.pulse ? "animate-pulse" : ""}`}
        aria-hidden="true"
      />
      <span>{streamStatusMeta.label}</span>
      <span className="text-slate-600">|</span>
      <span title={lastUpdateTitle}>
        {t("dashboard.stream.lastUpdate", { defaultValue: "Last update" })}: {lastUpdateLabel}
      </span>
      {streamState.status === "live" && streamState.lastMessageAt ? (
        <>
          <span className="text-slate-600">|</span>
          <span title={lastMessageTitle}>
            {t("dashboard.stream.heartbeat", { defaultValue: "Heartbeat" })}: {lastMessageLabel}
          </span>
        </>
      ) : null}
      {streamState.status === "offline" ? (
        <>
          <span className="text-slate-600">|</span>
          <span>
            {t("dashboard.stream.retries", { defaultValue: "Retries" })}:{" "}
            {streamState.retryCount}
          </span>
        </>
      ) : null}
      {errorPreview ? (
        <>
          <span className="text-slate-600">|</span>
          <span
            className="inline-block max-w-[360px] truncate align-bottom text-red-400"
            title={streamState.error}
          >
            {t("dashboard.stream.error", { defaultValue: "Error" })}: {errorPreview}
          </span>
        </>
      ) : null}
      <span className="text-slate-600">|</span>
      <span>
        {t("dashboard.stream.window", { defaultValue: "Window" })}: {range} (
        {formatDashboardDate(start)} to {formatDashboardDate(end)})
      </span>
    </div>
  );
}

export function DashboardContent() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageQueue = permissions.includes("queue.manage");
  const queryClient = useQueryClient();
  const dashboardFetchingCount = useIsFetching({ queryKey: ["dashboard"] });
  const searchParams = useSearchParams();
  const isAnalysisFocused = searchParams.get("panel") === "analysis";
  const { resetFilters, hasActiveFilters } = useDashboardUrlSync();
  const { data, loading, error, refetch } = useQueueStatsQuery({
    skip: !canManageQueue
  });
  const { start, end, range } = useDashboardRangeStore();
  const [isRangeUpdating, setIsRangeUpdating] = useState(false);
  const lastRangeFingerprintRef = useRef<string | null>(null);
  const {
    accessState: heroAccessState,
    data: heroData,
    error: heroError,
    granularityInfo: appliedHeroGranularityInfo,
    hasData: heroHasData,
    loading: heroLoading,
    refetch: refetchHero,
    updating: heroUpdating,
  } = useHeroMetrics({ start, end });
  const isDashboardUpdating = dashboardFetchingCount > 0 || heroUpdating;

  const { lastEvent, connected: queueLive, connectionError } = useQueueEvents();
  const { queueStatus, selectedSector, setQueueStatus } =
    useDashboardFiltersStore();
  const queueFilterMounted = useRef(false);
  const lastHandledQueueEventKeyRef = useRef<string | null>(null);
  const shouldShowQueueConnectionError = useTimedValueDeduper(30_000);
  const { schedule: scheduleQueueRefetch } = useScheduledAction(() => {
    void refetch();
  }, DASHBOARD_QUEUE_REFETCH_DEBOUNCE_MS);
  const [activeDrillDownKey, setActiveDrillDownKey] = useState<string | null>(null);
  const [showSystemStats, setShowSystemStats] = useState(false);
  const analysisPanelRef = useRef<HTMLDivElement | null>(null);
  const rangeFingerprint = useMemo(
    () => `${start.toISOString()}_${end.toISOString()}`,
    [end, start]
  );

  useEffect(() => {
    if (lastRangeFingerprintRef.current === null) {
      lastRangeFingerprintRef.current = rangeFingerprint;
      return;
    }
    if (lastRangeFingerprintRef.current === rangeFingerprint) {
      return;
    }
    lastRangeFingerprintRef.current = rangeFingerprint;
    setIsRangeUpdating(true);
  }, [rangeFingerprint]);

  useEffect(() => {
    if (!isRangeUpdating) return;
    if (!isDashboardUpdating) {
      setIsRangeUpdating(false);
    }
  }, [isDashboardUpdating, isRangeUpdating]);

  useEffect(() => {
    if (!connectionError) {
      return;
    }
    const nextMessage = t("dashboard.queue.connectionFailed", { error: connectionError });
    if (!shouldShowQueueConnectionError(nextMessage)) {
      return;
    }
    message.error(nextMessage);
  }, [connectionError, message, shouldShowQueueConnectionError, t]);

  useEffect(() => {
    if (searchParams.get("panel") === "analysis" && analysisPanelRef.current) {
      analysisPanelRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [searchParams]);

  useEffect(() => {
    if (!lastEvent) return;
    if (!canManageQueue) return;
    if (lastEvent.event === "PROGRESS") return;
    const eventKey = `${lastEvent.event}:${lastEvent.jobId}:${lastEvent.timestamp}`;
    if (lastHandledQueueEventKeyRef.current === eventKey) {
      return;
    }
    lastHandledQueueEventKeyRef.current = eventKey;
    scheduleQueueRefetch();
    if (lastEvent.event === "FAILED") {
      message.error(t("dashboard.queue.jobFailed", { jobId: lastEvent.jobId }));
    } else if (lastEvent.event === "COMPLETED") {
      message.success(t("dashboard.queue.jobCompleted", { jobId: lastEvent.jobId }));
    } else if (lastEvent.event === "ACTIVE") {
      message.info(t("dashboard.queue.jobStarted", { jobId: lastEvent.jobId }));
    }
  }, [canManageQueue, lastEvent, message, scheduleQueueRefetch, t]);

  useEffect(() => {
    if (!queueFilterMounted.current) {
      queueFilterMounted.current = true;
      return;
    }
    if (canManageQueue) {
      void refetch();
    }
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }, [canManageQueue, queueStatus, queryClient, refetch]);
  const queueStats = data?.queueStats ?? null;
  const queueStatsInitialLoading = loading && !queueStats;
  const queueStatsBlockingErrorState =
    error && !queueStats ? buildRequestErrorEmptyState({ t, error, onRetry: () => refetch() }) : null;
  const heroPermissionDescription = t("dashboard.hero.permissionRequired", {
    defaultValue:
      "Hero metrics require the economicdata.read permission. Switch to an organization with access or contact an administrator.",
  });

  return (
    <div className="flex gap-6 h-full items-start">
      <LiveAlertsToasts />
      
      {/* Center Column: Market Feed & Visuals */}
      <div className="flex-1 flex flex-col gap-6 min-w-0">

        {/* Time Range */}
        <div className="glass-panel border border-[var(--border)] px-4 py-3">
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="text-xs text-slate-600 font-medium">
              {t("dashboard.timeRange.title", { defaultValue: "Time Range" })}
            </span>
            <Space size={8}>
              {isRangeUpdating ? (
                <Tag color="processing" className="text-xs">
                  {t("common.loading", { defaultValue: "Loading..." })}
                </Tag>
              ) : null}
              {hasActiveFilters ? (
                <Button type="link" size="small" onClick={resetFilters} className="px-0">
                  {t("common.reset", { defaultValue: "Reset" })}
                </Button>
              ) : null}
            </Space>
	          </div>
	          <TimeRangeControls
	            appliedGranularity={appliedHeroGranularityInfo.coarsest}
	            appliedGranularityRange={appliedHeroGranularityInfo.range}
	          />
	        </div>
	        
	        {/* Status Bar */}
        <div className="flex items-center justify-between">
           <DashboardStreamStatusLine
             accessToken={session?.accessToken}
             start={start}
             end={end}
             range={range}
             queueStatus={queueStatus}
             selectedSector={selectedSector}
             enabled={Boolean(session?.accessToken)}
           />
           <Space>
             <span className="text-xs text-slate-500">System Status</span>
             <Switch size="small" checked={showSystemStats} onChange={setShowSystemStats} />
           </Space>
        </div>

        {/* Hero / Market Pulse */}
        <div className="relative">
          {heroAccessState.kind === "forbidden" ? (
            <div className="mb-6 glass-panel border border-[var(--border)] p-6 shadow-[0_8px_20px_rgba(15,23,42,0.08)]">
              <ChartEmptyState
                className="h-auto"
                variant="permission"
                title={t("common.accessDenied", { defaultValue: "Access denied" })}
                description={heroPermissionDescription}
              />
            </div>
          ) : heroError && !heroHasData ? (
            <div className="mb-6 glass-panel border border-[var(--border)] p-6 shadow-[0_8px_20px_rgba(15,23,42,0.08)]">
              <RequestErrorBanner
                presentation="center"
                error={heroError}
                onRetry={() => void refetchHero()}
              />
            </div>
          ) : (
            <>
              {heroError && heroHasData ? (
                <div className="mb-3">
                  <RequestErrorBanner
                    error={heroError}
                    onRetry={() => void refetchHero()}
                    showCachedDataHint
                  />
                </div>
              ) : null}
              <MarketPulse
                loading={heroLoading}
                conflictData={heroData?.conflict ?? []}
                marketData={heroData?.market ?? []}
                resourceData={heroData?.resource ?? []}
                supplyData={heroData?.supply ?? []}
                onMetricClick={setActiveDrillDownKey}
              />
            </>
          )}
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
           <Card title={t("dashboard.charts.sectorHeatmap", { defaultValue: "Sector Performance" })} className="glass-card h-[500px]" variant="borderless">
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
             <Card className="glass-card h-full" variant="borderless">
               <FinancialCandlestick />
             </Card>
           </div>
        </div>

        {/* Entity Impact Graph */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
           <div className="xl:col-span-3">
             <Card title={t("dashboard.charts.entityImpactGraph", { defaultValue: "Entity Impact Graph" })} className="glass-card" variant="borderless">
               <EntityImpactGraph />
             </Card>
           </div>
        </div>

        {/* Knowledge Graph */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
           <div className="xl:col-span-3">
             <Card title={t("dashboard.charts.knowledgeGraph", { defaultValue: "Knowledge Graph" })} className="glass-card" variant="borderless">
               <KnowledgeGraph />
             </Card>
           </div>
        </div>

        {/* Spacetime Visualization */}
        <SpacetimeViz />

        {/* System Stats (Hidden by default) */}
        {showSystemStats && (
          <div className="animate-in fade-in slide-in-from-top-4 duration-300">
            {!canManageQueue ? (
              <div className="mb-6" style={{ height: QUEUE_STATS_CARD_MIN_HEIGHT }}>
                <ChartEmptyState
                  title={t("common.accessDenied", { defaultValue: "Access denied" })}
                  description={t("common.accessDeniedDescription", {
                    defaultValue:
                      "You don't have permission to view this data. Contact an administrator if you need access."
                  })}
                  variant="permission"
                />
              </div>
            ) : (
              <Row gutter={[20, 20]} className="mb-6" align="stretch">
                <Col xs={24} md={12} lg={8} className="flex">
                  <Card
                    className="content-card flex-1 flex flex-col justify-center"
                    style={{ minHeight: QUEUE_STATS_CARD_MIN_HEIGHT }}
                  >
                    {queueStatsInitialLoading ? (
                      <Skeleton active paragraph={{ rows: 2 }} />
                    ) : (
                      <Statistic
                        title={t("dashboard.stats.totalItems")}
                        value={queueStats ? queueStats.itemCount : "--"}
                        valueStyle={{
                          color: queueStats ? "#1f2933" : "#94a3b8",
                          fontFamily: "var(--font-mono)"
                        }}
                      />
                    )}
                  </Card>
                </Col>

                <Col xs={24} md={12} lg={8} className="flex">
                  <Card
                    className="content-card flex-1 flex flex-col justify-center"
                    style={{ minHeight: QUEUE_STATS_CARD_MIN_HEIGHT }}
                  >
                    {queueStatsInitialLoading ? (
                      <Skeleton active paragraph={{ rows: 2 }} />
                    ) : (
                      <Statistic
                        title={t("dashboard.stats.processedItems")}
                        value={queueStats ? queueStats.processedCount : "--"}
                        valueStyle={{
                          color: queueStats ? "#1f2933" : "#94a3b8",
                          fontFamily: "var(--font-mono)"
                        }}
                      />
                    )}
                  </Card>
                </Col>

                <Col xs={24} md={24} lg={8} className="flex">
                  <Card
                    className="content-card flex-1"
                    style={{ minHeight: QUEUE_STATS_CARD_MIN_HEIGHT }}
                    title={
                      <Space size="small" align="center">
                        <span>{t("dashboard.queue.snapshot")}</span>
                        <Tag color={queueLive ? "green" : "default"}>
                          {queueLive ? t("dashboard.queue.live") : t("dashboard.queue.offline")}
                        </Tag>
                      </Space>
                    }
                  >
                    {queueStatsInitialLoading ? (
                      <div className="flex items-center" style={{ height: QUEUE_STATS_CHART_HEIGHT }}>
                        <Skeleton active paragraph={{ rows: 6 }} />
                      </div>
                    ) : queueStatsBlockingErrorState ? (
                      <div style={{ height: QUEUE_STATS_CHART_HEIGHT }}>
                        <ChartEmptyState
                          className="h-full"
                          variant={queueStatsBlockingErrorState.variant}
                          title={queueStatsBlockingErrorState.title}
                          description={queueStatsBlockingErrorState.description}
                          actionLabel={queueStatsBlockingErrorState.actionLabel}
                          onAction={queueStatsBlockingErrorState.onAction}
                        />
                      </div>
                    ) : !queueStats ? (
                      <div style={{ height: QUEUE_STATS_CHART_HEIGHT }}>
                        <ChartEmptyState
                          className="h-full"
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
                      <>
                        {error ? (
                          <div className="mb-3">
                            <RequestErrorBanner
                              error={error}
                              onRetry={() => void refetch()}
                              showCachedDataHint
                            />
                          </div>
                        ) : null}
                        <div className="relative" style={{ height: QUEUE_STATS_CHART_HEIGHT }}>
                          <QueueChart
                            data={{
                              waiting: queueStats.counts.waiting,
                              active: queueStats.counts.active,
                              completed: queueStats.counts.completed,
                              failed: queueStats.counts.failed,
                              delayed: queueStats.counts.delayed
                            }}
                            activeStatus={queueStatus}
                            onFilterChange={setQueueStatus}
                          />
                          {loading ? (
                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                              <Skeleton active paragraph={{ rows: 4 }} />
                            </div>
                          ) : null}
                        </div>
                      </>
                    )}
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
