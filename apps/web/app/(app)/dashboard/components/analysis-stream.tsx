"use client";

import { LoadingOutlined } from "@ant-design/icons";
import { useSession } from "next-auth/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  AnalysisType,
  useAnalysisEventsSubscription,
  useAnalysisResultsQuery,
  type AnalysisEventsSubscription,
} from "@/graphql/generated";
import dayjs from "@/lib/dayjs";

const LIVE_UPDATES_LIMIT = 50;
const LIVE_SUMMARY_LIMIT = 4000;
const POLL_FALLBACK_INTERVAL_MS = 30_000;
const CONNECTION_TOAST_ID = "analysis-stream-connection";

export function AnalysisStream() {
  const { t } = useTranslation();
  const { status } = useSession();
  const authenticated = status === "authenticated";
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [pollFallbackEnabled, setPollFallbackEnabled] = useState(false);

  const { data, loading, error } = useAnalysisResultsQuery({
    variables: { limit: 20 },
    skip: !authenticated,
    ...(pollFallbackEnabled ? { pollInterval: POLL_FALLBACK_INTERVAL_MS } : {})
  });

  const [liveUpdates, setLiveUpdates] = useState<
    Record<
      string,
      AnalysisEventsSubscription["analysisEvents"] & { summaryText: string }
    >
  >({});

  useAnalysisEventsSubscription({
    skip: !authenticated,
    onData: ({ data: subscription }) => {
      const event = subscription.data?.analysisEvents;
      if (!event) return;
      setLiveUpdates((prev) => {
        const existing = prev[event.id];
        const previousText = existing?.summaryText ?? "";
        const delta = typeof event.summary === "string" ? event.summary : "";
        const summaryTextRaw =
          event.status === "running" ? previousText + delta : delta || previousText;
        const summaryText =
          summaryTextRaw.length > LIVE_SUMMARY_LIMIT
            ? summaryTextRaw.slice(-LIVE_SUMMARY_LIMIT)
            : summaryTextRaw;
        const next: Record<
          string,
          AnalysisEventsSubscription["analysisEvents"] & { summaryText: string }
        > = {
          ...prev,
          [event.id]: {
            ...event,
            summaryText,
          },
        };
        const ids = Object.keys(next);
        if (ids.length <= LIVE_UPDATES_LIMIT) {
          return next;
        }
        const sorted = ids
          .map((id) => ({
            id,
            sortAt: dayjs(next[id]?.createdAt).valueOf() || 0
          }))
          .sort((a, b) => b.sortAt - a.sortAt)
          .slice(0, LIVE_UPDATES_LIMIT)
          .map((entry) => entry.id);
        return sorted.reduce<typeof next>((acc, id) => {
          const value = next[id];
          if (value) {
            acc[id] = value;
          }
          return acc;
        }, {});
      });
      setSubscriptionError(null);
      setPollFallbackEnabled(false);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSubscriptionError(message);
      setPollFallbackEnabled(true);
    }
  });

  const results = useMemo(() => {
    const base = data?.analysisResults ?? [];
    const merged = base.map((result) => {
      const live = liveUpdates[result.id];
      if (!live) return result;
      return {
        ...result,
        status: live.status,
        type: live.type,
        createdAt: live.createdAt,
        summary: live.summaryText,
      };
    });
    const missing = Object.values(liveUpdates)
      .filter((live) => !base.some((result) => result.id === live.id))
      .map((live) => ({
        id: live.id,
        type: live.type,
        status: live.status,
        createdAt: live.createdAt,
        summary: live.summaryText,
      }));
    return [...missing, ...merged].sort(
      (a, b) => dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf(),
    );
  }, [data?.analysisResults, liveUpdates]);

  const title = t("dashboard.analysisStream.title", {
    defaultValue: "Analysis Stream",
  });
  const updatesLabel = t("dashboard.analysisStream.updates", {
    defaultValue: "{{count}} updates",
    count: results.length,
  });
  const loadingLabel = t("dashboard.analysisStream.loading", {
    defaultValue: "Preparing analysis stream...",
  });
  const emptyLabel = t("dashboard.analysisStream.empty", {
    defaultValue: "No analysis updates yet.",
  });
  const summaryUnavailableLabel = t("dashboard.analysisStream.summaryUnavailable", {
    defaultValue: "Summary unavailable",
  });
  const unexpectedErrorLabel = t("common.unexpectedError", {
    defaultValue: "Unexpected error",
  });
  const subscriptionErrorLabel = t("dashboard.analysisStream.subscriptionError", {
    defaultValue: "Live updates disconnected",
  });
  const pollIntervalSeconds = Math.round(POLL_FALLBACK_INTERVAL_MS / 1000);
  const liveModeLabel = t("dashboard.analysisStream.mode.live", { defaultValue: "Live" });
  const pollModeLabel = t("dashboard.analysisStream.mode.polling", {
    defaultValue: "Polling ({{seconds}}s)",
    seconds: pollIntervalSeconds
  });
  const pollFallbackBannerLabel = t("dashboard.analysisStream.pollFallback", {
    defaultValue: "Switched to polling every {{seconds}}s due to live update errors.",
    seconds: pollIntervalSeconds
  });
  const pollFallbackToastLabel = t("dashboard.analysisStream.pollFallbackToast", {
    defaultValue: "Live updates disconnected — switched to polling ({{seconds}}s).",
    seconds: pollIntervalSeconds
  });
  const liveRecoveredToastLabel = t("dashboard.analysisStream.liveRecoveredToast", {
    defaultValue: "Live updates reconnected.",
  });

  const lastPollFallbackRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!authenticated) {
      lastPollFallbackRef.current = null;
      return;
    }

    const prev = lastPollFallbackRef.current;
    if (prev === pollFallbackEnabled) {
      return;
    }
    lastPollFallbackRef.current = pollFallbackEnabled;
    if (prev === null) {
      return;
    }

    if (pollFallbackEnabled) {
      toast.error(pollFallbackToastLabel, {
        id: CONNECTION_TOAST_ID,
        closeButton: true,
        duration: 10_000,
        ...(subscriptionError
          ? { description: `${subscriptionErrorLabel}: ${subscriptionError}` }
          : {})
      });
      return;
    }

    toast.success(liveRecoveredToastLabel, {
      id: CONNECTION_TOAST_ID,
      duration: 4_000,
    });
  }, [
    authenticated,
    liveRecoveredToastLabel,
    pollFallbackEnabled,
    pollFallbackToastLabel,
    subscriptionError,
    subscriptionErrorLabel,
  ]);

  return (
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
               pollFallbackEnabled
                 ? "border-amber-200 bg-amber-50 text-amber-800"
                 : "border-emerald-200 bg-emerald-50 text-emerald-800"
             ].join(" ")}
           >
             {pollFallbackEnabled ? pollModeLabel : liveModeLabel}
           </span>
           <span className="text-[10px] text-slate-500">
             {updatesLabel}
           </span>
        </div>
      </div>

      {/* Terminal Feed */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-[var(--primary)]/20 scrollbar-track-transparent p-4 space-y-4">
        {pollFallbackEnabled ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <div className="font-medium">{pollFallbackBannerLabel}</div>
            {subscriptionError ? (
              <div className="mt-1 opacity-80">
                {subscriptionErrorLabel}: {subscriptionError}
              </div>
            ) : null}
          </div>
        ) : subscriptionError ? (
          <div className="text-[var(--destructive)] text-xs">
            {subscriptionErrorLabel}: {subscriptionError}
          </div>
        ) : null}

        {loading && results.length === 0 && (
          <div className="text-slate-500 animate-pulse">
            {loadingLabel}
          </div>
        )}

        {error && (
           <div className="text-[var(--destructive)]">
             {error instanceof Error ? error.message : unexpectedErrorLabel}
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
              <span className={item.type === AnalysisType.Anomaly ? "text-[var(--bearish)]" : "text-[var(--bullish)]"}>
                {item.type}
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
  );
}
