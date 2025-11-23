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
export type EconomicDataFrequency = "realtime" | "hourly" | "daily" | "weekly" | "monthly";
export type EconomicDataValueType =
  | "price"
  | "index"
  | "percent"
  | "yield"
  | "fx"
  | "volume"
  | "quantity"
  | "spread";
export type EconomicDataRunStatus = "pending" | "running" | "success" | "failed";
export const AlertChannelType = {
  Email: "email",
  Webhook: "webhook"
} as const;

export type AlertChannelType = (typeof AlertChannelType)[keyof typeof AlertChannelType];
export const AlertDeliveryStatus = {
  Pending: "pending",
  Sent: "sent",
  Failed: "failed"
} as const;

export type AlertDeliveryStatus = (typeof AlertDeliveryStatus)[keyof typeof AlertDeliveryStatus];
export const AlertEventStatus = {
  Pending: "pending",
  Delivered: "delivered",
  Failed: "failed"
} as const;

export type AlertEventStatus = (typeof AlertEventStatus)[keyof typeof AlertEventStatus];
export const AlertMetricProvider = {
  EconomicData: "economic_data",
  SystemEvent: "system_event",
  PipelineJob: "pipeline_job",
  CrawlTask: "crawl_task",
  SystemMetric: "system_metric"
} as const;

export type AlertMetricProvider = (typeof AlertMetricProvider)[keyof typeof AlertMetricProvider];
export const AlertOperator = {
  Gt: "gt",
  Gte: "gte",
  Lt: "lt",
  Lte: "lte",
  Eq: "eq",
  OutsideRange: "outside_range",
  WithinRange: "within_range",
  ChangeUpPct: "change_up_pct",
  ChangeDownPct: "change_down_pct"
} as const;

export type AlertOperator = (typeof AlertOperator)[keyof typeof AlertOperator];
export const AlertSeverity = {
  Low: "low",
  Medium: "medium",
  High: "high"
} as const;

export type AlertSeverity = (typeof AlertSeverity)[keyof typeof AlertSeverity];
export const AlertStatus = {
  Draft: "draft",
  Active: "active",
  Paused: "paused",
  Archived: "archived"
} as const;

export type AlertStatus = (typeof AlertStatus)[keyof typeof AlertStatus];

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

export type CrawlMarkdownStrategyInput = {
  type: string;
  params?: InputMaybe<any>;
};

