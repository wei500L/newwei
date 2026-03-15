"use client";

import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { io, type Socket } from "socket.io-client";

import { env } from "@/lib/env";
import { formatRealtimeSocketError } from "@/lib/realtime-socket-errors";

export interface QueueEventMessage {
  orgId: string;
  event: string;
  jobId: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

interface QueueEventState {
  lastEvent?: QueueEventMessage;
  connected: boolean;
  connectionError?: string;
}

export function useQueueEvents(): QueueEventState {
  const { data: session, status } = useSession();
  const { t } = useTranslation();
  const [state, setState] = useState<QueueEventState>({ connected: false });
  const socketRef = useRef<Socket | null>(null);
  const tRef = useRef(t);
  const token = session?.accessToken as string | undefined;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageQueue = permissions.includes("queue.manage");

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (status !== "authenticated" || !token || !canManageQueue) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setState({ connected: false });
      return;
    }

    const socket = io(`${env.apiRoot}/queue`, {
      transports: ["websocket"],
      auth: { token },
      withCredentials: true,
      autoConnect: false,
    });
    socketRef.current = socket;

    const connectTimer = setTimeout(() => {
      socket.connect();
    }, 0);

    const handleQueueEvent = (payload: QueueEventMessage) => {
      setState((prev) => ({ ...prev, lastEvent: payload }));
    };
    const handleConnect = () =>
      setState((prev) => ({
        ...prev,
        connected: true,
        connectionError: undefined,
      }));
    const handleDisconnect = () =>
      setState((prev) => ({ ...prev, connected: false }));
    const getLocalizedError = (
      payload:
        | { code?: string; message?: string; retryAfterMs?: number }
        | undefined,
      fallbackKind: "socket" | "connect",
    ) =>
      formatRealtimeSocketError(payload, tRef.current, {
        keyPrefix: "dashboard.queue.connectionError",
        fallbackKind,
        defaults: {
          unauthorized: "Queue connection expired. Please sign in again.",
          tooManyConnections:
            "Queue connections are at capacity. Please try again later.",
          tooManyConnectionAttempts:
            "Too many queue connection attempts. Please try again later.",
          rateLimitExceeded:
            "Queue connection attempts are too frequent. Please try again in about {{seconds}} second(s).",
          tooManyFailedAttempts:
            "Too many failed queue sign-in attempts. Please try again in about {{seconds}} second(s).",
          timeout: "Connecting to the queue timed out. Please try again.",
          network:
            "Unable to connect to the queue. Please check the network and try again.",
          connect:
            "Unable to connect to the queue right now. Please try again later.",
          socket: "Queue connection is unstable. Please try again later.",
        },
      });

    socket.on("connect", handleConnect);
    socket.on("queue:event", handleQueueEvent);
    socket.on(
      "queue:error",
      (
        payload:
          | { code?: string; message?: string; retryAfterMs?: number }
          | undefined,
      ) => {
        setState((prev) => ({
          ...prev,
          connectionError: getLocalizedError(payload, "socket"),
          connected: false,
        }));
      },
    );
    socket.on("connect_error", (error) => {
      setState((prev) => ({
        ...prev,
        connectionError: getLocalizedError(error, "connect"),
        connected: false,
      }));
    });
    socket.on("disconnect", handleDisconnect);

    return () => {
      clearTimeout(connectTimer);
      socket.off("connect", handleConnect);
      socket.off("queue:event", handleQueueEvent);
      socket.off("queue:error");
      socket.off("connect_error");
      socket.off("disconnect", handleDisconnect);
      socket.disconnect();
      socketRef.current = null;
      setState({ connected: false });
    };
  }, [canManageQueue, status, token]);

  return state;
}
