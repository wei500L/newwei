/* eslint-disable */
import { gql } from "@apollo/client";
import * as Apollo from "@apollo/client";

export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
const defaultOptions = {} as const;

export type CrawlTaskStatus = "pending" | "queued" | "running" | "completed" | "failed" | "paused";

export type CrawlTimeRangeInput = {
  from?: InputMaybe<string>;
  to?: InputMaybe<string>;
};

export type CrawlMarkdownOptionsInput = {
  contentSource?: InputMaybe<string>;
  ignoreLinks?: InputMaybe<boolean>;
  escapeHtml?: InputMaybe<boolean>;
  bodyWidth?: InputMaybe<number>;
};

export type CrawlMarkdownFilterInput = {
  type?: InputMaybe<string>;
  threshold?: InputMaybe<number>;
  thresholdType?: InputMaybe<string>;
  minWordThreshold?: InputMaybe<number>;
};

export type CrawlCleanMarkdownInput = {
  cssSelector?: InputMaybe<string>;
  targetElements?: InputMaybe<Array<string>>;
  excludedTags?: InputMaybe<Array<string>>;
  removeOverlayElements?: InputMaybe<boolean>;
  wordCountThreshold?: InputMaybe<number>;
};

export type CrawlLinkPreviewInput = {
  includeInternal?: InputMaybe<boolean>;
  includeExternal?: InputMaybe<boolean>;
  includeSocial?: InputMaybe<boolean>;
  maxLinks?: InputMaybe<number>;
  concurrency?: InputMaybe<number>;
  timeoutSeconds?: InputMaybe<number>;
  query?: InputMaybe<string>;
  scoreThreshold?: InputMaybe<number>;
  verbose?: InputMaybe<boolean>;
  includePatterns?: InputMaybe<Array<string>>;
  excludePatterns?: InputMaybe<Array<string>>;
};

export type CrawlUrlMatcherInput = {
  matchMode?: InputMaybe<string>;
  patterns?: InputMaybe<Array<string>>;
};

export type CrawlStrategyOverridesInput = {
  scanFullPage?: InputMaybe<boolean>;
  adjustViewportToContent?: InputMaybe<boolean>;
  scrollDelayMs?: InputMaybe<number>;
  onlyMainContent?: InputMaybe<boolean>;
  extractLinks?: InputMaybe<boolean>;
  simulateUser?: InputMaybe<boolean>;
  overrideNavigator?: InputMaybe<boolean>;
  jsCode?: InputMaybe<Array<string>>;
  jsOnly?: InputMaybe<boolean>;
  waitForSelector?: InputMaybe<string>;
  waitForScript?: InputMaybe<string>;
  waitForTimeoutMs?: InputMaybe<number>;
  cacheMode?: InputMaybe<string>;
};

export type CrawlMultiUrlStrategyInput = {
  name?: InputMaybe<string>;
  urls?: InputMaybe<Array<string>>;
  matcher?: InputMaybe<CrawlUrlMatcherInput>;
  options?: InputMaybe<CrawlStrategyOverridesInput>;
};

export type CrawlProxyConfigInput = {
  server: string;
  username?: InputMaybe<string>;
  password?: InputMaybe<string>;
};

export type CrawlBrowserHeaderInput = {
  name: string;
  value: string;
};

export type CrawlBrowserCookieInput = {
  name: string;
  value: string;
  domain: string;
  path?: InputMaybe<string>;
};

export type CrawlUserAgentGeneratorInput = {
  platform?: InputMaybe<string>;
  browser?: InputMaybe<string>;
  deviceType?: InputMaybe<string>;
  locale?: InputMaybe<string>;
};

export type CrawlGeolocationInput = {
  latitude: number;
  longitude: number;
  accuracy?: InputMaybe<number>;
};