export type CrawlTableExtractionInput = {
  type: string;
  params?: InputMaybe<any>;
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

export type RateLimitBucketInput = {
  limit: number;
  windowSeconds: number;
};

export type UpdateRateLimitSettingsInput = {
  login: RateLimitBucketInput;
  crawlCreate: RateLimitBucketInput;
  rbacWrite: RateLimitBucketInput;
};

export type UpdateCrawlClientSettingsInput = {
  healthCheckTtlMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
};

export type UpdateAuditLogRetentionInput = {
  retentionDays: number;
};

export type UpdateNewsPromptConfigInput = {
  version: string;
  systemPromptTemplate: string;
  userPromptTemplate: string;
};

export type AlertChannelInput = {
  type: AlertChannelType;
  name: string;
  target: string;
  config?: InputMaybe<any>;
};

export type UpsertAlertRuleInput = {
  id?: InputMaybe<string>;
  name: string;
  description?: InputMaybe<string>;
  severity?: InputMaybe<AlertSeverity>;
  status?: InputMaybe<AlertStatus>;
  metricProvider?: InputMaybe<AlertMetricProvider>;
  metricSlug: string;
  operator: AlertOperator;
  thresholdValue?: InputMaybe<number>;
  thresholdLower?: InputMaybe<number>;
  thresholdUpper?: InputMaybe<number>;
  changeWindowMin?: InputMaybe<number>;
  cooldownSeconds?: InputMaybe<number>;
  checkIntervalSec?: InputMaybe<number>;
  channelIds?: InputMaybe<Array<string>>;
  metadata?: InputMaybe<any>;
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
  markdownStrategy?: InputMaybe<CrawlMarkdownStrategyInput>;
  tableScoreThreshold?: InputMaybe<number>;
  tableExtraction?: InputMaybe<CrawlTableExtractionInput>;
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

export type DateRangeInput = {
  start: any;
  end: any;
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

export type EconomicDataItemModel = {
  __typename?: "EconomicDataItemModel";
  slug: string;
  displayName: string;
  groupLabel?: Maybe<string>;
};

export type EconomicDataPointModel = {
  __typename?: "EconomicDataPointModel";
  timestamp: any;
  value: number;
  unit?: Maybe<string>;
  sourceField?: Maybe<string>;
  dataType: EconomicDataValueType;
  item: EconomicDataItemModel;
};

export type EconomicDataFetchConfigModel = {
  __typename?: "EconomicDataFetchConfigModel";
  id: string;
  frequency: EconomicDataFrequency;
  repeatCron?: Maybe<string>;
  isEnabled: boolean;
  lastRunAt?: Maybe<any>;
  lastStatus?: Maybe<EconomicDataRunStatus>;
  lastError?: Maybe<string>;
  item: EconomicDataItemModel;
};

export type EconomicDataQueryVariables = Exact<{
  category: string;
  timeRange: DateRangeInput;
}>;

export type EconomicDataQuery = {
  getEconomicData: Array<{
    __typename?: "EconomicDataPointModel";
    timestamp: any;
    value: number;
    unit?: string | null;
    sourceField?: string | null;
    dataType: EconomicDataValueType;
    item: { __typename?: "EconomicDataItemModel"; slug: string; displayName: string; groupLabel?: string | null };
  }>;
};

export type EconomicFetchConfigsQueryVariables = Exact<{ [key: string]: never }>;

export type EconomicFetchConfigsQuery = {
  economicDataFetchConfigs: Array<{
    __typename?: "EconomicDataFetchConfigModel";
    id: string;
    frequency: EconomicDataFrequency;
    repeatCron?: string | null;
    isEnabled: boolean;
    lastRunAt?: any | null;
    lastStatus?: EconomicDataRunStatus | null;
    lastError?: string | null;
    item: { __typename?: "EconomicDataItemModel"; slug: string; displayName: string };
  }>;
};

export type UpdateEconomicFetchConfigMutationVariables = Exact<{
  slug: string;
  frequency?: InputMaybe<EconomicDataFrequency>;
  repeatCron?: InputMaybe<string>;
  isEnabled?: InputMaybe<boolean>;
}>;

export type UpdateEconomicFetchConfigMutation = {
  updateEconomicDataFetchConfig: {
    __typename?: "EconomicDataFetchConfigModel";
    id: string;
    frequency: EconomicDataFrequency;
    repeatCron?: string | null;
    isEnabled: boolean;
    lastRunAt?: any | null;
    lastStatus?: EconomicDataRunStatus | null;
    lastError?: string | null;
    item: { __typename?: "EconomicDataItemModel"; slug: string; displayName: string };
  };
};

export type TriggerEconomicDataFetchMutationVariables = Exact<{
  slugs: Array<string> | string;
}>;

export type TriggerEconomicDataFetchMutation = { triggerDataFetch: boolean };

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

export type RateLimitSettingsQueryVariables = Exact<{ [key: string]: never }>;

export type RateLimitSettingsQuery = {
  rateLimitSettings: {
    login: { limit: number; windowSeconds: number };
    crawlCreate: { limit: number; windowSeconds: number };
    rbacWrite: { limit: number; windowSeconds: number };
  };
};

export type UpdateRateLimitSettingsMutationVariables = Exact<{
  input: UpdateRateLimitSettingsInput;
}>;

export type UpdateRateLimitSettingsMutation = {
  updateRateLimitSettings: {
    login: { limit: number; windowSeconds: number };
    crawlCreate: { limit: number; windowSeconds: number };
    rbacWrite: { limit: number; windowSeconds: number };
  };
};

export type AuditLogRetentionQueryVariables = Exact<{ [key: string]: never }>;

export type AuditLogRetentionQuery = {
  auditLogRetention: { retentionDays: number };
};

export type UpdateAuditLogRetentionMutationVariables = Exact<{
  input: UpdateAuditLogRetentionInput;
}>;

export type UpdateAuditLogRetentionMutation = {
  updateAuditLogRetention: { retentionDays: number };
};

export type NewsPromptConfigQueryVariables = Exact<{ [key: string]: never }>;

export type NewsPromptConfigQuery = {
  newsPromptConfig: {
    version: string;
    systemPromptTemplate: string;
    userPromptTemplate: string;
  };
};

export type UpdateNewsPromptConfigMutationVariables = Exact<{
  input: UpdateNewsPromptConfigInput;
}>;

export type UpdateNewsPromptConfigMutation = {
  updateNewsPromptConfig: {
    version: string;
    systemPromptTemplate: string;
    userPromptTemplate: string;
  };
};

export type CrawlClientSettingsQueryVariables = Exact<{ [key: string]: never }>;

export type CrawlClientSettingsQuery = {
  crawlClientSettings: {
    healthCheckTtlMs: number;
    requestTimeoutMs: number;
    maxRetries: number;
    retryBackoffMs: number;
  };
};

export type UpdateCrawlClientSettingsMutationVariables = Exact<{
  input: UpdateCrawlClientSettingsInput;
}>;

export type UpdateCrawlClientSettingsMutation = {
  updateCrawlClientSettings: {
    healthCheckTtlMs: number;
    requestTimeoutMs: number;
    maxRetries: number;
    retryBackoffMs: number;
  };
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
      mediaAssets?: string | null;
      tables?: any | null;
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
export const RateLimitSettingsDocument = gql`
  query RateLimitSettings {
    rateLimitSettings {
      login {
        limit
        windowSeconds
      }
      crawlCreate {
        limit
        windowSeconds
      }
      rbacWrite {
        limit
        windowSeconds
      }
    }
  }
`;

export function useRateLimitSettingsQuery(
  baseOptions?: Apollo.QueryHookOptions<RateLimitSettingsQuery, RateLimitSettingsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<RateLimitSettingsQuery, RateLimitSettingsQueryVariables>(
    RateLimitSettingsDocument,
    options
  );
}

export function useRateLimitSettingsLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<RateLimitSettingsQuery, RateLimitSettingsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<RateLimitSettingsQuery, RateLimitSettingsQueryVariables>(
    RateLimitSettingsDocument,
    options
  );
}

export type RateLimitSettingsQueryHookResult = ReturnType<typeof useRateLimitSettingsQuery>;
export type RateLimitSettingsLazyQueryHookResult = ReturnType<typeof useRateLimitSettingsLazyQuery>;
export type RateLimitSettingsQueryResult = Apollo.QueryResult<
  RateLimitSettingsQuery,
  RateLimitSettingsQueryVariables
>;
export const UpdateRateLimitSettingsDocument = gql`
  mutation UpdateRateLimitSettings($input: UpdateRateLimitSettingsInput!) {
    updateRateLimitSettings(input: $input) {
      login {
        limit
        windowSeconds
      }
      crawlCreate {
        limit
        windowSeconds
      }
      rbacWrite {
        limit
        windowSeconds
      }
    }
  }
`;
export type UpdateRateLimitSettingsMutationFn = Apollo.MutationFunction<
  UpdateRateLimitSettingsMutation,
  UpdateRateLimitSettingsMutationVariables
>;

export function useUpdateRateLimitSettingsMutation(
  baseOptions?: Apollo.MutationHookOptions<
    UpdateRateLimitSettingsMutation,
    UpdateRateLimitSettingsMutationVariables
  >
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<
    UpdateRateLimitSettingsMutation,
    UpdateRateLimitSettingsMutationVariables
  >(UpdateRateLimitSettingsDocument, options);
}
export type UpdateRateLimitSettingsMutationHookResult = ReturnType<
  typeof useUpdateRateLimitSettingsMutation
>;
export type UpdateRateLimitSettingsMutationResult =
  Apollo.MutationResult<UpdateRateLimitSettingsMutation>;
export type UpdateRateLimitSettingsMutationOptions = Apollo.BaseMutationOptions<
  UpdateRateLimitSettingsMutation,
  UpdateRateLimitSettingsMutationVariables
>;
export const AuditLogRetentionDocument = gql`
  query AuditLogRetention {
    auditLogRetention {
      retentionDays
    }
  }
`;

export function useAuditLogRetentionQuery(
  baseOptions?: Apollo.QueryHookOptions<AuditLogRetentionQuery, AuditLogRetentionQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<AuditLogRetentionQuery, AuditLogRetentionQueryVariables>(
    AuditLogRetentionDocument,
    options
  );
}

export function useAuditLogRetentionLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<AuditLogRetentionQuery, AuditLogRetentionQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<AuditLogRetentionQuery, AuditLogRetentionQueryVariables>(
    AuditLogRetentionDocument,
    options
  );
}
export type AuditLogRetentionQueryHookResult = ReturnType<typeof useAuditLogRetentionQuery>;
export type AuditLogRetentionLazyQueryHookResult = ReturnType<
  typeof useAuditLogRetentionLazyQuery
>;
export type AuditLogRetentionQueryResult = Apollo.QueryResult<
  AuditLogRetentionQuery,
  AuditLogRetentionQueryVariables
>;
export const UpdateAuditLogRetentionDocument = gql`
  mutation UpdateAuditLogRetention($input: UpdateAuditLogRetentionInput!) {
    updateAuditLogRetention(input: $input) {
      retentionDays
    }
  }
`;
export type UpdateAuditLogRetentionMutationFn = Apollo.MutationFunction<
  UpdateAuditLogRetentionMutation,
  UpdateAuditLogRetentionMutationVariables
>;

export function useUpdateAuditLogRetentionMutation(
  baseOptions?: Apollo.MutationHookOptions<
    UpdateAuditLogRetentionMutation,
    UpdateAuditLogRetentionMutationVariables
  >
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<
    UpdateAuditLogRetentionMutation,
    UpdateAuditLogRetentionMutationVariables
  >(UpdateAuditLogRetentionDocument, options);
}
export type UpdateAuditLogRetentionMutationHookResult = ReturnType<
  typeof useUpdateAuditLogRetentionMutation
>;
export type UpdateAuditLogRetentionMutationResult =
  Apollo.MutationResult<UpdateAuditLogRetentionMutation>;
export type UpdateAuditLogRetentionMutationOptions = Apollo.BaseMutationOptions<
  UpdateAuditLogRetentionMutation,
  UpdateAuditLogRetentionMutationVariables
>;
export const NewsPromptConfigDocument = gql`
  query NewsPromptConfig {
    newsPromptConfig {
      version
      systemPromptTemplate
      userPromptTemplate
    }
  }
`;

export function useNewsPromptConfigQuery(
  baseOptions?: Apollo.QueryHookOptions<NewsPromptConfigQuery, NewsPromptConfigQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<NewsPromptConfigQuery, NewsPromptConfigQueryVariables>(
    NewsPromptConfigDocument,
    options
  );
}

export function useNewsPromptConfigLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<NewsPromptConfigQuery, NewsPromptConfigQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<NewsPromptConfigQuery, NewsPromptConfigQueryVariables>(
    NewsPromptConfigDocument,
    options
  );
}

export type NewsPromptConfigQueryHookResult = ReturnType<typeof useNewsPromptConfigQuery>;
export type NewsPromptConfigLazyQueryHookResult = ReturnType<typeof useNewsPromptConfigLazyQuery>;
export type NewsPromptConfigQueryResult = Apollo.QueryResult<
  NewsPromptConfigQuery,
  NewsPromptConfigQueryVariables
>;
export const UpdateNewsPromptConfigDocument = gql`
  mutation UpdateNewsPromptConfig($input: UpdateNewsPromptConfigInput!) {
    updateNewsPromptConfig(input: $input) {
      version
      systemPromptTemplate
      userPromptTemplate
    }
  }
`;
export type UpdateNewsPromptConfigMutationFn = Apollo.MutationFunction<
  UpdateNewsPromptConfigMutation,
  UpdateNewsPromptConfigMutationVariables
>;

export function useUpdateNewsPromptConfigMutation(
  baseOptions?: Apollo.MutationHookOptions<
    UpdateNewsPromptConfigMutation,
    UpdateNewsPromptConfigMutationVariables
  >
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<
    UpdateNewsPromptConfigMutation,
    UpdateNewsPromptConfigMutationVariables
  >(UpdateNewsPromptConfigDocument, options);
}
export type UpdateNewsPromptConfigMutationHookResult = ReturnType<
  typeof useUpdateNewsPromptConfigMutation
>;
export type UpdateNewsPromptConfigMutationResult =
  Apollo.MutationResult<UpdateNewsPromptConfigMutation>;
export type UpdateNewsPromptConfigMutationOptions = Apollo.BaseMutationOptions<
  UpdateNewsPromptConfigMutation,
  UpdateNewsPromptConfigMutationVariables
>;
export const CrawlClientSettingsDocument = gql`
  query CrawlClientSettings {
    crawlClientSettings {
      healthCheckTtlMs
      requestTimeoutMs
      maxRetries
      retryBackoffMs
    }
  }
`;

export function useCrawlClientSettingsQuery(
  baseOptions?: Apollo.QueryHookOptions<CrawlClientSettingsQuery, CrawlClientSettingsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<CrawlClientSettingsQuery, CrawlClientSettingsQueryVariables>(
    CrawlClientSettingsDocument,
    options
  );
}

export function useCrawlClientSettingsLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<
    CrawlClientSettingsQuery,
    CrawlClientSettingsQueryVariables
  >
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<CrawlClientSettingsQuery, CrawlClientSettingsQueryVariables>(
    CrawlClientSettingsDocument,
    options
  );
}
export type CrawlClientSettingsQueryHookResult = ReturnType<typeof useCrawlClientSettingsQuery>;
export type CrawlClientSettingsLazyQueryHookResult = ReturnType<
  typeof useCrawlClientSettingsLazyQuery
