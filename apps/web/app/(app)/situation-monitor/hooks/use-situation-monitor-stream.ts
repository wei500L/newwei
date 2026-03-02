"use client";

import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import { env } from "@/lib/env";

import type {
  SituationOrefRealtimePayload,
  SituationTelegramRealtimePayload,
} from "../types/situation-monitor-signals";

export interface SituationMonitorStreamState {
  connected: boolean;
  error?: string;
}

export interface UseSituationMonitorStreamOptions {
  onTelegramUpdate?: (payload: SituationTelegramRealtimePayload) => void;
  onOrefUpdate?: (payload: SituationOrefRealtimePayload) => void;
}

export function useSituationMonitorStream(
  options?: UseSituationMonitorStreamOptions,
): SituationMonitorStreamState {
  const { data: session, status } = useSession();
  const token = session?.accessToken as string | undefined;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadItems = permissions.includes("items.read");
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState<SituationMonitorStreamState>({
    connected: false,
  });

  const onTelegramUpdate = options?.onTelegramUpdate;
  const onOrefUpdate = options?.onOrefUpdate;

  useEffect(() => {
    if (status !== "authenticated" || !token || !canReadItems) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setState({ connected: false });
      return;
    }

    const socket = io(`${env.apiRoot}/situation-monitor`, {
      transports: ["websocket"],
      auth: { token },
      withCredentials: true,
      autoConnect: false,
    });
    socketRef.current = socket;

    const connectTimer = setTimeout(() => {
      socket.connect();
    }, 0);

    const handleConnect = () => {
      setState({ connected: true });
    };

    const handleDisconnect = () => {
      setState((prev) => ({ ...prev, connected: false }));
    };

    const handleTelegramUpdate = (payload: SituationTelegramRealtimePayload) => {
      onTelegramUpdate?.(payload);
    };

    const handleOrefUpdate = (payload: SituationOrefRealtimePayload) => {
      onOrefUpdate?.(payload);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("situation:telegram.update", handleTelegramUpdate);
    socket.on("situation:oref.update", handleOrefUpdate);
    socket.on("situation:error", (payload: { message?: string } | undefined) => {
      setState({
        connected: false,
        error: payload?.message ?? "Situation monitor realtime socket error",
      });
    });
    socket.on("connect_error", (error) => {
      setState({
        connected: false,
        error: error?.message ?? "Situation monitor realtime socket connect error",
      });
    });

    return () => {
      clearTimeout(connectTimer);
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("situation:telegram.update", handleTelegramUpdate);
      socket.off("situation:oref.update", handleOrefUpdate);
      socket.off("situation:error");
      socket.off("connect_error");
      socket.disconnect();
      socketRef.current = null;
      setState({ connected: false });
    };
  }, [canReadItems, onOrefUpdate, onTelegramUpdate, status, token]);

  return state;
}
