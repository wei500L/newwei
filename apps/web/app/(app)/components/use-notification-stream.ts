"use client";

import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import type { NotificationType } from "@/graphql/generated";
import { env } from "@/lib/env";

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

interface NotificationStreamState {
  connected: boolean;
  connectionError?: string;
}

export function useNotificationStream(onNotification?: (notification: NotificationMessage) => void) {
  const { data: session, status } = useSession();
  const [state, setState] = useState<NotificationStreamState>({ connected: false });
  const socketRef = useRef<Socket | null>(null);
  const token = session?.accessToken as string | undefined;

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
      autoConnect: false
    });
    socketRef.current = socket;

    const connectTimer = setTimeout(() => {
      socket.connect();
    }, 0);

    const handleNotification = (payload: NotificationMessage) => {
      onNotification?.(payload);
    };
    const handleConnect = () => setState({ connected: true, connectionError: undefined });
    const handleDisconnect = () => setState((prev) => ({ ...prev, connected: false }));

    socket.on("connect", handleConnect);
    socket.on("notification", handleNotification);
    socket.on("notification:error", (payload: { message?: string } | undefined) => {
      setState((prev) => ({
        ...prev,
        connectionError: payload?.message ?? "Notification socket error",
        connected: false
      }));
    });
    socket.on("connect_error", (error) => {
      setState((prev) => ({
        ...prev,
        connectionError: error?.message ?? "Notification socket connect error",
        connected: false
      }));
    });
    socket.on("disconnect", handleDisconnect);

    return () => {
      clearTimeout(connectTimer);
      socket.off("connect", handleConnect);
      socket.off("notification", handleNotification);
      socket.off("notification:error");
      socket.off("connect_error");
      socket.off("disconnect", handleDisconnect);
      socket.disconnect();
      socketRef.current = null;
      setState({ connected: false });
    };
  }, [status, token, onNotification]);

  return state;
}
