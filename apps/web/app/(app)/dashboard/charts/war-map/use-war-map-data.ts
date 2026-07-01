'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import {
  SITUATION_MONITOR_QUERY_KEYS,
  fetchSituationMonitorMonitors,
} from '@/app/(app)/situation-monitor/monitors-query';
import { SITUATION_MONITOR_MONITORS_UPDATED_EVENT } from '@/app/(app)/situation-monitor/utils/monitor-events';
import type { createApiClient } from '@/lib/api-client';

import {
  buildWarMapBaseRequestParams,
  buildWarMapEventsQueryKey,
  buildWarMapLayerRequestParams,
  buildWarMapLayersQueryKey,
  buildWarMapNewsMarkersQueryKey,
  normalizeWarMapEventsResponse,
  normalizeWarMapLayersResponse,
  normalizeWarMapNewsMarkersResponse,
  type WarMapQueryInput,
} from './war-map-data';

export interface UseWarMapDataOptions extends WarMapQueryInput {
  apiClient: ReturnType<typeof createApiClient>;
  enabled: boolean;
}

export function useWarMapData(options: UseWarMapDataOptions) {
  const queryClient = useQueryClient();
  const { apiClient, enabled, ...queryInput } = options;

  const eventsQuery = useQuery({
    queryKey: buildWarMapEventsQueryKey(queryInput),
    queryFn: async () => {
      const response = await apiClient.get('dashboard/war-map/events', {
        params: buildWarMapBaseRequestParams({ ...queryInput, cluster: false }),
      });
      return normalizeWarMapEventsResponse(response.data);
    },
    staleTime: 15_000,
    enabled,
    placeholderData: (previous) => previous,
  });

  const newsQuery = useQuery({
    queryKey: buildWarMapNewsMarkersQueryKey(queryInput),
    queryFn: async () => {
      const response = await apiClient.get('dashboard/war-map/news-markers', {
        params: buildWarMapBaseRequestParams({ ...queryInput, cluster: false }),
      });
      return normalizeWarMapNewsMarkersResponse(response.data);
    },
    staleTime: 15_000,
    enabled,
    placeholderData: (previous) => previous,
  });

  const layersQuery = useQuery({
    queryKey: buildWarMapLayersQueryKey(queryInput),
    queryFn: async () => {
      const response = await apiClient.get('dashboard/war-map/layers', {
        params: buildWarMapLayerRequestParams(queryInput),
      });
      return normalizeWarMapLayersResponse(response.data);
    },
    staleTime: 30_000,
    enabled,
  });

  const monitorsQuery = useQuery({
    queryKey: SITUATION_MONITOR_QUERY_KEYS.monitors,
    queryFn: () => fetchSituationMonitorMonitors(apiClient),
    staleTime: 30_000,
    enabled,
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }

    const handleMonitorsUpdated = () => {
      void queryClient.invalidateQueries({
        queryKey: SITUATION_MONITOR_QUERY_KEYS.monitors,
        exact: true,
        refetchType: 'active',
      });
    };

    window.addEventListener(
      SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
      handleMonitorsUpdated,
    );
    return () => {
      window.removeEventListener(
        SITUATION_MONITOR_MONITORS_UPDATED_EVENT,
        handleMonitorsUpdated,
      );
    };
  }, [enabled, queryClient]);

  return {
    eventsQuery,
    newsQuery,
    layersQuery,
    monitorsQuery,
  };
}
