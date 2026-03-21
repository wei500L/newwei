'use client';

import {
  DASHBOARD_STREAM_EVENT_TYPES,
  type WarMapAisMode,
  type WarMapEventsResponse,
  type WarMapFlightMode,
  type WarMapLayersResponse,
  type WarMapNewsMarkersResponse,
  type WarMapTranslateTarget,
} from '@modular/utils';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { emitUnauthorized } from '@/lib/auth-events';
import { env } from '@/lib/env';
import {
  buildWarMapEventsQueryKey,
  buildWarMapLayersQueryKey,
  buildWarMapNewsMarkersQueryKey,
} from './charts/war-map/war-map-data';

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
  latestObservedAt?: string;
  skippedIncompleteCount?: number;
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

export type DashboardStreamStatus = 'live' | 'offline';

export interface DashboardStreamState {
  connected: boolean;
  status: DashboardStreamStatus;
  error?: string;
  retryCount: number;
  lastUpdateAt?: number;
  lastMessageAt?: number;
  nextRetryAt?: number;
}

export interface DashboardStreamOptions {
  accessToken?: string;
  start: Date;
  end: Date;
  queryStart?: Date;
  queryEnd?: Date;
  warMapStart?: Date;
  warMapEnd?: Date;
  warMapBBox?: string;
  warMapZoom?: number;
  warMapTranslateTarget?: WarMapTranslateTarget;
  warMapFlightMode?: WarMapFlightMode;
  warMapAisMode?: WarMapAisMode;
  queueStatus?: string | null;
  selectedSector?: string | null;
  enabled?: boolean;
}

const MAX_RECONNECT_DELAY_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isWarMapEventsResponse = (value: unknown): value is WarMapEventsResponse => {
  return isRecord(value) && Array.isArray(value.events);
};

const isWarMapNewsMarkersResponse = (
  value: unknown,
): value is WarMapNewsMarkersResponse => {
  return isRecord(value) && Array.isArray(value.markers);
};

