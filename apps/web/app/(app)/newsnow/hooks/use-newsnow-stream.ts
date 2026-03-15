"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { io, type Socket } from "socket.io-client";

import { env } from "@/lib/env";
import { formatRealtimeSocketError } from "@/lib/realtime-socket-errors";

import { useNewsnowStore } from "../store/newsnow-store";

export interface NewsnowRealtimeMessage {
  sourceId: string;
  newItemsCount: number;
  topTitles?: string[];
  updatedTime: string;
  intervalMs: number;
  timestamp: string;
}

export function useNewsnowStream() {
  const { data: session, status } = useSession();
  const { t } = useTranslation();
  const token = session?.accessToken as string | undefined;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadItems =
    permissions.includes("items.read") || permissions.includes("items.write");
  const socketRef = useRef<Socket | null>(null);
  const tRef = useRef(t);
  const queryClient = useQueryClient();

  const recordRealtimeArrival = useNewsnowStore(
    (state) => state.recordRealtimeArrival,
  );
  const setRealtimeConnectionState = useNewsnowStore(
    (state) => state.setRealtimeConnectionState,
  );

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (status !== "authenticated" || !token || !canReadItems) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setRealtimeConnectionState({ connected: false });
      return;
    }

    const socket = io(`${env.apiRoot}/newsnow`, {
      transports: ["websocket"],
      auth: { token },
      withCredentials: true,
      autoConnect: false,
    });
    socketRef.current = socket;

    const connectTimer = setTimeout(() => {
      socket.connect();
    }, 0);
    const pendingSourceIds = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushPendingRefetches = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const sourceIds = Array.from(pendingSourceIds);
      pendingSourceIds.clear();
      if (sourceIds.length === 0) {
        return;
      }
      void Promise.all(
        sourceIds.map((sourceId) =>
          queryClient.refetchQueries({
            queryKey: ["news-source", sourceId],
            exact: true,
            type: "active",
          }),
        ),
      );
    };

    const scheduleSourceRefetch = (sourceId: string) => {
      pendingSourceIds.add(sourceId);
      if (flushTimer) {
        return;
      }
      flushTimer = setTimeout(() => {
        flushPendingRefetches();
      }, 800);
    };

    const handleUpdate = (payload: NewsnowRealtimeMessage) => {
      const sourceId =
        payload && typeof payload.sourceId === "string"
          ? payload.sourceId.trim()
          : "";
      const newItemsCount =
        payload &&
        typeof payload.newItemsCount === "number" &&
        Number.isFinite(payload.newItemsCount)
          ? payload.newItemsCount
          : 0;
      if (!sourceId || newItemsCount <= 0) {
        return;
      }

      recordRealtimeArrival({
        sourceId,
        count: newItemsCount,
        topTitles: Array.isArray(payload.topTitles) ? payload.topTitles : [],
        timestamp:
          typeof payload.timestamp === "string"
            ? payload.timestamp
            : new Date().toISOString(),
        updatedTime:
          typeof payload.updatedTime === "string"
            ? payload.updatedTime
            : undefined,
      });
      scheduleSourceRefetch(sourceId);
    };

    const handleConnect = () => {
      setRealtimeConnectionState({ connected: true });
    };
    const handleDisconnect = () => {
      setRealtimeConnectionState({ connected: false });
    };
    const getLocalizedError = (
      payload:
        | { code?: string; message?: string; retryAfterMs?: number }
        | undefined,
      fallbackKind: "socket" | "connect",
    ) =>
      formatRealtimeSocketError(payload, tRef.current, {
        keyPrefix: "newsnow.connectionError",
        fallbackKind,
        defaults: {
          unauthorized:
            "NewsNow realtime access expired. Please sign in again.",
          tooManyConnections:
            "NewsNow realtime connections are at capacity. Please try again later.",
          tooManyConnectionAttempts:
            "Too many NewsNow realtime connection attempts. Please try again later.",
          rateLimitExceeded:
            "NewsNow realtime connection attempts are too frequent. Please try again later.",
          tooManyFailedAttempts:
            "Too many failed NewsNow realtime sign-in attempts. Please try again later.",
          timeout:
            "Connecting to NewsNow realtime timed out. Please try again.",
          network:
            "Unable to connect to NewsNow realtime. Please check the network and try again.",
          connect:
            "Unable to connect to NewsNow realtime right now. Please try again later.",
          socket:
            "NewsNow realtime connection is unstable. Please try again later.",
        },
      });

    socket.on("connect", handleConnect);
    socket.on("newsnow:update", handleUpdate);
    socket.on(
      "newsnow:error",
      (
        payload:
          | { code?: string; message?: string; retryAfterMs?: number }
          | undefined,
      ) => {
        setRealtimeConnectionState({
          connected: false,
          error: getLocalizedError(payload, "socket"),
        });
      },
    );
    socket.on("connect_error", (error) => {
      setRealtimeConnectionState({
        connected: false,
        error: getLocalizedError(error, "connect"),
      });
    });
    socket.on("disconnect", handleDisconnect);

    return () => {
      clearTimeout(connectTimer);
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingSourceIds.clear();
      socket.off("connect", handleConnect);
      socket.off("newsnow:update", handleUpdate);
      socket.off("newsnow:error");
      socket.off("connect_error");
      socket.off("disconnect", handleDisconnect);
      socket.disconnect();
      socketRef.current = null;
      setRealtimeConnectionState({ connected: false });
    };
  }, [
    canReadItems,
    recordRealtimeArrival,
    queryClient,
    setRealtimeConnectionState,
    status,
    token,
  ]);
}
