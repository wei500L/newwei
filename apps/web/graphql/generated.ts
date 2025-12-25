import { gql } from '@apollo/client';
import * as Apollo from '@apollo/client';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
const defaultOptions = {} as const;
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  /** A date-time string at UTC, such as 2019-12-03T09:54:33Z, compliant with the date-time format. */
  DateTime: { input: any; output: any; }
  /** The `JSON` scalar type represents JSON values as specified by [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf). */
  JSON: { input: any; output: any; }
};

export type AlertChannelInput = {
  config?: InputMaybe<Scalars['JSON']['input']>;
  name: Scalars['String']['input'];
  target: Scalars['String']['input'];
  type: AlertChannelType;
};

export type AlertChannelModel = {
  __typename?: 'AlertChannelModel';
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
  target: Scalars['String']['output'];
  type: AlertChannelType;
  updatedAt: Scalars['DateTime']['output'];
};

export enum AlertChannelType {
  Email = 'email',
  Webhook = 'webhook'
}

export type AlertDeliveryModel = {
  __typename?: 'AlertDeliveryModel';
  channelType: AlertChannelType;
  error?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  sentAt?: Maybe<Scalars['DateTime']['output']>;
  status: AlertDeliveryStatus;
};

export enum AlertDeliveryStatus {
  Failed = 'failed',
  Pending = 'pending',
  Sent = 'sent'
}

export type AlertEventModel = {
  __typename?: 'AlertEventModel';
  changePercent?: Maybe<Scalars['Float']['output']>;
  context?: Maybe<Scalars['JSON']['output']>;
  deliveries: Array<AlertDeliveryModel>;
  id: Scalars['String']['output'];
  message?: Maybe<Scalars['String']['output']>;
  metricValue: Scalars['Float']['output'];
  severity: AlertSeverity;
  status: AlertEventStatus;
  triggeredAt: Scalars['DateTime']['output'];
};

export enum AlertEventStatus {
  Delivered = 'delivered',
  Failed = 'failed',
  Pending = 'pending'
}

export enum AlertMetricProvider {
  CrawlTask = 'crawl_task',
  EconomicData = 'economic_data',
  PipelineJob = 'pipeline_job',
  SystemEvent = 'system_event',
  SystemMetric = 'system_metric'
}

export enum AlertOperator {
  ChangeDownPct = 'change_down_pct',
  ChangeUpPct = 'change_up_pct',
  Eq = 'eq',
  Gt = 'gt',
  Gte = 'gte',
  Lt = 'lt',
  Lte = 'lte',
  OutsideRange = 'outside_range',
  WithinRange = 'within_range'
}

export type AlertRuleModel = {
  __typename?: 'AlertRuleModel';
  changeWindowMin?: Maybe<Scalars['Float']['output']>;
  channels: Array<AlertChannelModel>;
  checkIntervalSec: Scalars['Float']['output'];
  cooldownSeconds: Scalars['Float']['output'];
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  lastTriggeredAt?: Maybe<Scalars['DateTime']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  metricProvider: AlertMetricProvider;
  metricSlug: Scalars['String']['output'];
  name: Scalars['String']['output'];
  operator: AlertOperator;
  severity: AlertSeverity;
  status: AlertStatus;
  thresholdLower?: Maybe<Scalars['Float']['output']>;
  thresholdUpper?: Maybe<Scalars['Float']['output']>;
  thresholdValue?: Maybe<Scalars['Float']['output']>;
};

export enum AlertSeverity {
  High = 'high',
  Low = 'low',
  Medium = 'medium'
}

export enum AlertStatus {
  Active = 'active',
  Archived = 'archived',
  Draft = 'draft',
  Paused = 'paused'
}

export type AnalysisResultModel = {
  __typename?: 'AnalysisResultModel';
  createdAt: Scalars['DateTime']['output'];
  error?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  input?: Maybe<Scalars['JSON']['output']>;
  output?: Maybe<Scalars['JSON']['output']>;
  status: AnalysisStatus;
  summary?: Maybe<Scalars['String']['output']>;
  type: AnalysisType;
};

export enum AnalysisStatus {
  Completed = 'completed',
  Failed = 'failed',
  Pending = 'pending',
  Running = 'running'
}

export enum AnalysisType {
  Anomaly = 'anomaly',
  Correlation = 'correlation'
}

export type AnomalyAnalysisInput = {
  deviationPercent: Scalars['Float']['input'];
  metric: Scalars['String']['input'];
  newsList: Array<Scalars['String']['input']>;
  policyList: Array<Scalars['String']['input']>;
  series?: InputMaybe<Array<SeriesPointInput>>;
  timestamp: Scalars['String']['input'];
  value: Scalars['Float']['input'];
};

export type AssignRoleInput = {
  roleId: Scalars['String']['input'];
  userId: Scalars['String']['input'];
};

export type AuditLogRetentionModel = {
  __typename?: 'AuditLogRetentionModel';
  retentionDays: Scalars['Int']['output'];
};

export type AuthCacheSettingsModel = {
  __typename?: 'AuthCacheSettingsModel';
  lockTtlMs: Scalars['Int']['output'];
  maxWaitMs: Scalars['Int']['output'];
  profileTtlSeconds: Scalars['Int']['output'];
  retryDelayMs: Scalars['Int']['output'];
};

export type CorrelationAnalysisInput = {
  changePercent: Scalars['Float']['input'];
  endDate: Scalars['String']['input'];
  indicatorName: Scalars['String']['input'];
  newsSummaries: Array<Scalars['String']['input']>;
  startDate: Scalars['String']['input'];
  value: Scalars['Float']['input'];
};

export type CrawlBrowserCookieInput = {
  domain: Scalars['String']['input'];
  name: Scalars['String']['input'];
  path?: InputMaybe<Scalars['String']['input']>;
  value: Scalars['String']['input'];
};

export type CrawlBrowserHeaderInput = {
  name: Scalars['String']['input'];
  value: Scalars['String']['input'];
};

export type CrawlCleanMarkdownInput = {
  cssSelector?: InputMaybe<Scalars['String']['input']>;
  excludedTags?: InputMaybe<Array<Scalars['String']['input']>>;
  removeOverlayElements?: InputMaybe<Scalars['Boolean']['input']>;
  targetElements?: InputMaybe<Array<Scalars['String']['input']>>;
  wordCountThreshold?: InputMaybe<Scalars['Int']['input']>;
};

export type CrawlClientSettingsModel = {
  __typename?: 'CrawlClientSettingsModel';
  healthCheckTtlMs: Scalars['Int']['output'];
  maxRetries: Scalars['Int']['output'];
  requestTimeoutMs: Scalars['Int']['output'];
  retryBackoffMs: Scalars['Int']['output'];
};

export type CrawlGeolocationInput = {
  accuracy?: InputMaybe<Scalars['Float']['input']>;
  latitude: Scalars['Float']['input'];
  longitude: Scalars['Float']['input'];
};

export type CrawlLinkAnalysisModel = {
  __typename?: 'CrawlLinkAnalysisModel';
  buckets: Array<CrawlLinkBucketModel>;
  lowQualityLinks: Array<CrawlLinkModel>;
  stats: CrawlLinkStatsModel;
  topLinks: Array<CrawlLinkModel>;
};

export type CrawlLinkBucketModel = {
  __typename?: 'CrawlLinkBucketModel';
  kind: Scalars['String']['output'];
  links: Array<CrawlLinkModel>;
};

export type CrawlLinkModel = {
  __typename?: 'CrawlLinkModel';
  baseDomain?: Maybe<Scalars['String']['output']>;
  contextualScore?: Maybe<Scalars['Float']['output']>;
  href: Scalars['String']['output'];
  intrinsicScore?: Maybe<Scalars['Float']['output']>;
  rel?: Maybe<Scalars['String']['output']>;
  text?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  totalScore?: Maybe<Scalars['Float']['output']>;
  type?: Maybe<Scalars['String']['output']>;
};

export type CrawlLinkPreviewInput = {
  concurrency?: InputMaybe<Scalars['Int']['input']>;
  excludePatterns?: InputMaybe<Array<Scalars['String']['input']>>;
  includeExternal?: InputMaybe<Scalars['Boolean']['input']>;
  includeInternal?: InputMaybe<Scalars['Boolean']['input']>;
  includePatterns?: InputMaybe<Array<Scalars['String']['input']>>;
  includeSocial?: InputMaybe<Scalars['Boolean']['input']>;
  maxLinks?: InputMaybe<Scalars['Int']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
  scoreThreshold?: InputMaybe<Scalars['Float']['input']>;
  timeoutSeconds?: InputMaybe<Scalars['Int']['input']>;
  verbose?: InputMaybe<Scalars['Boolean']['input']>;
};

export type CrawlLinkStatsModel = {
  __typename?: 'CrawlLinkStatsModel';
  averageIntrinsicScore?: Maybe<Scalars['Float']['output']>;
  externalLinks: Scalars['Float']['output'];
  highQualityLinks?: Maybe<Scalars['Float']['output']>;
  internalLinks: Scalars['Float']['output'];
  lowQualityLinks?: Maybe<Scalars['Float']['output']>;
  totalLinks: Scalars['Float']['output'];
};

export type CrawlMarkdownFilterInput = {
  minWordThreshold?: InputMaybe<Scalars['Int']['input']>;
  threshold?: InputMaybe<Scalars['Float']['input']>;
  thresholdType?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<Scalars['String']['input']>;
};

export type CrawlMarkdownOptionsInput = {
  bodyWidth?: InputMaybe<Scalars['Int']['input']>;
  contentSource?: InputMaybe<Scalars['String']['input']>;
  escapeHtml?: InputMaybe<Scalars['Boolean']['input']>;
  ignoreLinks?: InputMaybe<Scalars['Boolean']['input']>;
};

export type CrawlMarkdownStrategyInput = {
  params?: InputMaybe<Scalars['JSON']['input']>;
  type: Scalars['String']['input'];
};

export type CrawlMemoryStatsModel = {
  __typename?: 'CrawlMemoryStatsModel';
  efficiencyPercent?: Maybe<Scalars['Float']['output']>;
  peakMemoryMb?: Maybe<Scalars['Float']['output']>;
  serverMemoryMb?: Maybe<Scalars['Float']['output']>;
};

