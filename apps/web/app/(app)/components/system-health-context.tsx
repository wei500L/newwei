"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type PropsWithChildren,
} from "react";
import { useSession } from "next-auth/react";

import type { QueueStatsQuery } from "@/graphql/generated";
import { useQueueStatsQuery } from "@/graphql/generated";

import {
  resolveSystemHealthAssessment,
  type SystemHealthAssessment,
} from "./system-health";

interface SystemHealthContextValue {
  assessment: SystemHealthAssessment;
  canManageQueue: boolean;
  enabled: boolean;
  error: unknown;
  loading: boolean;
  queueStats: QueueStatsQuery["queueStats"] | null;
  refetchQueueStats: () => Promise<unknown>;
}

const SystemHealthContext = createContext<SystemHealthContextValue | null>(
  null,
);

interface SystemHealthProviderProps extends PropsWithChildren {
  enabled: boolean;
}

export function SystemHealthProvider({
  children,
  enabled,
}: SystemHealthProviderProps) {
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageQueue = permissions.includes("queue.manage");

  const { data, loading, error, refetch, startPolling, stopPolling } =
    useQueueStatsQuery({
      skip: !enabled || !canManageQueue,
    });

  useEffect(() => {
    if (!enabled || !canManageQueue) {
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
  }, [canManageQueue, enabled, startPolling, stopPolling]);

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
      loading,
      queueStats,
      refetchQueueStats: () =>
        enabled && canManageQueue ? refetch() : Promise.resolve(null),
    }),
    [canManageQueue, enabled, error, loading, queueStats, refetch],
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
