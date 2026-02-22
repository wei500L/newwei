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

export interface MetadataResponse {
  sources: Record<string, Source>;
  columns: Record<string, Column>;
}

export interface Column {
  name: string;
  sources: string[];
}

const api = createApiClient();

async function fetchSourceById(id: string): Promise<SourceResponse> {
  const { data } = await api.get(`/news-aggregator/source?id=${encodeURIComponent(id)}`);
  return data;
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
  const sourceQuery = useQuery<SourceResponse>({
    queryKey: ["news-source", id],
    queryFn: async () => await fetchSourceById(id),
    refetchInterval: interval || false,
    staleTime: 1000 * 30, // 30 seconds
  });

  return {
    ...sourceQuery,
    refresh: sourceQuery.refetch,
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
        queryClient.setQueryData(["news-source", source.id], source);
      });
    } catch (error) {
      console.error("Batch prefetch failed:", error);
    }
  };
}