export type CrawlMetadataInput = {
  concurrency?: InputMaybe<Scalars['Int']['input']>;
  domain?: InputMaybe<Scalars['String']['input']>;
  extractJsonLd?: InputMaybe<Scalars['Boolean']['input']>;
  extractOpenGraph?: InputMaybe<Scalars['Boolean']['input']>;
  extractStandardMeta?: InputMaybe<Scalars['Boolean']['input']>;
  maxUrls?: InputMaybe<Scalars['Int']['input']>;
  pattern?: InputMaybe<Scalars['String']['input']>;
  query?: InputMaybe<Scalars['String']['input']>;
  scoreThreshold?: InputMaybe<Scalars['Float']['input']>;
  source?: InputMaybe<Scalars['String']['input']>;
  urls?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type CrawlMetadataResultModel = {
  __typename?: 'CrawlMetadataResultModel';
  author?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  fetchedAt?: Maybe<Scalars['DateTime']['output']>;
  httpStatus?: Maybe<Scalars['Float']['output']>;
  jsonLd: Array<Scalars['String']['output']>;
  keywords?: Maybe<Array<Scalars['String']['output']>>;
  metaTags: Array<CrawlMetadataTagModel>;
  openGraph: Array<CrawlMetadataTagModel>;
  relevanceScore?: Maybe<Scalars['Float']['output']>;
  status: Scalars['String']['output'];
  title?: Maybe<Scalars['String']['output']>;
  url: Scalars['String']['output'];
};

export type CrawlMetadataTagModel = {
  __typename?: 'CrawlMetadataTagModel';
  name: Scalars['String']['output'];
  value: Scalars['String']['output'];
};

export type CrawlMultiUrlStrategyInput = {
  matcher?: InputMaybe<CrawlUrlMatcherInput>;
  name?: InputMaybe<Scalars['String']['input']>;
  options?: InputMaybe<CrawlStrategyOverridesInput>;
  urls?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type CrawlOptionsInput = {
  additionalUrls?: InputMaybe<Array<Scalars['String']['input']>>;
  adjustViewportToContent?: InputMaybe<Scalars['Boolean']['input']>;
  browserCookies?: InputMaybe<Array<CrawlBrowserCookieInput>>;
  browserHeaders?: InputMaybe<Array<CrawlBrowserHeaderInput>>;
  cleanMarkdown?: InputMaybe<CrawlCleanMarkdownInput>;
  enableStealthMode?: InputMaybe<Scalars['Boolean']['input']>;
  enableUndetectedBrowser?: InputMaybe<Scalars['Boolean']['input']>;
  excludeExternalImages?: InputMaybe<Scalars['Boolean']['input']>;
  extractLinks?: InputMaybe<Scalars['Boolean']['input']>;
  geolocation?: InputMaybe<CrawlGeolocationInput>;
  includeImages?: InputMaybe<Scalars['Boolean']['input']>;
  jsCode?: InputMaybe<Array<Scalars['String']['input']>>;
  jsOnly?: InputMaybe<Scalars['Boolean']['input']>;
  linkPreview?: InputMaybe<CrawlLinkPreviewInput>;
  locale?: InputMaybe<Scalars['String']['input']>;
  markdownFilter?: InputMaybe<CrawlMarkdownFilterInput>;
  markdownOptions?: InputMaybe<CrawlMarkdownOptionsInput>;
  markdownStrategy?: InputMaybe<CrawlMarkdownStrategyInput>;
  multiUrlConfigs?: InputMaybe<Array<CrawlMultiUrlStrategyInput>>;
  onlyMainContent?: InputMaybe<Scalars['Boolean']['input']>;
  overrideNavigator?: InputMaybe<Scalars['Boolean']['input']>;
  proxyConfig?: InputMaybe<CrawlProxyConfigInput>;
  proxyUrl?: InputMaybe<Scalars['String']['input']>;
  scanFullPage?: InputMaybe<Scalars['Boolean']['input']>;
  scoreLinks?: InputMaybe<Scalars['Boolean']['input']>;
  scrollDelayMs?: InputMaybe<Scalars['Int']['input']>;
  sessionId?: InputMaybe<Scalars['String']['input']>;
  simulateUser?: InputMaybe<Scalars['Boolean']['input']>;
  storageState?: InputMaybe<Scalars['String']['input']>;
  storeMedia?: InputMaybe<Scalars['Boolean']['input']>;
  tableExtraction?: InputMaybe<CrawlTableExtractionInput>;
  tableScoreThreshold?: InputMaybe<Scalars['Float']['input']>;
  timezoneId?: InputMaybe<Scalars['String']['input']>;
  useManagedBrowser?: InputMaybe<Scalars['Boolean']['input']>;
  userAgent?: InputMaybe<Scalars['String']['input']>;
  userAgentGenerator?: InputMaybe<CrawlUserAgentGeneratorInput>;
  userAgentMode?: InputMaybe<Scalars['String']['input']>;
  userDataDir?: InputMaybe<Scalars['String']['input']>;
  waitForImages?: InputMaybe<Scalars['Boolean']['input']>;
  waitForScript?: InputMaybe<Scalars['String']['input']>;
  waitForSelector?: InputMaybe<Scalars['String']['input']>;
  waitForTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
};

export type CrawlProxyConfigInput = {
  password?: InputMaybe<Scalars['String']['input']>;
  server: Scalars['String']['input'];
  username?: InputMaybe<Scalars['String']['input']>;
};

export type CrawlResultModel = {
  __typename?: 'CrawlResultModel';
  fetchedAt: Scalars['DateTime']['output'];
  fitMarkdown?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  linkAnalysis?: Maybe<CrawlLinkAnalysisModel>;
  markdown: Scalars['String']['output'];
  markdownWithCitations?: Maybe<Scalars['String']['output']>;
  media?: Maybe<Scalars['String']['output']>;
  mediaAssets?: Maybe<Scalars['String']['output']>;
  metadata?: Maybe<Scalars['String']['output']>;
  referencesMarkdown?: Maybe<Scalars['String']['output']>;
  sourceUrl: Scalars['String']['output'];
  tables?: Maybe<Scalars['JSON']['output']>;
};

export type CrawlStrategyOverridesInput = {
  adjustViewportToContent?: InputMaybe<Scalars['Boolean']['input']>;
  cacheMode?: InputMaybe<Scalars['String']['input']>;
  captureScreenshot?: InputMaybe<Scalars['Boolean']['input']>;
  cssSelector?: InputMaybe<Scalars['String']['input']>;
  excludeExternalImages?: InputMaybe<Scalars['Boolean']['input']>;
  excludeExternalLinks?: InputMaybe<Scalars['Boolean']['input']>;
  excludedTags?: InputMaybe<Array<Scalars['String']['input']>>;
  extractLinks?: InputMaybe<Scalars['Boolean']['input']>;
  jsCode?: InputMaybe<Array<Scalars['String']['input']>>;
  jsOnly?: InputMaybe<Scalars['Boolean']['input']>;
  onlyMainContent?: InputMaybe<Scalars['Boolean']['input']>;
  overrideNavigator?: InputMaybe<Scalars['Boolean']['input']>;
  processIframes?: InputMaybe<Scalars['Boolean']['input']>;
  removeOverlayElements?: InputMaybe<Scalars['Boolean']['input']>;
  scanFullPage?: InputMaybe<Scalars['Boolean']['input']>;
  scrollDelayMs?: InputMaybe<Scalars['Int']['input']>;
  simulateUser?: InputMaybe<Scalars['Boolean']['input']>;
  textMode?: InputMaybe<Scalars['Boolean']['input']>;
  waitForImages?: InputMaybe<Scalars['Boolean']['input']>;
  waitForScript?: InputMaybe<Scalars['String']['input']>;
  waitForSelector?: InputMaybe<Scalars['String']['input']>;
  waitForTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  wordCountThreshold?: InputMaybe<Scalars['Int']['input']>;
};

export type CrawlTableExtractionInput = {
  params?: InputMaybe<Scalars['JSON']['input']>;
  type: Scalars['String']['input'];
};

export type CrawlTaskConnection = {
  __typename?: 'CrawlTaskConnection';
  edges: Array<CrawlTaskEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Float']['output'];
};

export type CrawlTaskEdge = {
  __typename?: 'CrawlTaskEdge';
  cursor: Scalars['String']['output'];
  node: CrawlTaskModel;
};

export type CrawlTaskModel = {
  __typename?: 'CrawlTaskModel';
  concurrency: Scalars['Float']['output'];
  config?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  displayName?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  keywords: Array<Scalars['String']['output']>;
  lastCursor?: Maybe<Scalars['String']['output']>;
  lastError?: Maybe<Scalars['String']['output']>;
  lastMemoryEfficiency?: Maybe<Scalars['Float']['output']>;
  lastPeakMemoryMb?: Maybe<Scalars['Float']['output']>;
  lastResultAt?: Maybe<Scalars['DateTime']['output']>;
  lastRunAt?: Maybe<Scalars['DateTime']['output']>;
  lastServerMemoryMb?: Maybe<Scalars['Float']['output']>;
  lastSuccessAt?: Maybe<Scalars['DateTime']['output']>;
  memoryStats?: Maybe<CrawlMemoryStatsModel>;
  resultCount: Scalars['Float']['output'];
  results?: Maybe<Array<CrawlResultModel>>;
  runCount: Scalars['Float']['output'];
  status: CrawlTaskStatus;
  targetUrl: Scalars['String']['output'];
  timeRangeFrom?: Maybe<Scalars['DateTime']['output']>;
  timeRangeTo?: Maybe<Scalars['DateTime']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export enum CrawlTaskStatus {
  Completed = 'completed',
  Failed = 'failed',
  Paused = 'paused',
  Pending = 'pending',
  Queued = 'queued',
  Running = 'running'
}

export type CrawlTimeRangeInput = {
  from?: InputMaybe<Scalars['String']['input']>;
  to?: InputMaybe<Scalars['String']['input']>;
};

export type CrawlUrlMatcherInput = {
  matchMode?: InputMaybe<Scalars['String']['input']>;
  patterns?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type CrawlUserAgentGeneratorInput = {
  browser?: InputMaybe<Scalars['String']['input']>;
  deviceType?: InputMaybe<Scalars['String']['input']>;
  locale?: InputMaybe<Scalars['String']['input']>;
  platform?: InputMaybe<Scalars['String']['input']>;
};

export type CreateCrawlTaskInput = {
  concurrency?: InputMaybe<Scalars['Int']['input']>;
  displayName?: InputMaybe<Scalars['String']['input']>;
  keywords?: InputMaybe<Array<Scalars['String']['input']>>;
  options?: InputMaybe<CrawlOptionsInput>;
  timeRange?: InputMaybe<CrawlTimeRangeInput>;
  url: Scalars['String']['input'];
};

export type CreateItemInput = {
  externalId: Scalars['String']['input'];
  payload: Scalars['String']['input'];
  status?: InputMaybe<Scalars['String']['input']>;
  title: Scalars['String']['input'];
};

export type CreateOrgInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  slug: Scalars['String']['input'];
};

export type DashboardModel = {
  __typename?: 'DashboardModel';
  config?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
  slug: Scalars['String']['output'];
  theme?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  version: Scalars['Int']['output'];
  widgets: Array<DashboardWidgetModel>;
};

export type DashboardWidgetInput = {
  dataConfig?: InputMaybe<Scalars['JSON']['input']>;
  dataSource: Scalars['String']['input'];
  id?: InputMaybe<Scalars['String']['input']>;
  layoutH: Scalars['Int']['input'];
  layoutW: Scalars['Int']['input'];
  layoutX: Scalars['Int']['input'];
  layoutY: Scalars['Int']['input'];
  options?: InputMaybe<Scalars['JSON']['input']>;
  sortOrder?: InputMaybe<Scalars['Int']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
  type: DashboardWidgetType;
};

export type DashboardWidgetModel = {
  __typename?: 'DashboardWidgetModel';
  dataConfig?: Maybe<Scalars['JSON']['output']>;
  dataSource: Scalars['String']['output'];
  id: Scalars['String']['output'];
  layoutH: Scalars['Float']['output'];
  layoutW: Scalars['Float']['output'];
  layoutX: Scalars['Float']['output'];
  layoutY: Scalars['Float']['output'];
  options?: Maybe<Scalars['JSON']['output']>;
  sortOrder: Scalars['Float']['output'];
  title?: Maybe<Scalars['String']['output']>;
  type: DashboardWidgetType;
};

export enum DashboardWidgetType {
  Bar = 'bar',
  Kline = 'kline',
  Line = 'line',
  Pie = 'pie',
  Radar = 'radar',
  Scatter = 'scatter',
  Table = 'table'
}

export type DateRangeInput = {
  end: Scalars['DateTime']['input'];
  start: Scalars['DateTime']['input'];
};

export type EconomicDataFetchConfigModel = {
  __typename?: 'EconomicDataFetchConfigModel';
  frequency: EconomicDataFrequency;
  id: Scalars['String']['output'];
  isEnabled: Scalars['Boolean']['output'];
  item: EconomicDataItemModel;
  lastError?: Maybe<Scalars['String']['output']>;
  lastRunAt?: Maybe<Scalars['DateTime']['output']>;
  lastStatus?: Maybe<EconomicDataRunStatus>;
  repeatCron?: Maybe<Scalars['String']['output']>;
};

export enum EconomicDataFrequency {
  Daily = 'daily',
  Hourly = 'hourly',
  Monthly = 'monthly',
  Realtime = 'realtime',
  Weekly = 'weekly'
}

export type EconomicDataItemModel = {
  __typename?: 'EconomicDataItemModel';
  displayName: Scalars['String']['output'];
  groupLabel?: Maybe<Scalars['String']['output']>;
  slug: Scalars['String']['output'];
};

export type EconomicDataPointModel = {
  __typename?: 'EconomicDataPointModel';
  dataType: EconomicDataValueType;
  item: EconomicDataItemModel;
  sourceField?: Maybe<Scalars['String']['output']>;
  timestamp: Scalars['DateTime']['output'];
  unit?: Maybe<Scalars['String']['output']>;
  value: Scalars['Float']['output'];
};

export enum EconomicDataRunStatus {
  Failed = 'failed',
  Pending = 'pending',
  Running = 'running',
  Success = 'success'
}

export enum EconomicDataValueType {
  Fx = 'fx',
  Index = 'index',
  Percent = 'percent',
  Price = 'price',
  Quantity = 'quantity',
  Spread = 'spread',
  Volume = 'volume',
  Yield = 'yield'
}

export type ItemConnection = {
  __typename?: 'ItemConnection';
  edges: Array<ItemEdge>;
  pageInfo: PageInfo;
  totalCount: Scalars['Int']['output'];
};

export type ItemEdge = {
  __typename?: 'ItemEdge';
  cursor: Scalars['String']['output'];
  node: ItemModel;
};

export type ItemMetaModel = {
  __typename?: 'ItemMetaModel';
  createdAt: Scalars['DateTime']['output'];
  externalId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  mongoRef: Scalars['String']['output'];
  name: Scalars['String']['output'];
  status: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type ItemModel = {
  __typename?: 'ItemModel';
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  meta: ItemMetaModel;
  orgId: Scalars['String']['output'];
  processed?: Maybe<ProcessedItemModelGraph>;
  raw?: Maybe<RawItemModelGraph>;
  status: Scalars['String']['output'];
  title: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type MembershipModel = {
  __typename?: 'MembershipModel';
  id: Scalars['String']['output'];
  orgId: Scalars['String']['output'];
  role: RoleModel;
  roles: Array<RoleModel>;
  user: UserModel;
};

export type Mutation = {
  __typename?: 'Mutation';
  assignRole: MembershipModel;
  createAlertChannel: AlertChannelModel;
  createCrawlTask: CrawlTaskModel;
  createItem: ItemModel;
  createOrg: OrgModel;
  deleteAlertRule: Scalars['Boolean']['output'];
  deleteCrawlTask: Scalars['Boolean']['output'];
  deleteDashboard: Scalars['Boolean']['output'];
  markAllNotificationsRead: Scalars['Boolean']['output'];
  markNotificationRead?: Maybe<NotificationModel>;
  requestAnomalyExplanation: AnalysisResultModel;
  requestCorrelationAnalysis: AnalysisResultModel;
  retryCrawlTask: CrawlTaskModel;
  setOrgActive: OrgModel;
  triggerAlertRule: Scalars['Boolean']['output'];
  triggerDataFetch: Scalars['Boolean']['output'];
  updateAuditLogRetention: AuditLogRetentionModel;
  updateAuthCacheSettings: AuthCacheSettingsModel;
  updateCrawlClientSettings: CrawlClientSettingsModel;
  updateEconomicDataFetchConfig: EconomicDataFetchConfigModel;
  updateItem: ItemModel;
  updateNewsPromptConfig: NewsPromptConfigModel;
  updateOrg: OrgModel;
  updateRateLimitSettings: RateLimitSettingsModel;
  updateRole: RoleModel;
  upsertAlertRule: AlertRuleModel;
  upsertDashboard: DashboardModel;
};


export type MutationAssignRoleArgs = {
  input: AssignRoleInput;
};


export type MutationCreateAlertChannelArgs = {
  input: AlertChannelInput;
};


export type MutationCreateCrawlTaskArgs = {
  input: CreateCrawlTaskInput;
};


export type MutationCreateItemArgs = {
  input: CreateItemInput;
};


export type MutationCreateOrgArgs = {
  input: CreateOrgInput;
};


export type MutationDeleteAlertRuleArgs = {
  ruleId: Scalars['String']['input'];
};


export type MutationDeleteCrawlTaskArgs = {
  id: Scalars['String']['input'];
};


export type MutationDeleteDashboardArgs = {
  id: Scalars['String']['input'];
};


export type MutationMarkNotificationReadArgs = {
  id: Scalars['String']['input'];
};


export type MutationRequestAnomalyExplanationArgs = {
  input: AnomalyAnalysisInput;
};


export type MutationRequestCorrelationAnalysisArgs = {
  input: CorrelationAnalysisInput;
};


export type MutationRetryCrawlTaskArgs = {
  id: Scalars['String']['input'];
};


export type MutationSetOrgActiveArgs = {
  input: SetOrgActiveInput;
};


export type MutationTriggerAlertRuleArgs = {
  ruleId: Scalars['String']['input'];
};


export type MutationTriggerDataFetchArgs = {
  input: TriggerDataFetchInput;
};


export type MutationUpdateAuditLogRetentionArgs = {
  input: UpdateAuditLogRetentionInput;
};


export type MutationUpdateAuthCacheSettingsArgs = {
  input: UpdateAuthCacheSettingsInput;
};


export type MutationUpdateCrawlClientSettingsArgs = {
  input: UpdateCrawlClientSettingsInput;
};


export type MutationUpdateEconomicDataFetchConfigArgs = {
  frequency?: InputMaybe<EconomicDataFrequency>;
  isEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  repeatCron?: InputMaybe<Scalars['String']['input']>;
  slug: Scalars['String']['input'];
};


export type MutationUpdateItemArgs = {
  input: UpdateItemInput;
};


export type MutationUpdateNewsPromptConfigArgs = {
  input: UpdateNewsPromptConfigInput;
};


export type MutationUpdateOrgArgs = {
  input: UpdateOrgInput;
};


export type MutationUpdateRateLimitSettingsArgs = {
  input: UpdateRateLimitSettingsInput;
};


export type MutationUpdateRoleArgs = {
  input: UpdateRoleInput;
};


export type MutationUpsertAlertRuleArgs = {
  input: UpsertAlertRuleInput;
};


export type MutationUpsertDashboardArgs = {
  input: UpsertDashboardInput;
};

export type NewsPromptConfigModel = {
  __typename?: 'NewsPromptConfigModel';
  systemPromptTemplate: Scalars['String']['output'];
  userPromptTemplate: Scalars['String']['output'];
  version: Scalars['String']['output'];
};

export type NotificationModel = {
  __typename?: 'NotificationModel';
  body?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  data?: Maybe<Scalars['JSON']['output']>;
  id: Scalars['String']['output'];
  readAt?: Maybe<Scalars['DateTime']['output']>;
  title: Scalars['String']['output'];
  type: NotificationType;
};

export enum NotificationType {
  AlertTriggered = 'alert_triggered',
  AnalysisCompleted = 'analysis_completed',
  AnalysisFailed = 'analysis_failed',
  CrawlCompleted = 'crawl_completed',
  CrawlFailed = 'crawl_failed',
  OrgInvite = 'org_invite',
  System = 'system'
}

export type OrgModel = {
  __typename?: 'OrgModel';
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  slug: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type PageInfo = {
  __typename?: 'PageInfo';
  endCursor?: Maybe<Scalars['String']['output']>;
  hasNextPage: Scalars['Boolean']['output'];
};

export type PermissionModel = {
  __typename?: 'PermissionModel';
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

export type ProcessedItemModelGraph = {
  __typename?: 'ProcessedItemModelGraph';
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  itemMetaId: Scalars['String']['output'];
  result?: Maybe<Scalars['String']['output']>;
  status: Scalars['String']['output'];
  tags: Array<Scalars['String']['output']>;
};

export type Query = {
  __typename?: 'Query';
  alertChannels: Array<AlertChannelModel>;
  alertEvents: Array<AlertEventModel>;
  alertRules: Array<AlertRuleModel>;
  analysisResults: Array<AnalysisResultModel>;
  auditLogRetention: AuditLogRetentionModel;
  authCacheSettings: AuthCacheSettingsModel;
  crawlClientSettings: CrawlClientSettingsModel;
  crawlMetadata: Array<CrawlMetadataResultModel>;
  crawlTask?: Maybe<CrawlTaskModel>;
  crawlTasks: CrawlTaskConnection;
  dashboards: Array<DashboardModel>;
  economicDataFetchConfigs: Array<EconomicDataFetchConfigModel>;
  getEconomicData: Array<EconomicDataPointModel>;
  item?: Maybe<ItemModel>;
  items: ItemConnection;
  me: UserModel;
  memberships: Array<MembershipModel>;
  myOrganizations: Array<OrgModel>;
  newsPromptConfig: NewsPromptConfigModel;
  notifications: Array<NotificationModel>;
  permissions: Array<PermissionModel>;
  queueStats: QueueStatsModel;
  rateLimitSettings: RateLimitSettingsModel;
  roles: Array<RoleModel>;
  unreadNotificationCount: Scalars['Int']['output'];
  users: Array<UserModel>;
};


export type QueryAlertEventsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryAnalysisResultsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryCrawlMetadataArgs = {
  input: CrawlMetadataInput;
};


export type QueryCrawlTaskArgs = {
  id: Scalars['ID']['input'];
  resultLimit?: InputMaybe<Scalars['Int']['input']>;
  resultSearch?: InputMaybe<Scalars['String']['input']>;
};


export type QueryCrawlTasksArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  first?: Scalars['Int']['input'];
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<CrawlTaskStatus>;
};


export type QueryGetEconomicDataArgs = {
  category: Scalars['String']['input'];
  granularity?: InputMaybe<TimeGranularity>;
  timeRange: DateRangeInput;
};


export type QueryItemArgs = {
  id: Scalars['String']['input'];
};


export type QueryItemsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  first?: Scalars['Int']['input'];
  search?: InputMaybe<Scalars['String']['input']>;
};


export type QueryNotificationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryRolesArgs = {
  includeSystem?: InputMaybe<Scalars['Boolean']['input']>;
};


export type QueryUsersArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
};

export type QueueCountsModel = {
  __typename?: 'QueueCountsModel';
  active: Scalars['Int']['output'];
  completed: Scalars['Int']['output'];
  delayed: Scalars['Int']['output'];
  failed: Scalars['Int']['output'];
  waiting: Scalars['Int']['output'];
};

export type QueueEventModel = {
  __typename?: 'QueueEventModel';
  data?: Maybe<Scalars['String']['output']>;
  event: Scalars['String']['output'];
  jobId: Scalars['String']['output'];
  timestamp: Scalars['String']['output'];
};

export type QueueStatsModel = {
  __typename?: 'QueueStatsModel';
  counts: QueueCountsModel;
  itemCount: Scalars['Int']['output'];
  processedCount: Scalars['Int']['output'];
  recentLogs: Array<QueueEventModel>;
};

export type RateLimitBucketInput = {
  limit: Scalars['Int']['input'];
  windowSeconds: Scalars['Int']['input'];
};

export type RateLimitBucketModel = {
  __typename?: 'RateLimitBucketModel';
  limit: Scalars['Int']['output'];
  windowSeconds: Scalars['Int']['output'];
};

export type RateLimitSettingsModel = {
  __typename?: 'RateLimitSettingsModel';
  crawlCreate: RateLimitBucketModel;
  login: RateLimitBucketModel;
  rbacWrite: RateLimitBucketModel;
};

export type RawItemModelGraph = {
  __typename?: 'RawItemModelGraph';
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  itemMetaId: Scalars['String']['output'];
  /** Raw payload JSON string */
  payload: Scalars['String']['output'];
  source?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type RoleModel = {
  __typename?: 'RoleModel';
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  isSystem: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  permissions: Array<PermissionModel>;
};

export type SeriesPointInput = {
  timestamp: Scalars['String']['input'];
  value: Scalars['Float']['input'];
};

export type SetOrgActiveInput = {
  id: Scalars['String']['input'];
  isActive: Scalars['Boolean']['input'];
};

export type Subscription = {
  __typename?: 'Subscription';
  alertEvents: AlertEventModel;
  analysisEvents: AnalysisResultModel;
  queueEvents: QueueEventModel;
};

export enum TimeGranularity {
  Day = 'day',
  Month = 'month',
  Quarter = 'quarter',
  Week = 'week',
  Year = 'year'
}

export type TriggerDataFetchInput = {
  slugs: Array<Scalars['String']['input']>;
};

export type UpdateAuditLogRetentionInput = {
  retentionDays: Scalars['Int']['input'];
};

export type UpdateAuthCacheSettingsInput = {
  lockTtlMs: Scalars['Int']['input'];
  maxWaitMs: Scalars['Int']['input'];
  profileTtlSeconds: Scalars['Int']['input'];
  retryDelayMs: Scalars['Int']['input'];
};

export type UpdateCrawlClientSettingsInput = {
  healthCheckTtlMs: Scalars['Int']['input'];
  maxRetries: Scalars['Int']['input'];
  requestTimeoutMs: Scalars['Int']['input'];
  retryBackoffMs: Scalars['Int']['input'];
};

export type UpdateItemInput = {
  id: Scalars['String']['input'];
  payload?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateNewsPromptConfigInput = {
  systemPromptTemplate: Scalars['String']['input'];
  userPromptTemplate: Scalars['String']['input'];
  version: Scalars['String']['input'];
};

export type UpdateOrgInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['String']['input'];
  name?: InputMaybe<Scalars['String']['input']>;
  slug?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateRateLimitSettingsInput = {
  crawlCreate: RateLimitBucketInput;
  login: RateLimitBucketInput;
  rbacWrite: RateLimitBucketInput;
};

export type UpdateRoleInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['String']['input'];
  permissions: Array<Scalars['String']['input']>;
};

export type UpsertAlertRuleInput = {
  changeWindowMin?: InputMaybe<Scalars['Int']['input']>;
  channelIds?: InputMaybe<Array<Scalars['String']['input']>>;
  checkIntervalSec?: InputMaybe<Scalars['Int']['input']>;
  cooldownSeconds?: InputMaybe<Scalars['Int']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  id?: InputMaybe<Scalars['String']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  metricProvider?: InputMaybe<AlertMetricProvider>;
  metricSlug: Scalars['String']['input'];
  name: Scalars['String']['input'];
  operator: AlertOperator;
  severity?: InputMaybe<AlertSeverity>;
  status?: InputMaybe<AlertStatus>;
  thresholdLower?: InputMaybe<Scalars['Float']['input']>;
  thresholdUpper?: InputMaybe<Scalars['Float']['input']>;
  thresholdValue?: InputMaybe<Scalars['Float']['input']>;
};

export type UpsertDashboardInput = {
  config?: InputMaybe<Scalars['JSON']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  id?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  slug: Scalars['String']['input'];
  theme?: InputMaybe<Scalars['String']['input']>;
  version?: InputMaybe<Scalars['Int']['input']>;
  widgets: Array<DashboardWidgetInput>;
};

export type UserModel = {
  __typename?: 'UserModel';
  email: Scalars['String']['output'];
  firstName: Scalars['String']['output'];
  id: Scalars['String']['output'];
  lastName: Scalars['String']['output'];
  orgId: Scalars['String']['output'];
  permissions: Array<Scalars['String']['output']>;
  roleIds: Array<Scalars['String']['output']>;
};

export type AlertRulesQueryVariables = Exact<{ [key: string]: never; }>;


export type AlertRulesQuery = { __typename?: 'Query', alertRules: Array<{ __typename?: 'AlertRuleModel', id: string, name: string, description?: string | null, severity: AlertSeverity, status: AlertStatus, metricProvider: AlertMetricProvider, metricSlug: string, operator: AlertOperator, thresholdValue?: number | null, thresholdLower?: number | null, thresholdUpper?: number | null, changeWindowMin?: number | null, cooldownSeconds: number, checkIntervalSec: number, lastTriggeredAt?: any | null, metadata?: any | null, channels: Array<{ __typename?: 'AlertChannelModel', id: string, name: string, type: AlertChannelType, target: string }> }> };

export type AlertChannelsQueryVariables = Exact<{ [key: string]: never; }>;


export type AlertChannelsQuery = { __typename?: 'Query', alertChannels: Array<{ __typename?: 'AlertChannelModel', id: string, name: string, type: AlertChannelType, target: string }> };

export type AlertEventsQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
}>;


export type AlertEventsQuery = { __typename?: 'Query', alertEvents: Array<{ __typename?: 'AlertEventModel', id: string, triggeredAt: any, metricValue: number, changePercent?: number | null, severity: AlertSeverity, status: AlertEventStatus, message?: string | null, deliveries: Array<{ __typename?: 'AlertDeliveryModel', id: string, status: AlertDeliveryStatus, channelType: AlertChannelType, sentAt?: any | null, error?: string | null }> }> };

export type UpsertAlertRuleMutationVariables = Exact<{
  input: UpsertAlertRuleInput;
}>;


export type UpsertAlertRuleMutation = { __typename?: 'Mutation', upsertAlertRule: { __typename?: 'AlertRuleModel', id: string, name: string } };

export type CreateAlertChannelMutationVariables = Exact<{
  input: AlertChannelInput;
}>;


export type CreateAlertChannelMutation = { __typename?: 'Mutation', createAlertChannel: { __typename?: 'AlertChannelModel', id: string, name: string, type: AlertChannelType, target: string } };

export type TriggerAlertRuleMutationVariables = Exact<{
  ruleId: Scalars['String']['input'];
}>;


export type TriggerAlertRuleMutation = { __typename?: 'Mutation', triggerAlertRule: boolean };

export type AlertEventsStreamSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type AlertEventsStreamSubscription = { __typename?: 'Subscription', alertEvents: { __typename?: 'AlertEventModel', id: string, triggeredAt: any, severity: AlertSeverity, message?: string | null, metricValue: number } };

export type AnalysisResultsQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
}>;


export type AnalysisResultsQuery = { __typename?: 'Query', analysisResults: Array<{ __typename?: 'AnalysisResultModel', id: string, type: AnalysisType, status: AnalysisStatus, summary?: string | null, createdAt: any }> };

export type AnalysisEventsSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type AnalysisEventsSubscription = { __typename?: 'Subscription', analysisEvents: { __typename?: 'AnalysisResultModel', id: string, type: AnalysisType, status: AnalysisStatus, summary?: string | null, createdAt: any } };

export type RequestCorrelationMutationVariables = Exact<{
  input: CorrelationAnalysisInput;
}>;


export type RequestCorrelationMutation = { __typename?: 'Mutation', requestCorrelationAnalysis: { __typename?: 'AnalysisResultModel', id: string, status: AnalysisStatus, type: AnalysisType } };

export type RequestAnomalyMutationVariables = Exact<{
  input: AnomalyAnalysisInput;
}>;


export type RequestAnomalyMutation = { __typename?: 'Mutation', requestAnomalyExplanation: { __typename?: 'AnalysisResultModel', id: string, status: AnalysisStatus, type: AnalysisType } };

export type CrawlTasksQueryVariables = Exact<{
  first: Scalars['Int']['input'];
  after?: InputMaybe<Scalars['String']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<CrawlTaskStatus>;
}>;


export type CrawlTasksQuery = { __typename?: 'Query', crawlTasks: { __typename?: 'CrawlTaskConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'CrawlTaskEdge', cursor: string, node: { __typename?: 'CrawlTaskModel', id: string, displayName?: string | null, targetUrl: string, status: CrawlTaskStatus, concurrency: number, runCount: number, resultCount: number, lastRunAt?: any | null, lastSuccessAt?: any | null, lastError?: string | null, createdAt: any, lastPeakMemoryMb?: number | null, lastMemoryEfficiency?: number | null } }> } };

export type CrawlTaskQueryVariables = Exact<{
  id: Scalars['ID']['input'];
  resultLimit?: InputMaybe<Scalars['Int']['input']>;
  resultSearch?: InputMaybe<Scalars['String']['input']>;
}>;


export type CrawlTaskQuery = { __typename?: 'Query', crawlTask?: { __typename?: 'CrawlTaskModel', id: string, displayName?: string | null, targetUrl: string, status: CrawlTaskStatus, keywords: Array<string>, concurrency: number, runCount: number, lastRunAt?: any | null, lastSuccessAt?: any | null, lastResultAt?: any | null, lastError?: string | null, config?: string | null, lastServerMemoryMb?: number | null, lastPeakMemoryMb?: number | null, lastMemoryEfficiency?: number | null, results?: Array<{ __typename?: 'CrawlResultModel', id: string, sourceUrl: string, fetchedAt: any, markdown: string, markdownWithCitations?: string | null, referencesMarkdown?: string | null, fitMarkdown?: string | null, metadata?: string | null, media?: string | null, mediaAssets?: string | null, tables?: any | null, linkAnalysis?: { __typename?: 'CrawlLinkAnalysisModel', stats: { __typename?: 'CrawlLinkStatsModel', totalLinks: number, internalLinks: number, externalLinks: number, averageIntrinsicScore?: number | null, highQualityLinks?: number | null, lowQualityLinks?: number | null }, topLinks: Array<{ __typename?: 'CrawlLinkModel', href: string, text?: string | null, title?: string | null, baseDomain?: string | null, type?: string | null, intrinsicScore?: number | null, contextualScore?: number | null, totalScore?: number | null }>, lowQualityLinks: Array<{ __typename?: 'CrawlLinkModel', href: string, text?: string | null, title?: string | null, intrinsicScore?: number | null, baseDomain?: string | null }>, buckets: Array<{ __typename?: 'CrawlLinkBucketModel', kind: string, links: Array<{ __typename?: 'CrawlLinkModel', href: string, text?: string | null, title?: string | null, baseDomain?: string | null, type?: string | null, intrinsicScore?: number | null, contextualScore?: number | null, totalScore?: number | null }> }> } | null }> | null, memoryStats?: { __typename?: 'CrawlMemoryStatsModel', serverMemoryMb?: number | null, peakMemoryMb?: number | null, efficiencyPercent?: number | null } | null } | null };

export type CreateCrawlTaskMutationVariables = Exact<{
  input: CreateCrawlTaskInput;
}>;


export type CreateCrawlTaskMutation = { __typename?: 'Mutation', createCrawlTask: { __typename?: 'CrawlTaskModel', id: string, displayName?: string | null, targetUrl: string, status: CrawlTaskStatus, concurrency: number, runCount: number, resultCount: number, lastRunAt?: any | null, lastSuccessAt?: any | null, lastError?: string | null, createdAt: any } };

export type RetryCrawlTaskMutationVariables = Exact<{
  id: Scalars['String']['input'];
}>;


export type RetryCrawlTaskMutation = { __typename?: 'Mutation', retryCrawlTask: { __typename?: 'CrawlTaskModel', id: string, status: CrawlTaskStatus, lastRunAt?: any | null, lastError?: string | null, runCount: number } };

export type CrawlMetadataQueryVariables = Exact<{
  input: CrawlMetadataInput;
}>;


export type CrawlMetadataQuery = { __typename?: 'Query', crawlMetadata: Array<{ __typename?: 'CrawlMetadataResultModel', url: string, status: string, httpStatus?: number | null, fetchedAt?: any | null, title?: string | null, description?: string | null, keywords?: Array<string> | null, author?: string | null, relevanceScore?: number | null, error?: string | null, jsonLd: Array<string>, metaTags: Array<{ __typename?: 'CrawlMetadataTagModel', name: string, value: string }>, openGraph: Array<{ __typename?: 'CrawlMetadataTagModel', name: string, value: string }> }> };

export type DashboardHeroMetricsQueryVariables = Exact<{
  start: Scalars['DateTime']['input'];
  end: Scalars['DateTime']['input'];
}>;


export type DashboardHeroMetricsQuery = { __typename?: 'Query', conflict: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, value: number, unit?: string | null, item: { __typename?: 'EconomicDataItemModel', displayName: string } }>, market: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, value: number, unit?: string | null, item: { __typename?: 'EconomicDataItemModel', displayName: string } }>, resource: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, value: number, unit?: string | null, item: { __typename?: 'EconomicDataItemModel', displayName: string } }>, supply: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, value: number, unit?: string | null, item: { __typename?: 'EconomicDataItemModel', displayName: string } }> };

export type MetricDrillDownDetailsQueryVariables = Exact<{
  category: Scalars['String']['input'];
  start: Scalars['DateTime']['input'];
  end: Scalars['DateTime']['input'];
}>;


export type MetricDrillDownDetailsQuery = { __typename?: 'Query', history: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, value: number, unit?: string | null, item: { __typename?: 'EconomicDataItemModel', displayName: string } }>, relatedAlerts: Array<{ __typename?: 'AlertEventModel', id: string, severity: AlertSeverity, message?: string | null, triggeredAt: any, status: AlertEventStatus, metricValue: number, context?: any | null }> };

