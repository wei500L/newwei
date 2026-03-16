import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useCallback, useMemo } from "react";

import { createApiClient } from "@/lib/api-client";
import type { NewsSourceRuntimeSecretsConfig } from '@/lib/news-source-runtime-secrets';

import {
  type NewsnowAnalysisAccessState,
  NewsnowDataState,
  type NewsnowDomesticOpinionEmptyReason,
  type NewsnowHottestAnalysisEmptyReason,
  getNewsnowAnalysisAccessState,
  getNewsnowAnalysisPermissions,
} from "../lib/newsnow-analysis-access";
import { getNewsItemStableKey, sanitizeNewsItems } from "../lib/newsnow-items";

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
  runtimeSecrets?: NewsSourceRuntimeSecretsConfig;
  redirect?: string;
}

export interface SourceResponse {
  status: "success" | "cache";
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

export type NewsnowContentKind =
  | 'article'
  | 'discussion'
  | 'video'
  | 'mixed'
  | 'unknown';

export interface NewsnowAnalyzedItem {
  sourceId: string;
  itemId: string;
  clusterId: string;
  theme: string | null;
  candidateLabel: string | null;
  candidateSummary: string | null;
  reason: string | null;
  topics: string[];
  entities: string[];
  contentKind: NewsnowContentKind;
  sourceCount: number;
  heatScore: number;
  freshnessScore: number;
  candidateScore: number;
  isNew: boolean;
  isRising: boolean;
  bridgeEligible: boolean;
  bridgeStatus: 'existing' | 'queued' | 'eligible' | 'not_supported';
  matchedItemId?: string;
  matchedEventId?: string;
}

export interface NewsnowEventCandidate {
  candidateId: string;
  label: string;
  summary: string | null;
  reason: string | null;
  themes: string[];
  entities: string[];
  sourceIds: string[];
  sourceCount: number;
  itemCount: number;
  heatScore: number;
  freshnessScore: number;
  candidateScore: number;
  itemRefs: Array<{
    sourceId: string;
    itemId: string;
    title: string;
    matchedItemId?: string;
    matchedEventId?: string;
  }>;
}

export interface NewsnowHottestAnalysisResponse {
  generatedAt: string;
  cached: boolean;
  dataState: NewsnowDataState;
  emptyReason: NewsnowHottestAnalysisEmptyReason | null;
  diagnostics: NewsnowHottestAnalysisDiagnostics;
  sourcesAnalyzed: number;
  itemsAnalyzed: number;
  bySource: Record<string, Record<string, NewsnowAnalyzedItem>>;
  candidates: NewsnowEventCandidate[];
  errors: Array<{ sourceId: string; message: string }>;
}

export interface NewsnowHottestAnalysisDiagnostics {
  sourcesRequested: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  sourceItemsFetched: number;
}

export interface NewsnowDomesticOpinionIndexPoint {
  bucketStart: string;
  indexValue: number;
  attentionScore: number;
  breadthScore: number;
  freshnessScore: number;
  sentimentPressure: number;
  candidateCount: number;
}

export interface NewsnowDomesticOpinionBreakdownSourcePoint {
  bucketStart: string;
  indexValue: number;
  attentionScore: number;
  breadthScore: number;
  freshnessScore: number;
  sentimentPressure: number;
  candidateCount: number;
}

export interface NewsnowDomesticOpinionPipelineBreakdownSourcePoint {
  bucketStart: string;
  indexValue: number;
  attentionScore: number;
  breadthScore: number;
  freshnessScore: number;
  sentimentPressure: number;
  articleCount: number;
  sourceCount: number;
}

export interface NewsnowDomesticOpinionBreakdownPoint {
  bucketStart: string;
  newsnow: NewsnowDomesticOpinionBreakdownSourcePoint | null;
  pipeline: NewsnowDomesticOpinionPipelineBreakdownSourcePoint | null;
}

export interface NewsnowDomesticOpinionKeywordSummary {
  keyword: string;
  weight: number;
}

export interface NewsnowDomesticOpinionTopCandidate {
  label: string;
  candidateScore: number;
  sourceCount: number;
}

export interface NewsnowDomesticOpinionIndexResponse {
  generatedAt: string;
  dataState: NewsnowDataState;
  emptyReason: NewsnowDomesticOpinionEmptyReason | null;
  diagnostics: NewsnowDomesticOpinionDiagnostics;
  latest: NewsnowDomesticOpinionIndexPoint | null;
  trend: NewsnowDomesticOpinionIndexPoint[];
  topKeywords: NewsnowDomesticOpinionKeywordSummary[];
  topCandidates: NewsnowDomesticOpinionTopCandidate[];
  breakdown: {
    latest: NewsnowDomesticOpinionBreakdownPoint | null;
    trend: NewsnowDomesticOpinionBreakdownPoint[];
    topKeywords: {
      newsnow: NewsnowDomesticOpinionKeywordSummary[];
      pipeline: NewsnowDomesticOpinionKeywordSummary[];
    };
  };
}

export interface NewsnowDomesticOpinionDiagnostics {
  requestedHours: number;
  snapshotCount: number;
  pipelineBucketCount: number;
}

interface ResolveNewsUrlOptions {
  signal?: AbortSignal;
  forceRefresh?: boolean;
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
    items: sanitizeNewsItems(data.items) as NewsItem[],
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
    previousPositions.set(getNewsItemStableKey(item, index), index);
  });

  return {
    ...incoming,
    items: incoming.items.map((item, index) => {
      const previousIndex = previousPositions.get(getNewsItemStableKey(item, index));
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

async function fetchResolvedByUrl(
  url: string,
  options?: ResolveNewsUrlOptions,
): Promise<NewsResolveResponse> {
  const { data } = await api.get(
    `/news-aggregator/resolve?url=${encodeURIComponent(url)}`,
    options?.signal ? { signal: options.signal } : undefined,
  );
  return (data ?? { matched: false }) as NewsResolveResponse;
}

async function fetchHottestAnalysis(
  apiClient: ReturnType<typeof createApiClient>,
): Promise<NewsnowHottestAnalysisResponse> {
  const { data } = await apiClient.get('/news-aggregator/hottest-analysis');
  return data as NewsnowHottestAnalysisResponse;
}

async function fetchDomesticOpinionIndex(
  apiClient: ReturnType<typeof createApiClient>,
): Promise<NewsnowDomesticOpinionIndexResponse> {
  const { data } = await apiClient.get('/news-aggregator/domestic-opinion-index');
  return data as NewsnowDomesticOpinionIndexResponse;
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

  return useCallback(
    async (
      url: string,
      options?: ResolveNewsUrlOptions,
    ): Promise<NewsResolveResponse> => {
      const normalized = url.trim();
      if (!normalized) {
        return { matched: false };
      }

      // Abortable prefetches are intentionally kept out of React Query cache
      // to avoid global cancelled-error noise from rapid card rerenders.
      if (options?.signal) {
        return fetchResolvedByUrl(normalized, options);
      }

      return queryClient.fetchQuery<NewsResolveResponse>({
        queryKey: ["news-resolve", normalized],
        queryFn: () => fetchResolvedByUrl(normalized, options),
        staleTime: options?.forceRefresh ? 0 : 1000 * 60 * 30,
      });
    },
    [queryClient],
  );
}

export function useHottestAnalysis(enabled: boolean) {
  const { data: session, status } = useSession();
  const accessToken = session?.accessToken as string | undefined;
  const permissions = getNewsnowAnalysisPermissions(session);
  const accessState = getNewsnowAnalysisAccessState(status, permissions);
  const resolvedAccessState =
    status === 'authenticated' && !accessToken
      ? getNewsnowAnalysisAccessState('unauthenticated', permissions)
      : accessState;
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );
  const queryEnabled = enabled && resolvedAccessState.canQuery && !!accessToken;

  const query = useQuery<NewsnowHottestAnalysisResponse>({
    queryKey: [
      'newsnow-hottest-analysis',
      session?.orgId ?? 'anonymous-org',
      session?.user?.id ?? 'anonymous-user',
    ],
    queryFn: () => fetchHottestAnalysis(apiClient),
    enabled: queryEnabled,
    staleTime: 1000 * 60,
    refetchInterval: queryEnabled ? 1000 * 60 * 2 : false,
    refetchOnWindowFocus: false,
  });

  return {
    ...query,
    accessState: resolvedAccessState,
    permissions,
  };
}

export function useDomesticOpinionIndex(enabled: boolean) {
  const { data: session, status } = useSession();
  const accessToken = session?.accessToken as string | undefined;
  const permissions = getNewsnowAnalysisPermissions(session);
  const accessState = getNewsnowAnalysisAccessState(status, permissions);
  const resolvedAccessState =
    status === 'authenticated' && !accessToken
      ? getNewsnowAnalysisAccessState('unauthenticated', permissions)
      : accessState;
  const apiClient = useMemo(
    () => createApiClient({ accessToken }),
    [accessToken],
  );
  const queryEnabled = enabled && resolvedAccessState.canQuery && !!accessToken;

  const query = useQuery<NewsnowDomesticOpinionIndexResponse>({
    queryKey: [
      'newsnow-domestic-opinion-index',
      session?.orgId ?? 'anonymous-org',
    ],
    queryFn: () => fetchDomesticOpinionIndex(apiClient),
    enabled: queryEnabled,
    staleTime: 1000 * 60,
    refetchInterval: queryEnabled ? 1000 * 60 * 2 : false,
    refetchOnWindowFocus: false,
  });

  return {
    ...query,
    accessState: resolvedAccessState,
    permissions,
  };
}
