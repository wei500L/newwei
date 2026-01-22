'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { emitUnauthorized } from '@/lib/auth-events';
import { env } from '@/lib/env';

enum WarEventSeverity {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

interface WarMapEvent {
  id: string;
  name: string;
  lat: number;
  lng: number;
  severity: WarEventSeverity;
  value: number;
  updatedAt?: string;
}

interface WarMapEventsResponse {
  events: WarMapEvent[];
  updatedAt?: string;
}

interface FinancialCandlePoint {
  timestamp: string;
  open: number;
  close: number;
  low: number;
  high: number;
  volume?: number;
}

interface FinancialCandlestickResponse {
  symbol: string;
  interval: string;
  points: FinancialCandlePoint[];
  updatedAt?: string;
}

interface SpacetimeGeoHeatPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  heat: number;
  total: number;
  sentiment: Record<string, number>;
}

interface SpacetimeGeoHeatmapResponse {
  points: SpacetimeGeoHeatPoint[];
  updatedAt?: string;
}

interface DashboardStreamErrorPayload {
  code?: string;
  message?: string;
  detail?: string;
}

export type DashboardStreamStatus = 'live' | 'polling' | 'offline';

interface DashboardStreamState {
  connected: boolean;
  status: DashboardStreamStatus;
  error?: string;
}