export type DashboardsQueryVariables = Exact<{ [key: string]: never; }>;


export type DashboardsQuery = { __typename?: 'Query', dashboards: Array<{ __typename?: 'DashboardModel', id: string, version: number, name: string, slug: string, description?: string | null, theme?: string | null, config?: any | null, widgets: Array<{ __typename?: 'DashboardWidgetModel', id: string, title?: string | null, type: DashboardWidgetType, dataSource: string, dataConfig?: any | null, layoutX: number, layoutY: number, layoutW: number, layoutH: number, sortOrder: number, options?: any | null }> }> };

export type UpsertDashboardMutationVariables = Exact<{
  input: UpsertDashboardInput;
}>;


export type UpsertDashboardMutation = { __typename?: 'Mutation', upsertDashboard: { __typename?: 'DashboardModel', id: string, name: string, slug: string } };

export type DeleteDashboardMutationVariables = Exact<{
  id: Scalars['String']['input'];
}>;


export type DeleteDashboardMutation = { __typename?: 'Mutation', deleteDashboard: boolean };

export type EconomicDataQueryVariables = Exact<{
  category: Scalars['String']['input'];
  timeRange: DateRangeInput;
  granularity?: InputMaybe<TimeGranularity>;
}>;


export type EconomicDataQuery = { __typename?: 'Query', getEconomicData: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, value: number, unit?: string | null, sourceField?: string | null, dataType: EconomicDataValueType, item: { __typename?: 'EconomicDataItemModel', slug: string, displayName: string } }> };

