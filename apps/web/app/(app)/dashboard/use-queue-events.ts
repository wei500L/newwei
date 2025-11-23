"use client";

import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import { env } from "@/lib/env";

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
  const [state, setState] = useState<QueueEventState>({ connected: false });
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

    const socket = io(`${env.apiRoot}/queue`, {
      transports: ["websocket"],
      auth: { token },
      withCredentials: true
    });
    socketRef.current = socket;

    const handleQueueEvent = (payload: QueueEventMessage) => {
      setState((prev) => ({ ...prev, lastEvent: payload }));
    };
    const handleConnect = () => setState((prev) => ({ ...prev, connected: true, connectionError: undefined }));
    const handleDisconnect = () => setState((prev) => ({ ...prev, connected: false }));

    socket.on("connect", handleConnect);
    socket.on("queue:event", handleQueueEvent);
    socket.on("queue:error", (payload: { message?: string } | undefined) => {
      setState((prev) => ({
        ...prev,
        connectionError: payload?.message ?? "Queue socket error",
        connected: false
      }));
    });
    socket.on("connect_error", (error) => {
      setState((prev) => ({
        ...prev,
        connectionError: error?.message ?? "Queue socket connect error",
        connected: false
      }));
    });
    socket.on("disconnect", handleDisconnect);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("queue:event", handleQueueEvent);
      socket.off("queue:error");
      socket.off("connect_error");
      socket.off("disconnect", handleDisconnect);
      socket.disconnect();
      socketRef.current = null;
      setState({ connected: false });
    };
  }, [status, token]);

  return state;
}