>;
export type CrawlClientSettingsQueryResult = Apollo.QueryResult<
  CrawlClientSettingsQuery,
  CrawlClientSettingsQueryVariables
>;
export const UpdateCrawlClientSettingsDocument = gql`
  mutation UpdateCrawlClientSettings($input: UpdateCrawlClientSettingsInput!) {
    updateCrawlClientSettings(input: $input) {
      healthCheckTtlMs
      requestTimeoutMs
      maxRetries
      retryBackoffMs
    }
  }
`;
export type UpdateCrawlClientSettingsMutationFn = Apollo.MutationFunction<
  UpdateCrawlClientSettingsMutation,
  UpdateCrawlClientSettingsMutationVariables
>;

export function useUpdateCrawlClientSettingsMutation(
  baseOptions?: Apollo.MutationHookOptions<
    UpdateCrawlClientSettingsMutation,
    UpdateCrawlClientSettingsMutationVariables
  >
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<
    UpdateCrawlClientSettingsMutation,
    UpdateCrawlClientSettingsMutationVariables
  >(UpdateCrawlClientSettingsDocument, options);
}
export type UpdateCrawlClientSettingsMutationHookResult = ReturnType<
  typeof useUpdateCrawlClientSettingsMutation
>;
export type UpdateCrawlClientSettingsMutationResult =
  Apollo.MutationResult<UpdateCrawlClientSettingsMutation>;