export type CrawlOptionsInput = {
  includeImages?: InputMaybe<boolean>;
  storeMedia?: InputMaybe<boolean>;
  onlyMainContent?: InputMaybe<boolean>;
  extractLinks?: InputMaybe<boolean>;
  scanFullPage?: InputMaybe<boolean>;
  adjustViewportToContent?: InputMaybe<boolean>;
  scrollDelayMs?: InputMaybe<number>;
  enableUndetectedBrowser?: InputMaybe<boolean>;
  enableStealthMode?: InputMaybe<boolean>;
  useManagedBrowser?: InputMaybe<boolean>;
  userDataDir?: InputMaybe<string>;
  simulateUser?: InputMaybe<boolean>;
  overrideNavigator?: InputMaybe<boolean>;
  jsCode?: InputMaybe<Array<string>>;
  jsOnly?: InputMaybe<boolean>;
  waitForSelector?: InputMaybe<string>;
  waitForScript?: InputMaybe<string>;
  waitForTimeoutMs?: InputMaybe<number>;
  proxyUrl?: InputMaybe<string>;
  proxyConfig?: InputMaybe<CrawlProxyConfigInput>;
  additionalUrls?: InputMaybe<Array<string>>;
  multiUrlConfigs?: InputMaybe<Array<CrawlMultiUrlStrategyInput>>;
  markdownOptions?: InputMaybe<CrawlMarkdownOptionsInput>;
  markdownFilter?: InputMaybe<CrawlMarkdownFilterInput>;
  cleanMarkdown?: InputMaybe<CrawlCleanMarkdownInput>;
  scoreLinks?: InputMaybe<boolean>;
  linkPreview?: InputMaybe<CrawlLinkPreviewInput>;
  browserHeaders?: InputMaybe<Array<CrawlBrowserHeaderInput>>;
  browserCookies?: InputMaybe<Array<CrawlBrowserCookieInput>>;
  userAgent?: InputMaybe<string>;
  userAgentMode?: InputMaybe<string>;
  userAgentGenerator?: InputMaybe<CrawlUserAgentGeneratorInput>;
  locale?: InputMaybe<string>;
  timezoneId?: InputMaybe<string>;
  geolocation?: InputMaybe<CrawlGeolocationInput>;
  sessionId?: InputMaybe<string>;
  storageState?: InputMaybe<string>;
};

export type CrawlMetadataInput = {
  source?: InputMaybe<string>;
  domain?: InputMaybe<string>;
  urls?: InputMaybe<Array<string>>;
  pattern?: InputMaybe<string>;
  maxUrls?: InputMaybe<number>;
  query?: InputMaybe<string>;
  scoreThreshold?: InputMaybe<number>;
  extractJsonLd?: InputMaybe<boolean>;
  extractOpenGraph?: InputMaybe<boolean>;
  extractStandardMeta?: InputMaybe<boolean>;
  concurrency?: InputMaybe<number>;
};

export type CreateCrawlTaskInput = {
  url: string;
  displayName?: InputMaybe<string>;
  timeRange?: InputMaybe<CrawlTimeRangeInput>;
  concurrency?: InputMaybe<number>;
  keywords?: InputMaybe<Array<string>>;
  options?: InputMaybe<CrawlOptionsInput>;
};

export type MeQueryVariables = Exact<{ [key: string]: never }>;

export type MeQuery = {
  me: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    orgId: string;
    permissions: Array<string>;
  };
};

export type ItemsQueryVariables = Exact<{
  first: number;
  after?: InputMaybe<string>;
  search?: InputMaybe<string>;
}>;

export type ItemsQuery = {
  items: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    edges: Array<{ cursor: string; node: { id: string; title: string; status: string; createdAt: any } }>;
  };
};

export type QueueStatsQueryVariables = Exact<{ [key: string]: never }>;

export type QueueStatsQuery = {
  queueStats: {
    processedCount: number;
    itemCount: number;
    counts: { waiting: number; active: number; completed: number; failed: number; delayed: number };
    recentLogs: Array<{ event: string; jobId: string; data?: string | null; timestamp: string }>;
  };
};