export type EconomicFetchConfigsQueryVariables = Exact<{ [key: string]: never; }>;


export type EconomicFetchConfigsQuery = { __typename?: 'Query', economicDataFetchConfigs: Array<{ __typename?: 'EconomicDataFetchConfigModel', id: string, frequency: EconomicDataFrequency, repeatCron?: string | null, isEnabled: boolean, lastRunAt?: any | null, lastStatus?: EconomicDataRunStatus | null, lastError?: string | null, item: { __typename?: 'EconomicDataItemModel', slug: string, displayName: string } }> };

export type UpdateEconomicFetchConfigMutationVariables = Exact<{
  slug: Scalars['String']['input'];
  frequency?: InputMaybe<EconomicDataFrequency>;
  repeatCron?: InputMaybe<Scalars['String']['input']>;
  isEnabled?: InputMaybe<Scalars['Boolean']['input']>;
}>;


export type UpdateEconomicFetchConfigMutation = { __typename?: 'Mutation', updateEconomicDataFetchConfig: { __typename?: 'EconomicDataFetchConfigModel', id: string, frequency: EconomicDataFrequency, repeatCron?: string | null, isEnabled: boolean, lastRunAt?: any | null, lastStatus?: EconomicDataRunStatus | null, lastError?: string | null, item: { __typename?: 'EconomicDataItemModel', slug: string, displayName: string } } };

export type TriggerEconomicDataFetchMutationVariables = Exact<{
  slugs: Array<Scalars['String']['input']> | Scalars['String']['input'];
}>;


export type TriggerEconomicDataFetchMutation = { __typename?: 'Mutation', triggerDataFetch: boolean };

export type ItemsQueryVariables = Exact<{
  first: Scalars['Int']['input'];
  after?: InputMaybe<Scalars['String']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
}>;


export type ItemsQuery = { __typename?: 'Query', items: { __typename?: 'ItemConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'ItemEdge', cursor: string, node: { __typename?: 'ItemModel', id: string, title: string, status: string, createdAt: any } }> } };

export type MeQueryVariables = Exact<{ [key: string]: never; }>;


export type MeQuery = { __typename?: 'Query', me: { __typename?: 'UserModel', id: string, email: string, firstName: string, lastName: string, orgId: string, permissions: Array<string> } };

export type NotificationsQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
}>;


export type NotificationsQuery = { __typename?: 'Query', notifications: Array<{ __typename?: 'NotificationModel', id: string, type: NotificationType, title: string, body?: string | null, data?: any | null, createdAt: any, readAt?: any | null }> };

export type UnreadNotificationCountQueryVariables = Exact<{ [key: string]: never; }>;


export type UnreadNotificationCountQuery = { __typename?: 'Query', unreadNotificationCount: number };

export type MarkNotificationReadMutationVariables = Exact<{
  id: Scalars['String']['input'];
}>;


export type MarkNotificationReadMutation = { __typename?: 'Mutation', markNotificationRead?: { __typename?: 'NotificationModel', id: string, readAt?: any | null } | null };

export type MarkAllNotificationsReadMutationVariables = Exact<{ [key: string]: never; }>;


export type MarkAllNotificationsReadMutation = { __typename?: 'Mutation', markAllNotificationsRead: boolean };

export type MyOrganizationsQueryVariables = Exact<{ [key: string]: never; }>;


export type MyOrganizationsQuery = { __typename?: 'Query', myOrganizations: Array<{ __typename?: 'OrgModel', id: string, name: string, slug: string, description?: string | null, isActive: boolean, createdAt: any, updatedAt: any }> };

export type CreateOrgMutationVariables = Exact<{
  input: CreateOrgInput;
}>;


export type CreateOrgMutation = { __typename?: 'Mutation', createOrg: { __typename?: 'OrgModel', id: string, name: string, slug: string, description?: string | null, isActive: boolean, createdAt: any, updatedAt: any } };

export type UpdateOrgMutationVariables = Exact<{
  input: UpdateOrgInput;
}>;


export type UpdateOrgMutation = { __typename?: 'Mutation', updateOrg: { __typename?: 'OrgModel', id: string, name: string, slug: string, description?: string | null, isActive: boolean, createdAt: any, updatedAt: any } };

export type SetOrgActiveMutationVariables = Exact<{
  input: SetOrgActiveInput;
}>;


export type SetOrgActiveMutation = { __typename?: 'Mutation', setOrgActive: { __typename?: 'OrgModel', id: string, name: string, slug: string, description?: string | null, isActive: boolean, createdAt: any, updatedAt: any } };

export type QueueStatsQueryVariables = Exact<{ [key: string]: never; }>;


export type QueueStatsQuery = { __typename?: 'Query', queueStats: { __typename?: 'QueueStatsModel', processedCount: number, itemCount: number, counts: { __typename?: 'QueueCountsModel', waiting: number, active: number, completed: number, failed: number, delayed: number }, recentLogs: Array<{ __typename?: 'QueueEventModel', event: string, jobId: string, data?: string | null, timestamp: string }> } };

export type RbacOverviewQueryVariables = Exact<{ [key: string]: never; }>;


export type RbacOverviewQuery = { __typename?: 'Query', roles: Array<{ __typename?: 'RoleModel', id: string, name: string, description?: string | null, isSystem: boolean, permissions: Array<{ __typename?: 'PermissionModel', id: string, name: string, description?: string | null }> }>, permissions: Array<{ __typename?: 'PermissionModel', id: string, name: string, description?: string | null }>, memberships: Array<{ __typename?: 'MembershipModel', id: string, orgId: string, role: { __typename?: 'RoleModel', id: string, name: string, isSystem: boolean }, user: { __typename?: 'UserModel', id: string, email: string, firstName: string, lastName: string } }> };

export type AssignRoleMutationVariables = Exact<{
  input: AssignRoleInput;
}>;


export type AssignRoleMutation = { __typename?: 'Mutation', assignRole: { __typename?: 'MembershipModel', id: string, orgId: string, role: { __typename?: 'RoleModel', id: string, name: string, isSystem: boolean }, user: { __typename?: 'UserModel', id: string, email: string, firstName: string, lastName: string } } };

export type UpdateRoleMutationVariables = Exact<{
  input: UpdateRoleInput;
}>;


export type UpdateRoleMutation = { __typename?: 'Mutation', updateRole: { __typename?: 'RoleModel', id: string, name: string, description?: string | null, isSystem: boolean, permissions: Array<{ __typename?: 'PermissionModel', id: string, name: string, description?: string | null }> } };

export type RateLimitSettingsQueryVariables = Exact<{ [key: string]: never; }>;


export type RateLimitSettingsQuery = { __typename?: 'Query', rateLimitSettings: { __typename?: 'RateLimitSettingsModel', login: { __typename?: 'RateLimitBucketModel', limit: number, windowSeconds: number }, crawlCreate: { __typename?: 'RateLimitBucketModel', limit: number, windowSeconds: number }, rbacWrite: { __typename?: 'RateLimitBucketModel', limit: number, windowSeconds: number } } };

export type UpdateRateLimitSettingsMutationVariables = Exact<{
  input: UpdateRateLimitSettingsInput;
}>;


export type UpdateRateLimitSettingsMutation = { __typename?: 'Mutation', updateRateLimitSettings: { __typename?: 'RateLimitSettingsModel', login: { __typename?: 'RateLimitBucketModel', limit: number, windowSeconds: number }, crawlCreate: { __typename?: 'RateLimitBucketModel', limit: number, windowSeconds: number }, rbacWrite: { __typename?: 'RateLimitBucketModel', limit: number, windowSeconds: number } } };

export type AuthCacheSettingsQueryVariables = Exact<{ [key: string]: never; }>;


export type AuthCacheSettingsQuery = { __typename?: 'Query', authCacheSettings: { __typename?: 'AuthCacheSettingsModel', profileTtlSeconds: number, lockTtlMs: number, maxWaitMs: number, retryDelayMs: number } };

export type UpdateAuthCacheSettingsMutationVariables = Exact<{
  input: UpdateAuthCacheSettingsInput;
}>;


export type UpdateAuthCacheSettingsMutation = { __typename?: 'Mutation', updateAuthCacheSettings: { __typename?: 'AuthCacheSettingsModel', profileTtlSeconds: number, lockTtlMs: number, maxWaitMs: number, retryDelayMs: number } };

export type AuditLogRetentionQueryVariables = Exact<{ [key: string]: never; }>;


export type AuditLogRetentionQuery = { __typename?: 'Query', auditLogRetention: { __typename?: 'AuditLogRetentionModel', retentionDays: number } };

export type UpdateAuditLogRetentionMutationVariables = Exact<{
  input: UpdateAuditLogRetentionInput;
}>;


export type UpdateAuditLogRetentionMutation = { __typename?: 'Mutation', updateAuditLogRetention: { __typename?: 'AuditLogRetentionModel', retentionDays: number } };

export type NewsPromptConfigQueryVariables = Exact<{ [key: string]: never; }>;


export type NewsPromptConfigQuery = { __typename?: 'Query', newsPromptConfig: { __typename?: 'NewsPromptConfigModel', version: string, systemPromptTemplate: string, userPromptTemplate: string } };

export type UpdateNewsPromptConfigMutationVariables = Exact<{
  input: UpdateNewsPromptConfigInput;
}>;


export type UpdateNewsPromptConfigMutation = { __typename?: 'Mutation', updateNewsPromptConfig: { __typename?: 'NewsPromptConfigModel', version: string, systemPromptTemplate: string, userPromptTemplate: string } };

export type CrawlClientSettingsQueryVariables = Exact<{ [key: string]: never; }>;


export type CrawlClientSettingsQuery = { __typename?: 'Query', crawlClientSettings: { __typename?: 'CrawlClientSettingsModel', healthCheckTtlMs: number, requestTimeoutMs: number, maxRetries: number, retryBackoffMs: number } };

export type UpdateCrawlClientSettingsMutationVariables = Exact<{
  input: UpdateCrawlClientSettingsInput;
}>;


export type UpdateCrawlClientSettingsMutation = { __typename?: 'Mutation', updateCrawlClientSettings: { __typename?: 'CrawlClientSettingsModel', healthCheckTtlMs: number, requestTimeoutMs: number, maxRetries: number, retryBackoffMs: number } };


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

/**
 * __useAlertRulesQuery__
 *
 * To run a query within a React component, call `useAlertRulesQuery` and pass it any options that fit your needs.
 * When your component renders, `useAlertRulesQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAlertRulesQuery({
 *   variables: {
 *   },
 * });
 */
export function useAlertRulesQuery(baseOptions?: Apollo.QueryHookOptions<AlertRulesQuery, AlertRulesQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<AlertRulesQuery, AlertRulesQueryVariables>(AlertRulesDocument, options);
      }
export function useAlertRulesLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<AlertRulesQuery, AlertRulesQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<AlertRulesQuery, AlertRulesQueryVariables>(AlertRulesDocument, options);
        }
export function useAlertRulesSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<AlertRulesQuery, AlertRulesQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<AlertRulesQuery, AlertRulesQueryVariables>(AlertRulesDocument, options);
        }
export type AlertRulesQueryHookResult = ReturnType<typeof useAlertRulesQuery>;
export type AlertRulesLazyQueryHookResult = ReturnType<typeof useAlertRulesLazyQuery>;
export type AlertRulesSuspenseQueryHookResult = ReturnType<typeof useAlertRulesSuspenseQuery>;
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

/**
 * __useAlertChannelsQuery__
 *
 * To run a query within a React component, call `useAlertChannelsQuery` and pass it any options that fit your needs.
 * When your component renders, `useAlertChannelsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAlertChannelsQuery({
 *   variables: {
 *   },
 * });
 */
export function useAlertChannelsQuery(baseOptions?: Apollo.QueryHookOptions<AlertChannelsQuery, AlertChannelsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<AlertChannelsQuery, AlertChannelsQueryVariables>(AlertChannelsDocument, options);
      }
export function useAlertChannelsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<AlertChannelsQuery, AlertChannelsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<AlertChannelsQuery, AlertChannelsQueryVariables>(AlertChannelsDocument, options);
        }
export function useAlertChannelsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<AlertChannelsQuery, AlertChannelsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<AlertChannelsQuery, AlertChannelsQueryVariables>(AlertChannelsDocument, options);
        }
export type AlertChannelsQueryHookResult = ReturnType<typeof useAlertChannelsQuery>;
export type AlertChannelsLazyQueryHookResult = ReturnType<typeof useAlertChannelsLazyQuery>;
export type AlertChannelsSuspenseQueryHookResult = ReturnType<typeof useAlertChannelsSuspenseQuery>;
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

/**
 * __useAlertEventsQuery__
 *
 * To run a query within a React component, call `useAlertEventsQuery` and pass it any options that fit your needs.
 * When your component renders, `useAlertEventsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAlertEventsQuery({
 *   variables: {
 *      limit: // value for 'limit'
 *   },
 * });
 */
export function useAlertEventsQuery(baseOptions?: Apollo.QueryHookOptions<AlertEventsQuery, AlertEventsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<AlertEventsQuery, AlertEventsQueryVariables>(AlertEventsDocument, options);
      }
export function useAlertEventsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<AlertEventsQuery, AlertEventsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<AlertEventsQuery, AlertEventsQueryVariables>(AlertEventsDocument, options);
        }
export function useAlertEventsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<AlertEventsQuery, AlertEventsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<AlertEventsQuery, AlertEventsQueryVariables>(AlertEventsDocument, options);
        }
export type AlertEventsQueryHookResult = ReturnType<typeof useAlertEventsQuery>;
export type AlertEventsLazyQueryHookResult = ReturnType<typeof useAlertEventsLazyQuery>;
export type AlertEventsSuspenseQueryHookResult = ReturnType<typeof useAlertEventsSuspenseQuery>;
export type AlertEventsQueryResult = Apollo.QueryResult<AlertEventsQuery, AlertEventsQueryVariables>;
export const UpsertAlertRuleDocument = gql`
    mutation UpsertAlertRule($input: UpsertAlertRuleInput!) {
  upsertAlertRule(input: $input) {
    id
    name
  }
}
    `;
export type UpsertAlertRuleMutationFn = Apollo.MutationFunction<UpsertAlertRuleMutation, UpsertAlertRuleMutationVariables>;

