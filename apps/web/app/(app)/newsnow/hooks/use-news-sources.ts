import { useQuery, useQueryClient } from "@tanstack/react-query";

import { createApiClient } from "@/lib/api-client";

export interface NewsItem {
  id: string | number;
  title: string;
  url: string;
  mobileUrl?: string;
  pubDate?: number | string;
  extra?: {
    hover?: string;
    date?: number | string;
    info?: false | string;
    diff?: number;
    icon?: false | string | { url: string; scale: number };
  };
}

export interface Source {
  name: string;
  interval: number;
  color: string;
  title?: string;
  desc?: string;
  type?: "hottest" | "realtime";
  column?: string;
  home?: string;
  disable?: boolean;
  redirect?: string;
}

export interface SourceResponse {
  status: "success" | "cache" | "error";
  id: string;
  updatedTime: number | string;
  items: NewsItem[];
}

export interface NewsResolveResponse {
  matched: boolean;
  itemId?: string;
  eventId?: string;
  confidence?: number;
  matchedUrl?: string;
}

export interface MetadataResponse {
  sources: Record<string, Source>;
  columns: Record<string, Column>;
}

export interface Column {
  name: string;
  sources: string[];
}

const api = createApiClient();

function coerceSourceResponse(data: SourceResponse): SourceResponse {
  return {
    ...data,
    items: Array.isArray(data.items) ? data.items : [],
  };
}

function normalizeSourceResponse(
  incoming: SourceResponse,
  previous?: SourceResponse
): SourceResponse {
  if (!previous?.items?.length) {
    return incoming;
  }

  const previousPositions = new Map<string, number>();
  previous.items.forEach((item, index) => {
    previousPositions.set(String(item.id), index);
  });

  return {
    ...incoming,
    items: incoming.items.map((item, index) => {
      const previousIndex = previousPositions.get(String(item.id));
      if (previousIndex === undefined) {
        return item;
      }

      return {
        ...item,
        extra: {
          ...(item.extra ?? {}),
          diff: previousIndex - index,
        },
      };
    }),
  };
}

async function fetchSourceById(id: string, latest = false): Promise<SourceResponse> {
  const query = latest
    ? `/news-aggregator/source?id=${encodeURIComponent(id)}&latest=1`
    : `/news-aggregator/source?id=${encodeURIComponent(id)}`;
  const { data } = await api.get(query);
  return coerceSourceResponse(data as SourceResponse);
}

async function fetchResolvedByUrl(url: string): Promise<NewsResolveResponse> {
  const { data } = await api.get(`/news-aggregator/resolve?url=${encodeURIComponent(url)}`);
  return (data ?? { matched: false }) as NewsResolveResponse;
}

export function useNewsMetadata() {
  return useQuery<MetadataResponse>({
    queryKey: ["news-metadata"],
    queryFn: async () => {
      const { data } = await api.get("/news-aggregator/metadata");
      return data;
    },
    staleTime: 1000 * 60 * 60, // 1 hour
  });
}

export function useNewsSource(id: string, interval?: number) {
  const queryClient = useQueryClient();

  const sourceQuery = useQuery<SourceResponse>({
    queryKey: ["news-source", id],
    queryFn: async () => {
      const previous = queryClient.getQueryData<SourceResponse>(["news-source", id]);
      const incoming = await fetchSourceById(id);
      return normalizeSourceResponse(incoming, previous);
    },
    refetchInterval: interval || false,
    staleTime: 1000 * 30, // 30 seconds
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return {
    ...sourceQuery,
    refresh: async () => {
      const previous = queryClient.getQueryData<SourceResponse>(["news-source", id]);
      const latestData = normalizeSourceResponse(await fetchSourceById(id, true), previous);
      queryClient.setQueryData(["news-source", id], latestData);
      return latestData;
    },
  };
}

export function useBatchPrefetch() {
  const queryClient = useQueryClient();

  return async (sourceIds: string[]) => {
    if (sourceIds.length === 0) return;

    try {
      const { data } = await api.post<{ results: SourceResponse[] }>("/news-aggregator/sources/batch", {
        sources: sourceIds,
      });

      data.results.forEach((source) => {
        const normalizedSource = coerceSourceResponse(source);
        const previous = queryClient.getQueryData<SourceResponse>(["news-source", normalizedSource.id]);
        queryClient.setQueryData(["news-source", normalizedSource.id], normalizeSourceResponse(normalizedSource, previous));
      });
    } catch (error) {
      console.error("Batch prefetch failed:", error);
    }
  };
}

export function useResolveNewsUrl() {
  const queryClient = useQueryClient();

  return async (url: string): Promise<NewsResolveResponse> => {
    const normalized = url.trim();
    if (!normalized) {
      return { matched: false };
    }

    return queryClient.fetchQuery<NewsResolveResponse>({
      queryKey: ["news-resolve", normalized],
      queryFn: () => fetchResolvedByUrl(normalized),
      staleTime: 1000 * 60 * 30,
    });
  };
}
