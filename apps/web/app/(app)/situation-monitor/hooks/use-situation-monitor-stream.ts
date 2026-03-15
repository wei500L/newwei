"use client";

import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { io, type Socket } from "socket.io-client";

import { env } from "@/lib/env";
import { formatRealtimeSocketError } from "@/lib/realtime-socket-errors";

import type {
  SituationOrefRealtimePayload,
  SituationTelegramRealtimePayload,
} from "../types/situation-monitor-signals";

export interface SituationMonitorStreamState {
  connected: boolean;
  error?: string;
}

export interface UseSituationMonitorStreamOptions {
  enabled?: boolean;
  onTelegramUpdate?: (payload: SituationTelegramRealtimePayload) => void;
  onOrefUpdate?: (payload: SituationOrefRealtimePayload) => void;
}

export function useSituationMonitorStream(
  options?: UseSituationMonitorStreamOptions,
): SituationMonitorStreamState {
  const { data: session, status } = useSession();
  const { t } = useTranslation();
  const token = session?.accessToken as string | undefined;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadItems =
    permissions.includes("items.read") || permissions.includes("items.write");
  const isEnabled = options?.enabled ?? true;
  const socketRef = useRef<Socket | null>(null);
  const tRef = useRef(t);
  const [state, setState] = useState<SituationMonitorStreamState>({
    connected: false,
  });

  const optionsRef = useRef<UseSituationMonitorStreamOptions | undefined>(
    options,
  );

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (status !== "authenticated" || !token || !canReadItems || !isEnabled) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setState({ connected: false });
      return;
    }

    const socket = io(`${env.apiRoot}/situation-monitor`, {
      transports: ["websocket", "polling"],
      auth: { token },
      withCredentials: true,
      autoConnect: false,
      timeout: 10_000,
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
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

    const handleTelegramUpdate = (
      payload: SituationTelegramRealtimePayload,
    ) => {
      optionsRef.current?.onTelegramUpdate?.(payload);
    };

    const handleOrefUpdate = (payload: SituationOrefRealtimePayload) => {
      optionsRef.current?.onOrefUpdate?.(payload);
    };
    const getLocalizedError = (
      payload:
        | { code?: string; message?: string; retryAfterMs?: number }
        | undefined,
      fallbackKind: "socket" | "connect",
    ) =>
      formatRealtimeSocketError(payload, tRef.current, {
        keyPrefix: "situationMonitor.realtime.connectionError",
        fallbackKind,
        defaults: {
          unauthorized:
            "Situation monitor realtime access expired. Please sign in again.",
          tooManyConnections:
            "Situation monitor realtime connections are at capacity. Please try again later.",
          tooManyConnectionAttempts:
            "Too many situation monitor realtime connection attempts. Please try again later.",
          rateLimitExceeded:
            "Situation monitor realtime connection attempts are too frequent. Please try again later.",
          tooManyFailedAttempts:
            "Too many failed situation monitor realtime sign-in attempts. Please try again later.",
          timeout:
            "Connecting to situation monitor realtime timed out. Please try again.",
          network:
            "Unable to connect to situation monitor realtime. Please check the network and try again.",
          connect:
            "Unable to connect to situation monitor realtime right now. Please try again later.",
          socket:
            "Situation monitor realtime connection is unstable. Please try again later.",
        },
      });

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("situation:telegram.update", handleTelegramUpdate);
    socket.on("situation:oref.update", handleOrefUpdate);
    socket.on(
      "situation:error",
      (
        payload:
          | { code?: string; message?: string; retryAfterMs?: number }
          | undefined,
      ) => {
        setState({
          connected: false,
          error: getLocalizedError(payload, "socket"),
        });
      },
    );
    socket.on("connect_error", (error) => {
      setState({
        connected: false,
        error: getLocalizedError(error, "connect"),
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
  }, [canReadItems, isEnabled, status, token]);

  return state;
}