export const MeDocument = gql`
  query Me {
    me {
      id
      email
      firstName
      lastName
      orgId
      permissions
    }
  }
`;

export function useMeQuery(baseOptions?: Apollo.QueryHookOptions<MeQuery, MeQueryVariables>) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<MeQuery, MeQueryVariables>(MeDocument, options);
}

export function useMeLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<MeQuery, MeQueryVariables>) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<MeQuery, MeQueryVariables>(MeDocument, options);
}

export type MeQueryHookResult = ReturnType<typeof useMeQuery>;
export type MeLazyQueryHookResult = ReturnType<typeof useMeLazyQuery>;
export type MeQueryResult = Apollo.QueryResult<MeQuery, MeQueryVariables>;
export const ItemsDocument = gql`
  query Items($first: Int!, $after: String, $search: String) {
    items(first: $first, after: $after, search: $search) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          title
          status
          createdAt
        }
      }
    }
  }
`;

export function useItemsQuery(baseOptions: Apollo.QueryHookOptions<ItemsQuery, ItemsQueryVariables>) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<ItemsQuery, ItemsQueryVariables>(ItemsDocument, options);
}

export function useItemsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<ItemsQuery, ItemsQueryVariables>) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<ItemsQuery, ItemsQueryVariables>(ItemsDocument, options);
}

export type ItemsQueryHookResult = ReturnType<typeof useItemsQuery>;
export type ItemsLazyQueryHookResult = ReturnType<typeof useItemsLazyQuery>;
export type ItemsQueryResult = Apollo.QueryResult<ItemsQuery, ItemsQueryVariables>;
export const QueueStatsDocument = gql`
  query QueueStats {
    queueStats {
      counts {
        waiting
        active
        completed
        failed
        delayed
      }
      processedCount
      itemCount
      recentLogs {
        event
        jobId
        data
        timestamp
      }
    }
  }
`;

export function useQueueStatsQuery(
  baseOptions?: Apollo.QueryHookOptions<QueueStatsQuery, QueueStatsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<QueueStatsQuery, QueueStatsQueryVariables>(QueueStatsDocument, options);
}

export function useQueueStatsLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<QueueStatsQuery, QueueStatsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<QueueStatsQuery, QueueStatsQueryVariables>(QueueStatsDocument, options);
}
export type QueueStatsQueryHookResult = ReturnType<typeof useQueueStatsQuery>;
export type QueueStatsLazyQueryHookResult = ReturnType<typeof useQueueStatsLazyQuery>;
export type QueueStatsQueryResult = Apollo.QueryResult<QueueStatsQuery, QueueStatsQueryVariables>;
export type RbacOverviewQueryVariables = Exact<{ [key: string]: never }>;

export type RbacOverviewQuery = {
  roles: Array<{
    id: string;
    name: string;
    description?: string | null;
    permissions: Array<{ id: string; name: string; description?: string | null }>;
  }>;
  permissions: Array<{ id: string; name: string; description?: string | null }>;
  memberships: Array<{
    id: string;
    orgId: string;
    role: { id: string; name: string };
    user: { id: string; email: string; firstName: string; lastName: string };
  }>;
};

export type CrawlTasksQueryVariables = Exact<{
  first: number;
  after?: InputMaybe<string>;
  search?: InputMaybe<string>;
  status?: InputMaybe<CrawlTaskStatus>;
}>;

export type CrawlTasksQuery = {
  crawlTasks: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        displayName?: string | null;
        targetUrl: string;
        status: CrawlTaskStatus;
        concurrency: number;
        runCount: number;
        resultCount: number;
        lastRunAt?: any | null;
        lastSuccessAt?: any | null;
        lastError?: string | null;
        createdAt: any;
        lastPeakMemoryMb?: number | null;
        lastMemoryEfficiency?: number | null;
      };
    }>;
  };
};

