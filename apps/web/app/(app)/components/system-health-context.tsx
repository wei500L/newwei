"use client";

import { useApolloClient } from "@apollo/client";
import { useSession } from "next-auth/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type PropsWithChildren,
} from "react";

import type { QueueEventMessage } from "@/app/(app)/dashboard/use-queue-events";
import { useQueueEvents } from "@/app/(app)/dashboard/use-queue-events";
import type { QueueStatsQuery } from "@/graphql/generated";
import { QueueStatsDocument, useQueueStatsQuery } from "@/graphql/generated";

import {
  resolveSystemHealthAssessment,
  type SystemHealthAssessment,
} from "./system-health";

type QueueCounts = QueueStatsQuery["queueStats"]["counts"];
type QueueCountKey = "waiting" | "active" | "completed" | "failed" | "delayed";
type QueueLog = QueueStatsQuery["queueStats"]["recentLogs"][number];

interface SystemHealthContextValue {
  assessment: SystemHealthAssessment;
  canManageQueue: boolean;
  enabled: boolean;
  error: unknown;
  lastQueueEvent?: QueueEventMessage;
  loading: boolean;
  queueConnectionError?: string;
  queueLive: boolean;
  queueStats: QueueStatsQuery["queueStats"] | null;
  refetchQueueStats: () => Promise<unknown>;
}

const SystemHealthContext = createContext<SystemHealthContextValue | null>(
  null,
);

interface SystemHealthProviderProps extends PropsWithChildren {
  enabled: boolean;
  realtimeEnabled?: boolean;
}

function clampQueueCount(value: number) {
  return Math.max(0, value);
}

function adjustQueueCount(
  counts: QueueCounts,
  key: QueueCountKey,
  delta: number,
) {
  return {
    ...counts,
    [key]: clampQueueCount((counts[key] ?? 0) + delta),
  };
}

function applyQueueEventToCounts(
  counts: QueueCounts,
  payload: QueueEventMessage,
): QueueCounts {
  const prevStateRaw = payload.data?.prev;
  const prevState =
    typeof prevStateRaw === "string" ? prevStateRaw.toLowerCase() : undefined;

  if (payload.event === "ACTIVE") {
    const decrementedCounts =
      prevState === "waiting" || prevState === "delayed"
        ? adjustQueueCount(counts, prevState, -1)
        : counts.waiting > 0
          ? adjustQueueCount(counts, "waiting", -1)
          : counts;
    return adjustQueueCount(decrementedCounts, "active", 1);
  }

  if (payload.event === "COMPLETED") {
    return adjustQueueCount(
      adjustQueueCount(counts, "active", -1),
      "completed",
      1,
    );
  }

  if (payload.event === "FAILED") {
    return adjustQueueCount(
      adjustQueueCount(counts, "active", -1),
      "failed",
      1,
    );
  }

  return counts;
}

function toQueueLog(payload: QueueEventMessage): QueueLog {
  return {
    __typename: "QueueEventModel",
    event: payload.event,
    jobId: payload.jobId,
    data: payload.data ? JSON.stringify(payload.data) : null,
    timestamp: payload.timestamp,
  };
}

export function SystemHealthProvider({
  children,
  enabled,
  realtimeEnabled = false,
}: SystemHealthProviderProps) {
  const apolloClient = useApolloClient();
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageQueue = permissions.includes("queue.manage");
  const queueRealtime = useQueueEvents({
    enabled: enabled && realtimeEnabled && canManageQueue,
  });

  const { data, loading, error, refetch, startPolling, stopPolling } =
    useQueueStatsQuery({
      skip: !enabled || !canManageQueue,
    });

  useEffect(() => {
    if (!enabled || !canManageQueue || queueRealtime.connected) {
      stopPolling();
      return;
    }

    const pollIntervalMs = 30_000;

    const updatePolling = () => {
      if (document.visibilityState === "visible") {
        startPolling(pollIntervalMs);
      } else {
        stopPolling();
      }
    };

    updatePolling();
    document.addEventListener("visibilitychange", updatePolling);
    return () => {
      document.removeEventListener("visibilitychange", updatePolling);
      stopPolling();
    };
  }, [canManageQueue, enabled, queueRealtime.connected, startPolling, stopPolling]);

  useEffect(() => {
    const lastEvent = queueRealtime.lastEvent;
    if (!enabled || !canManageQueue || !lastEvent || lastEvent.event === "PROGRESS") {
      return;
    }

    try {
      const cached = apolloClient.readQuery<QueueStatsQuery>({
        query: QueueStatsDocument,
      });

      if (!cached?.queueStats) {
        return;
      }

      const eventKey = `${lastEvent.event}:${lastEvent.jobId}:${lastEvent.timestamp}`;
      const nextCounts = applyQueueEventToCounts(cached.queueStats.counts, lastEvent);
      const nextRecentLogs = [
        toQueueLog(lastEvent),
        ...cached.queueStats.recentLogs.filter((entry) => {
          const currentKey = `${entry.event}:${entry.jobId}:${entry.timestamp}`;
          return currentKey !== eventKey;
        }),
      ].slice(0, 10);

      apolloClient.writeQuery<QueueStatsQuery>({
        query: QueueStatsDocument,
        data: {
          queueStats: {
            ...cached.queueStats,
            counts: nextCounts,
            recentLogs: nextRecentLogs,
          },
        },
      });
    } catch {
      // Ignore cache misses and keep the GraphQL query as the fallback source of truth.
    }
  }, [apolloClient, canManageQueue, enabled, queueRealtime.lastEvent]);

  const queueStats =
    enabled && canManageQueue ? (data?.queueStats ?? null) : null;

  const value = useMemo<SystemHealthContextValue>(
    () => ({
      assessment: resolveSystemHealthAssessment({
        canManageQueue,
        loading: enabled ? loading : false,
        error: enabled ? error : null,
        counts: queueStats?.counts,
      }),
      canManageQueue,
      enabled,
      error,
      lastQueueEvent: queueRealtime.lastEvent,
      loading,
      queueConnectionError: queueRealtime.connectionError,
      queueLive: queueRealtime.connected,
      queueStats,
      refetchQueueStats: () =>
        enabled && canManageQueue ? refetch() : Promise.resolve(null),
    }),
    [
      canManageQueue,
      enabled,
      error,
      loading,
      queueRealtime.connected,
      queueRealtime.connectionError,
      queueRealtime.lastEvent,
      queueStats,
      refetch,
    ],
  );

  return (
    <SystemHealthContext.Provider value={value}>
      {children}
    </SystemHealthContext.Provider>
  );
}

export function useSystemHealthContext(): SystemHealthContextValue {
  const context = useContext(SystemHealthContext);

  if (!context) {
    throw new Error(
      "useSystemHealthContext must be used within SystemHealthProvider.",
    );
  }

  return context;
}