const isWarMapLayersResponse = (value: unknown): value is WarMapLayersResponse => {
  return isRecord(value) && isRecord(value.layers);
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

interface BuildStreamUrlOptions {
  dashboardStartIso: string;
  dashboardEndIso: string;
  warMapStartIso: string;
  warMapEndIso: string;
  warMapBBox?: string;
  warMapZoom?: number;
  warMapTranslateTarget?: WarMapTranslateTarget;
  warMapFlightMode?: WarMapFlightMode;
  warMapAisMode?: WarMapAisMode;
}

const buildStreamUrl = ({
  dashboardStartIso,
  dashboardEndIso,
  warMapStartIso,
  warMapEndIso,
  warMapBBox,
  warMapZoom,
  warMapTranslateTarget,
  warMapFlightMode,
  warMapAisMode,
}: BuildStreamUrlOptions) => {
  const base = env.apiBaseUrl.endsWith('/') ? env.apiBaseUrl : `${env.apiBaseUrl}/`;
  const url = new URL('dashboard/stream', base);
  url.searchParams.set('start', dashboardStartIso);
  url.searchParams.set('end', dashboardEndIso);
  url.searchParams.set('warMapStart', warMapStartIso);
  url.searchParams.set('warMapEnd', warMapEndIso);
  if (warMapBBox) {
    url.searchParams.set('warMapBbox', warMapBBox);
  }
  if (typeof warMapZoom === 'number' && Number.isFinite(warMapZoom)) {
    url.searchParams.set('warMapZoom', warMapZoom.toFixed(2));
  }
  if (warMapTranslateTarget) {
    url.searchParams.set('warMapTranslate', warMapTranslateTarget);
  }
  if (warMapFlightMode) {
    url.searchParams.set('warMapFlightMode', warMapFlightMode);
  }
  if (warMapAisMode) {
    url.searchParams.set('warMapAisMode', warMapAisMode);
  }
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
    queryStart = start,
    queryEnd = end,
    warMapStart = start,
    warMapEnd = end,
    warMapBBox,
    warMapZoom,
    warMapTranslateTarget,
    warMapFlightMode,
    warMapAisMode,
    enabled = true,
    queueStatus,
    selectedSector,
  } = options;
  const queryClient = useQueryClient();
  const [state, setState] = useState<DashboardStreamState>({
    connected: false,
    status: 'offline',
    retryCount: 0,
  });
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const retryRef = useRef(0);
  const statusRef = useRef<DashboardStreamStatus>('offline');
  const hasLiveRef = useRef(false);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const queryStartIso = queryStart.toISOString();
  const queryEndIso = queryEnd.toISOString();
  const warMapStartIso = warMapStart.toISOString();
  const warMapEndIso = warMapEnd.toISOString();

  useEffect(() => {
    if (!enabled || !accessToken) {
      abortRef.current?.abort();
      if (readerRef.current) {
        void readerRef.current.cancel().catch(() => null);
        readerRef.current = null;
      }
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      retryRef.current = 0;
      statusRef.current = 'offline';
      hasLiveRef.current = false;
      setState((prev) => {
        const next: DashboardStreamState = {
          connected: false,
          status: 'offline',
          error: undefined,
          retryCount: 0,
          lastUpdateAt: undefined,
          lastMessageAt: undefined,
          nextRetryAt: undefined,
        };
        return prev.connected === next.connected &&
          prev.status === next.status &&
          prev.error === next.error &&
          prev.retryCount === next.retryCount &&
          prev.lastUpdateAt === next.lastUpdateAt &&
          prev.lastMessageAt === next.lastMessageAt &&
          prev.nextRetryAt === next.nextRetryAt
          ? prev
          : next;
      });
      return;
    }

    retryRef.current = 0;
    statusRef.current = 'offline';
    hasLiveRef.current = false;
    const warMapQueryInput = {
      start: warMapStartIso,
      end: warMapEndIso,
      bbox: warMapBBox,
      zoom: warMapZoom,
      translateTarget: warMapTranslateTarget,
    };
    const warMapEventKey = buildWarMapEventsQueryKey(warMapQueryInput);
    const warMapNewsMarkersKey = buildWarMapNewsMarkersQueryKey(
      warMapQueryInput,
    );
    const warMapLayersKey = buildWarMapLayersQueryKey({
      ...warMapQueryInput,
      flightMode: warMapFlightMode,
      aisMode: warMapAisMode,
    });
    const candlestickKey = [
      'dashboard',
      'financial-candlestick',
      queryStartIso,
      queryEndIso,
    ] as const;
    const geoHeatmapKey = [
      'dashboard',
      'spacetime',
      'geo-heatmap',
      queryStartIso,
      queryEndIso,
    ] as const;
    const geoHeatmapPrefixKey = ['dashboard', 'spacetime', 'geo-heatmap'] as const;
    let active = true;
    let connecting = false;
    let authBlocked = false;
    const unknownEventTypes = new Set<string>();

    const isStreamDataQueryKey = (queryKey: unknown) => {
      if (!Array.isArray(queryKey)) return false;
      if (queryKey[0] !== 'dashboard') return false;
      if (queryKey[1] === 'war-map' && queryKey[2] === 'events') {
        return true;
      }
      if (queryKey[1] === 'war-map' && queryKey[2] === 'news-markers') {
        return true;
      }
      if (queryKey[1] === 'war-map' && queryKey[2] === 'layers') {
        return true;
      }
      if (queryKey[1] === 'financial-candlestick') return true;
      if (
        queryKey[1] === 'spacetime' &&
        queryKey[2] === 'geo-heatmap' &&
        queryKey[3] !== 'articles'
      ) {
        return true;
      }
      return false;
    };

    const isGeoHeatmapBaseQueryKey = (queryKey: readonly unknown[]) =>
      queryKey.length === geoHeatmapKey.length &&
      queryKey[0] === geoHeatmapKey[0] &&
      queryKey[1] === geoHeatmapKey[1] &&
      queryKey[2] === geoHeatmapKey[2] &&
      queryKey[3] === geoHeatmapKey[3] &&
      queryKey[4] === geoHeatmapKey[4];

    const invalidateGeoHeatmapQueries = (includeBaseKey: boolean) => {
      if (includeBaseKey) {
        void queryClient.invalidateQueries({
          queryKey: geoHeatmapKey,
          exact: true,
          refetchType: 'active'
        });
      }
      void queryClient.invalidateQueries({
        predicate: (query) => {
          const queryKey = query.queryKey;
          if (!Array.isArray(queryKey)) return false;
          if (queryKey[0] !== geoHeatmapPrefixKey[0]) return false;
          if (queryKey[1] !== geoHeatmapPrefixKey[1]) return false;
          if (queryKey[2] !== geoHeatmapPrefixKey[2]) return false;
          if (queryKey[3] === 'articles') return false;
          if (isGeoHeatmapBaseQueryKey(queryKey)) return false;
          return true;
        },
        refetchType: 'active',
      });
    };

    const recordMessage = (timestamp = Date.now()) => {
      if (!active) return;
      setState((prev) =>
        prev.lastMessageAt === timestamp ? prev : { ...prev, lastMessageAt: timestamp },
      );
    };

    const isOnline = () => {
      if (typeof navigator === 'undefined') return true;
      return navigator.onLine;
    };

    const scheduleReconnect = () => {
      if (!active) return;
      if (authBlocked) return;
      if (!isOnline()) return;
      if (reconnectRef.current) return;
      const attempt = retryRef.current;
      const baseDelay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** attempt);
      const jitter = 0.7 + Math.random() * 0.6;
      const delay = Math.round(baseDelay * jitter);
      retryRef.current = Math.min(attempt + 1, 10);
      const retryCount = retryRef.current;
      const nextRetryAt = Date.now() + delay;
      setState((prev) =>
        prev.retryCount === retryCount && prev.nextRetryAt === nextRetryAt
          ? prev
          : { ...prev, retryCount, nextRetryAt },
      );
      reconnectRef.current = setTimeout(() => {
        reconnectRef.current = null;
        if (!active) return;
        void connect();
      }, delay);
    };

    const markHealthy = () => {
      if (!active) return;
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      retryRef.current = 0;
      statusRef.current = 'live';
      hasLiveRef.current = true;
      setState((prev) =>
        prev.connected &&
        prev.status === 'live' &&
        !prev.error &&
        prev.retryCount === 0 &&
        !prev.nextRetryAt
          ? prev
          : {
              ...prev,
              connected: true,
              status: 'live',
              error: undefined,
              retryCount: 0,
              nextRetryAt: undefined,
            },
      );
    };

    const handleError = (message: string, forceOffline?: boolean) => {
      if (!active) return;
      statusRef.current = 'offline';
      setState((prev) =>
        prev.status === 'offline' && prev.error === message && !prev.connected
          ? prev
          : {
              ...prev,
              connected: false,
              status: 'offline',
              error: message,
            },
      );

      if (forceOffline || !isOnline()) {
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current);
          reconnectRef.current = null;
        }
        retryRef.current = 0;
        setState((prev) =>
          prev.retryCount === 0 && prev.nextRetryAt === undefined
            ? prev
            : { ...prev, retryCount: 0, nextRetryAt: undefined },
        );
        return;
      }

      scheduleReconnect();
    };

    const handleUnauthorized = (status: number) => {
      if (!active) return;
      authBlocked = true;
      emitUnauthorized({ status });
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      retryRef.current = 0;
      statusRef.current = 'offline';
      const message = `Dashboard stream unauthorized (${status})`;
      setState((prev) =>
        prev.status === 'offline' &&
        prev.error === message &&
        !prev.connected &&
        prev.retryCount === 0 &&
        !prev.nextRetryAt
          ? prev
          : {
              ...prev,
              connected: false,
              status: 'offline',
              error: message,
              retryCount: 0,
              nextRetryAt: undefined,
            },
      );
    };

    const handleEvent = (eventType: string, rawData: string) => {
      recordMessage();
      const payload = parseStreamData(rawData);
      if (
        eventType === DASHBOARD_STREAM_EVENT_TYPES.warMapEvents &&
        isWarMapEventsResponse(payload)
      ) {
        queryClient.setQueryData(warMapEventKey, payload);
        markHealthy();
        return;
      }
      if (
        eventType === DASHBOARD_STREAM_EVENT_TYPES.warMapNewsMarkers &&
        isWarMapNewsMarkersResponse(payload)
      ) {
        queryClient.setQueryData(warMapNewsMarkersKey, payload);
        markHealthy();
        return;
      }
      if (
        eventType === DASHBOARD_STREAM_EVENT_TYPES.warMapLayers &&
        isWarMapLayersResponse(payload)
      ) {
        queryClient.setQueryData(warMapLayersKey, payload);
        markHealthy();
        return;
      }
      if (
        eventType === DASHBOARD_STREAM_EVENT_TYPES.financialCandlestick &&
        isFinancialCandlestickResponse(payload)
      ) {
        queryClient.setQueryData(candlestickKey, payload);
        markHealthy();
        return;
      }
      if (
        eventType === DASHBOARD_STREAM_EVENT_TYPES.spacetimeGeoHeatmap &&
        isSpacetimeGeoHeatmapResponse(payload)
      ) {
        queryClient.setQueryData(geoHeatmapKey, payload);
        invalidateGeoHeatmapQueries(false);
        markHealthy();
        return;
      }
      if (eventType === DASHBOARD_STREAM_EVENT_TYPES.streamError) {
        const errorPayload = isRecord(payload) ? (payload as DashboardStreamErrorPayload) : null;
        const baseMessage =
          errorPayload?.message ?? 'Dashboard stream update failed';
        const code = errorPayload?.code;
        const detail = errorPayload?.detail;
        const headline = code ? `${baseMessage} (${code})` : baseMessage;
        handleError(detail ? `${headline}: ${detail}` : headline);
        return;
      }
      if (eventType === DASHBOARD_STREAM_EVENT_TYPES.ping) {
        markHealthy();
        return;
      }

      if (process.env.NODE_ENV !== 'production' && !unknownEventTypes.has(eventType)) {
        unknownEventTypes.add(eventType);
        const preview = rawData.length > 200 ? `${rawData.slice(0, 200)}...` : rawData;
        // eslint-disable-next-line no-console
        console.debug(`[dashboard-stream] Unhandled event type: ${eventType}`, preview);
      }
      markHealthy();
    };

    const connect = async () => {
      if (!active) return;
      if (authBlocked) return;
      if (connecting) return;
      if (!isOnline()) {
        handleError('Network offline', true);
        return;
      }
      connecting = true;
      setState((prev) => (prev.nextRetryAt === undefined ? prev : { ...prev, nextRetryAt: undefined }));

      abortRef.current?.abort();
      if (readerRef.current) {
        void readerRef.current.cancel().catch(() => null);
        readerRef.current = null;
      }
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch(
          buildStreamUrl({
            dashboardStartIso: startIso,
            dashboardEndIso: endIso,
            warMapStartIso,
            warMapEndIso,
            warMapBBox,
            warMapZoom,
            warMapTranslateTarget,
            warMapFlightMode,
            warMapAisMode,
          }),
          {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${accessToken}`,
          },
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
          },
        );

        if (!response.ok || !response.body) {
          if (response.status === 401) {
            handleUnauthorized(response.status);
            return;
          }
          handleError(`Dashboard stream failed (${response.status})`);
          return;
        }

        markHealthy();

        const reader = response.body.getReader();
        readerRef.current = reader;
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

        if (!active) {
          void reader.cancel().catch(() => null);
          return;
        }
        if (buffer) {
          processLine(buffer);
        }
        dispatchEvent();
        handleError('Dashboard stream disconnected');
      } catch (error) {
        if (!active) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        handleError(resolveErrorMessage(error));
      } finally {
        connecting = false;
        if (readerRef.current) {
          void readerRef.current.cancel().catch(() => null);
          readerRef.current = null;
        }
      }
    };

    const handleBrowserOnline = () => {
      if (!active) return;
      if (authBlocked) return;
      if (statusRef.current === 'live') return;
      retryRef.current = 0;
      setState((prev) =>
        prev.retryCount === 0 && prev.nextRetryAt === undefined
          ? prev
          : { ...prev, retryCount: 0, nextRetryAt: undefined },
      );
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      void connect();
    };

    const handleBrowserOffline = () => {
      if (!active) return;
      abortRef.current?.abort();
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      retryRef.current = 0;
      handleError('Network offline', true);
    };

    const unsubscribeQueryCache = queryClient.getQueryCache().subscribe((event) => {
      if (!active) return;
      if (event.type !== 'updated') return;
      if (event.action.type !== 'success') return;
      if (!isStreamDataQueryKey(event.query.queryKey)) return;
      const updatedAt = event.query.state.dataUpdatedAt;
      if (!updatedAt) return;
      setState((prev) =>
        prev.lastUpdateAt === updatedAt ? prev : { ...prev, lastUpdateAt: updatedAt },
      );
    });

    window.addEventListener('online', handleBrowserOnline);
    window.addEventListener('offline', handleBrowserOffline);

    void connect();

    return () => {
      active = false;
      unsubscribeQueryCache();
      window.removeEventListener('online', handleBrowserOnline);
      window.removeEventListener('offline', handleBrowserOffline);
      abortRef.current?.abort();
      if (readerRef.current) {
        void readerRef.current.cancel().catch(() => null);
        readerRef.current = null;
      }
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
    };
  }, [
    accessToken,
    enabled,
    endIso,
    queryEndIso,
    queryClient,
    queryStartIso,
    queueStatus,
    selectedSector,
    startIso,
    warMapAisMode,
    warMapBBox,
    warMapEndIso,
    warMapFlightMode,
    warMapStartIso,
    warMapTranslateTarget,
    warMapZoom,
  ]);

  return state;
}