export type UpdateCrawlClientSettingsMutationOptions = Apollo.BaseMutationOptions<
  UpdateCrawlClientSettingsMutation,
  UpdateCrawlClientSettingsMutationVariables
>;
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
        mediaAssets
        tables
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

export const EconomicDataDocument = gql`
  query EconomicData($category: String!, $timeRange: DateRangeInput!) {
    getEconomicData(category: $category, timeRange: $timeRange) {
      timestamp
      value
      unit
      sourceField
      dataType
      item {
        slug
        displayName
        groupLabel
      }
    }
  }
`;

export function useEconomicDataQuery(
  baseOptions: Apollo.QueryHookOptions<EconomicDataQuery, EconomicDataQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<EconomicDataQuery, EconomicDataQueryVariables>(EconomicDataDocument, options);
}

export function useEconomicDataLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<EconomicDataQuery, EconomicDataQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<EconomicDataQuery, EconomicDataQueryVariables>(EconomicDataDocument, options);
}
export type EconomicDataQueryHookResult = ReturnType<typeof useEconomicDataQuery>;
export type EconomicDataLazyQueryHookResult = ReturnType<typeof useEconomicDataLazyQuery>;
export type EconomicDataQueryResult = Apollo.QueryResult<EconomicDataQuery, EconomicDataQueryVariables>;
export const EconomicFetchConfigsDocument = gql`
  query EconomicFetchConfigs {
    economicDataFetchConfigs {
      id
      frequency
      repeatCron
      isEnabled
      lastRunAt
      lastStatus
      lastError
      item {
        slug
        displayName
      }
    }
  }
`;

