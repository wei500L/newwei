"use client";

import { LoadingOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { AnalysisType } from "@/graphql/generated";
import { usePendingAction } from "@/hooks/use-pending-action";
import dayjs from "@/lib/dayjs";

import { useDashboardAnalysisFeed } from "../analysis-feed-context";

const CONNECTION_TOAST_ID = "analysis-stream-connection";

function getAnalysisTypeLabel(type: AnalysisType): string {
  switch (type) {
    case AnalysisType.Anomaly:
      return "anomaly";
    case AnalysisType.GeoTransport:
      return "geo transport";
    case AnalysisType.Correlation:
    default:
      return "correlation";
  }
}

function getAnalysisTypeClassName(type: AnalysisType): string {
  switch (type) {
    case AnalysisType.Anomaly:
      return "text-[var(--bearish)]";
    case AnalysisType.GeoTransport:
      return "text-sky-600";
    case AnalysisType.Correlation:
    default:
      return "text-[var(--bullish)]";
  }
}

export function AnalysisStream() {
  const { t } = useTranslation();
  const {
    authenticated,
    canReadAnalysis,
    loading,
    error,
    results,
    refetch,
    subscriptionError,
    retrySubscription,
  } = useDashboardAnalysisFeed();
  const canStream = authenticated && canReadAnalysis;
  const { pending: refreshingResults, run: refreshResults } = usePendingAction(
    () => refetch(),
  );

  const title = t("dashboard.analysisStream.title");
  const updatesLabel = t("dashboard.analysisStream.updates", {
    count: results.length,
  });
  const loadingLabel = t("dashboard.analysisStream.loading");
  const emptyLabel = t("dashboard.analysisStream.empty");
  const summaryUnavailableLabel = t("dashboard.analysisStream.summaryUnavailable");
  const unexpectedErrorLabel = t("common.unexpectedError");
  const subscriptionErrorLabel = t("dashboard.analysisStream.subscriptionError");
  const liveModeLabel = t("dashboard.analysisStream.mode.live");
  const offlineModeLabel = t("dashboard.analysisStream.mode.offline");
  const liveRecoveredToastLabel = t("dashboard.analysisStream.liveRecoveredToast");

  const lastOfflineRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!canStream) {
      lastOfflineRef.current = null;
      return;
    }

    const offline = Boolean(subscriptionError);
    const prev = lastOfflineRef.current;
    if (prev === offline) {
      return;
    }
    lastOfflineRef.current = offline;
    if (prev === null) {
      return;
    }

    if (offline) {
      toast.error(subscriptionErrorLabel, {
        id: CONNECTION_TOAST_ID,
        closeButton: true,
        duration: 10_000,
        ...(subscriptionError ? { description: subscriptionError } : {})
      });
      return;
    }

    toast.success(liveRecoveredToastLabel, {
      id: CONNECTION_TOAST_ID,
      duration: 4_000,
    });
  }, [
    canStream,
    liveRecoveredToastLabel,
    subscriptionError,
    subscriptionErrorLabel,
  ]);

  return canStream ? (
    <div className="flex flex-col h-full glass-panel overflow-hidden relative text-sm">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-white/70">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--primary)] opacity-40"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--primary)]"></span>
          </span>
          <span className="font-semibold text-slate-700 text-xs">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2">
           {loading && <LoadingOutlined className="text-[var(--primary)]" />}
           <span
             className={[
               "rounded-full border px-2 py-[2px] text-[10px] font-medium",
               subscriptionError
                 ? "border-red-200 bg-red-50 text-red-800"
                 : "border-emerald-200 bg-emerald-50 text-emerald-800"
             ].join(" ")}
           >
             {subscriptionError ? offlineModeLabel : liveModeLabel}
           </span>
           <span className="text-[10px] text-slate-500">
             {updatesLabel}
           </span>
        </div>
      </div>

      {/* Terminal Feed */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-[var(--primary)]/20 scrollbar-track-transparent p-4 space-y-4">
        {subscriptionError ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{subscriptionErrorLabel}</div>
                <div className="mt-1 opacity-80">{subscriptionError}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="small"
                  loading={refreshingResults}
                  disabled={refreshingResults}
                  onClick={() => {
                    void refreshResults();
                  }}
                >
                  {t("dashboard.actions.fetchLatest")}
                </Button>
                <Button size="small" type="primary" onClick={retrySubscription}>
                  {t("common.retry")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {loading && results.length === 0 && (
          <div className="text-slate-500 animate-pulse">
            {loadingLabel}
          </div>
        )}

        {Boolean(error) && (
           <div className="text-[var(--destructive)]">
             {error instanceof Error
               ? error.message
               : typeof error === "string"
                 ? error
                 : unexpectedErrorLabel}
           </div>
        )}

        {!loading && results.length === 0 && (
          <div className="text-slate-500">
            {emptyLabel}
          </div>
        )}

        {results.map((item) => (
          <div 
            key={item.id}
            className="group relative pl-4 border-l border-slate-200 hover:border-[var(--primary)] transition-colors duration-200"
          >
            {/* Timestamp & Type Line */}
            <div className="flex items-center gap-2 mb-1 opacity-60 text-[10px]">
              <span className="text-slate-500">
                [{dayjs(item.createdAt).format("HH:mm:ss")}]
              </span>
              <span className={getAnalysisTypeClassName(item.type)}>
                {getAnalysisTypeLabel(item.type)}
              </span>
              <span>:: {item.status}</span>
            </div>
            
            {/* Content Line */}
            <div className="text-slate-700 text-xs leading-relaxed group-hover:text-slate-900 transition-all">
              {item.summary || summaryUnavailableLabel}
            </div>

            {/* Decorator */}
            <div className="absolute left-[-1px] top-0 bottom-0 w-[1px] bg-gradient-to-b from-[var(--primary)] to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        ))}
        
        <div className="h-4" /> {/* Spacer */}
      </div>

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-white/5 to-transparent opacity-40" />
    </div>
  ) : authenticated && !canReadAnalysis ? (
    <div className="flex h-full">
      <ChartEmptyState
        presentation="center"
        variant="permission"
        title={t("common.accessDenied")}
        description={t("common.accessDeniedDescription")}
      />
    </div>
  ) : (
    <div className="flex flex-col h-full glass-panel overflow-hidden relative text-sm">
      <div className="flex flex-1 items-center justify-center px-4 py-6 text-xs text-slate-500">
        {t("auth.login.required")}
      </div>
    </div>
  );
}