export type CrawlTaskQueryVariables = Exact<{
  id: string;
  resultLimit?: InputMaybe<number>;
  resultSearch?: InputMaybe<string>;
}>;

export type CrawlTaskQuery = {
  crawlTask?: {
    id: string;
    displayName?: string | null;
    targetUrl: string;
    status: CrawlTaskStatus;
    keywords: Array<string>;
    concurrency: number;
    runCount: number;
    lastRunAt?: any | null;
    lastSuccessAt?: any | null;
    lastResultAt?: any | null;
    lastError?: string | null;
    config?: string | null;
    lastServerMemoryMb?: number | null;
    lastPeakMemoryMb?: number | null;
    lastMemoryEfficiency?: number | null;
    results?: Array<{
      id: string;
      sourceUrl: string;
      fetchedAt: any;
      markdown: string;
      markdownWithCitations?: string | null;
      referencesMarkdown?: string | null;
      fitMarkdown?: string | null;
      metadata?: string | null;
      media?: string | null;
      linkAnalysis?: {
        stats: {
          totalLinks: number;
          internalLinks: number;
          externalLinks: number;
          averageIntrinsicScore?: number | null;
          highQualityLinks?: number | null;
          lowQualityLinks?: number | null;
        };
        topLinks: Array<{
          href: string;
          text?: string | null;
          title?: string | null;
          baseDomain?: string | null;
          type?: string | null;
          intrinsicScore?: number | null;
          contextualScore?: number | null;
          totalScore?: number | null;
        }>;
        lowQualityLinks: Array<{
          href: string;
          text?: string | null;
          title?: string | null;
          baseDomain?: string | null;
          intrinsicScore?: number | null;
        }>;
        buckets: Array<{
          kind: string;
          links: Array<{
            href: string;
            text?: string | null;
            title?: string | null;
            baseDomain?: string | null;
            type?: string | null;
            intrinsicScore?: number | null;
            contextualScore?: number | null;
            totalScore?: number | null;
          }>;
        }>;
      } | null;
    }> | null;
    memoryStats?: {
      serverMemoryMb?: number | null;
      peakMemoryMb?: number | null;
      efficiencyPercent?: number | null;
    } | null;
  } | null;
};

export type CreateCrawlTaskMutationVariables = Exact<{
  input: CreateCrawlTaskInput;
}>;

export type CreateCrawlTaskMutation = {
  createCrawlTask: {
    id: string;
    displayName?: string | null;
    targetUrl: string;
    status: CrawlTaskStatus;
    concurrency: number;
    runCount: number;
    resultCount: number;
    lastRunAt?: any | null;
    lastSuccessAt?: any | null;
    lastError?: string | null;
    createdAt: any;
  };
};

export type RetryCrawlTaskMutationVariables = Exact<{
  id: string;
}>;

export type RetryCrawlTaskMutation = {
  retryCrawlTask: {
    id: string;
    status: CrawlTaskStatus;
    lastRunAt?: any | null;
    lastError?: string | null;
    runCount: number;
  };
};

export type CrawlMetadataQueryVariables = Exact<{
  input: CrawlMetadataInput;
}>;

export type CrawlMetadataQuery = {
  crawlMetadata: Array<{
    url: string;
    status: string;
    httpStatus?: number | null;
    fetchedAt?: any | null;
    title?: string | null;
    description?: string | null;
    keywords?: Array<string> | null;
    author?: string | null;
    relevanceScore?: number | null;
    error?: string | null;
    metaTags: Array<{ name: string; value: string }>;
    openGraph: Array<{ name: string; value: string }>;
    jsonLd: Array<string>;
  }>;
};

export const RbacOverviewDocument = gql`
  query RbacOverview {
    roles {
      id
      name
      description
      permissions {
        id
        name
        description
      }
    }
    permissions {
      id
      name
      description
    }
    memberships {
      id
      orgId
      role {
        id
        name
      }
      user {
        id
        email
        firstName
        lastName
      }
    }
  }
`;