export function useEconomicFetchConfigsQuery(
  baseOptions?: Apollo.QueryHookOptions<EconomicFetchConfigsQuery, EconomicFetchConfigsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<EconomicFetchConfigsQuery, EconomicFetchConfigsQueryVariables>(
    EconomicFetchConfigsDocument,
    options
  );
}

export function useEconomicFetchConfigsLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<EconomicFetchConfigsQuery, EconomicFetchConfigsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<EconomicFetchConfigsQuery, EconomicFetchConfigsQueryVariables>(
    EconomicFetchConfigsDocument,
    options
  );
}
export type EconomicFetchConfigsQueryHookResult = ReturnType<typeof useEconomicFetchConfigsQuery>;
export type EconomicFetchConfigsLazyQueryHookResult = ReturnType<typeof useEconomicFetchConfigsLazyQuery>;
export type EconomicFetchConfigsQueryResult = Apollo.QueryResult<
  EconomicFetchConfigsQuery,
  EconomicFetchConfigsQueryVariables
>;
export const UpdateEconomicFetchConfigDocument = gql`
  mutation UpdateEconomicFetchConfig(
    $slug: String!
    $frequency: EconomicDataFrequency
    $repeatCron: String
    $isEnabled: Boolean
  ) {
    updateEconomicDataFetchConfig(
      slug: $slug
      frequency: $frequency
      repeatCron: $repeatCron
      isEnabled: $isEnabled
    ) {
      id
      frequency
      repeatCron
      isEnabled
      lastRunAt
      lastStatus
      lastError
      item {
        slug
        displayName
      }
    }
  }
`;
export type UpdateEconomicFetchConfigMutationFn = Apollo.MutationFunction<
  UpdateEconomicFetchConfigMutation,
  UpdateEconomicFetchConfigMutationVariables
