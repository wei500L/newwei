"use client";

/**
 * Crawl Task Detail 实时刷新域（FE-批5A：自 task-detail.tsx 拆出）。
 * Socket /ops 连接（token 鉴权 + websocket + autoConnect:false + 10s
 * 超时，经 0ms timer connect）、700ms 合并刷新窗口、断线 3s fallback
 * polling 协调与卸载清理；监听与合并语义原样保持。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { io, type Socket } from "socket.io-client";

import { getCrawlTaskDetailOpsRefreshDecision } from "@/lib/crawl-ops-refresh";
import { env } from "@/lib/env";
import { formatRealtimeSocketError } from "@/lib/realtime-socket-errors";

const REALTIME_SOCKET_TIMEOUT_MS = 10_000;

export type OpsLiveStatus = "disconnected" | "connecting" | "connected";

export interface UseCrawlTaskOpsLiveOptions {
  canView: boolean;
  accessToken?: string;
  taskId: string;
  pipelineJobId: string | null;
  shouldTrackInFlightTask: boolean;
  refetch: () => Promise<unknown>;
  startPolling: (interval: number) => void;
  stopPolling: () => void;
}

export interface CrawlTaskOpsLiveModel {
  status: OpsLiveStatus;
  error: string | null;
}

export function useCrawlTaskOpsLive({
  canView,
  accessToken,
  taskId,
  pipelineJobId,
  shouldTrackInFlightTask,
  refetch,
  startPolling,
  stopPolling,
}: UseCrawlTaskOpsLiveOptions): CrawlTaskOpsLiveModel {
  const { t } = useTranslation();
  const opsSocketRef = useRef<Socket | null>(null);
  const opsSocketBootstrappingRef = useRef(false);
  const opsRefreshTimerRef = useRef<number | null>(null);
  const pendingOpsRefreshRef = useRef({ task: false });
  const [opsLiveStatus, setOpsLiveStatus] = useState<OpsLiveStatus>(
    "disconnected",
  );
  const [opsLiveError, setOpsLiveError] = useState<string | null>(null);

  const scheduleOpsRefresh = useCallback(
    (options?: { task?: boolean }) => {
      if (!canView) {
        return;
      }
      pendingOpsRefreshRef.current.task =
        pendingOpsRefreshRef.current.task || options?.task !== false;
      if (opsRefreshTimerRef.current) {
        return;
      }
      opsRefreshTimerRef.current = window.setTimeout(() => {
        opsRefreshTimerRef.current = null;
        const pending = pendingOpsRefreshRef.current;
        pendingOpsRefreshRef.current = { task: false };
        if (pending.task) {
          void refetch();
        }
      }, 700);
    },
    [canView, refetch],
  );

  useEffect(() => {
    if (!canView || !accessToken) {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("disconnected");
      setOpsLiveError(null);
      return;
    }

    opsSocketBootstrappingRef.current = true;
    setOpsLiveStatus("connecting");
    setOpsLiveError(null);
    let hasConnectedOnce = false;
    const socket = io(`${env.apiRoot}/ops`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      withCredentials: true,
      autoConnect: false,
      timeout: REALTIME_SOCKET_TIMEOUT_MS,
    });
    opsSocketRef.current = socket;
    const connectTimer = window.setTimeout(() => {
      socket.connect();
    }, 0);

    const handleConnect = () => {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("connected");
      setOpsLiveError(null);
      if (hasConnectedOnce) {
        scheduleOpsRefresh({ task: true });
        return;
      }
      hasConnectedOnce = true;
    };
    const getLocalizedError = (
      payload:
        | { code?: string; message?: string; retryAfterMs?: number }
        | undefined,
      fallbackKind: "socket" | "connect",
    ) =>
      formatRealtimeSocketError(payload, t, {
        keyPrefix: "crawl.liveUpdates.connectionError",
        fallbackKind,
        defaults: {
          unauthorized: "Crawl realtime access expired. Please sign in again.",
          tooManyConnections:
            "Crawl realtime connections are at capacity. Please try again later.",
          tooManyConnectionAttempts:
            "Too many crawl realtime connection attempts. Please try again later.",
          rateLimitExceeded:
            "Crawl realtime connection attempts are too frequent. Please try again later.",
          tooManyFailedAttempts:
            "Too many failed crawl realtime sign-in attempts. Please try again later.",
          timeout: "Connecting to crawl realtime timed out. Please try again.",
          network:
            "Unable to connect to crawl realtime. Please check the network and try again.",
          connect:
            "Unable to connect to crawl realtime right now. Please try again later.",
          socket:
            "Crawl realtime connection is unstable. Please try again later.",
        },
      });
    const handleDisconnect = (reason: string) => {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("disconnected");
      if (reason === "io client disconnect") {
        setOpsLiveError(null);
        return;
      }
      setOpsLiveError((currentError) =>
        currentError ?? getLocalizedError({ message: reason }, "socket"),
      );
    };
    const handleConnectError = (
      error: { code?: string; message?: string; retryAfterMs?: number },
    ) => {
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("disconnected");
      setOpsLiveError(getLocalizedError(error, "connect"));
    };
    const handleServerError = (payload: unknown) => {
      const candidate =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as {
              code?: string;
              message?: string;
              retryAfterMs?: number;
            })
          : undefined;
      opsSocketBootstrappingRef.current = false;
      setOpsLiveStatus("disconnected");
      setOpsLiveError(getLocalizedError(candidate, "socket"));
    };
    const handleEvent = (payload: unknown) => {
      const refreshDecision = getCrawlTaskDetailOpsRefreshDecision(payload, {
        taskId,
        pipelineJobId,
      });
      if (!refreshDecision) {
        return;
      }
      scheduleOpsRefresh(refreshDecision);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("ops:error", handleServerError);
    socket.on("ops:event", handleEvent);

    return () => {
      window.clearTimeout(connectTimer);
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("ops:error", handleServerError);
      socket.off("ops:event", handleEvent);
      socket.disconnect();
      if (opsSocketRef.current === socket) {
        opsSocketRef.current = null;
      }
      opsSocketBootstrappingRef.current = false;
    };
  }, [
    accessToken,
    canView,
    pipelineJobId,
    scheduleOpsRefresh,
    taskId,
    t,
  ]);

  useEffect(() => {
    if (!canView) {
      stopPolling();
      return;
    }
    if (
      opsSocketBootstrappingRef.current ||
      opsLiveStatus === "connected" ||
      opsLiveStatus === "connecting"
    ) {
      stopPolling();
      return;
    }
    if (shouldTrackInFlightTask) {
      startPolling(3000);
      return;
    }
    stopPolling();
  }, [
    canView,
    opsLiveStatus,
    shouldTrackInFlightTask,
    startPolling,
    stopPolling,
  ]);

  useEffect(() => {
    return () => {
      if (opsRefreshTimerRef.current) {
        window.clearTimeout(opsRefreshTimerRef.current);
        opsRefreshTimerRef.current = null;
      }
      pendingOpsRefreshRef.current = { task: false };
    };
  }, []);

  return { status: opsLiveStatus, error: opsLiveError };
}
