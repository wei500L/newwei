"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";

import { env } from "@/lib/env";

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
  const token = session?.accessToken as string | undefined;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadItems = permissions.includes("items.read");
  const socketRef = useRef<Socket | null>(null);
  const queryClient = useQueryClient();

  const recordRealtimeArrival = useNewsnowStore((state) => state.recordRealtimeArrival);
  const setRealtimeConnectionState = useNewsnowStore(
    (state) => state.setRealtimeConnectionState,
  );

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
        payload && typeof payload.sourceId === "string" ? payload.sourceId.trim() : "";
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
          typeof payload.timestamp === "string" ? payload.timestamp : new Date().toISOString(),
        updatedTime:
          typeof payload.updatedTime === "string" ? payload.updatedTime : undefined,
      });
      scheduleSourceRefetch(sourceId);
    };

    const handleConnect = () => {
      setRealtimeConnectionState({ connected: true });
    };
    const handleDisconnect = () => {
      setRealtimeConnectionState({ connected: false });
    };

    socket.on("connect", handleConnect);
    socket.on("newsnow:update", handleUpdate);
    socket.on("newsnow:error", (payload: { message?: string } | undefined) => {
      setRealtimeConnectionState({
        connected: false,
        error: payload?.message ?? "NewsNow realtime socket error",
      });
    });
    socket.on("connect_error", (error) => {
      setRealtimeConnectionState({
        connected: false,
        error: error?.message ?? "NewsNow realtime socket connect error",
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