/**
 * __useUpsertAlertRuleMutation__
 *
 * To run a mutation, you first call `useUpsertAlertRuleMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpsertAlertRuleMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [upsertAlertRuleMutation, { data, loading, error }] = useUpsertAlertRuleMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpsertAlertRuleMutation(baseOptions?: Apollo.MutationHookOptions<UpsertAlertRuleMutation, UpsertAlertRuleMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpsertAlertRuleMutation, UpsertAlertRuleMutationVariables>(UpsertAlertRuleDocument, options);
      }
export type UpsertAlertRuleMutationHookResult = ReturnType<typeof useUpsertAlertRuleMutation>;
export type UpsertAlertRuleMutationResult = Apollo.MutationResult<UpsertAlertRuleMutation>;
export type UpsertAlertRuleMutationOptions = Apollo.BaseMutationOptions<UpsertAlertRuleMutation, UpsertAlertRuleMutationVariables>;
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
export type CreateAlertChannelMutationFn = Apollo.MutationFunction<CreateAlertChannelMutation, CreateAlertChannelMutationVariables>;

/**
 * __useCreateAlertChannelMutation__
 *
 * To run a mutation, you first call `useCreateAlertChannelMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useCreateAlertChannelMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [createAlertChannelMutation, { data, loading, error }] = useCreateAlertChannelMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useCreateAlertChannelMutation(baseOptions?: Apollo.MutationHookOptions<CreateAlertChannelMutation, CreateAlertChannelMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<CreateAlertChannelMutation, CreateAlertChannelMutationVariables>(CreateAlertChannelDocument, options);
      }
export type CreateAlertChannelMutationHookResult = ReturnType<typeof useCreateAlertChannelMutation>;
export type CreateAlertChannelMutationResult = Apollo.MutationResult<CreateAlertChannelMutation>;
export type CreateAlertChannelMutationOptions = Apollo.BaseMutationOptions<CreateAlertChannelMutation, CreateAlertChannelMutationVariables>;
export const TriggerAlertRuleDocument = gql`
    mutation TriggerAlertRule($ruleId: String!) {
  triggerAlertRule(ruleId: $ruleId)
}
    `;
export type TriggerAlertRuleMutationFn = Apollo.MutationFunction<TriggerAlertRuleMutation, TriggerAlertRuleMutationVariables>;

/**
 * __useTriggerAlertRuleMutation__
 *
 * To run a mutation, you first call `useTriggerAlertRuleMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useTriggerAlertRuleMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [triggerAlertRuleMutation, { data, loading, error }] = useTriggerAlertRuleMutation({
 *   variables: {
 *      ruleId: // value for 'ruleId'
 *   },
 * });
 */
export function useTriggerAlertRuleMutation(baseOptions?: Apollo.MutationHookOptions<TriggerAlertRuleMutation, TriggerAlertRuleMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<TriggerAlertRuleMutation, TriggerAlertRuleMutationVariables>(TriggerAlertRuleDocument, options);
      }
export type TriggerAlertRuleMutationHookResult = ReturnType<typeof useTriggerAlertRuleMutation>;
export type TriggerAlertRuleMutationResult = Apollo.MutationResult<TriggerAlertRuleMutation>;
export type TriggerAlertRuleMutationOptions = Apollo.BaseMutationOptions<TriggerAlertRuleMutation, TriggerAlertRuleMutationVariables>;
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

/**
 * __useAlertEventsStreamSubscription__
 *
 * To run a query within a React component, call `useAlertEventsStreamSubscription` and pass it any options that fit your needs.
 * When your component renders, `useAlertEventsStreamSubscription` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the subscription, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAlertEventsStreamSubscription({
 *   variables: {
 *   },
 * });
 */
export function useAlertEventsStreamSubscription(baseOptions?: Apollo.SubscriptionHookOptions<AlertEventsStreamSubscription, AlertEventsStreamSubscriptionVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useSubscription<AlertEventsStreamSubscription, AlertEventsStreamSubscriptionVariables>(AlertEventsStreamDocument, options);
      }
export type AlertEventsStreamSubscriptionHookResult = ReturnType<typeof useAlertEventsStreamSubscription>;
export type AlertEventsStreamSubscriptionResult = Apollo.SubscriptionResult<AlertEventsStreamSubscription>;
export const AnalysisResultsDocument = gql`
    query AnalysisResults($limit: Int) {
  analysisResults(limit: $limit) {
    id
    type
    status
    summary
    createdAt
  }
}
    `;

/**
 * __useAnalysisResultsQuery__
 *
 * To run a query within a React component, call `useAnalysisResultsQuery` and pass it any options that fit your needs.
 * When your component renders, `useAnalysisResultsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAnalysisResultsQuery({
 *   variables: {
 *      limit: // value for 'limit'
 *   },
 * });
 */
export function useAnalysisResultsQuery(baseOptions?: Apollo.QueryHookOptions<AnalysisResultsQuery, AnalysisResultsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<AnalysisResultsQuery, AnalysisResultsQueryVariables>(AnalysisResultsDocument, options);
      }
export function useAnalysisResultsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<AnalysisResultsQuery, AnalysisResultsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<AnalysisResultsQuery, AnalysisResultsQueryVariables>(AnalysisResultsDocument, options);
        }
export function useAnalysisResultsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<AnalysisResultsQuery, AnalysisResultsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<AnalysisResultsQuery, AnalysisResultsQueryVariables>(AnalysisResultsDocument, options);
        }
export type AnalysisResultsQueryHookResult = ReturnType<typeof useAnalysisResultsQuery>;
export type AnalysisResultsLazyQueryHookResult = ReturnType<typeof useAnalysisResultsLazyQuery>;
export type AnalysisResultsSuspenseQueryHookResult = ReturnType<typeof useAnalysisResultsSuspenseQuery>;
export type AnalysisResultsQueryResult = Apollo.QueryResult<AnalysisResultsQuery, AnalysisResultsQueryVariables>;
export const AnalysisEventsDocument = gql`
    subscription AnalysisEvents {
  analysisEvents {
    id
    type
    status
    summary
    createdAt
  }
}
    `;

/**
 * __useAnalysisEventsSubscription__
 *
 * To run a query within a React component, call `useAnalysisEventsSubscription` and pass it any options that fit your needs.
 * When your component renders, `useAnalysisEventsSubscription` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the subscription, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAnalysisEventsSubscription({
 *   variables: {
 *   },
 * });
 */
export function useAnalysisEventsSubscription(baseOptions?: Apollo.SubscriptionHookOptions<AnalysisEventsSubscription, AnalysisEventsSubscriptionVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useSubscription<AnalysisEventsSubscription, AnalysisEventsSubscriptionVariables>(AnalysisEventsDocument, options);
      }
export type AnalysisEventsSubscriptionHookResult = ReturnType<typeof useAnalysisEventsSubscription>;
export type AnalysisEventsSubscriptionResult = Apollo.SubscriptionResult<AnalysisEventsSubscription>;
export const RequestCorrelationDocument = gql`
    mutation RequestCorrelation($input: CorrelationAnalysisInput!) {
  requestCorrelationAnalysis(input: $input) {
    id
    status
    type
  }
}
    `;
export type RequestCorrelationMutationFn = Apollo.MutationFunction<RequestCorrelationMutation, RequestCorrelationMutationVariables>;

/**
 * __useRequestCorrelationMutation__
 *
 * To run a mutation, you first call `useRequestCorrelationMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useRequestCorrelationMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [requestCorrelationMutation, { data, loading, error }] = useRequestCorrelationMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useRequestCorrelationMutation(baseOptions?: Apollo.MutationHookOptions<RequestCorrelationMutation, RequestCorrelationMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<RequestCorrelationMutation, RequestCorrelationMutationVariables>(RequestCorrelationDocument, options);
      }
export type RequestCorrelationMutationHookResult = ReturnType<typeof useRequestCorrelationMutation>;
export type RequestCorrelationMutationResult = Apollo.MutationResult<RequestCorrelationMutation>;
export type RequestCorrelationMutationOptions = Apollo.BaseMutationOptions<RequestCorrelationMutation, RequestCorrelationMutationVariables>;
export const RequestAnomalyDocument = gql`
    mutation RequestAnomaly($input: AnomalyAnalysisInput!) {
  requestAnomalyExplanation(input: $input) {
    id
    status
    type
  }
}
    `;
export type RequestAnomalyMutationFn = Apollo.MutationFunction<RequestAnomalyMutation, RequestAnomalyMutationVariables>;

/**
 * __useRequestAnomalyMutation__
 *
 * To run a mutation, you first call `useRequestAnomalyMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useRequestAnomalyMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [requestAnomalyMutation, { data, loading, error }] = useRequestAnomalyMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useRequestAnomalyMutation(baseOptions?: Apollo.MutationHookOptions<RequestAnomalyMutation, RequestAnomalyMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<RequestAnomalyMutation, RequestAnomalyMutationVariables>(RequestAnomalyDocument, options);
      }
export type RequestAnomalyMutationHookResult = ReturnType<typeof useRequestAnomalyMutation>;
export type RequestAnomalyMutationResult = Apollo.MutationResult<RequestAnomalyMutation>;
export type RequestAnomalyMutationOptions = Apollo.BaseMutationOptions<RequestAnomalyMutation, RequestAnomalyMutationVariables>;
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

/**
 * __useCrawlTasksQuery__
 *
 * To run a query within a React component, call `useCrawlTasksQuery` and pass it any options that fit your needs.
 * When your component renders, `useCrawlTasksQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useCrawlTasksQuery({
 *   variables: {
 *      first: // value for 'first'
 *      after: // value for 'after'
 *      search: // value for 'search'
 *      status: // value for 'status'
 *   },
 * });
 */
export function useCrawlTasksQuery(baseOptions: Apollo.QueryHookOptions<CrawlTasksQuery, CrawlTasksQueryVariables> & ({ variables: CrawlTasksQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<CrawlTasksQuery, CrawlTasksQueryVariables>(CrawlTasksDocument, options);
      }
export function useCrawlTasksLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<CrawlTasksQuery, CrawlTasksQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<CrawlTasksQuery, CrawlTasksQueryVariables>(CrawlTasksDocument, options);
        }
export function useCrawlTasksSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<CrawlTasksQuery, CrawlTasksQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<CrawlTasksQuery, CrawlTasksQueryVariables>(CrawlTasksDocument, options);
        }
export type CrawlTasksQueryHookResult = ReturnType<typeof useCrawlTasksQuery>;
export type CrawlTasksLazyQueryHookResult = ReturnType<typeof useCrawlTasksLazyQuery>;
export type CrawlTasksSuspenseQueryHookResult = ReturnType<typeof useCrawlTasksSuspenseQuery>;
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
          intrinsicScore
          baseDomain
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

/**
 * __useCrawlTaskQuery__
 *
 * To run a query within a React component, call `useCrawlTaskQuery` and pass it any options that fit your needs.
 * When your component renders, `useCrawlTaskQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useCrawlTaskQuery({
 *   variables: {
 *      id: // value for 'id'
 *      resultLimit: // value for 'resultLimit'
 *      resultSearch: // value for 'resultSearch'
 *   },
 * });
 */
export function useCrawlTaskQuery(baseOptions: Apollo.QueryHookOptions<CrawlTaskQuery, CrawlTaskQueryVariables> & ({ variables: CrawlTaskQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<CrawlTaskQuery, CrawlTaskQueryVariables>(CrawlTaskDocument, options);
      }
export function useCrawlTaskLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<CrawlTaskQuery, CrawlTaskQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<CrawlTaskQuery, CrawlTaskQueryVariables>(CrawlTaskDocument, options);
        }
export function useCrawlTaskSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<CrawlTaskQuery, CrawlTaskQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<CrawlTaskQuery, CrawlTaskQueryVariables>(CrawlTaskDocument, options);
        }
export type CrawlTaskQueryHookResult = ReturnType<typeof useCrawlTaskQuery>;
export type CrawlTaskLazyQueryHookResult = ReturnType<typeof useCrawlTaskLazyQuery>;
export type CrawlTaskSuspenseQueryHookResult = ReturnType<typeof useCrawlTaskSuspenseQuery>;
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
export type CreateCrawlTaskMutationFn = Apollo.MutationFunction<CreateCrawlTaskMutation, CreateCrawlTaskMutationVariables>;

/**
 * __useCreateCrawlTaskMutation__
 *
 * To run a mutation, you first call `useCreateCrawlTaskMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useCreateCrawlTaskMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [createCrawlTaskMutation, { data, loading, error }] = useCreateCrawlTaskMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useCreateCrawlTaskMutation(baseOptions?: Apollo.MutationHookOptions<CreateCrawlTaskMutation, CreateCrawlTaskMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<CreateCrawlTaskMutation, CreateCrawlTaskMutationVariables>(CreateCrawlTaskDocument, options);
      }
export type CreateCrawlTaskMutationHookResult = ReturnType<typeof useCreateCrawlTaskMutation>;
export type CreateCrawlTaskMutationResult = Apollo.MutationResult<CreateCrawlTaskMutation>;
export type CreateCrawlTaskMutationOptions = Apollo.BaseMutationOptions<CreateCrawlTaskMutation, CreateCrawlTaskMutationVariables>;
export const RetryCrawlTaskDocument = gql`
    mutation RetryCrawlTask($id: String!) {
  retryCrawlTask(id: $id) {
    id
    status
    lastRunAt
    lastError
    runCount
  }
}
    `;
export type RetryCrawlTaskMutationFn = Apollo.MutationFunction<RetryCrawlTaskMutation, RetryCrawlTaskMutationVariables>;

/**
 * __useRetryCrawlTaskMutation__
 *
 * To run a mutation, you first call `useRetryCrawlTaskMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useRetryCrawlTaskMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [retryCrawlTaskMutation, { data, loading, error }] = useRetryCrawlTaskMutation({
 *   variables: {
 *      id: // value for 'id'
 *   },
 * });
 */
export function useRetryCrawlTaskMutation(baseOptions?: Apollo.MutationHookOptions<RetryCrawlTaskMutation, RetryCrawlTaskMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<RetryCrawlTaskMutation, RetryCrawlTaskMutationVariables>(RetryCrawlTaskDocument, options);
      }
export type RetryCrawlTaskMutationHookResult = ReturnType<typeof useRetryCrawlTaskMutation>;
export type RetryCrawlTaskMutationResult = Apollo.MutationResult<RetryCrawlTaskMutation>;
export type RetryCrawlTaskMutationOptions = Apollo.BaseMutationOptions<RetryCrawlTaskMutation, RetryCrawlTaskMutationVariables>;
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

/**
 * __useCrawlMetadataQuery__
 *
 * To run a query within a React component, call `useCrawlMetadataQuery` and pass it any options that fit your needs.
 * When your component renders, `useCrawlMetadataQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useCrawlMetadataQuery({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useCrawlMetadataQuery(baseOptions: Apollo.QueryHookOptions<CrawlMetadataQuery, CrawlMetadataQueryVariables> & ({ variables: CrawlMetadataQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<CrawlMetadataQuery, CrawlMetadataQueryVariables>(CrawlMetadataDocument, options);
      }
export function useCrawlMetadataLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<CrawlMetadataQuery, CrawlMetadataQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<CrawlMetadataQuery, CrawlMetadataQueryVariables>(CrawlMetadataDocument, options);
        }
export function useCrawlMetadataSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<CrawlMetadataQuery, CrawlMetadataQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<CrawlMetadataQuery, CrawlMetadataQueryVariables>(CrawlMetadataDocument, options);
        }
export type CrawlMetadataQueryHookResult = ReturnType<typeof useCrawlMetadataQuery>;
export type CrawlMetadataLazyQueryHookResult = ReturnType<typeof useCrawlMetadataLazyQuery>;
export type CrawlMetadataSuspenseQueryHookResult = ReturnType<typeof useCrawlMetadataSuspenseQuery>;
export type CrawlMetadataQueryResult = Apollo.QueryResult<CrawlMetadataQuery, CrawlMetadataQueryVariables>;
export const DashboardHeroMetricsDocument = gql`
    query DashboardHeroMetrics($start: DateTime!, $end: DateTime!) {
  conflict: getEconomicData(
    category: "global-conflict-index"
    timeRange: {start: $start, end: $end}
    granularity: day
  ) {
    timestamp
    value
    unit
    item {
      displayName
    }
  }
  market: getEconomicData(
    category: "market-sentiment"
    timeRange: {start: $start, end: $end}
    granularity: day
  ) {
    timestamp
    value
    unit
    item {
      displayName
    }
  }
  resource: getEconomicData(
    category: "resource-scarcity"
    timeRange: {start: $start, end: $end}
    granularity: day
  ) {
    timestamp
    value
    unit
    item {
      displayName
    }
  }
  supply: getEconomicData(
    category: "supply-chain-stability"
    timeRange: {start: $start, end: $end}
    granularity: day
  ) {
    timestamp
    value
    unit
    item {
      displayName
    }
  }
}
    `;

/**
 * __useDashboardHeroMetricsQuery__
 *
 * To run a query within a React component, call `useDashboardHeroMetricsQuery` and pass it any options that fit your needs.
 * When your component renders, `useDashboardHeroMetricsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useDashboardHeroMetricsQuery({
 *   variables: {
 *      start: // value for 'start'
 *      end: // value for 'end'
 *   },
 * });
 */
