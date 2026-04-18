'use client';

import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useMemo } from 'react';

import { createApiClient } from '@/lib/api-client';

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
  const { data: session, status } = useSession();
  const accessToken = session?.accessToken as string | undefined;
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canReadItems =
    permissions.includes('items.read') || permissions.includes('items.write');
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );

  return useQuery<NewsnowRecommendedResponse>({
    queryKey: ['newsnow-recommended', limit],
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
          typeof data?.generatedAt === 'string' ? data.generatedAt : new Date().toISOString(),
        degraded: data?.degraded === true,
        items: Array.isArray(data?.items) ? data.items : [],
      };
    },
  });
}
