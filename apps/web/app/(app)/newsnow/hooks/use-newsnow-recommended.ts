'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useEffect, useMemo } from 'react';

import { createApiClient } from '@/lib/api-client';
import { subscribeNewsnowPersonalizationUpdated } from '@/lib/newsnow-personalization-events';

import {
  NEWSNOW_RECOMMENDED_QUERY_KEY_PREFIX,
  buildNewsnowRecommendedQueryKey,
} from './newsnow-recommended-query';

export interface NewsnowRecommendedItem {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  mobileUrl?: string | null;
  pubDate?: number | string | null;
  topics: string[];
  entities: string[];
  matchedItemId?: string;
  matchedEventId?: string;
  reasonLabel: string;
  score: number;
  scoreBreakdown: {
    content: number;
    collaborative: number;
    source: number;
    hotness: number;
    final: number;
  };
}

export interface NewsnowRecommendedResponse {
  scope: 'hottest';
  generatedAt: string;
  degraded: boolean;
  items: NewsnowRecommendedItem[];
}

export function useNewsnowRecommended(limit = 30) {
  const queryClient = useQueryClient();
  const { data: session, status } = useSession();
  const accessToken = session?.accessToken as string | undefined;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadItems =
    permissions.includes('items.read') || permissions.includes('items.write');
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );

  useEffect(() => {
    return subscribeNewsnowPersonalizationUpdated(() => {
      void queryClient.invalidateQueries({
        queryKey: [NEWSNOW_RECOMMENDED_QUERY_KEY_PREFIX],
      });
    });
  }, [queryClient]);

  return useQuery<NewsnowRecommendedResponse>({
    queryKey: buildNewsnowRecommendedQueryKey({
      orgId: session?.orgId,
      userId: session?.user?.id,
      limit,
    }),
    enabled: status === 'authenticated' && canReadItems && Boolean(accessToken),
    staleTime: 60_000,
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      const { data } = await apiClient.get<NewsnowRecommendedResponse>(
        `/news-aggregator/recommended?${params.toString()}`,
      );
      return {
        scope: data?.scope === 'hottest' ? 'hottest' : 'hottest',
        generatedAt:
          typeof data?.generatedAt === 'string'
            ? data.generatedAt
            : new Date().toISOString(),
        degraded: data?.degraded === true,
        items: Array.isArray(data?.items) ? data.items : [],
      };
    },
  });
}