>;

export function useUpdateEconomicFetchConfigMutation(
  baseOptions?: Apollo.MutationHookOptions<
    UpdateEconomicFetchConfigMutation,
    UpdateEconomicFetchConfigMutationVariables
  >
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<
    UpdateEconomicFetchConfigMutation,
    UpdateEconomicFetchConfigMutationVariables
  >(UpdateEconomicFetchConfigDocument, options);
}
export type UpdateEconomicFetchConfigMutationHookResult = ReturnType<
  typeof useUpdateEconomicFetchConfigMutation
>;
export type UpdateEconomicFetchConfigMutationResult = Apollo.MutationResult<UpdateEconomicFetchConfigMutation>;
export type UpdateEconomicFetchConfigMutationOptions = Apollo.BaseMutationOptions<
  UpdateEconomicFetchConfigMutation,
  UpdateEconomicFetchConfigMutationVariables
>;
export const TriggerEconomicDataFetchDocument = gql`
  mutation TriggerEconomicDataFetch($slugs: [String!]!) {
    triggerDataFetch(input: { slugs: $slugs })
  }
`;
export type TriggerEconomicDataFetchMutationFn = Apollo.MutationFunction<
  TriggerEconomicDataFetchMutation,
  TriggerEconomicDataFetchMutationVariables
>;

export function useTriggerEconomicDataFetchMutation(
  baseOptions?: Apollo.MutationHookOptions<
    TriggerEconomicDataFetchMutation,
    TriggerEconomicDataFetchMutationVariables
  >
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<
    TriggerEconomicDataFetchMutation,
    TriggerEconomicDataFetchMutationVariables
  >(TriggerEconomicDataFetchDocument, options);
}
export type TriggerEconomicDataFetchMutationHookResult = ReturnType<
  typeof useTriggerEconomicDataFetchMutation
>;
export type TriggerEconomicDataFetchMutationResult = Apollo.MutationResult<TriggerEconomicDataFetchMutation>;
export type TriggerEconomicDataFetchMutationOptions = Apollo.BaseMutationOptions<
  TriggerEconomicDataFetchMutation,
  TriggerEconomicDataFetchMutationVariables
>;
export type AlertRulesQueryVariables = Exact<{ [key: string]: never }>;

export type AlertRulesQuery = {
  alertRules: Array<{
    __typename?: "AlertRuleModel";
    id: string;
    name: string;
    description?: string | null;
    severity: AlertSeverity;
    status: AlertStatus;
    metricProvider: AlertMetricProvider;
    metricSlug: string;
    operator: AlertOperator;
    thresholdValue?: number | null;
    thresholdLower?: number | null;
    thresholdUpper?: number | null;
    changeWindowMin?: number | null;
    cooldownSeconds: number;
    checkIntervalSec: number;
    lastTriggeredAt?: any | null;
    metadata?: any | null;
    channels: Array<{
      __typename?: "AlertChannelModel";
      id: string;
      name: string;
      type: AlertChannelType;
      target: string;
    }>;
  }>;
};

export type AlertChannelsQueryVariables = Exact<{ [key: string]: never }>;

export type AlertChannelsQuery = {
  alertChannels: Array<{
    __typename?: "AlertChannelModel";
    id: string;
    name: string;
    type: AlertChannelType;
    target: string;
  }>;
};

export type AlertEventsQueryVariables = Exact<{
  limit?: InputMaybe<number>;
}>;