export function useRbacOverviewQuery(
  baseOptions?: Apollo.QueryHookOptions<RbacOverviewQuery, RbacOverviewQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<RbacOverviewQuery, RbacOverviewQueryVariables>(RbacOverviewDocument, options);
}

export function useRbacOverviewLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<RbacOverviewQuery, RbacOverviewQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<RbacOverviewQuery, RbacOverviewQueryVariables>(RbacOverviewDocument, options);
}

export type RbacOverviewQueryHookResult = ReturnType<typeof useRbacOverviewQuery>;
export type RbacOverviewLazyQueryHookResult = ReturnType<typeof useRbacOverviewLazyQuery>;
export type RbacOverviewQueryResult = Apollo.QueryResult<RbacOverviewQuery, RbacOverviewQueryVariables>;
export const CrawlTasksDocument = gql`
  query CrawlTasks($first: Int!, $after: String, $search: String, $status: CrawlTaskStatus) {
    crawlTasks(first: $first, after: $after, search: $search, status: $status) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          displayName
          targetUrl
          status
          concurrency
          runCount
          resultCount
          lastRunAt
          lastSuccessAt
          lastError
          createdAt
          lastPeakMemoryMb
          lastMemoryEfficiency
        }
      }
    }
  }
`;

export function useCrawlTasksQuery(
  baseOptions: Apollo.QueryHookOptions<CrawlTasksQuery, CrawlTasksQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<CrawlTasksQuery, CrawlTasksQueryVariables>(CrawlTasksDocument, options);
}

export function useCrawlTasksLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<CrawlTasksQuery, CrawlTasksQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<CrawlTasksQuery, CrawlTasksQueryVariables>(CrawlTasksDocument, options);
}
export type CrawlTasksQueryHookResult = ReturnType<typeof useCrawlTasksQuery>;
export type CrawlTasksLazyQueryHookResult = ReturnType<typeof useCrawlTasksLazyQuery>;
export type CrawlTasksQueryResult = Apollo.QueryResult<CrawlTasksQuery, CrawlTasksQueryVariables>;
export const CrawlTaskDocument = gql`
  query CrawlTask($id: ID!, $resultLimit: Int, $resultSearch: String) {
    crawlTask(id: $id, resultLimit: $resultLimit, resultSearch: $resultSearch) {
      id
      displayName
      targetUrl
      status
      keywords
      concurrency
      runCount
      lastRunAt
      lastSuccessAt
      lastResultAt
      lastError
      config
      lastServerMemoryMb
      lastPeakMemoryMb
      lastMemoryEfficiency
      results {
        id
        sourceUrl
        fetchedAt
        markdown
        markdownWithCitations
        referencesMarkdown
        fitMarkdown
        metadata
        media
        linkAnalysis {
          stats {
            totalLinks
            internalLinks
            externalLinks
            averageIntrinsicScore
            highQualityLinks
            lowQualityLinks
          }
          topLinks {
            href
            text
            title
            baseDomain
            type
            intrinsicScore
            contextualScore
            totalScore
          }
          lowQualityLinks {
            href
            text
            title
            baseDomain
            intrinsicScore
          }
          buckets {
            kind
            links {
              href
              text
              title
              baseDomain
              type
              intrinsicScore
              contextualScore
              totalScore
            }
          }
        }
      }
      memoryStats {
        serverMemoryMb
        peakMemoryMb
        efficiencyPercent
      }
    }
  }
`;

export function useCrawlTaskQuery(
  baseOptions: Apollo.QueryHookOptions<CrawlTaskQuery, CrawlTaskQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<CrawlTaskQuery, CrawlTaskQueryVariables>(CrawlTaskDocument, options);
}