export function useDashboardHeroMetricsQuery(baseOptions: Apollo.QueryHookOptions<DashboardHeroMetricsQuery, DashboardHeroMetricsQueryVariables> & ({ variables: DashboardHeroMetricsQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<DashboardHeroMetricsQuery, DashboardHeroMetricsQueryVariables>(DashboardHeroMetricsDocument, options);
      }
export function useDashboardHeroMetricsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<DashboardHeroMetricsQuery, DashboardHeroMetricsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<DashboardHeroMetricsQuery, DashboardHeroMetricsQueryVariables>(DashboardHeroMetricsDocument, options);
        }
export function useDashboardHeroMetricsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<DashboardHeroMetricsQuery, DashboardHeroMetricsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<DashboardHeroMetricsQuery, DashboardHeroMetricsQueryVariables>(DashboardHeroMetricsDocument, options);
        }
export type DashboardHeroMetricsQueryHookResult = ReturnType<typeof useDashboardHeroMetricsQuery>;
export type DashboardHeroMetricsLazyQueryHookResult = ReturnType<typeof useDashboardHeroMetricsLazyQuery>;
export type DashboardHeroMetricsSuspenseQueryHookResult = ReturnType<typeof useDashboardHeroMetricsSuspenseQuery>;
export type DashboardHeroMetricsQueryResult = Apollo.QueryResult<DashboardHeroMetricsQuery, DashboardHeroMetricsQueryVariables>;
export const MetricDrillDownDetailsDocument = gql`
    query MetricDrillDownDetails($category: String!, $start: DateTime!, $end: DateTime!) {
  history: getEconomicData(
    category: $category
    timeRange: {start: $start, end: $end}
    granularity: day
  ) {
    timestamp
    value
    unit
    item {
      displayName
    }
  }
  relatedAlerts: alertEvents(limit: 20, metricSlug: $category) {
    id
    severity
    message
    triggeredAt
    status
    metricValue
    context
  }
}
    `;

/**
 * __useMetricDrillDownDetailsQuery__
 *
 * To run a query within a React component, call `useMetricDrillDownDetailsQuery` and pass it any options that fit your needs.
 * When your component renders, `useMetricDrillDownDetailsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useMetricDrillDownDetailsQuery({
 *   variables: {
 *      category: // value for 'category'
 *      start: // value for 'start'
 *      end: // value for 'end'
 *   },
 * });
 */
export function useMetricDrillDownDetailsQuery(baseOptions: Apollo.QueryHookOptions<MetricDrillDownDetailsQuery, MetricDrillDownDetailsQueryVariables> & ({ variables: MetricDrillDownDetailsQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<MetricDrillDownDetailsQuery, MetricDrillDownDetailsQueryVariables>(MetricDrillDownDetailsDocument, options);
      }
export function useMetricDrillDownDetailsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<MetricDrillDownDetailsQuery, MetricDrillDownDetailsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<MetricDrillDownDetailsQuery, MetricDrillDownDetailsQueryVariables>(MetricDrillDownDetailsDocument, options);
        }
export function useMetricDrillDownDetailsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<MetricDrillDownDetailsQuery, MetricDrillDownDetailsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<MetricDrillDownDetailsQuery, MetricDrillDownDetailsQueryVariables>(MetricDrillDownDetailsDocument, options);
        }
export type MetricDrillDownDetailsQueryHookResult = ReturnType<typeof useMetricDrillDownDetailsQuery>;
export type MetricDrillDownDetailsLazyQueryHookResult = ReturnType<typeof useMetricDrillDownDetailsLazyQuery>;
export type MetricDrillDownDetailsSuspenseQueryHookResult = ReturnType<typeof useMetricDrillDownDetailsSuspenseQuery>;
export type MetricDrillDownDetailsQueryResult = Apollo.QueryResult<MetricDrillDownDetailsQuery, MetricDrillDownDetailsQueryVariables>;
export const DashboardsDocument = gql`
    query Dashboards {
  dashboards {
    id
    version
    name
    slug
    description
    theme
    config
    widgets {
      id
      title
      type
      dataSource
      dataConfig
      layoutX
      layoutY
      layoutW
      layoutH
      sortOrder
      options
    }
  }
}
    `;

/**
 * __useDashboardsQuery__
 *
 * To run a query within a React component, call `useDashboardsQuery` and pass it any options that fit your needs.
 * When your component renders, `useDashboardsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useDashboardsQuery({
 *   variables: {
 *   },
 * });
 */
export function useDashboardsQuery(baseOptions?: Apollo.QueryHookOptions<DashboardsQuery, DashboardsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<DashboardsQuery, DashboardsQueryVariables>(DashboardsDocument, options);
      }
export function useDashboardsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<DashboardsQuery, DashboardsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<DashboardsQuery, DashboardsQueryVariables>(DashboardsDocument, options);
        }
export function useDashboardsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<DashboardsQuery, DashboardsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<DashboardsQuery, DashboardsQueryVariables>(DashboardsDocument, options);
        }
export type DashboardsQueryHookResult = ReturnType<typeof useDashboardsQuery>;
export type DashboardsLazyQueryHookResult = ReturnType<typeof useDashboardsLazyQuery>;
export type DashboardsSuspenseQueryHookResult = ReturnType<typeof useDashboardsSuspenseQuery>;
export type DashboardsQueryResult = Apollo.QueryResult<DashboardsQuery, DashboardsQueryVariables>;
export const UpsertDashboardDocument = gql`
    mutation UpsertDashboard($input: UpsertDashboardInput!) {
  upsertDashboard(input: $input) {
    id
    name
    slug
  }
}
    `;
export type UpsertDashboardMutationFn = Apollo.MutationFunction<UpsertDashboardMutation, UpsertDashboardMutationVariables>;

/**
 * __useUpsertDashboardMutation__
 *
 * To run a mutation, you first call `useUpsertDashboardMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpsertDashboardMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [upsertDashboardMutation, { data, loading, error }] = useUpsertDashboardMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpsertDashboardMutation(baseOptions?: Apollo.MutationHookOptions<UpsertDashboardMutation, UpsertDashboardMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpsertDashboardMutation, UpsertDashboardMutationVariables>(UpsertDashboardDocument, options);
      }
export type UpsertDashboardMutationHookResult = ReturnType<typeof useUpsertDashboardMutation>;
export type UpsertDashboardMutationResult = Apollo.MutationResult<UpsertDashboardMutation>;
export type UpsertDashboardMutationOptions = Apollo.BaseMutationOptions<UpsertDashboardMutation, UpsertDashboardMutationVariables>;
export const DeleteDashboardDocument = gql`
    mutation DeleteDashboard($id: String!) {
  deleteDashboard(id: $id)
}
    `;
export type DeleteDashboardMutationFn = Apollo.MutationFunction<DeleteDashboardMutation, DeleteDashboardMutationVariables>;

/**
 * __useDeleteDashboardMutation__
 *
 * To run a mutation, you first call `useDeleteDashboardMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useDeleteDashboardMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [deleteDashboardMutation, { data, loading, error }] = useDeleteDashboardMutation({
 *   variables: {
 *      id: // value for 'id'
 *   },
 * });
 */
export function useDeleteDashboardMutation(baseOptions?: Apollo.MutationHookOptions<DeleteDashboardMutation, DeleteDashboardMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<DeleteDashboardMutation, DeleteDashboardMutationVariables>(DeleteDashboardDocument, options);
      }
export type DeleteDashboardMutationHookResult = ReturnType<typeof useDeleteDashboardMutation>;
export type DeleteDashboardMutationResult = Apollo.MutationResult<DeleteDashboardMutation>;
export type DeleteDashboardMutationOptions = Apollo.BaseMutationOptions<DeleteDashboardMutation, DeleteDashboardMutationVariables>;
export const EconomicDataDocument = gql`
    query EconomicData($category: String!, $timeRange: DateRangeInput!, $granularity: TimeGranularity) {
  getEconomicData(
    category: $category
    timeRange: $timeRange
    granularity: $granularity
  ) {
    timestamp
    value
    unit
    sourceField
    dataType
    item {
      slug
      displayName
    }
  }
}
    `;

/**
 * __useEconomicDataQuery__
 *
 * To run a query within a React component, call `useEconomicDataQuery` and pass it any options that fit your needs.
 * When your component renders, `useEconomicDataQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useEconomicDataQuery({
 *   variables: {
 *      category: // value for 'category'
 *      timeRange: // value for 'timeRange'
 *      granularity: // value for 'granularity'
 *   },
 * });
 */
export function useEconomicDataQuery(baseOptions: Apollo.QueryHookOptions<EconomicDataQuery, EconomicDataQueryVariables> & ({ variables: EconomicDataQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<EconomicDataQuery, EconomicDataQueryVariables>(EconomicDataDocument, options);
      }
export function useEconomicDataLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<EconomicDataQuery, EconomicDataQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<EconomicDataQuery, EconomicDataQueryVariables>(EconomicDataDocument, options);
        }
export function useEconomicDataSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<EconomicDataQuery, EconomicDataQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<EconomicDataQuery, EconomicDataQueryVariables>(EconomicDataDocument, options);
        }
export type EconomicDataQueryHookResult = ReturnType<typeof useEconomicDataQuery>;
export type EconomicDataLazyQueryHookResult = ReturnType<typeof useEconomicDataLazyQuery>;
export type EconomicDataSuspenseQueryHookResult = ReturnType<typeof useEconomicDataSuspenseQuery>;
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

/**
 * __useEconomicFetchConfigsQuery__
 *
 * To run a query within a React component, call `useEconomicFetchConfigsQuery` and pass it any options that fit your needs.
 * When your component renders, `useEconomicFetchConfigsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useEconomicFetchConfigsQuery({
 *   variables: {
 *   },
 * });
 */
export function useEconomicFetchConfigsQuery(baseOptions?: Apollo.QueryHookOptions<EconomicFetchConfigsQuery, EconomicFetchConfigsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<EconomicFetchConfigsQuery, EconomicFetchConfigsQueryVariables>(EconomicFetchConfigsDocument, options);
      }
export function useEconomicFetchConfigsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<EconomicFetchConfigsQuery, EconomicFetchConfigsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<EconomicFetchConfigsQuery, EconomicFetchConfigsQueryVariables>(EconomicFetchConfigsDocument, options);
        }
export function useEconomicFetchConfigsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<EconomicFetchConfigsQuery, EconomicFetchConfigsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<EconomicFetchConfigsQuery, EconomicFetchConfigsQueryVariables>(EconomicFetchConfigsDocument, options);
        }
export type EconomicFetchConfigsQueryHookResult = ReturnType<typeof useEconomicFetchConfigsQuery>;
export type EconomicFetchConfigsLazyQueryHookResult = ReturnType<typeof useEconomicFetchConfigsLazyQuery>;
export type EconomicFetchConfigsSuspenseQueryHookResult = ReturnType<typeof useEconomicFetchConfigsSuspenseQuery>;
export type EconomicFetchConfigsQueryResult = Apollo.QueryResult<EconomicFetchConfigsQuery, EconomicFetchConfigsQueryVariables>;
export const UpdateEconomicFetchConfigDocument = gql`
    mutation UpdateEconomicFetchConfig($slug: String!, $frequency: EconomicDataFrequency, $repeatCron: String, $isEnabled: Boolean) {
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
export type UpdateEconomicFetchConfigMutationFn = Apollo.MutationFunction<UpdateEconomicFetchConfigMutation, UpdateEconomicFetchConfigMutationVariables>;

/**
 * __useUpdateEconomicFetchConfigMutation__
 *
 * To run a mutation, you first call `useUpdateEconomicFetchConfigMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateEconomicFetchConfigMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateEconomicFetchConfigMutation, { data, loading, error }] = useUpdateEconomicFetchConfigMutation({
 *   variables: {
 *      slug: // value for 'slug'
 *      frequency: // value for 'frequency'
 *      repeatCron: // value for 'repeatCron'
 *      isEnabled: // value for 'isEnabled'
 *   },
 * });
 */
export function useUpdateEconomicFetchConfigMutation(baseOptions?: Apollo.MutationHookOptions<UpdateEconomicFetchConfigMutation, UpdateEconomicFetchConfigMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateEconomicFetchConfigMutation, UpdateEconomicFetchConfigMutationVariables>(UpdateEconomicFetchConfigDocument, options);
      }
export type UpdateEconomicFetchConfigMutationHookResult = ReturnType<typeof useUpdateEconomicFetchConfigMutation>;
export type UpdateEconomicFetchConfigMutationResult = Apollo.MutationResult<UpdateEconomicFetchConfigMutation>;
export type UpdateEconomicFetchConfigMutationOptions = Apollo.BaseMutationOptions<UpdateEconomicFetchConfigMutation, UpdateEconomicFetchConfigMutationVariables>;
export const TriggerEconomicDataFetchDocument = gql`
    mutation TriggerEconomicDataFetch($slugs: [String!]!) {
  triggerDataFetch(input: {slugs: $slugs})
}
    `;
export type TriggerEconomicDataFetchMutationFn = Apollo.MutationFunction<TriggerEconomicDataFetchMutation, TriggerEconomicDataFetchMutationVariables>;

/**
 * __useTriggerEconomicDataFetchMutation__
 *
 * To run a mutation, you first call `useTriggerEconomicDataFetchMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useTriggerEconomicDataFetchMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [triggerEconomicDataFetchMutation, { data, loading, error }] = useTriggerEconomicDataFetchMutation({
 *   variables: {
 *      slugs: // value for 'slugs'
 *   },
 * });
 */
export function useTriggerEconomicDataFetchMutation(baseOptions?: Apollo.MutationHookOptions<TriggerEconomicDataFetchMutation, TriggerEconomicDataFetchMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<TriggerEconomicDataFetchMutation, TriggerEconomicDataFetchMutationVariables>(TriggerEconomicDataFetchDocument, options);
      }
export type TriggerEconomicDataFetchMutationHookResult = ReturnType<typeof useTriggerEconomicDataFetchMutation>;
export type TriggerEconomicDataFetchMutationResult = Apollo.MutationResult<TriggerEconomicDataFetchMutation>;
export type TriggerEconomicDataFetchMutationOptions = Apollo.BaseMutationOptions<TriggerEconomicDataFetchMutation, TriggerEconomicDataFetchMutationVariables>;
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

/**
 * __useItemsQuery__
 *
 * To run a query within a React component, call `useItemsQuery` and pass it any options that fit your needs.
 * When your component renders, `useItemsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useItemsQuery({
 *   variables: {
 *      first: // value for 'first'
 *      after: // value for 'after'
 *      search: // value for 'search'
 *   },
 * });
 */
export function useItemsQuery(baseOptions: Apollo.QueryHookOptions<ItemsQuery, ItemsQueryVariables> & ({ variables: ItemsQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<ItemsQuery, ItemsQueryVariables>(ItemsDocument, options);
      }
export function useItemsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<ItemsQuery, ItemsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<ItemsQuery, ItemsQueryVariables>(ItemsDocument, options);
        }
export function useItemsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<ItemsQuery, ItemsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<ItemsQuery, ItemsQueryVariables>(ItemsDocument, options);
        }