export type AlertEventsQuery = {
  alertEvents: Array<{
    __typename?: "AlertEventModel";
    id: string;
    triggeredAt: any;
    metricValue: number;
    changePercent?: number | null;
    severity: AlertSeverity;
    status: AlertEventStatus;
    message?: string | null;
    deliveries: Array<{
      __typename?: "AlertDeliveryModel";
      id: string;
      status: AlertDeliveryStatus;
      channelType: AlertChannelType;
      sentAt?: any | null;
      error?: string | null;
    }>;
  }>;
};

export type UpsertAlertRuleMutationVariables = Exact<{
  input: UpsertAlertRuleInput;
}>;

export type UpsertAlertRuleMutation = { upsertAlertRule: { __typename?: "AlertRuleModel"; id: string; name: string } };

export type CreateAlertChannelMutationVariables = Exact<{
  input: AlertChannelInput;
}>;

export type CreateAlertChannelMutation = {
  createAlertChannel: { __typename?: "AlertChannelModel"; id: string; name: string; type: AlertChannelType; target: string };
};

export type TriggerAlertRuleMutationVariables = Exact<{
  ruleId: string;
}>;

export type TriggerAlertRuleMutation = { triggerAlertRule: boolean };

export type AlertEventsStreamSubscriptionVariables = Exact<{ [key: string]: never }>;

export type AlertEventsStreamSubscription = {
  alertEvents: {
    __typename?: "AlertEventModel";
    id: string;
    triggeredAt: any;
    severity: AlertSeverity;
    message?: string | null;
    metricValue: number;
  };
};

export const AlertRulesDocument = gql`
  query AlertRules {
    alertRules {
      id
      name
      description
      severity
      status
      metricProvider
      metricSlug
      operator
      thresholdValue
      thresholdLower
      thresholdUpper
      changeWindowMin
      cooldownSeconds
      checkIntervalSec
      lastTriggeredAt
      metadata
      channels {
        id
        name
        type
        target
      }
    }
  }
`;

export function useAlertRulesQuery(baseOptions?: Apollo.QueryHookOptions<AlertRulesQuery, AlertRulesQueryVariables>) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<AlertRulesQuery, AlertRulesQueryVariables>(AlertRulesDocument, options);
}

export function useAlertRulesLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<AlertRulesQuery, AlertRulesQueryVariables>) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<AlertRulesQuery, AlertRulesQueryVariables>(AlertRulesDocument, options);
}
export type AlertRulesQueryHookResult = ReturnType<typeof useAlertRulesQuery>;
export type AlertRulesLazyQueryHookResult = ReturnType<typeof useAlertRulesLazyQuery>;
export type AlertRulesQueryResult = Apollo.QueryResult<AlertRulesQuery, AlertRulesQueryVariables>;
export const AlertChannelsDocument = gql`
  query AlertChannels {
    alertChannels {
      id
      name
      type
      target
    }
  }
`;

export function useAlertChannelsQuery(
  baseOptions?: Apollo.QueryHookOptions<AlertChannelsQuery, AlertChannelsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<AlertChannelsQuery, AlertChannelsQueryVariables>(AlertChannelsDocument, options);
}

export function useAlertChannelsLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<AlertChannelsQuery, AlertChannelsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<AlertChannelsQuery, AlertChannelsQueryVariables>(AlertChannelsDocument, options);
}
export type AlertChannelsQueryHookResult = ReturnType<typeof useAlertChannelsQuery>;
export type AlertChannelsLazyQueryHookResult = ReturnType<typeof useAlertChannelsLazyQuery>;
export type AlertChannelsQueryResult = Apollo.QueryResult<AlertChannelsQuery, AlertChannelsQueryVariables>;
export const AlertEventsDocument = gql`
  query AlertEvents($limit: Int) {
    alertEvents(limit: $limit) {
      id
      triggeredAt
      metricValue
      changePercent
      severity
      status
      message
      deliveries {
        id
        status
        channelType
        sentAt
        error
      }
    }
  }
`;

export function useAlertEventsQuery(baseOptions?: Apollo.QueryHookOptions<AlertEventsQuery, AlertEventsQueryVariables>) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useQuery<AlertEventsQuery, AlertEventsQueryVariables>(AlertEventsDocument, options);
}