export function useCrawlTaskLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<CrawlTaskQuery, CrawlTaskQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<CrawlTaskQuery, CrawlTaskQueryVariables>(CrawlTaskDocument, options);
}
export type CrawlTaskQueryHookResult = ReturnType<typeof useCrawlTaskQuery>;
export type CrawlTaskLazyQueryHookResult = ReturnType<typeof useCrawlTaskLazyQuery>;
export type CrawlTaskQueryResult = Apollo.QueryResult<CrawlTaskQuery, CrawlTaskQueryVariables>;
export const CreateCrawlTaskDocument = gql`
  mutation CreateCrawlTask($input: CreateCrawlTaskInput!) {
    createCrawlTask(input: $input) {
      id
      displayName
      targetUrl
      status
      concurrency
      runCount
      resultCount
      lastRunAt
      lastSuccessAt
      lastError
      createdAt
    }
  }
`;
export type CreateCrawlTaskMutationFn = Apollo.MutationFunction<
  CreateCrawlTaskMutation,
  CreateCrawlTaskMutationVariables
>;

export function useCreateCrawlTaskMutation(
  baseOptions?: Apollo.MutationHookOptions<CreateCrawlTaskMutation, CreateCrawlTaskMutationVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<CreateCrawlTaskMutation, CreateCrawlTaskMutationVariables>(
    CreateCrawlTaskDocument,
    options
  );
}
export type CreateCrawlTaskMutationHookResult = ReturnType<typeof useCreateCrawlTaskMutation>;
export type CreateCrawlTaskMutationResult = Apollo.MutationResult<CreateCrawlTaskMutation>;
export type CreateCrawlTaskMutationOptions = Apollo.BaseMutationOptions<
  CreateCrawlTaskMutation,
  CreateCrawlTaskMutationVariables
>;
export const RetryCrawlTaskDocument = gql`
  mutation RetryCrawlTask($id: ID!) {
    retryCrawlTask(id: $id) {
      id
      status
      lastRunAt
      lastError
      runCount
    }
  }
`;
export type RetryCrawlTaskMutationFn = Apollo.MutationFunction<
  RetryCrawlTaskMutation,
  RetryCrawlTaskMutationVariables
>;

export function useRetryCrawlTaskMutation(
  baseOptions?: Apollo.MutationHookOptions<RetryCrawlTaskMutation, RetryCrawlTaskMutationVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<RetryCrawlTaskMutation, RetryCrawlTaskMutationVariables>(
    RetryCrawlTaskDocument,
    options
  );
}
export type RetryCrawlTaskMutationHookResult = ReturnType<typeof useRetryCrawlTaskMutation>;
export type RetryCrawlTaskMutationResult = Apollo.MutationResult<RetryCrawlTaskMutation>;
export type RetryCrawlTaskMutationOptions = Apollo.BaseMutationOptions<
  RetryCrawlTaskMutation,
  RetryCrawlTaskMutationVariables
>;
export const CrawlMetadataDocument = gql`
  query CrawlMetadata($input: CrawlMetadataInput!) {
    crawlMetadata(input: $input) {
      url
      status
      httpStatus
      fetchedAt
      title
      description
      keywords
      author
      relevanceScore
      error
      metaTags {
        name
        value
      }
      openGraph {
        name
        value
      }
      jsonLd
    }
  }
`;

export function useCrawlMetadataQuery(
  baseOptions: Apollo.QueryHookOptions<CrawlMetadataQuery, CrawlMetadataQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<CrawlMetadataQuery, CrawlMetadataQueryVariables>(CrawlMetadataDocument, options);
}

export function useCrawlMetadataLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<CrawlMetadataQuery, CrawlMetadataQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<CrawlMetadataQuery, CrawlMetadataQueryVariables>(CrawlMetadataDocument, options);
}
export type CrawlMetadataQueryHookResult = ReturnType<typeof useCrawlMetadataQuery>;
export type CrawlMetadataLazyQueryHookResult = ReturnType<typeof useCrawlMetadataLazyQuery>;
export type CrawlMetadataQueryResult = Apollo.QueryResult<
  CrawlMetadataQuery,
  CrawlMetadataQueryVariables
>;
