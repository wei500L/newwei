"use client";

import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import type { NotificationType } from "@/graphql/generated";
import { env } from "@/lib/env";

const REALTIME_SOCKET_TIMEOUT_MS = 10_000;

export interface NotificationMessage {
  id: string;
  orgId?: string;
  userId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Record<string, unknown> | null;
  readAt?: string | null;
  createdAt: string;
}

export interface NotificationConnectionError {
  kind: "socket" | "connect";
  code?: string;
  message?: string;
  retryAfterMs?: number;
}

interface NotificationStreamState {
  connected: boolean;
  connectionError?: NotificationConnectionError;
}

export function useNotificationStream(
  onNotification?: (notification: NotificationMessage) => void,
) {
  const { data: session, status } = useSession();
  const [state, setState] = useState<NotificationStreamState>({
    connected: false,
  });
  const socketRef = useRef<Socket | null>(null);
  const onNotificationRef = useRef(onNotification);
  const token = session?.accessToken as string | undefined;

  useEffect(() => {
    onNotificationRef.current = onNotification;
  }, [onNotification]);

  useEffect(() => {
    if (status !== "authenticated" || !token) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setState({ connected: false });
      return;
    }

    const socket = io(`${env.apiRoot}/notifications`, {
      transports: ["websocket"],
      auth: { token },
      withCredentials: true,
      autoConnect: false,
      timeout: REALTIME_SOCKET_TIMEOUT_MS,
    });
    socketRef.current = socket;

    const connectTimer = setTimeout(() => {
      socket.connect();
    }, 0);

    const handleNotification = (payload: NotificationMessage) => {
      onNotificationRef.current?.(payload);
    };
    const handleConnect = () =>
      setState({ connected: true, connectionError: undefined });
    const handleDisconnect = () =>
      setState((prev) => ({ ...prev, connected: false }));
    const handleSocketError = (
      payload:
        | { code?: string; message?: string; retryAfterMs?: number }
        | undefined,
    ) => {
      setState((prev) => ({
        ...prev,
        connectionError: {
          kind: "socket",
          code: payload?.code,
          message: payload?.message,
          retryAfterMs: payload?.retryAfterMs,
        },
        connected: false,
      }));
    };
    const handleConnectError = (
      error:
        | { code?: string; message?: string; retryAfterMs?: number }
        | undefined,
    ) => {
      setState((prev) => ({
        ...prev,
        connectionError: {
          kind: "connect",
          code: error?.code,
          message: error?.message,
          retryAfterMs: error?.retryAfterMs,
        },
        connected: false,
      }));
    };

    socket.on("connect", handleConnect);
    socket.on("notification", handleNotification);
    socket.on("notification:error", handleSocketError);
    socket.on("connect_error", handleConnectError);
    socket.on("disconnect", handleDisconnect);

    return () => {
      clearTimeout(connectTimer);
      socket.off("connect", handleConnect);
      socket.off("notification", handleNotification);
      socket.off("notification:error", handleSocketError);
      socket.off("connect_error", handleConnectError);
      socket.off("disconnect", handleDisconnect);
      socket.disconnect();
      socketRef.current = null;
      setState({ connected: false });
    };
  }, [status, token]);

  return state;
}