export function useAlertEventsLazyQuery(
  baseOptions?: Apollo.LazyQueryHookOptions<AlertEventsQuery, AlertEventsQueryVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useLazyQuery<AlertEventsQuery, AlertEventsQueryVariables>(AlertEventsDocument, options);
}
export type AlertEventsQueryHookResult = ReturnType<typeof useAlertEventsQuery>;
export type AlertEventsLazyQueryHookResult = ReturnType<typeof useAlertEventsLazyQuery>;
export type AlertEventsQueryResult = Apollo.QueryResult<AlertEventsQuery, AlertEventsQueryVariables>;
export const UpsertAlertRuleDocument = gql`
  mutation UpsertAlertRule($input: UpsertAlertRuleInput!) {
    upsertAlertRule(input: $input) {
      id
      name
    }
  }
`;
export type UpsertAlertRuleMutationFn = Apollo.MutationFunction<
  UpsertAlertRuleMutation,
  UpsertAlertRuleMutationVariables
>;

export function useUpsertAlertRuleMutation(
  baseOptions?: Apollo.MutationHookOptions<UpsertAlertRuleMutation, UpsertAlertRuleMutationVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<UpsertAlertRuleMutation, UpsertAlertRuleMutationVariables>(UpsertAlertRuleDocument, options);
}
export type UpsertAlertRuleMutationHookResult = ReturnType<typeof useUpsertAlertRuleMutation>;
export type UpsertAlertRuleMutationResult = Apollo.MutationResult<UpsertAlertRuleMutation>;
export type UpsertAlertRuleMutationOptions = Apollo.BaseMutationOptions<
  UpsertAlertRuleMutation,
  UpsertAlertRuleMutationVariables
>;
export const CreateAlertChannelDocument = gql`
  mutation CreateAlertChannel($input: AlertChannelInput!) {
    createAlertChannel(input: $input) {
      id
      name
      type
      target
    }
  }
`;
export type CreateAlertChannelMutationFn = Apollo.MutationFunction<
  CreateAlertChannelMutation,
  CreateAlertChannelMutationVariables
>;

export function useCreateAlertChannelMutation(
  baseOptions?: Apollo.MutationHookOptions<CreateAlertChannelMutation, CreateAlertChannelMutationVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<CreateAlertChannelMutation, CreateAlertChannelMutationVariables>(
    CreateAlertChannelDocument,
    options
  );
}
export type CreateAlertChannelMutationHookResult = ReturnType<typeof useCreateAlertChannelMutation>;
export type CreateAlertChannelMutationResult = Apollo.MutationResult<CreateAlertChannelMutation>;
export type CreateAlertChannelMutationOptions = Apollo.BaseMutationOptions<
  CreateAlertChannelMutation,
  CreateAlertChannelMutationVariables
>;
export const TriggerAlertRuleDocument = gql`
  mutation TriggerAlertRule($ruleId: String!) {
    triggerAlertRule(ruleId: $ruleId)
  }
`;
export type TriggerAlertRuleMutationFn = Apollo.MutationFunction<
  TriggerAlertRuleMutation,
  TriggerAlertRuleMutationVariables
>;

export function useTriggerAlertRuleMutation(
  baseOptions?: Apollo.MutationHookOptions<TriggerAlertRuleMutation, TriggerAlertRuleMutationVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useMutation<TriggerAlertRuleMutation, TriggerAlertRuleMutationVariables>(
    TriggerAlertRuleDocument,
    options
  );
}
export type TriggerAlertRuleMutationHookResult = ReturnType<typeof useTriggerAlertRuleMutation>;
export type TriggerAlertRuleMutationResult = Apollo.MutationResult<TriggerAlertRuleMutation>;
export type TriggerAlertRuleMutationOptions = Apollo.BaseMutationOptions<
  TriggerAlertRuleMutation,
  TriggerAlertRuleMutationVariables
>;
export const AlertEventsStreamDocument = gql`
  subscription AlertEventsStream {
    alertEvents {
      id
      triggeredAt
      severity
      message
      metricValue
    }
  }
`;

export function useAlertEventsStreamSubscription(
  baseOptions?: Apollo.SubscriptionHookOptions<AlertEventsStreamSubscription, AlertEventsStreamSubscriptionVariables>
) {
  const options = { ...defaultOptions, ...baseOptions };
  return Apollo.useSubscription<AlertEventsStreamSubscription, AlertEventsStreamSubscriptionVariables>(
    AlertEventsStreamDocument,
    options
  );
}
export type AlertEventsStreamSubscriptionHookResult = ReturnType<typeof useAlertEventsStreamSubscription>;
export type AlertEventsStreamSubscriptionResult = Apollo.SubscriptionResult<AlertEventsStreamSubscription>;
