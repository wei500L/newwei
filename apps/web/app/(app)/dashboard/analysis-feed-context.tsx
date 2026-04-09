"use client";

import { useSession } from "next-auth/react";
import {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import {
  useAnalysisEventsSubscription,
  useAnalysisResultsQuery,
  type AnalysisEventsSubscription,
  type AnalysisResultsQuery,
} from "@/graphql/generated";
import dayjs from "@/lib/dayjs";

const ANALYSIS_RESULTS_LIMIT = 20;
const LIVE_UPDATES_LIMIT = 50;
const LIVE_SUMMARY_LIMIT = 4000;

type LiveAnalysisEvent = AnalysisEventsSubscription["analysisEvents"] & {
  summaryText: string;
};

export type DashboardAnalysisResult =
  AnalysisResultsQuery["analysisResults"][number];

interface DashboardAnalysisFeedContextValue {
  status: "authenticated" | "loading" | "unauthenticated";
  authenticated: boolean;
  canReadAnalysis: boolean;
  canRunAnalysis: boolean;
  loading: boolean;
  error: unknown;
  results: DashboardAnalysisResult[];
  refetch: () => Promise<unknown>;
  subscriptionError: string | null;
  retrySubscription: () => void;
}

const DashboardAnalysisFeedContext =
  createContext<DashboardAnalysisFeedContextValue | null>(null);

function mergeAnalysisResults(
  base: DashboardAnalysisResult[],
  liveUpdates: Record<string, LiveAnalysisEvent>,
): DashboardAnalysisResult[] {
  const merged = base.map((result) => {
    const live = liveUpdates[result.id];
    if (!live) {
      return result;
    }
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
    (left, right) =>
      dayjs(right.createdAt).valueOf() - dayjs(left.createdAt).valueOf(),
  );
}

export function DashboardAnalysisFeedProvider({
  children,
}: PropsWithChildren) {
  const { data: session, status } = useSession();
  const authenticated = status === "authenticated";
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadAnalysis = permissions.includes("analysis.read");
  const canRunAnalysis = permissions.includes("analysis.run");
  const [subscriptionError, setSubscriptionError] = useState<string | null>(
    null,
  );
  const [subscriptionEnabled, setSubscriptionEnabled] = useState(true);
  const [liveUpdates, setLiveUpdates] = useState<Record<string, LiveAnalysisEvent>>(
    {},
  );

  useEffect(() => {
    if (subscriptionEnabled) {
      return;
    }
    const timer = window.setTimeout(() => setSubscriptionEnabled(true), 50);
    return () => window.clearTimeout(timer);
  }, [subscriptionEnabled]);

  useEffect(() => {
    if (authenticated && canReadAnalysis) {
      return;
    }
    setLiveUpdates({});
    setSubscriptionError(null);
  }, [authenticated, canReadAnalysis]);

  const retrySubscription = useCallback(() => {
    setSubscriptionError(null);
    setSubscriptionEnabled(false);
  }, []);

  const { data, loading, error, refetch } = useAnalysisResultsQuery({
    variables: { limit: ANALYSIS_RESULTS_LIMIT },
    notifyOnNetworkStatusChange: true,
    skip: !authenticated || !canReadAnalysis,
  });

  useAnalysisEventsSubscription({
    skip: !authenticated || !subscriptionEnabled || !canReadAnalysis,
    onData: ({ data: subscription }) => {
      const event = subscription.data?.analysisEvents;
      if (!event) {
        return;
      }

      setLiveUpdates((previous) => {
        const existing = previous[event.id];
        const previousText = existing?.summaryText ?? "";
        const delta = typeof event.summary === "string" ? event.summary : "";
        const summaryTextRaw =
          event.status === "running" ? previousText + delta : delta || previousText;
        const summaryText =
          summaryTextRaw.length > LIVE_SUMMARY_LIMIT
            ? summaryTextRaw.slice(-LIVE_SUMMARY_LIMIT)
            : summaryTextRaw;

        const nextRecord = {
          ...event,
          summaryText,
        };

        if (
          existing &&
          existing.status === nextRecord.status &&
          existing.type === nextRecord.type &&
          existing.summaryText === nextRecord.summaryText &&
          existing.createdAt === nextRecord.createdAt
        ) {
          return previous;
        }

        const next = {
          ...previous,
          [event.id]: nextRecord,
        };
        const ids = Object.keys(next);
        if (ids.length <= LIVE_UPDATES_LIMIT) {
          return next;
        }
        const keptIds = ids
          .map((id) => ({
            id,
            sortAt: dayjs(next[id]?.createdAt).valueOf() || 0,
          }))
          .sort((left, right) => right.sortAt - left.sortAt)
          .slice(0, LIVE_UPDATES_LIMIT)
          .map((entry) => entry.id);

        return keptIds.reduce<typeof next>((accumulator, id) => {
          const value = next[id];
          if (value) {
            accumulator[id] = value;
          }
          return accumulator;
        }, {});
      });
      setSubscriptionError(null);
    },
    onError: (nextError) => {
      const message =
        nextError instanceof Error ? nextError.message : String(nextError);
      setSubscriptionError(message);
    },
  });

  const results = useMemo(
    () => mergeAnalysisResults(data?.analysisResults ?? [], liveUpdates),
    [data?.analysisResults, liveUpdates],
  );

  const value = useMemo<DashboardAnalysisFeedContextValue>(
    () => ({
      status,
      authenticated,
      canReadAnalysis,
      canRunAnalysis,
      loading,
      error,
      results,
      refetch: () => refetch(),
      subscriptionError,
      retrySubscription,
    }),
    [
      authenticated,
      canReadAnalysis,
      canRunAnalysis,
      error,
      loading,
      refetch,
      results,
      status,
      subscriptionError,
      retrySubscription,
    ],
  );

  return (
    <DashboardAnalysisFeedContext.Provider value={value}>
      {children}
    </DashboardAnalysisFeedContext.Provider>
  );
}

export function useDashboardAnalysisFeed() {
  const context = useContext(DashboardAnalysisFeedContext);

  if (!context) {
    throw new Error(
      "useDashboardAnalysisFeed must be used within DashboardAnalysisFeedProvider.",
    );
  }

  return context;
}