export interface DashboardStreamOptions {
  accessToken?: string;
  start: Date;
  end: Date;
  queueStatus?: string | null;
  selectedSector?: string | null;
  enabled?: boolean;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = process.env.NODE_ENV === 'development' ? 5_000 : 15_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isWarMapEventsResponse = (value: unknown): value is WarMapEventsResponse => {
  if (!isRecord(value)) return false;
  const events = value.events;
  return Array.isArray(events);
};

const isFinancialCandlestickResponse = (
  value: unknown,
): value is FinancialCandlestickResponse => {
  if (!isRecord(value)) return false;
  return (
    typeof value.symbol === 'string' &&
    typeof value.interval === 'string' &&
    Array.isArray(value.points)
  );
};

const isSpacetimeGeoHeatmapResponse = (
  value: unknown,
): value is SpacetimeGeoHeatmapResponse => {
  if (!isRecord(value)) return false;
  return Array.isArray(value.points);
};

const parseStreamData = (payload: string): unknown => {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
};

const buildStreamUrl = (startIso: string, endIso: string) => {
  const base = env.apiBaseUrl.endsWith('/') ? env.apiBaseUrl : `${env.apiBaseUrl}/`;
  const url = new URL('dashboard/stream', base);
  url.searchParams.set('start', startIso);
  url.searchParams.set('end', endIso);
  return url.toString();
};

const resolveErrorMessage = (error: unknown) => {
  if (!error) return 'Dashboard stream error';
  if (error instanceof Error) return error.message || 'Dashboard stream error';
  if (typeof error === 'string') return error;
  return 'Dashboard stream error';
};

export function useDashboardStream(options: DashboardStreamOptions): DashboardStreamState {
  const {
    accessToken,
    start,
    end,
    enabled = true,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    queueStatus,
    selectedSector,
  } = options;
  const queryClient = useQueryClient();
  const [state, setState] = useState<DashboardStreamState>({
    connected: false,
    status: 'offline',
  });
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const retryRef = useRef(0);
  const statusRef = useRef<DashboardStreamStatus>('offline');
  const hasLiveRef = useRef(false);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  useEffect(() => {
    if (!enabled || !accessToken) {
      abortRef.current?.abort();
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      retryRef.current = 0;
      statusRef.current = 'offline';
      hasLiveRef.current = false;
      setState((prev) =>
        prev.connected || prev.error || prev.status !== 'offline'
          ? { connected: false, status: 'offline', error: undefined }
          : prev,
      );
      return;
    }

    retryRef.current = 0;
    statusRef.current = 'offline';
    hasLiveRef.current = false;
    const warEventsKey = ['dashboard', 'war-map', 'events', startIso, endIso] as const;
    const candlestickKey = ['dashboard', 'financial-candlestick', startIso, endIso] as const;
    const geoHeatmapKey = ['dashboard', 'spacetime', 'geo-heatmap', startIso, endIso] as const;
    const geoHeatmapPrefixKey = ['dashboard', 'spacetime', 'geo-heatmap'] as const;
    const geoHeatmapEventPrefixKey = [
      'dashboard',
      'spacetime',
      'geo-heatmap',
      'event',
    ] as const;
    let active = true;

    const stopPolling = () => {
      if (!pollingRef.current) return;
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    };

    const startPolling = () => {
      if (pollingRef.current) return;
      void queryClient.invalidateQueries({ queryKey: warEventsKey, exact: true });
      void queryClient.invalidateQueries({ queryKey: candlestickKey, exact: true });
      void queryClient.invalidateQueries({
        queryKey: geoHeatmapPrefixKey,
        exact: false,
        refetchType: 'active',
      });
      pollingRef.current = setInterval(() => {
        void queryClient.invalidateQueries({ queryKey: warEventsKey, exact: true });
        void queryClient.invalidateQueries({ queryKey: candlestickKey, exact: true });
        void queryClient.invalidateQueries({
          queryKey: geoHeatmapPrefixKey,
          exact: false,
          refetchType: 'active',
        });
      }, pollIntervalMs);
    };

    const scheduleReconnect = () => {
      if (reconnectRef.current) return;
      const attempt = retryRef.current;
      const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** attempt);
      retryRef.current = Math.min(attempt + 1, 10);
      reconnectRef.current = setTimeout(() => {
        reconnectRef.current = null;
        if (!active) return;
        void connect();
      }, delay);
    };

    const resolveFallbackStatus = (forceOffline?: boolean): DashboardStreamStatus => {
      if (forceOffline) return 'offline';
      const hasGeoHeatmapData =
        Boolean(queryClient.getQueryData(geoHeatmapKey)) ||
        queryClient
          .getQueriesData({ queryKey: geoHeatmapPrefixKey, exact: false })
          .some((entry) => Boolean(entry[1]));
      const hasCachedData =
        queryClient.getQueryData(warEventsKey) ||
        queryClient.getQueryData(candlestickKey) ||
        hasGeoHeatmapData;
      return hasCachedData ? 'polling' : 'offline';
    };

    const markHealthy = () => {
      if (!active) return;
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      retryRef.current = 0;
      stopPolling();
      const wasLive = statusRef.current === 'live';
      statusRef.current = 'live';
      if (!wasLive && hasLiveRef.current) {
        void queryClient.invalidateQueries({
          queryKey: warEventsKey,
          exact: true,
          refetchType: 'active'
        });
        void queryClient.invalidateQueries({
          queryKey: candlestickKey,
          exact: true,
          refetchType: 'active'
        });
        void queryClient.invalidateQueries({
          queryKey: geoHeatmapKey,
          exact: true,
          refetchType: 'active'
        });
        void queryClient.invalidateQueries({
          queryKey: geoHeatmapEventPrefixKey,
          exact: false,
          refetchType: 'active'
        });
      }
      hasLiveRef.current = true;
      setState((prev) =>
        prev.connected && prev.status === 'live' && !prev.error
          ? prev
          : { connected: true, status: 'live', error: undefined },
      );
    };

    const handleError = (message: string, statusOverride?: DashboardStreamStatus) => {
      if (!active) return;
      const nextStatus = statusOverride ?? resolveFallbackStatus();
      statusRef.current = nextStatus;
      setState((prev) =>
        prev.status === nextStatus && prev.error === message && !prev.connected
          ? prev
          : { connected: false, status: nextStatus, error: message },
      );
      startPolling();
      scheduleReconnect();
    };

    const handleUnauthorized = (status: number) => {
      if (!active) return;
      emitUnauthorized({ status });
      stopPolling();
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      retryRef.current = 0;
      statusRef.current = 'offline';
      const message = `Dashboard stream unauthorized (${status})`;
      setState((prev) =>
        prev.status === 'offline' && prev.error === message && !prev.connected
          ? prev
          : { connected: false, status: 'offline', error: message },
      );
    };

    const handleEvent = (eventType: string, rawData: string) => {
      const payload = parseStreamData(rawData);
      if (eventType === 'war-map-events' && isWarMapEventsResponse(payload)) {
        queryClient.setQueryData(warEventsKey, payload);
        markHealthy();
        return;
      }
      if (eventType === 'financial-candlestick' && isFinancialCandlestickResponse(payload)) {
        queryClient.setQueryData(candlestickKey, payload);
        markHealthy();
        return;
      }
      if (eventType === 'spacetime-geo-heatmap' && isSpacetimeGeoHeatmapResponse(payload)) {
        queryClient.setQueryData(geoHeatmapKey, payload);
        void queryClient.invalidateQueries({
          queryKey: geoHeatmapEventPrefixKey,
          exact: false,
          refetchType: 'active',
        });
        markHealthy();
        return;
      }
      if (eventType === 'stream-error') {
        const errorPayload = isRecord(payload) ? (payload as DashboardStreamErrorPayload) : null;
        const baseMessage =
          errorPayload?.message ?? 'Dashboard stream update failed';
        const code = errorPayload?.code;
        const detail = errorPayload?.detail;
        const headline = code ? `${baseMessage} (${code})` : baseMessage;
        handleError(detail ? `${headline}: ${detail}` : headline, 'polling');
        return;
      }
      if (eventType === 'ping') {
        markHealthy();
      }
    };

    const connect = async () => {
      abortRef.current?.abort();
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch(buildStreamUrl(startIso, endIso), {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${accessToken}`,
          },
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          if (response.status === 401) {
            handleUnauthorized(response.status);
            return;
          }
          handleError(`Dashboard stream failed (${response.status})`, 'polling');
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        let dataLines: string[] = [];

        const dispatchEvent = () => {
          if (dataLines.length === 0) {
            currentEvent = '';
            return;
          }
          const payload = dataLines.join('\n');
          handleEvent(currentEvent || 'message', payload);
          currentEvent = '';
          dataLines = [];
        };

        const processLine = (line: string) => {
          if (line === '') {
            dispatchEvent();
            return;
          }
          if (line.startsWith(':')) return;

          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
            return;
          }
          if (line.startsWith('data:')) {
            let value = line.slice(5);
            if (value.startsWith(' ')) {
              value = value.slice(1);
            }
            dataLines.push(value);
          }
        };

        while (active) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          lines.forEach(processLine);
        }

        if (!active) return;
        if (buffer) {
          processLine(buffer);
        }
        dispatchEvent();
        handleError('Dashboard stream disconnected');
      } catch (error) {
        if (!active) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        handleError(resolveErrorMessage(error), 'offline');
      }
    };

    void connect();

    return () => {
      active = false;
      abortRef.current?.abort();
      stopPolling();
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
    };
  }, [
    accessToken,
    enabled,
    endIso,
    pollIntervalMs,
    queryClient,
    queueStatus,
    selectedSector,
    startIso,
  ]);

  return state;
}
