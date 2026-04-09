import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { createApiClient } from "@/lib/api-client";
import type { NewsSourceRuntimeSecretsConfig } from '@/lib/news-source-runtime-secrets';

import type {
  NewsnowDataState,
  type NewsnowDomesticOpinionEmptyReason,
  type NewsnowHottestAnalysisEmptyReason,
} from "../lib/newsnow-analysis-access";
import {
  getNewsnowAnalysisAccessState,
  getNewsnowAnalysisPermissions,
} from "../lib/newsnow-analysis-access";
import { normalizeNewsnowSourceIds } from "../lib/newsnow-fetching";
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
  itemRefs: {
    sourceId: string;
    itemId: string;
    title: string;
    matchedItemId?: string;
    matchedEventId?: string;
  }[];
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
  errors: { sourceId: string; message: string }[];
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

interface NewsSourceBatchFetchError {
  id: string;
  message: string;
}

interface NewsSourceBatchFetchResponse {
  results?: SourceResponse[];
  errors?: NewsSourceBatchFetchError[];
}

type NewsSourcePrimeFailureReason = 'unsupported' | 'transient';

interface NewsSourcePrimeFailure {
  id: string;
  message: string;
  reason: NewsSourcePrimeFailureReason;
}

interface NewsSourceBatchPrimeResult {
  failures: NewsSourcePrimeFailure[];
}

interface NewsSourcePrimeFeedback {
  failedSourceIds: string[];
  unsupportedSourceIds: string[];
  transientSourceIds: string[];
  requestFailed: boolean;
}

const api = createApiClient();
const NEWS_SOURCE_QUERY_STALE_TIME_MS = 1000 * 30;
const NEWS_SOURCE_BATCH_REQUEST_LIMIT = 100;
const newsSourcePrimeInFlight = new Map<
  string,
  Promise<NewsSourceBatchPrimeResult>
>();
const KNOWN_BATCH_UNSUPPORTED_NEWS_SOURCE_IDS = new Set<string>([
  // `/news-aggregator/sources/batch` currently omits this source, so keep it
  // on the per-card owner path and skip the redundant batch request upfront.
  "producthunt",
]);
const newsSourceBatchUnsupported = new Set<string>(
  KNOWN_BATCH_UNSUPPORTED_NEWS_SOURCE_IDS,
);

function getNewsSourceQueryKey(id: string) {
  return ["news-source", id] as const;
}

function normalizeSourceIds(sourceIds: string[]) {
  return normalizeNewsnowSourceIds(sourceIds);
}

function hasFreshNewsSourceCache(queryClient: QueryClient, id: string) {
  const queryKey = getNewsSourceQueryKey(id);
  const cachedData = queryClient.getQueryData<SourceResponse>(queryKey);
  const updatedAt =
    queryClient.getQueryState<SourceResponse>(queryKey)?.dataUpdatedAt ?? 0;

  return Boolean(cachedData) && Date.now() - updatedAt < NEWS_SOURCE_QUERY_STALE_TIME_MS;
}

function getStaleNewsSourceIds(queryClient: QueryClient, sourceIds: string[]) {
  return normalizeSourceIds(sourceIds).filter(
    (sourceId) => !hasFreshNewsSourceCache(queryClient, sourceId),
  );
}

function getBatchPrimeTargetIds(queryClient: QueryClient, sourceIds: string[]) {
  return getStaleNewsSourceIds(queryClient, sourceIds).filter(
    (sourceId) => !newsSourceBatchUnsupported.has(sourceId),
  );
}

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

function shouldMarkNewsSourceBatchUnsupported(
  error: NewsSourceBatchFetchError,
): boolean {
  return /unknown source|source getter not found/i.test(error.message);
}