export type ItemsQueryHookResult = ReturnType<typeof useItemsQuery>;
export type ItemsLazyQueryHookResult = ReturnType<typeof useItemsLazyQuery>;
export type ItemsSuspenseQueryHookResult = ReturnType<typeof useItemsSuspenseQuery>;
export type ItemsQueryResult = Apollo.QueryResult<ItemsQuery, ItemsQueryVariables>;
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

/**
 * __useMeQuery__
 *
 * To run a query within a React component, call `useMeQuery` and pass it any options that fit your needs.
 * When your component renders, `useMeQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useMeQuery({
 *   variables: {
 *   },
 * });
 */
export function useMeQuery(baseOptions?: Apollo.QueryHookOptions<MeQuery, MeQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<MeQuery, MeQueryVariables>(MeDocument, options);
      }
export function useMeLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<MeQuery, MeQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<MeQuery, MeQueryVariables>(MeDocument, options);
        }
export function useMeSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<MeQuery, MeQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<MeQuery, MeQueryVariables>(MeDocument, options);
        }
export type MeQueryHookResult = ReturnType<typeof useMeQuery>;
export type MeLazyQueryHookResult = ReturnType<typeof useMeLazyQuery>;
export type MeSuspenseQueryHookResult = ReturnType<typeof useMeSuspenseQuery>;
export type MeQueryResult = Apollo.QueryResult<MeQuery, MeQueryVariables>;
export const NotificationsDocument = gql`
    query Notifications($limit: Int) {
  notifications(limit: $limit) {
    id
    type
    title
    body
    data
    createdAt
    readAt
  }
}
    `;

/**
 * __useNotificationsQuery__
 *
 * To run a query within a React component, call `useNotificationsQuery` and pass it any options that fit your needs.
 * When your component renders, `useNotificationsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useNotificationsQuery({
 *   variables: {
 *      limit: // value for 'limit'
 *   },
 * });
 */
export function useNotificationsQuery(baseOptions?: Apollo.QueryHookOptions<NotificationsQuery, NotificationsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<NotificationsQuery, NotificationsQueryVariables>(NotificationsDocument, options);
      }
export function useNotificationsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<NotificationsQuery, NotificationsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<NotificationsQuery, NotificationsQueryVariables>(NotificationsDocument, options);
        }
export function useNotificationsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<NotificationsQuery, NotificationsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<NotificationsQuery, NotificationsQueryVariables>(NotificationsDocument, options);
        }
export type NotificationsQueryHookResult = ReturnType<typeof useNotificationsQuery>;
export type NotificationsLazyQueryHookResult = ReturnType<typeof useNotificationsLazyQuery>;
export type NotificationsSuspenseQueryHookResult = ReturnType<typeof useNotificationsSuspenseQuery>;
export type NotificationsQueryResult = Apollo.QueryResult<NotificationsQuery, NotificationsQueryVariables>;
export const UnreadNotificationCountDocument = gql`
    query UnreadNotificationCount {
  unreadNotificationCount
}
    `;

/**
 * __useUnreadNotificationCountQuery__
 *
 * To run a query within a React component, call `useUnreadNotificationCountQuery` and pass it any options that fit your needs.
 * When your component renders, `useUnreadNotificationCountQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useUnreadNotificationCountQuery({
 *   variables: {
 *   },
 * });
 */
export function useUnreadNotificationCountQuery(baseOptions?: Apollo.QueryHookOptions<UnreadNotificationCountQuery, UnreadNotificationCountQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<UnreadNotificationCountQuery, UnreadNotificationCountQueryVariables>(UnreadNotificationCountDocument, options);
      }
export function useUnreadNotificationCountLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<UnreadNotificationCountQuery, UnreadNotificationCountQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<UnreadNotificationCountQuery, UnreadNotificationCountQueryVariables>(UnreadNotificationCountDocument, options);
        }
export function useUnreadNotificationCountSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<UnreadNotificationCountQuery, UnreadNotificationCountQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<UnreadNotificationCountQuery, UnreadNotificationCountQueryVariables>(UnreadNotificationCountDocument, options);
        }
export type UnreadNotificationCountQueryHookResult = ReturnType<typeof useUnreadNotificationCountQuery>;
export type UnreadNotificationCountLazyQueryHookResult = ReturnType<typeof useUnreadNotificationCountLazyQuery>;
export type UnreadNotificationCountSuspenseQueryHookResult = ReturnType<typeof useUnreadNotificationCountSuspenseQuery>;
export type UnreadNotificationCountQueryResult = Apollo.QueryResult<UnreadNotificationCountQuery, UnreadNotificationCountQueryVariables>;
export const MarkNotificationReadDocument = gql`
    mutation MarkNotificationRead($id: String!) {
  markNotificationRead(id: $id) {
    id
    readAt
  }
}
    `;
export type MarkNotificationReadMutationFn = Apollo.MutationFunction<MarkNotificationReadMutation, MarkNotificationReadMutationVariables>;

/**
 * __useMarkNotificationReadMutation__
 *
 * To run a mutation, you first call `useMarkNotificationReadMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useMarkNotificationReadMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [markNotificationReadMutation, { data, loading, error }] = useMarkNotificationReadMutation({
 *   variables: {
 *      id: // value for 'id'
 *   },
 * });
 */
export function useMarkNotificationReadMutation(baseOptions?: Apollo.MutationHookOptions<MarkNotificationReadMutation, MarkNotificationReadMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<MarkNotificationReadMutation, MarkNotificationReadMutationVariables>(MarkNotificationReadDocument, options);
      }
export type MarkNotificationReadMutationHookResult = ReturnType<typeof useMarkNotificationReadMutation>;
export type MarkNotificationReadMutationResult = Apollo.MutationResult<MarkNotificationReadMutation>;
export type MarkNotificationReadMutationOptions = Apollo.BaseMutationOptions<MarkNotificationReadMutation, MarkNotificationReadMutationVariables>;
export const MarkAllNotificationsReadDocument = gql`
    mutation MarkAllNotificationsRead {
  markAllNotificationsRead
}
    `;
export type MarkAllNotificationsReadMutationFn = Apollo.MutationFunction<MarkAllNotificationsReadMutation, MarkAllNotificationsReadMutationVariables>;

/**
 * __useMarkAllNotificationsReadMutation__
 *
 * To run a mutation, you first call `useMarkAllNotificationsReadMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useMarkAllNotificationsReadMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [markAllNotificationsReadMutation, { data, loading, error }] = useMarkAllNotificationsReadMutation({
 *   variables: {
 *   },
 * });
 */
export function useMarkAllNotificationsReadMutation(baseOptions?: Apollo.MutationHookOptions<MarkAllNotificationsReadMutation, MarkAllNotificationsReadMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<MarkAllNotificationsReadMutation, MarkAllNotificationsReadMutationVariables>(MarkAllNotificationsReadDocument, options);
      }
export type MarkAllNotificationsReadMutationHookResult = ReturnType<typeof useMarkAllNotificationsReadMutation>;
export type MarkAllNotificationsReadMutationResult = Apollo.MutationResult<MarkAllNotificationsReadMutation>;
export type MarkAllNotificationsReadMutationOptions = Apollo.BaseMutationOptions<MarkAllNotificationsReadMutation, MarkAllNotificationsReadMutationVariables>;
export const MyOrganizationsDocument = gql`
    query MyOrganizations {
  myOrganizations {
    id
    name
    slug
    description
    isActive
    createdAt
    updatedAt
  }
}
    `;

/**
 * __useMyOrganizationsQuery__
 *
 * To run a query within a React component, call `useMyOrganizationsQuery` and pass it any options that fit your needs.
 * When your component renders, `useMyOrganizationsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useMyOrganizationsQuery({
 *   variables: {
 *   },
 * });
 */
export function useMyOrganizationsQuery(baseOptions?: Apollo.QueryHookOptions<MyOrganizationsQuery, MyOrganizationsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<MyOrganizationsQuery, MyOrganizationsQueryVariables>(MyOrganizationsDocument, options);
      }
export function useMyOrganizationsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<MyOrganizationsQuery, MyOrganizationsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<MyOrganizationsQuery, MyOrganizationsQueryVariables>(MyOrganizationsDocument, options);
        }
export function useMyOrganizationsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<MyOrganizationsQuery, MyOrganizationsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<MyOrganizationsQuery, MyOrganizationsQueryVariables>(MyOrganizationsDocument, options);
        }
export type MyOrganizationsQueryHookResult = ReturnType<typeof useMyOrganizationsQuery>;
export type MyOrganizationsLazyQueryHookResult = ReturnType<typeof useMyOrganizationsLazyQuery>;
export type MyOrganizationsSuspenseQueryHookResult = ReturnType<typeof useMyOrganizationsSuspenseQuery>;
export type MyOrganizationsQueryResult = Apollo.QueryResult<MyOrganizationsQuery, MyOrganizationsQueryVariables>;
export const CreateOrgDocument = gql`
    mutation CreateOrg($input: CreateOrgInput!) {
  createOrg(input: $input) {
    id
    name
    slug
    description
    isActive
    createdAt
    updatedAt
  }
}
    `;
export type CreateOrgMutationFn = Apollo.MutationFunction<CreateOrgMutation, CreateOrgMutationVariables>;

/**
 * __useCreateOrgMutation__
 *
 * To run a mutation, you first call `useCreateOrgMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useCreateOrgMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [createOrgMutation, { data, loading, error }] = useCreateOrgMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useCreateOrgMutation(baseOptions?: Apollo.MutationHookOptions<CreateOrgMutation, CreateOrgMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<CreateOrgMutation, CreateOrgMutationVariables>(CreateOrgDocument, options);
      }
export type CreateOrgMutationHookResult = ReturnType<typeof useCreateOrgMutation>;
export type CreateOrgMutationResult = Apollo.MutationResult<CreateOrgMutation>;
export type CreateOrgMutationOptions = Apollo.BaseMutationOptions<CreateOrgMutation, CreateOrgMutationVariables>;
export const UpdateOrgDocument = gql`
    mutation UpdateOrg($input: UpdateOrgInput!) {
  updateOrg(input: $input) {
    id
    name
    slug
    description
    isActive
    createdAt
    updatedAt
  }
}
    `;
export type UpdateOrgMutationFn = Apollo.MutationFunction<UpdateOrgMutation, UpdateOrgMutationVariables>;

/**
 * __useUpdateOrgMutation__
 *
 * To run a mutation, you first call `useUpdateOrgMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateOrgMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateOrgMutation, { data, loading, error }] = useUpdateOrgMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateOrgMutation(baseOptions?: Apollo.MutationHookOptions<UpdateOrgMutation, UpdateOrgMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateOrgMutation, UpdateOrgMutationVariables>(UpdateOrgDocument, options);
      }
export type UpdateOrgMutationHookResult = ReturnType<typeof useUpdateOrgMutation>;
export type UpdateOrgMutationResult = Apollo.MutationResult<UpdateOrgMutation>;
export type UpdateOrgMutationOptions = Apollo.BaseMutationOptions<UpdateOrgMutation, UpdateOrgMutationVariables>;
export const SetOrgActiveDocument = gql`
    mutation SetOrgActive($input: SetOrgActiveInput!) {
  setOrgActive(input: $input) {
    id
    name
    slug
    description
    isActive
    createdAt
    updatedAt
  }
}
    `;
export type SetOrgActiveMutationFn = Apollo.MutationFunction<SetOrgActiveMutation, SetOrgActiveMutationVariables>;

/**
 * __useSetOrgActiveMutation__
 *
 * To run a mutation, you first call `useSetOrgActiveMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useSetOrgActiveMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [setOrgActiveMutation, { data, loading, error }] = useSetOrgActiveMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useSetOrgActiveMutation(baseOptions?: Apollo.MutationHookOptions<SetOrgActiveMutation, SetOrgActiveMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<SetOrgActiveMutation, SetOrgActiveMutationVariables>(SetOrgActiveDocument, options);
      }
export type SetOrgActiveMutationHookResult = ReturnType<typeof useSetOrgActiveMutation>;
export type SetOrgActiveMutationResult = Apollo.MutationResult<SetOrgActiveMutation>;
export type SetOrgActiveMutationOptions = Apollo.BaseMutationOptions<SetOrgActiveMutation, SetOrgActiveMutationVariables>;
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

/**
 * __useQueueStatsQuery__
 *
 * To run a query within a React component, call `useQueueStatsQuery` and pass it any options that fit your needs.
 * When your component renders, `useQueueStatsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useQueueStatsQuery({
 *   variables: {
 *   },
 * });
 */
export function useQueueStatsQuery(baseOptions?: Apollo.QueryHookOptions<QueueStatsQuery, QueueStatsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<QueueStatsQuery, QueueStatsQueryVariables>(QueueStatsDocument, options);
      }
export function useQueueStatsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<QueueStatsQuery, QueueStatsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<QueueStatsQuery, QueueStatsQueryVariables>(QueueStatsDocument, options);
        }
export function useQueueStatsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<QueueStatsQuery, QueueStatsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<QueueStatsQuery, QueueStatsQueryVariables>(QueueStatsDocument, options);
        }
export type QueueStatsQueryHookResult = ReturnType<typeof useQueueStatsQuery>;
export type QueueStatsLazyQueryHookResult = ReturnType<typeof useQueueStatsLazyQuery>;
export type QueueStatsSuspenseQueryHookResult = ReturnType<typeof useQueueStatsSuspenseQuery>;
export type QueueStatsQueryResult = Apollo.QueryResult<QueueStatsQuery, QueueStatsQueryVariables>;
export const RbacOverviewDocument = gql`
    query RbacOverview {
  roles {
    id
    name
    description
    isSystem
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
      isSystem
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

/**
 * __useRbacOverviewQuery__
 *
 * To run a query within a React component, call `useRbacOverviewQuery` and pass it any options that fit your needs.
 * When your component renders, `useRbacOverviewQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useRbacOverviewQuery({
 *   variables: {
 *   },
 * });
 */
export function useRbacOverviewQuery(baseOptions?: Apollo.QueryHookOptions<RbacOverviewQuery, RbacOverviewQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<RbacOverviewQuery, RbacOverviewQueryVariables>(RbacOverviewDocument, options);
      }
export function useRbacOverviewLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<RbacOverviewQuery, RbacOverviewQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<RbacOverviewQuery, RbacOverviewQueryVariables>(RbacOverviewDocument, options);
        }
export function useRbacOverviewSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<RbacOverviewQuery, RbacOverviewQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<RbacOverviewQuery, RbacOverviewQueryVariables>(RbacOverviewDocument, options);
        }
export type RbacOverviewQueryHookResult = ReturnType<typeof useRbacOverviewQuery>;
export type RbacOverviewLazyQueryHookResult = ReturnType<typeof useRbacOverviewLazyQuery>;
export type RbacOverviewSuspenseQueryHookResult = ReturnType<typeof useRbacOverviewSuspenseQuery>;
export type RbacOverviewQueryResult = Apollo.QueryResult<RbacOverviewQuery, RbacOverviewQueryVariables>;
export const AssignRoleDocument = gql`
    mutation AssignRole($input: AssignRoleInput!) {
  assignRole(input: $input) {
    id
    orgId
    role {
      id
      name
      isSystem
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
export type AssignRoleMutationFn = Apollo.MutationFunction<AssignRoleMutation, AssignRoleMutationVariables>;

/**
 * __useAssignRoleMutation__
 *
 * To run a mutation, you first call `useAssignRoleMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useAssignRoleMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [assignRoleMutation, { data, loading, error }] = useAssignRoleMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useAssignRoleMutation(baseOptions?: Apollo.MutationHookOptions<AssignRoleMutation, AssignRoleMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<AssignRoleMutation, AssignRoleMutationVariables>(AssignRoleDocument, options);
      }
export type AssignRoleMutationHookResult = ReturnType<typeof useAssignRoleMutation>;
export type AssignRoleMutationResult = Apollo.MutationResult<AssignRoleMutation>;
export type AssignRoleMutationOptions = Apollo.BaseMutationOptions<AssignRoleMutation, AssignRoleMutationVariables>;
export const UpdateRoleDocument = gql`
    mutation UpdateRole($input: UpdateRoleInput!) {
  updateRole(input: $input) {
    id
    name
    description
    isSystem
    permissions {
      id
      name
      description
    }
  }
}
    `;