function buildNewsSourcePrimeFeedback(
  result: NewsSourceBatchPrimeResult,
): NewsSourcePrimeFeedback | null {
  if (result.failures.length === 0) {
    return null;
  }

  const failedSourceIds = result.failures.map((failure) => failure.id);
  const unsupportedSourceIds = result.failures
    .filter((failure) => failure.reason === 'unsupported')
    .map((failure) => failure.id);
  const transientSourceIds = result.failures
    .filter((failure) => failure.reason !== 'unsupported')
    .map((failure) => failure.id);

  return {
    failedSourceIds,
    unsupportedSourceIds,
    transientSourceIds,
    requestFailed: false,
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

async function batchFillNewsSourceCache(
  queryClient: QueryClient,
  sourceIds: string[],
  options?: { forceRefresh?: boolean },
): Promise<NewsSourceBatchPrimeResult> {
  const normalizedSourceIds = normalizeSourceIds(sourceIds);
  if (normalizedSourceIds.length === 0) {
    return { failures: [] };
  }

  const failures: NewsSourcePrimeFailure[] = [];

  for (
    let index = 0;
    index < normalizedSourceIds.length;
    index += NEWS_SOURCE_BATCH_REQUEST_LIMIT
  ) {
    const batchSourceIds = normalizedSourceIds.slice(
      index,
      index + NEWS_SOURCE_BATCH_REQUEST_LIMIT,
    );
    const requestPath = options?.forceRefresh
      ? "/news-aggregator/sources/batch?latest=1"
      : "/news-aggregator/sources/batch";
    const { data } = await api.post<NewsSourceBatchFetchResponse>(
      requestPath,
      {
        sources: batchSourceIds,
      },
    );
    const resolvedSourceIds = new Set<string>();
    const failedBatchSourceIds = new Set<string>();

    for (const source of data.results ?? []) {
      const normalizedSource = coerceSourceResponse(source);
      resolvedSourceIds.add(normalizedSource.id);
      newsSourceBatchUnsupported.delete(normalizedSource.id);
      const queryKey = getNewsSourceQueryKey(normalizedSource.id);
      const previous = queryClient.getQueryData<SourceResponse>(queryKey);
      queryClient.setQueryData(
        queryKey,
        normalizeSourceResponse(normalizedSource, previous),
      );
    }

    for (const error of data.errors ?? []) {
      failedBatchSourceIds.add(error.id);
      const unsupported = shouldMarkNewsSourceBatchUnsupported(error);
      failures.push({
        id: error.id,
        message: error.message,
        reason: unsupported ? 'unsupported' : 'transient',
      });
      if (unsupported) {
        newsSourceBatchUnsupported.add(error.id);
      } else if (!KNOWN_BATCH_UNSUPPORTED_NEWS_SOURCE_IDS.has(error.id)) {
        newsSourceBatchUnsupported.delete(error.id);
      }
    }

    for (const sourceId of batchSourceIds) {
      if (resolvedSourceIds.has(sourceId) || failedBatchSourceIds.has(sourceId)) {
        continue;
      }
      failures.push({
        id: sourceId,
        message: 'Source missing from batch response',
        reason: 'transient',
      });
      if (KNOWN_BATCH_UNSUPPORTED_NEWS_SOURCE_IDS.has(sourceId)) {
        newsSourceBatchUnsupported.add(sourceId);
      }
    }
  }

  return { failures };
}

async function primeNewsSourceCache(
  queryClient: QueryClient,
  sourceIds: string[],
  options?: { forceRefresh?: boolean },
): Promise<NewsSourceBatchPrimeResult> {
  const normalizedTargetIds = normalizeSourceIds(sourceIds);
  const batchTargetIds = options?.forceRefresh
    ? normalizedTargetIds.filter(
        (sourceId) => !newsSourceBatchUnsupported.has(sourceId),
      )
    : getBatchPrimeTargetIds(queryClient, normalizedTargetIds);
  if (batchTargetIds.length === 0) {
    return { failures: [] };
  }

  const fingerprint = `${options?.forceRefresh ? 'latest:' : 'default:'}${batchTargetIds.join("|")}`;
  const inFlight = newsSourcePrimeInFlight.get(fingerprint);
  if (inFlight) {
    return await inFlight;
  }

  const nextPromise = batchFillNewsSourceCache(queryClient, batchTargetIds, options)
    .finally(() => {
      if (newsSourcePrimeInFlight.get(fingerprint) === nextPromise) {
        newsSourcePrimeInFlight.delete(fingerprint);
      }
    });
  newsSourcePrimeInFlight.set(fingerprint, nextPromise);
  return await nextPromise;
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

export interface UseNewsSourceOptions {
  enabled?: boolean;
  interval?: number | false;
}

export function useNewsSource(id: string, options?: UseNewsSourceOptions) {
  const queryClient = useQueryClient();
  const queryKey = getNewsSourceQueryKey(id);
  const queryEnabled = options?.enabled ?? true;

  const sourceQuery = useQuery<SourceResponse>({
    queryKey,
    enabled: queryEnabled,
    queryFn: async () => {
      const cached = queryClient.getQueryData<SourceResponse>(queryKey);
      if (hasFreshNewsSourceCache(queryClient, id) && cached) {
        return cached;
      }

      await primeNewsSourceCache(queryClient, [id]);
      const primed = queryClient.getQueryData<SourceResponse>(queryKey);
      if (primed) {
        return primed;
      }

      const previous = queryClient.getQueryData<SourceResponse>(queryKey);
      const incoming = await fetchSourceById(id);
      return normalizeSourceResponse(incoming, previous);
    },
    refetchInterval: options?.interval || false,
    staleTime: NEWS_SOURCE_QUERY_STALE_TIME_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const cachedData = queryClient.getQueryData<SourceResponse>(queryKey);

  return {
    ...sourceQuery,
    data: sourceQuery.data ?? cachedData,
    refresh: async () => {
      const previous = queryClient.getQueryData<SourceResponse>(queryKey);
      const latestData = normalizeSourceResponse(await fetchSourceById(id, true), previous);
      queryClient.setQueryData(queryKey, latestData);
      return latestData;
    },
  };
}

export function usePrimeNewsSources(sourceIds: string[]) {
  const queryClient = useQueryClient();
  const normalizedSourceIds = useMemo(
    () => normalizeSourceIds(sourceIds),
    [sourceIds],
  );
  const sourcesFingerprint = useMemo(
    () => normalizedSourceIds.join("|"),
    [normalizedSourceIds],
  );
  const hasFreshSourceData =
    normalizedSourceIds.length === 0 ||
    normalizedSourceIds.every((sourceId) =>
      hasFreshNewsSourceCache(queryClient, sourceId),
    );
  const [activePrimeFingerprint, setActivePrimeFingerprint] = useState<
    string | null
  >(null);
  const [completedPrimeFingerprint, setCompletedPrimeFingerprint] = useState<
    string | null
  >(null);
  const [primeFeedback, setPrimeFeedback] =
    useState<NewsSourcePrimeFeedback | null>(null);

  useEffect(() => {
    if (normalizedSourceIds.length === 0) {
      setActivePrimeFingerprint(null);
      setCompletedPrimeFingerprint(null);
      setPrimeFeedback(null);
      return;
    }
    const staleSourceIds = getStaleNewsSourceIds(queryClient, normalizedSourceIds);
    if (staleSourceIds.length === 0) {
      setCompletedPrimeFingerprint(sourcesFingerprint);
      setPrimeFeedback(null);
      setActivePrimeFingerprint((current) =>
        current === sourcesFingerprint ? null : current,
      );
      return;
    }

    let cancelled = false;
    setActivePrimeFingerprint(sourcesFingerprint);
    void primeNewsSourceCache(queryClient, staleSourceIds)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setPrimeFeedback(buildNewsSourcePrimeFeedback(result));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        console.error("NewsNow source priming failed:", error);
        setPrimeFeedback({
          failedSourceIds: staleSourceIds,
          unsupportedSourceIds: [],
          transientSourceIds: staleSourceIds,
          requestFailed: true,
        });
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        setCompletedPrimeFingerprint(sourcesFingerprint);
        setActivePrimeFingerprint((current) =>
          current === sourcesFingerprint ? null : current,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [
    hasFreshSourceData,
    normalizedSourceIds,
    queryClient,
    sourcesFingerprint,
  ]);

  const primeSources = useCallback(
    async (ids: string[], options?: { force?: boolean }) => {
      const normalizedIds = normalizeSourceIds(ids);
      const unsupportedSourceIds = normalizedIds.filter((sourceId) =>
        newsSourceBatchUnsupported.has(sourceId),
      );
      const targetIds = options?.force
        ? normalizedIds.filter(
            (sourceId) => !newsSourceBatchUnsupported.has(sourceId),
          )
        : getBatchPrimeTargetIds(queryClient, normalizedIds);
      if (targetIds.length === 0) {
        if (unsupportedSourceIds.length > 0) {
          setPrimeFeedback({
            failedSourceIds: unsupportedSourceIds,
            unsupportedSourceIds,
            transientSourceIds: [],
            requestFailed: false,
          });
        }
        return false;
      }

      const nextFingerprint = normalizedIds.join("|");
      setActivePrimeFingerprint(nextFingerprint);
      try {
        const result = await primeNewsSourceCache(queryClient, targetIds, {
          forceRefresh: options?.force,
        });
        const nextFeedback = buildNewsSourcePrimeFeedback({
          failures: [
            ...result.failures,
            ...unsupportedSourceIds.map((sourceId) => ({
              id: sourceId,
              message: 'Source does not support batch refresh',
              reason: 'unsupported' as const,
            })),
          ],
        });
        setPrimeFeedback(nextFeedback);
        return nextFeedback === null;
      } catch (error) {
        console.error("NewsNow source priming failed:", error);
        setPrimeFeedback({
          failedSourceIds: targetIds,
          unsupportedSourceIds: [],
          transientSourceIds: targetIds,
          requestFailed: true,
        });
        return false;
      } finally {
        setActivePrimeFingerprint((current) =>
          current === nextFingerprint ? null : current,
        );
      }
    },
    [queryClient],
  );

  return {
    hasFreshSourceData,
    primeFeedback,
    isPrimingSources:
      normalizedSourceIds.length > 0 &&
      activePrimeFingerprint === sourcesFingerprint,
    shouldShowSourceSkeleton:
      normalizedSourceIds.length > 0 &&
      !hasFreshSourceData &&
      completedPrimeFingerprint !== sourcesFingerprint,
    clearPrimeFeedback: () => setPrimeFeedback(null),
    primeSources,
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
    staleTime: 1000 * 60 * 5,
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
    staleTime: 1000 * 60 * 5,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });

  return {
    ...query,
    accessState: resolvedAccessState,
    permissions,
  };
}