export type UpdateRoleMutationFn = Apollo.MutationFunction<UpdateRoleMutation, UpdateRoleMutationVariables>;

/**
 * __useUpdateRoleMutation__
 *
 * To run a mutation, you first call `useUpdateRoleMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateRoleMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateRoleMutation, { data, loading, error }] = useUpdateRoleMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateRoleMutation(baseOptions?: Apollo.MutationHookOptions<UpdateRoleMutation, UpdateRoleMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateRoleMutation, UpdateRoleMutationVariables>(UpdateRoleDocument, options);
      }
export type UpdateRoleMutationHookResult = ReturnType<typeof useUpdateRoleMutation>;
export type UpdateRoleMutationResult = Apollo.MutationResult<UpdateRoleMutation>;
export type UpdateRoleMutationOptions = Apollo.BaseMutationOptions<UpdateRoleMutation, UpdateRoleMutationVariables>;
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

/**
 * __useRateLimitSettingsQuery__
 *
 * To run a query within a React component, call `useRateLimitSettingsQuery` and pass it any options that fit your needs.
 * When your component renders, `useRateLimitSettingsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useRateLimitSettingsQuery({
 *   variables: {
 *   },
 * });
 */
export function useRateLimitSettingsQuery(baseOptions?: Apollo.QueryHookOptions<RateLimitSettingsQuery, RateLimitSettingsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<RateLimitSettingsQuery, RateLimitSettingsQueryVariables>(RateLimitSettingsDocument, options);
      }
export function useRateLimitSettingsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<RateLimitSettingsQuery, RateLimitSettingsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<RateLimitSettingsQuery, RateLimitSettingsQueryVariables>(RateLimitSettingsDocument, options);
        }
export function useRateLimitSettingsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<RateLimitSettingsQuery, RateLimitSettingsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<RateLimitSettingsQuery, RateLimitSettingsQueryVariables>(RateLimitSettingsDocument, options);
        }
export type RateLimitSettingsQueryHookResult = ReturnType<typeof useRateLimitSettingsQuery>;
export type RateLimitSettingsLazyQueryHookResult = ReturnType<typeof useRateLimitSettingsLazyQuery>;
export type RateLimitSettingsSuspenseQueryHookResult = ReturnType<typeof useRateLimitSettingsSuspenseQuery>;
export type RateLimitSettingsQueryResult = Apollo.QueryResult<RateLimitSettingsQuery, RateLimitSettingsQueryVariables>;
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
export type UpdateRateLimitSettingsMutationFn = Apollo.MutationFunction<UpdateRateLimitSettingsMutation, UpdateRateLimitSettingsMutationVariables>;

/**
 * __useUpdateRateLimitSettingsMutation__
 *
 * To run a mutation, you first call `useUpdateRateLimitSettingsMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateRateLimitSettingsMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateRateLimitSettingsMutation, { data, loading, error }] = useUpdateRateLimitSettingsMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateRateLimitSettingsMutation(baseOptions?: Apollo.MutationHookOptions<UpdateRateLimitSettingsMutation, UpdateRateLimitSettingsMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateRateLimitSettingsMutation, UpdateRateLimitSettingsMutationVariables>(UpdateRateLimitSettingsDocument, options);
      }
export type UpdateRateLimitSettingsMutationHookResult = ReturnType<typeof useUpdateRateLimitSettingsMutation>;
export type UpdateRateLimitSettingsMutationResult = Apollo.MutationResult<UpdateRateLimitSettingsMutation>;
export type UpdateRateLimitSettingsMutationOptions = Apollo.BaseMutationOptions<UpdateRateLimitSettingsMutation, UpdateRateLimitSettingsMutationVariables>;
export const AuthCacheSettingsDocument = gql`
    query AuthCacheSettings {
  authCacheSettings {
    profileTtlSeconds
    lockTtlMs
    maxWaitMs
    retryDelayMs
  }
}
    `;

/**
 * __useAuthCacheSettingsQuery__
 *
 * To run a query within a React component, call `useAuthCacheSettingsQuery` and pass it any options that fit your needs.
 * When your component renders, `useAuthCacheSettingsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAuthCacheSettingsQuery({
 *   variables: {
 *   },
 * });
 */
export function useAuthCacheSettingsQuery(baseOptions?: Apollo.QueryHookOptions<AuthCacheSettingsQuery, AuthCacheSettingsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<AuthCacheSettingsQuery, AuthCacheSettingsQueryVariables>(AuthCacheSettingsDocument, options);
      }
export function useAuthCacheSettingsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<AuthCacheSettingsQuery, AuthCacheSettingsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<AuthCacheSettingsQuery, AuthCacheSettingsQueryVariables>(AuthCacheSettingsDocument, options);
        }
export function useAuthCacheSettingsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<AuthCacheSettingsQuery, AuthCacheSettingsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<AuthCacheSettingsQuery, AuthCacheSettingsQueryVariables>(AuthCacheSettingsDocument, options);
        }
export type AuthCacheSettingsQueryHookResult = ReturnType<typeof useAuthCacheSettingsQuery>;
export type AuthCacheSettingsLazyQueryHookResult = ReturnType<typeof useAuthCacheSettingsLazyQuery>;
export type AuthCacheSettingsSuspenseQueryHookResult = ReturnType<typeof useAuthCacheSettingsSuspenseQuery>;
export type AuthCacheSettingsQueryResult = Apollo.QueryResult<AuthCacheSettingsQuery, AuthCacheSettingsQueryVariables>;
export const UpdateAuthCacheSettingsDocument = gql`
    mutation UpdateAuthCacheSettings($input: UpdateAuthCacheSettingsInput!) {
  updateAuthCacheSettings(input: $input) {
    profileTtlSeconds
    lockTtlMs
    maxWaitMs
    retryDelayMs
  }
}
    `;
export type UpdateAuthCacheSettingsMutationFn = Apollo.MutationFunction<UpdateAuthCacheSettingsMutation, UpdateAuthCacheSettingsMutationVariables>;

/**
 * __useUpdateAuthCacheSettingsMutation__
 *
 * To run a mutation, you first call `useUpdateAuthCacheSettingsMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateAuthCacheSettingsMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateAuthCacheSettingsMutation, { data, loading, error }] = useUpdateAuthCacheSettingsMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateAuthCacheSettingsMutation(baseOptions?: Apollo.MutationHookOptions<UpdateAuthCacheSettingsMutation, UpdateAuthCacheSettingsMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateAuthCacheSettingsMutation, UpdateAuthCacheSettingsMutationVariables>(UpdateAuthCacheSettingsDocument, options);
      }
export type UpdateAuthCacheSettingsMutationHookResult = ReturnType<typeof useUpdateAuthCacheSettingsMutation>;
export type UpdateAuthCacheSettingsMutationResult = Apollo.MutationResult<UpdateAuthCacheSettingsMutation>;
export type UpdateAuthCacheSettingsMutationOptions = Apollo.BaseMutationOptions<UpdateAuthCacheSettingsMutation, UpdateAuthCacheSettingsMutationVariables>;
export const AuditLogRetentionDocument = gql`
    query AuditLogRetention {
  auditLogRetention {
    retentionDays
  }
}
    `;

/**
 * __useAuditLogRetentionQuery__
 *
 * To run a query within a React component, call `useAuditLogRetentionQuery` and pass it any options that fit your needs.
 * When your component renders, `useAuditLogRetentionQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAuditLogRetentionQuery({
 *   variables: {
 *   },
 * });
 */
export function useAuditLogRetentionQuery(baseOptions?: Apollo.QueryHookOptions<AuditLogRetentionQuery, AuditLogRetentionQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<AuditLogRetentionQuery, AuditLogRetentionQueryVariables>(AuditLogRetentionDocument, options);
      }
export function useAuditLogRetentionLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<AuditLogRetentionQuery, AuditLogRetentionQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<AuditLogRetentionQuery, AuditLogRetentionQueryVariables>(AuditLogRetentionDocument, options);
        }
export function useAuditLogRetentionSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<AuditLogRetentionQuery, AuditLogRetentionQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<AuditLogRetentionQuery, AuditLogRetentionQueryVariables>(AuditLogRetentionDocument, options);
        }
export type AuditLogRetentionQueryHookResult = ReturnType<typeof useAuditLogRetentionQuery>;
export type AuditLogRetentionLazyQueryHookResult = ReturnType<typeof useAuditLogRetentionLazyQuery>;
export type AuditLogRetentionSuspenseQueryHookResult = ReturnType<typeof useAuditLogRetentionSuspenseQuery>;
export type AuditLogRetentionQueryResult = Apollo.QueryResult<AuditLogRetentionQuery, AuditLogRetentionQueryVariables>;
export const UpdateAuditLogRetentionDocument = gql`
    mutation UpdateAuditLogRetention($input: UpdateAuditLogRetentionInput!) {
  updateAuditLogRetention(input: $input) {
    retentionDays
  }
}
    `;
export type UpdateAuditLogRetentionMutationFn = Apollo.MutationFunction<UpdateAuditLogRetentionMutation, UpdateAuditLogRetentionMutationVariables>;

/**
 * __useUpdateAuditLogRetentionMutation__
 *
 * To run a mutation, you first call `useUpdateAuditLogRetentionMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateAuditLogRetentionMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateAuditLogRetentionMutation, { data, loading, error }] = useUpdateAuditLogRetentionMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateAuditLogRetentionMutation(baseOptions?: Apollo.MutationHookOptions<UpdateAuditLogRetentionMutation, UpdateAuditLogRetentionMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateAuditLogRetentionMutation, UpdateAuditLogRetentionMutationVariables>(UpdateAuditLogRetentionDocument, options);
      }
export type UpdateAuditLogRetentionMutationHookResult = ReturnType<typeof useUpdateAuditLogRetentionMutation>;
export type UpdateAuditLogRetentionMutationResult = Apollo.MutationResult<UpdateAuditLogRetentionMutation>;
export type UpdateAuditLogRetentionMutationOptions = Apollo.BaseMutationOptions<UpdateAuditLogRetentionMutation, UpdateAuditLogRetentionMutationVariables>;
export const NewsPromptConfigDocument = gql`
    query NewsPromptConfig {
  newsPromptConfig {
    version
    systemPromptTemplate
    userPromptTemplate
  }
}
    `;

/**
 * __useNewsPromptConfigQuery__
 *
 * To run a query within a React component, call `useNewsPromptConfigQuery` and pass it any options that fit your needs.
 * When your component renders, `useNewsPromptConfigQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useNewsPromptConfigQuery({
 *   variables: {
 *   },
 * });
 */
export function useNewsPromptConfigQuery(baseOptions?: Apollo.QueryHookOptions<NewsPromptConfigQuery, NewsPromptConfigQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<NewsPromptConfigQuery, NewsPromptConfigQueryVariables>(NewsPromptConfigDocument, options);
      }
export function useNewsPromptConfigLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<NewsPromptConfigQuery, NewsPromptConfigQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<NewsPromptConfigQuery, NewsPromptConfigQueryVariables>(NewsPromptConfigDocument, options);
        }
export function useNewsPromptConfigSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<NewsPromptConfigQuery, NewsPromptConfigQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<NewsPromptConfigQuery, NewsPromptConfigQueryVariables>(NewsPromptConfigDocument, options);
        }
export type NewsPromptConfigQueryHookResult = ReturnType<typeof useNewsPromptConfigQuery>;
export type NewsPromptConfigLazyQueryHookResult = ReturnType<typeof useNewsPromptConfigLazyQuery>;
export type NewsPromptConfigSuspenseQueryHookResult = ReturnType<typeof useNewsPromptConfigSuspenseQuery>;
export type NewsPromptConfigQueryResult = Apollo.QueryResult<NewsPromptConfigQuery, NewsPromptConfigQueryVariables>;
export const UpdateNewsPromptConfigDocument = gql`
    mutation UpdateNewsPromptConfig($input: UpdateNewsPromptConfigInput!) {
  updateNewsPromptConfig(input: $input) {
    version
    systemPromptTemplate
    userPromptTemplate
  }
}
    `;
export type UpdateNewsPromptConfigMutationFn = Apollo.MutationFunction<UpdateNewsPromptConfigMutation, UpdateNewsPromptConfigMutationVariables>;

/**
 * __useUpdateNewsPromptConfigMutation__
 *
 * To run a mutation, you first call `useUpdateNewsPromptConfigMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateNewsPromptConfigMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateNewsPromptConfigMutation, { data, loading, error }] = useUpdateNewsPromptConfigMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateNewsPromptConfigMutation(baseOptions?: Apollo.MutationHookOptions<UpdateNewsPromptConfigMutation, UpdateNewsPromptConfigMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateNewsPromptConfigMutation, UpdateNewsPromptConfigMutationVariables>(UpdateNewsPromptConfigDocument, options);
      }
export type UpdateNewsPromptConfigMutationHookResult = ReturnType<typeof useUpdateNewsPromptConfigMutation>;
export type UpdateNewsPromptConfigMutationResult = Apollo.MutationResult<UpdateNewsPromptConfigMutation>;
export type UpdateNewsPromptConfigMutationOptions = Apollo.BaseMutationOptions<UpdateNewsPromptConfigMutation, UpdateNewsPromptConfigMutationVariables>;
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

/**
 * __useCrawlClientSettingsQuery__
 *
 * To run a query within a React component, call `useCrawlClientSettingsQuery` and pass it any options that fit your needs.
 * When your component renders, `useCrawlClientSettingsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useCrawlClientSettingsQuery({
 *   variables: {
 *   },
 * });
 */
export function useCrawlClientSettingsQuery(baseOptions?: Apollo.QueryHookOptions<CrawlClientSettingsQuery, CrawlClientSettingsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<CrawlClientSettingsQuery, CrawlClientSettingsQueryVariables>(CrawlClientSettingsDocument, options);
      }
export function useCrawlClientSettingsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<CrawlClientSettingsQuery, CrawlClientSettingsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<CrawlClientSettingsQuery, CrawlClientSettingsQueryVariables>(CrawlClientSettingsDocument, options);
        }
export function useCrawlClientSettingsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<CrawlClientSettingsQuery, CrawlClientSettingsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<CrawlClientSettingsQuery, CrawlClientSettingsQueryVariables>(CrawlClientSettingsDocument, options);
        }
export type CrawlClientSettingsQueryHookResult = ReturnType<typeof useCrawlClientSettingsQuery>;
export type CrawlClientSettingsLazyQueryHookResult = ReturnType<typeof useCrawlClientSettingsLazyQuery>;
export type CrawlClientSettingsSuspenseQueryHookResult = ReturnType<typeof useCrawlClientSettingsSuspenseQuery>;
export type CrawlClientSettingsQueryResult = Apollo.QueryResult<CrawlClientSettingsQuery, CrawlClientSettingsQueryVariables>;
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
export type UpdateCrawlClientSettingsMutationFn = Apollo.MutationFunction<UpdateCrawlClientSettingsMutation, UpdateCrawlClientSettingsMutationVariables>;

/**
 * __useUpdateCrawlClientSettingsMutation__
 *
 * To run a mutation, you first call `useUpdateCrawlClientSettingsMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateCrawlClientSettingsMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateCrawlClientSettingsMutation, { data, loading, error }] = useUpdateCrawlClientSettingsMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateCrawlClientSettingsMutation(baseOptions?: Apollo.MutationHookOptions<UpdateCrawlClientSettingsMutation, UpdateCrawlClientSettingsMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateCrawlClientSettingsMutation, UpdateCrawlClientSettingsMutationVariables>(UpdateCrawlClientSettingsDocument, options);
      }
export type UpdateCrawlClientSettingsMutationHookResult = ReturnType<typeof useUpdateCrawlClientSettingsMutation>;
export type UpdateCrawlClientSettingsMutationResult = Apollo.MutationResult<UpdateCrawlClientSettingsMutation>;
export type UpdateCrawlClientSettingsMutationOptions = Apollo.BaseMutationOptions<UpdateCrawlClientSettingsMutation, UpdateCrawlClientSettingsMutationVariables>;
