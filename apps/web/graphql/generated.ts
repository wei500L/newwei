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
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  name: Scalars['String']['input'];
  target: Scalars['String']['input'];
  type: AlertChannelType;
};

export type AlertChannelModel = {
  __typename?: 'AlertChannelModel';
  config?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['String']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  target: Scalars['String']['output'];
  type: AlertChannelType;
  updatedAt: Scalars['DateTime']['output'];
};

export enum AlertChannelType {
  Email = 'email',
  InApp = 'in_app',
  Webhook = 'webhook'
}

export type AlertDeliveryModel = {
  __typename?: 'AlertDeliveryModel';
  channelName?: Maybe<Scalars['String']['output']>;
  channelType: AlertChannelType;
  error?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  sentAt?: Maybe<Scalars['DateTime']['output']>;
  status: AlertDeliveryStatus;
  target?: Maybe<Scalars['String']['output']>;
};

export enum AlertDeliveryStatus {
  Failed = 'failed',
  Pending = 'pending',
  Sent = 'sent'
}

export type AlertEventModel = {
  __typename?: 'AlertEventModel';
  changePercent?: Maybe<Scalars['Float']['output']>;
  changeWindowMin?: Maybe<Scalars['Float']['output']>;
  context?: Maybe<Scalars['JSON']['output']>;
  deliveries: Array<AlertDeliveryModel>;
  id: Scalars['String']['output'];
  message?: Maybe<Scalars['String']['output']>;
  metricProvider?: Maybe<AlertMetricProvider>;
  metricSlug?: Maybe<Scalars['String']['output']>;
  metricValue: Scalars['Float']['output'];
  operator?: Maybe<AlertOperator>;
  ruleId?: Maybe<Scalars['String']['output']>;
  ruleName?: Maybe<Scalars['String']['output']>;
  severity: AlertSeverity;
  status: AlertEventStatus;
  thresholdLower?: Maybe<Scalars['Float']['output']>;
  thresholdUpper?: Maybe<Scalars['Float']['output']>;
  thresholdValue?: Maybe<Scalars['Float']['output']>;
  triggeredAt: Scalars['DateTime']['output'];
};

export type AlertEventReplayModel = {
  __typename?: 'AlertEventReplayModel';
  eventId: Scalars['String']['output'];
  metricProvider: AlertMetricProvider;
  metricSlug: Scalars['String']['output'];
  points: Array<AlertEventReplayPointModel>;
  unit?: Maybe<Scalars['String']['output']>;
};

export type AlertEventReplayPointModel = {
  __typename?: 'AlertEventReplayPointModel';
  timestamp: Scalars['DateTime']['output'];
  value: Scalars['Float']['output'];
};

export enum AlertEventStatus {
  Confirmed = 'confirmed',
  Delivered = 'delivered',
  Failed = 'failed',
  Ignored = 'ignored',
  Pending = 'pending'
}

export enum AlertMetricProvider {
  CrawlTask = 'crawl_task',
  EconomicAnomaly = 'economic_anomaly',
  EconomicData = 'economic_data',
  EntityAssociation = 'entity_association',
  EntitySentiment = 'entity_sentiment',
  PipelineJob = 'pipeline_job',
  RealtimeSignal = 'realtime_signal',
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

export type AlertRuleTuningSuggestionModel = {
  __typename?: 'AlertRuleTuningSuggestionModel';
  action: AlertTuningAction;
  confirmedEvents: Scalars['Int']['output'];
  falsePositiveRate?: Maybe<Scalars['Float']['output']>;
  ignoredEvents: Scalars['Int']['output'];
  message?: Maybe<Scalars['String']['output']>;
  reviewedEvents: Scalars['Int']['output'];
  ruleId: Scalars['String']['output'];
  suggestedThresholdLower?: Maybe<Scalars['Float']['output']>;
  suggestedThresholdUpper?: Maybe<Scalars['Float']['output']>;
  suggestedThresholdValue?: Maybe<Scalars['Float']['output']>;
  totalEvents: Scalars['Int']['output'];
  windowDays: Scalars['Int']['output'];
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

export enum AlertTuningAction {
  AdjustRange = 'adjust_range',
  DecreaseThreshold = 'decrease_threshold',
  IncreaseThreshold = 'increase_threshold',
  None = 'none'
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
  Correlation = 'correlation',
  GeoTransport = 'geo_transport'
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

export type ArchiveCalendarDayModel = {
  __typename?: 'ArchiveCalendarDayModel';
  count: Scalars['Int']['output'];
  date: Scalars['String']['output'];
};

export type ArchiveCalendarInput = {
  month: Scalars['String']['input'];
  region?: InputMaybe<ArchiveRegion>;
  vertical?: InputMaybe<ArchiveVertical>;
};

export enum ArchiveClassificationDecisionReason {
  DefaultForeignAffairsFallback = 'DEFAULT_FOREIGN_AFFAIRS_FALLBACK',
  FusedWinner = 'FUSED_WINNER',
  RuleFallbackLowSemanticConfidence = 'RULE_FALLBACK_LOW_SEMANTIC_CONFIDENCE',
  StaleCachedResult = 'STALE_CACHED_RESULT',
  StrongRuleOverride = 'STRONG_RULE_OVERRIDE'
}

export type ArchiveClassificationDetailModel = {
  __typename?: 'ArchiveClassificationDetailModel';
  decisionReason: ArchiveClassificationDecisionReason;
  decisionReasonI18nKey: Scalars['String']['output'];
  embeddingModel: Scalars['String']['output'];
  isStale: Scalars['Boolean']['output'];
  pipelineVersion: Scalars['String']['output'];
  region: ArchiveRegion;
  rerankModel: Scalars['String']['output'];
  ruleSignals: Array<Scalars['String']['output']>;
  scoreEntries: Array<ArchiveClassificationScoreEntryModel>;
  staleReasonI18nKeys: Array<Scalars['String']['output']>;
  staleReasons: Array<ArchiveClassificationStaleReason>;
  taxonomyVersion: Scalars['String']['output'];
  vertical: ArchiveVertical;
};

export type ArchiveClassificationScoreEntryModel = {
  __typename?: 'ArchiveClassificationScoreEntryModel';
  embeddingScore: Scalars['Float']['output'];
  fusedScore: Scalars['Float']['output'];
  rerankScore: Scalars['Float']['output'];
  ruleScore: Scalars['Float']['output'];
  vertical: ArchiveVertical;
};

export enum ArchiveClassificationStaleReason {
  EmbeddingModelChanged = 'EMBEDDING_MODEL_CHANGED',
  PipelineVersionChanged = 'PIPELINE_VERSION_CHANGED',
  RerankModelChanged = 'RERANK_MODEL_CHANGED',
  TaxonomyVersionChanged = 'TAXONOMY_VERSION_CHANGED'
}

export type ArchiveDetailModel = {
  __typename?: 'ArchiveDetailModel';
  classification?: Maybe<ArchiveClassificationDetailModel>;
  eventId?: Maybe<Scalars['String']['output']>;
  fullEntities: Array<Scalars['String']['output']>;
  processedArticleId: Scalars['String']['output'];
  relatedArticles: Array<ArchiveRelatedArticleModel>;
  sourceLabel?: Maybe<Scalars['String']['output']>;
  sourceUrl?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['String']['output']>;
  timeline: Array<ArchiveTimelineEntryModel>;
  title?: Maybe<Scalars['String']['output']>;
};

export type ArchiveDigestModel = {
  __typename?: 'ArchiveDigestModel';
  anchorDate: Scalars['DateTime']['output'];
  groups: Array<ArchiveVerticalGroupModel>;
  preparation: ArchivePreparationStatusModel;
  region: ArchiveRegion;
  totalCount: Scalars['Int']['output'];
};

export type ArchiveEventItemModel = {
  __typename?: 'ArchiveEventItemModel';
  countryLabel?: Maybe<Scalars['String']['output']>;
  entityTags: Array<Scalars['String']['output']>;
  eventId?: Maybe<Scalars['String']['output']>;
  keywordHighlights: Array<Scalars['String']['output']>;
  matchOrigin?: Maybe<ArchiveMatchOrigin>;
  processedArticleId: Scalars['String']['output'];
  publishedAt?: Maybe<Scalars['DateTime']['output']>;
  qualityScore?: Maybe<Scalars['Float']['output']>;
  region: ArchiveRegion;
  relevanceScore?: Maybe<Scalars['Float']['output']>;
  sortAt: Scalars['DateTime']['output'];
  sourceLabel?: Maybe<Scalars['String']['output']>;
  sourceUrl?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  vertical: ArchiveVertical;
  weight: Scalars['Int']['output'];
};

export enum ArchiveMatchOrigin {
  Hybrid = 'HYBRID',
  Lexical = 'LEXICAL',
  Semantic = 'SEMANTIC'
}

export enum ArchivePreparationState {
  Failed = 'FAILED',
  Idle = 'IDLE',
  Partial = 'PARTIAL',
  Processing = 'PROCESSING',
  Queued = 'QUEUED',
  Ready = 'READY'
}

export type ArchivePreparationStatusModel = {
  __typename?: 'ArchivePreparationStatusModel';
  errorMessage?: Maybe<Scalars['String']['output']>;
  missingCount: Scalars['Int']['output'];
  readyCount: Scalars['Int']['output'];
  state: ArchivePreparationState;
  updatedAt: Scalars['DateTime']['output'];
};

export type ArchiveQueryInput = {
  anchorDate: Scalars['DateTime']['input'];
  cursors?: InputMaybe<Array<ArchiveVerticalCursorInput>>;
  limitPerVertical?: InputMaybe<Scalars['Int']['input']>;
  pageSize?: InputMaybe<Scalars['Int']['input']>;
  region: ArchiveRegion;
  search?: InputMaybe<Scalars['String']['input']>;
  weights?: InputMaybe<Array<ArchiveWeight>>;
};

export enum ArchiveRegion {
  Africa = 'AFRICA',
  Americas = 'AMERICAS',
  Apac = 'APAC',
  Europe = 'EUROPE',
  MiddleEast = 'MIDDLE_EAST',
  Other = 'OTHER'
}

export type ArchiveRelatedArticleModel = {
  __typename?: 'ArchiveRelatedArticleModel';
  processedArticleId: Scalars['String']['output'];
  publishedAt?: Maybe<Scalars['DateTime']['output']>;
  sourceLabel?: Maybe<Scalars['String']['output']>;
  sourceUrl?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
};

export type ArchiveTimelineEntryModel = {
  __typename?: 'ArchiveTimelineEntryModel';
  bucketStart: Scalars['DateTime']['output'];
  id: Scalars['String']['output'];
  summary?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
};

export enum ArchiveVertical {
  DomesticAffairs = 'DOMESTIC_AFFAIRS',
  EastSea = 'EAST_SEA',
  ForeignAffairs = 'FOREIGN_AFFAIRS',
  SouthSea = 'SOUTH_SEA',
  WestFront = 'WEST_FRONT'
}

export type ArchiveVerticalCursorInput = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  vertical: ArchiveVertical;
};

export type ArchiveVerticalGroupModel = {
  __typename?: 'ArchiveVerticalGroupModel';
  displayName: Scalars['String']['output'];
  items: Array<ArchiveEventItemModel>;
  pageInfo: ArchiveVerticalPageInfoModel;
  totalCount: Scalars['Int']['output'];
  vertical: ArchiveVertical;
};

export type ArchiveVerticalPageInfoModel = {
  __typename?: 'ArchiveVerticalPageInfoModel';
  hasMore: Scalars['Boolean']['output'];
  nextCursor?: Maybe<Scalars['String']['output']>;
};

export enum ArchiveWeight {
  Five = 'FIVE',
  Four = 'FOUR',
  One = 'ONE',
  Three = 'THREE',
  Two = 'TWO'
}

export type ArticleEntityLinkModel = {
  __typename?: 'ArticleEntityLinkModel';
  articleId: Scalars['String']['output'];
  confidence?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  entity: KnowledgeGraphNodeModel;
  mention?: Maybe<Scalars['String']['output']>;
};

export type AssignRoleInput = {
  roleId: Scalars['String']['input'];
  userId: Scalars['String']['input'];
};

export type AssistantForecastInput = {
  confidenceLevel?: InputMaybe<Scalars['Float']['input']>;
  lookbackDays?: InputMaybe<Scalars['Int']['input']>;
  modelKind?: InputMaybe<AssistantForecastModelKind>;
  seasonalPeriod?: InputMaybe<Scalars['Int']['input']>;
  series: Scalars['String']['input'];
  sourceField?: InputMaybe<Scalars['String']['input']>;
};

export enum AssistantForecastModelKind {
  Arima = 'arima',
  Ets = 'ets'
}

export enum AssistantKnowledgeSource {
  SiteDb = 'site_db',
  WebSearch = 'web_search'
}

export enum AssistantLlmApiSurface {
  ChatCompletions = 'chat_completions',
  Responses = 'responses'
}

export type AssistantQueryInput = {
  conversationId?: InputMaybe<Scalars['String']['input']>;
  knowledgeSource?: InputMaybe<AssistantKnowledgeSource>;
  message: Scalars['String']['input'];
};

export type AssistantReportInput = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  period: AssistantReportPeriod;
  topic?: InputMaybe<Scalars['String']['input']>;
};

export enum AssistantReportPeriod {
  Daily = 'daily',
  Weekly = 'weekly'
}

export type AssistantRunModel = {
  __typename?: 'AssistantRunModel';
  conversationId?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  error?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  input?: Maybe<Scalars['JSON']['output']>;
  output?: Maybe<Scalars['JSON']['output']>;
  status: AssistantRunStatus;
  summary?: Maybe<Scalars['String']['output']>;
  type: AssistantRunType;
};

export enum AssistantRunStatus {
  Completed = 'completed',
  Failed = 'failed',
  Pending = 'pending',
  Running = 'running'
}

export enum AssistantRunType {
  Forecast = 'forecast',
  Query = 'query',
  Report = 'report'
}

export type AssistantRuntimeCapabilitiesModel = {
  __typename?: 'AssistantRuntimeCapabilitiesModel';
  apiSurface?: Maybe<AssistantLlmApiSurface>;
  assistantModel?: Maybe<Scalars['String']['output']>;
  webSearchSupported: Scalars['Boolean']['output'];
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

export type ClassificationQualitySettingsModel = {
  __typename?: 'ClassificationQualitySettingsModel';
  cacheTtlSeconds: Scalars['Int']['output'];
  embeddingP95LatencyWarnMs: Scalars['Int']['output'];
  gatePenalizedRateWarn: Scalars['Float']['output'];
  gateRejectRateWarn: Scalars['Float']['output'];
  llmP95LatencyWarnMs: Scalars['Int']['output'];
  lowConfidenceThreshold: Scalars['Float']['output'];
  reportMinPairCount: Scalars['Int']['output'];
  reportMinPairErrorRate: Scalars['Float']['output'];
  rerankP95LatencyWarnMs: Scalars['Int']['output'];
};

export type CommodityMoveImpactInput = {
  commodityName: Scalars['String']['input'];
  maxCandidates?: InputMaybe<Scalars['Int']['input']>;
};

export type CorrelationAnalysisInput = {
  changePercent: Scalars['Float']['input'];
  endDate: Scalars['String']['input'];
  indicatorName: Scalars['String']['input'];
  newsSummaries: Array<Scalars['String']['input']>;
  startDate: Scalars['String']['input'];
  value: Scalars['Float']['input'];
};

export enum CrawlAntiBotMode {
  Auto = 'AUTO',
  Disabled = 'DISABLED',
  Enabled = 'ENABLED'
}

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
  adaptiveConcurrencyEnabled: Scalars['Boolean']['output'];
  adaptiveCooldownMinutes: Scalars['Int']['output'];
  adaptiveErrorRateThreshold: Scalars['Float']['output'];
  adaptiveLatencyThresholdRatio: Scalars['Float']['output'];
  adaptiveMemoryHeadroomThreshold: Scalars['Float']['output'];
  adaptiveWindowMinutes: Scalars['Int']['output'];
  conditionalRequestEnabled: Scalars['Boolean']['output'];
  conditionalRequestMaxRetries: Scalars['Int']['output'];
  conditionalRequestTimeoutMs: Scalars['Int']['output'];
  detailPublishSignalHeadFetchConcurrency: Scalars['Int']['output'];
  detailPublishSignalHeadFetchMaxReadBytes: Scalars['Int']['output'];
  detailPublishSignalHeadFetchTimeoutMs: Scalars['Int']['output'];
  healthCheckTtlMs: Scalars['Int']['output'];
  maxRetries: Scalars['Int']['output'];
  queueOverloadCooldownMs: Scalars['Int']['output'];
  requestTimeoutHotMs: Scalars['Int']['output'];
  requestTimeoutMs: Scalars['Int']['output'];
  requestTimeoutNormalMs: Scalars['Int']['output'];
  retryBackoffMs: Scalars['Int']['output'];
};

export type CrawlDetailExpansionOptionsInput = {
  allowExternalLinks?: InputMaybe<Scalars['Boolean']['input']>;
  excludeUrlPatterns?: InputMaybe<Array<Scalars['String']['input']>>;
  includeUrlPatterns?: InputMaybe<Array<Scalars['String']['input']>>;
  maxDetailUrls?: InputMaybe<Scalars['Int']['input']>;
  minPublishTimeConfidence?: InputMaybe<Scalars['Float']['input']>;
  minRelevanceScore?: InputMaybe<Scalars['Float']['input']>;
  preferFitMarkdownForQuality?: InputMaybe<Scalars['Boolean']['input']>;
  requireSameDomain?: InputMaybe<Scalars['Boolean']['input']>;
};

export type CrawlExecutionSummaryModel = {
  __typename?: 'CrawlExecutionSummaryModel';
  inserted: Scalars['Float']['output'];
  itemsQueueFailed?: Maybe<Scalars['Float']['output']>;
  itemsQueued?: Maybe<Scalars['Float']['output']>;
  lastFetchedAt?: Maybe<Scalars['DateTime']['output']>;
  retryableFailures?: Maybe<Scalars['Float']['output']>;
  runId?: Maybe<Scalars['String']['output']>;
  skipped: Scalars['Float']['output'];
};

export type CrawlGeolocationInput = {
  accuracy?: InputMaybe<Scalars['Float']['input']>;
  latitude: Scalars['Float']['input'];
  longitude: Scalars['Float']['input'];
};

export type CrawlIngestBatchModel = {
  __typename?: 'CrawlIngestBatchModel';
  attempted: Scalars['Float']['output'];
  failed: Scalars['Float']['output'];
  hasMore: Scalars['Boolean']['output'];
  ingested: Scalars['Float']['output'];
  nextCursor?: Maybe<Scalars['String']['output']>;
  scanned: Scalars['Float']['output'];
  skippedExisting: Scalars['Float']['output'];
  taskId: Scalars['ID']['output'];
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
  bm25Threshold?: InputMaybe<Scalars['Float']['input']>;
  language?: InputMaybe<Scalars['String']['input']>;
  minWordThreshold?: InputMaybe<Scalars['Int']['input']>;
  threshold?: InputMaybe<Scalars['Float']['input']>;
  thresholdType?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<Scalars['String']['input']>;
  userQuery?: InputMaybe<Scalars['String']['input']>;
};

export type CrawlMarkdownOptionsInput = {
  bodyWidth?: InputMaybe<Scalars['Int']['input']>;
  citations?: InputMaybe<Scalars['Boolean']['input']>;
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
  antiBotMode?: InputMaybe<CrawlAntiBotMode>;
  autoExpandDetails?: InputMaybe<Scalars['Boolean']['input']>;
  browserCookies?: InputMaybe<Array<CrawlBrowserCookieInput>>;
  browserHeaders?: InputMaybe<Array<CrawlBrowserHeaderInput>>;
  cleanMarkdown?: InputMaybe<CrawlCleanMarkdownInput>;
  delayBeforeReturnHtmlMs?: InputMaybe<Scalars['Int']['input']>;
  detailExpansion?: InputMaybe<CrawlDetailExpansionOptionsInput>;
  enableStealthMode?: InputMaybe<Scalars['Boolean']['input']>;
  enableUndetectedBrowser?: InputMaybe<Scalars['Boolean']['input']>;
  excludeExternalImages?: InputMaybe<Scalars['Boolean']['input']>;
  extractLinks?: InputMaybe<Scalars['Boolean']['input']>;
  geolocation?: InputMaybe<CrawlGeolocationInput>;
  headless?: InputMaybe<Scalars['Boolean']['input']>;
  includeImages?: InputMaybe<Scalars['Boolean']['input']>;
  jsCode?: InputMaybe<Array<Scalars['String']['input']>>;
  jsOnly?: InputMaybe<Scalars['Boolean']['input']>;
  linkPreview?: InputMaybe<CrawlLinkPreviewInput>;
  locale?: InputMaybe<Scalars['String']['input']>;
  markdownFilter?: InputMaybe<CrawlMarkdownFilterInput>;
  markdownOptions?: InputMaybe<CrawlMarkdownOptionsInput>;
  markdownStrategy?: InputMaybe<CrawlMarkdownStrategyInput>;
  maxDelayRangeMs?: InputMaybe<Scalars['Int']['input']>;
  meanDelayMs?: InputMaybe<Scalars['Int']['input']>;
  multiUrlConfigs?: InputMaybe<Array<CrawlMultiUrlStrategyInput>>;
  onlyMainContent?: InputMaybe<Scalars['Boolean']['input']>;
  overrideNavigator?: InputMaybe<Scalars['Boolean']['input']>;
  pageTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  pageTypeHint?: InputMaybe<Scalars['String']['input']>;
  proxyConfig?: InputMaybe<CrawlProxyConfigInput>;
  proxyUrl?: InputMaybe<Scalars['String']['input']>;
  qualityProfile?: InputMaybe<Scalars['String']['input']>;
  removeForms?: InputMaybe<Scalars['Boolean']['input']>;
  scanFullPage?: InputMaybe<Scalars['Boolean']['input']>;
  scoreLinks?: InputMaybe<Scalars['Boolean']['input']>;
  scrollDelayMs?: InputMaybe<Scalars['Int']['input']>;
  semaphoreCount?: InputMaybe<Scalars['Int']['input']>;
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
  virtualScroll?: InputMaybe<CrawlVirtualScrollInput>;
  waitForImages?: InputMaybe<Scalars['Boolean']['input']>;
  waitForScript?: InputMaybe<Scalars['String']['input']>;
  waitForSelector?: InputMaybe<Scalars['String']['input']>;
  waitForTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  waitUntil?: InputMaybe<CrawlWaitUntil>;
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
  itemId?: Maybe<Scalars['ID']['output']>;
  itemStatus?: Maybe<Scalars['String']['output']>;
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
  autoExpandDetails?: InputMaybe<Scalars['Boolean']['input']>;
  cacheMode?: InputMaybe<Scalars['String']['input']>;
  captureScreenshot?: InputMaybe<Scalars['Boolean']['input']>;
  cssSelector?: InputMaybe<Scalars['String']['input']>;
  delayBeforeReturnHtmlMs?: InputMaybe<Scalars['Int']['input']>;
  detailExpansion?: InputMaybe<CrawlDetailExpansionOptionsInput>;
  excludeExternalImages?: InputMaybe<Scalars['Boolean']['input']>;
  excludeExternalLinks?: InputMaybe<Scalars['Boolean']['input']>;
  excludedTags?: InputMaybe<Array<Scalars['String']['input']>>;
  extractLinks?: InputMaybe<Scalars['Boolean']['input']>;
  jsCode?: InputMaybe<Array<Scalars['String']['input']>>;
  jsOnly?: InputMaybe<Scalars['Boolean']['input']>;
  maxDelayRangeMs?: InputMaybe<Scalars['Int']['input']>;
  meanDelayMs?: InputMaybe<Scalars['Int']['input']>;
  onlyMainContent?: InputMaybe<Scalars['Boolean']['input']>;
  overrideNavigator?: InputMaybe<Scalars['Boolean']['input']>;
  pageTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  pageTypeHint?: InputMaybe<Scalars['String']['input']>;
  processIframes?: InputMaybe<Scalars['Boolean']['input']>;
  qualityProfile?: InputMaybe<Scalars['String']['input']>;
  removeForms?: InputMaybe<Scalars['Boolean']['input']>;
  removeOverlayElements?: InputMaybe<Scalars['Boolean']['input']>;
  scanFullPage?: InputMaybe<Scalars['Boolean']['input']>;
  scrollDelayMs?: InputMaybe<Scalars['Int']['input']>;
  semaphoreCount?: InputMaybe<Scalars['Int']['input']>;
  simulateUser?: InputMaybe<Scalars['Boolean']['input']>;
  textMode?: InputMaybe<Scalars['Boolean']['input']>;
  virtualScroll?: InputMaybe<CrawlVirtualScrollInput>;
  waitForImages?: InputMaybe<Scalars['Boolean']['input']>;
  waitForScript?: InputMaybe<Scalars['String']['input']>;
  waitForSelector?: InputMaybe<Scalars['String']['input']>;
  waitForTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  waitUntil?: InputMaybe<CrawlWaitUntil>;
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
  lastRunSummary?: Maybe<CrawlExecutionSummaryModel>;
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

export type CrawlVirtualScrollInput = {
  containerSelector?: InputMaybe<Scalars['String']['input']>;
  scrollBy?: InputMaybe<Scalars['String']['input']>;
  scrollCount?: InputMaybe<Scalars['Int']['input']>;
  waitAfterScrollMs?: InputMaybe<Scalars['Int']['input']>;
};

export enum CrawlWaitUntil {
  Commit = 'COMMIT',
  Domcontentloaded = 'DOMCONTENTLOADED',
  Load = 'LOAD',
  Networkidle = 'NETWORKIDLE'
}

export type CreateCrawlTaskInput = {
  concurrency?: InputMaybe<Scalars['Int']['input']>;
  displayName?: InputMaybe<Scalars['String']['input']>;
  ingestToItems?: InputMaybe<Scalars['Boolean']['input']>;
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

export type CreateRoleInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  permissions: Array<Scalars['String']['input']>;
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

export enum EconomicDashboardRefreshPreset {
  EconomicAlert = 'economicAlert',
  EconomicLong = 'economicLong',
  EconomicMedium = 'economicMedium',
  EconomicShort = 'economicShort',
  KeyMonitor = 'keyMonitor',
  LivelihoodPrices = 'livelihoodPrices',
  MilitaryAlert = 'militaryAlert'
}

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
  defaultUnit?: Maybe<Scalars['String']['output']>;
  displayName: Scalars['String']['output'];
  groupLabel?: Maybe<Scalars['String']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  slug: Scalars['String']['output'];
};

export type EconomicDataPointModel = {
  __typename?: 'EconomicDataPointModel';
  dataType: EconomicDataValueType;
  /** Effective aggregation granularity agreed by the backend and used to produce this time series. */
  effectiveGranularity: TimeGranularity;
  item: EconomicDataItemModel;
  sourceField?: Maybe<Scalars['String']['output']>;
  timestamp: Scalars['DateTime']['output'];
  unit?: Maybe<Scalars['String']['output']>;
  value: Scalars['Float']['output'];
};

export type EconomicDataRefreshPresetStatusModel = {
  __typename?: 'EconomicDataRefreshPresetStatusModel';
  categoryKey: Scalars['String']['output'];
  enabledItems: Scalars['Int']['output'];
  lastError?: Maybe<Scalars['String']['output']>;
  lastRunAt?: Maybe<Scalars['DateTime']['output']>;
  lastStatus?: Maybe<EconomicDataRunStatus>;
  preset: EconomicDashboardRefreshPreset;
  totalItems: Scalars['Int']['output'];
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

export type EconomicDataWithInsightsModel = {
  __typename?: 'EconomicDataWithInsightsModel';
  insights: Array<EconomicSeriesInsightModel>;
  points: Array<EconomicDataPointModel>;
};

export enum EconomicInsightClassification {
  Anomaly = 'anomaly',
  InsufficientData = 'insufficient_data',
  Stable = 'stable',
  Trend = 'trend',
  Volatility = 'volatility'
}

export enum EconomicInsightDirection {
  Down = 'down',
  Flat = 'flat',
  Up = 'up'
}

export type EconomicSeriesInsightModel = {
  __typename?: 'EconomicSeriesInsightModel';
  change?: Maybe<Scalars['Float']['output']>;
  classification: EconomicInsightClassification;
  currentValue?: Maybe<Scalars['Float']['output']>;
  direction: EconomicInsightDirection;
  itemSlug: Scalars['String']['output'];
  mean?: Maybe<Scalars['Float']['output']>;
  message: Scalars['String']['output'];
  percentChange?: Maybe<Scalars['Float']['output']>;
  previousValue?: Maybe<Scalars['Float']['output']>;
  sampleCount: Scalars['Int']['output'];
  seriesKey: Scalars['String']['output'];
  sourceField?: Maybe<Scalars['String']['output']>;
  stdDev?: Maybe<Scalars['Float']['output']>;
  unit?: Maybe<Scalars['String']['output']>;
  zScore?: Maybe<Scalars['Float']['output']>;
};

export type EconomicSeriesSuggestion = {
  __typename?: 'EconomicSeriesSuggestion';
  description?: Maybe<Scalars['String']['output']>;
  displayName: Scalars['String']['output'];
  docUrl?: Maybe<Scalars['String']['output']>;
  slug: Scalars['String']['output'];
};

export type EntityImpactGraphInput = {
  /** Restrict graph to categories (person, organization, stock, commodity) */
  categories?: InputMaybe<Array<Scalars['String']['input']>>;
  /** End date for data range */
  endDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Maximum number of nodes to return */
  maxNodes?: InputMaybe<Scalars['Int']['input']>;
  /** Minimum co-occurrence count between entities */
  minCoOccurrence?: InputMaybe<Scalars['Int']['input']>;
  /** Minimum entity confidence threshold (0-1) */
  minConfidence?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum absolute correlation threshold (0-1) */
  minCorrelation?: InputMaybe<Scalars['Float']['input']>;
  /** Start date for data range */
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type EntityImpactGraphModel = {
  __typename?: 'EntityImpactGraphModel';
  /** Graph links/edges representing relationships */
  links: Array<EntityImpactLinkModel>;
  /** Graph metadata */
  metadata: EntityImpactMetadataModel;
  /** Graph nodes (entities and financial instruments) */
  nodes: Array<EntityImpactNodeModel>;
};

export type EntityImpactGraphSettingsModel = {
  __typename?: 'EntityImpactGraphSettingsModel';
  cacheTtlSeconds: Scalars['Int']['output'];
  categories: Array<Scalars['String']['output']>;
  enabled: Scalars['Boolean']['output'];
  maxNodes: Scalars['Int']['output'];
  minCoOccurrence: Scalars['Int']['output'];
  minCorrelation: Scalars['Float']['output'];
  minEntityConfidence: Scalars['Float']['output'];
};

export type EntityImpactLinkModel = {
  __typename?: 'EntityImpactLinkModel';
  /** Source node ID */
  source: Scalars['String']['output'];
  /** Target node ID */
  target: Scalars['String']['output'];
  /** Relationship type (e.g., co-occurrence, correlation) */
  type: Scalars['String']['output'];
  /** Link strength/weight */
  value: Scalars['Float']['output'];
};

export type EntityImpactMetadataModel = {
  __typename?: 'EntityImpactMetadataModel';
  /** Timestamp when the graph was generated */
  generatedAt: Scalars['DateTime']['output'];
  /** Total number of links in the graph */
  totalLinks: Scalars['Int']['output'];
  /** Total number of nodes in the graph */
  totalNodes: Scalars['Int']['output'];
};

export type EntityImpactNodeModel = {
  __typename?: 'EntityImpactNodeModel';
  /** Node category (e.g., entity, financial) */
  category: Scalars['String']['output'];
  /** Unique node identifier */
  id: Scalars['String']['output'];
  /** Display name of the node */
  name: Scalars['String']['output'];
  /** Node type (e.g., PERSON, ORG, STOCK, COMMODITY) */
  type: Scalars['String']['output'];
  /** Node value/weight for visualization sizing */
  value: Scalars['Float']['output'];
};

export type EntitySentimentSnapshotModel = {
  __typename?: 'EntitySentimentSnapshotModel';
  avgScore: Scalars['Float']['output'];
  bucketStart: Scalars['DateTime']['output'];
  entityName: Scalars['String']['output'];
  entityType: Scalars['String']['output'];
  evidenceProcessedItemIds?: Maybe<Scalars['JSON']['output']>;
  negativeDocs: Scalars['Int']['output'];
  negativeRatio: Scalars['Float']['output'];
  neutralDocs: Scalars['Int']['output'];
  positiveDocs: Scalars['Int']['output'];
  scoreSum: Scalars['Int']['output'];
  totalDocs: Scalars['Int']['output'];
};

export type EventGroupItemModel = {
  __typename?: 'EventGroupItemModel';
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  itemMetaId: Scalars['String']['output'];
  publishedAt?: Maybe<Scalars['String']['output']>;
  source?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
};

export type EventGroupModel = {
  __typename?: 'EventGroupModel';
  count: Scalars['Int']['output'];
  entities: Array<Scalars['String']['output']>;
  eventId: Scalars['String']['output'];
  items: Array<EventGroupItemModel>;
  latestAt: Scalars['DateTime']['output'];
  publishedAt?: Maybe<Scalars['String']['output']>;
  source?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  topics: Array<Scalars['String']['output']>;
};

export type ExecutiveChangeImpactInput = {
  companyName: Scalars['String']['input'];
  maxCandidates?: InputMaybe<Scalars['Int']['input']>;
};

export type GeoTransportAnalysisInput = {
  bbox?: InputMaybe<Array<Scalars['Float']['input']>>;
  endDate: Scalars['String']['input'];
  objectKeys?: InputMaybe<Array<Scalars['String']['input']>>;
  startDate: Scalars['String']['input'];
  transportKinds: Array<GeoTransportKind>;
};

export enum GeoTransportKind {
  Aircraft = 'aircraft',
  Vessel = 'vessel'
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

export type ItemFacetOption = {
  __typename?: 'ItemFacetOption';
  count: Scalars['Int']['output'];
  value: Scalars['String']['output'];
};

export type ItemFacets = {
  __typename?: 'ItemFacets';
  contentTypes: Array<ItemFacetOption>;
  regions: Array<ItemFacetOption>;
  sentiments: Array<ItemFacetOption>;
  topics: Array<ItemFacetOption>;
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
  /** Item ingested time (record createdAt) */
  ingestedAt: Scalars['DateTime']['output'];
  meta: ItemMetaModel;
  orgId: Scalars['String']['output'];
  processed?: Maybe<ProcessedItemModelGraph>;
  processedPreview?: Maybe<ProcessedItemPreviewModelGraph>;
  /** Content published time (ISO8601) */
  publishedAt?: Maybe<Scalars['String']['output']>;
  raw?: Maybe<RawItemModelGraph>;
  rawPreview?: Maybe<RawItemPreviewModelGraph>;
  /** Search relevance score (0-1) when rankingMode is RELEVANCE. */
  relevanceScore?: Maybe<Scalars['Float']['output']>;
  status: Scalars['String']['output'];
  title: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type ItemsDateRangeInput = {
  end?: InputMaybe<Scalars['DateTime']['input']>;
  start?: InputMaybe<Scalars['DateTime']['input']>;
};

export type ItemsFiltersInput = {
  contentTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  dateRange?: InputMaybe<ItemsDateRangeInput>;
  excludeDuplicates?: InputMaybe<Scalars['Boolean']['input']>;
  regions?: InputMaybe<Array<Scalars['String']['input']>>;
  sentiments?: InputMaybe<Array<Scalars['String']['input']>>;
  sourceIds?: InputMaybe<Array<Scalars['String']['input']>>;
  topics?: InputMaybe<Array<Scalars['String']['input']>>;
};

export enum ItemsOrderBy {
  CreatedDesc = 'CREATED_DESC',
  Personalized = 'PERSONALIZED',
  PublishedDesc = 'PUBLISHED_DESC'
}

export enum ItemsRankingMode {
  Recency = 'RECENCY',
  Relevance = 'RELEVANCE'
}

export type KnowledgeGraphEdgeModel = {
  __typename?: 'KnowledgeGraphEdgeModel';
  confidence: Scalars['Float']['output'];
  from: Scalars['String']['output'];
  id: Scalars['String']['output'];
  properties?: Maybe<Scalars['JSON']['output']>;
  to: Scalars['String']['output'];
  type: Scalars['String']['output'];
  weight: Scalars['Float']['output'];
};

export type KnowledgeGraphEvidenceReviewItemModel = {
  __typename?: 'KnowledgeGraphEvidenceReviewItemModel';
  article: KnowledgeGraphReviewArticleModel;
  confidence?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  edge: KnowledgeGraphReviewEdgeModel;
  evidence?: Maybe<Scalars['JSON']['output']>;
  extractorVersion?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
};

export type KnowledgeGraphExplainChainModel = {
  __typename?: 'KnowledgeGraphExplainChainModel';
  edges: Array<KnowledgeGraphEdgeModel>;
  nodes: Array<KnowledgeGraphNodeModel>;
  reason: Scalars['String']['output'];
};

export type KnowledgeGraphImpactAnalysisModel = {
  __typename?: 'KnowledgeGraphImpactAnalysisModel';
  candidates: Array<KnowledgeGraphImpactCandidateModel>;
  generatedAt: Scalars['DateTime']['output'];
  metadata?: Maybe<Scalars['JSON']['output']>;
  scenario: Scalars['String']['output'];
  seed: KnowledgeGraphNodeModel;
};

export type KnowledgeGraphImpactCandidateModel = {
  __typename?: 'KnowledgeGraphImpactCandidateModel';
  chains: Array<KnowledgeGraphExplainChainModel>;
  entity: KnowledgeGraphNodeModel;
  kind: Scalars['String']['output'];
  score: Scalars['Float']['output'];
};

export type KnowledgeGraphMetadataModel = {
  __typename?: 'KnowledgeGraphMetadataModel';
  generatedAt: Scalars['DateTime']['output'];
  totalEdges: Scalars['Int']['output'];
  totalNodes: Scalars['Int']['output'];
};

export type KnowledgeGraphModel = {
  __typename?: 'KnowledgeGraphModel';
  edges: Array<KnowledgeGraphEdgeModel>;
  metadata: KnowledgeGraphMetadataModel;
  nodes: Array<KnowledgeGraphNodeModel>;
  seed: KnowledgeGraphNodeModel;
};

export type KnowledgeGraphNodeModel = {
  __typename?: 'KnowledgeGraphNodeModel';
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
  properties?: Maybe<Scalars['JSON']['output']>;
  type: Scalars['String']['output'];
};

export type KnowledgeGraphReviewArticleModel = {
  __typename?: 'KnowledgeGraphReviewArticleModel';
  crawlAt: Scalars['DateTime']['output'];
  id: Scalars['String']['output'];
  language?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  url: Scalars['String']['output'];
};

export type KnowledgeGraphReviewEdgeModel = {
  __typename?: 'KnowledgeGraphReviewEdgeModel';
  confidence: Scalars['Float']['output'];
  fromEntity: KnowledgeGraphNodeModel;
  id: Scalars['String']['output'];
  properties?: Maybe<Scalars['JSON']['output']>;
  toEntity: KnowledgeGraphNodeModel;
  type: Scalars['String']['output'];
  weight: Scalars['Float']['output'];
};

export type KnowledgeGraphSettingsModel = {
  __typename?: 'KnowledgeGraphSettingsModel';
  cacheTtlSeconds: Scalars['Int']['output'];
  dynamicEdgeConfidenceEnabled: Scalars['Boolean']['output'];
  dynamicEdgeConfidenceQuantile: Scalars['Float']['output'];
  enabled: Scalars['Boolean']['output'];
  entityDisambiguationEnabled: Scalars['Boolean']['output'];
  entityDisambiguationMaxCandidates: Scalars['Int']['output'];
  ingestionEnabled: Scalars['Boolean']['output'];
  maxBatchSize: Scalars['Int']['output'];
  maxRelationsPerArticle: Scalars['Int']['output'];
  minEdgeConfidence: Scalars['Float']['output'];
  multiModelValidationEnabled: Scalars['Boolean']['output'];
  multiModelValidationMaxRelationsPerArticle: Scalars['Int']['output'];
  multiModelValidationModelCount: Scalars['Int']['output'];
  multiModelValidationModels: Array<Scalars['String']['output']>;
};

export type KnowledgeGraphSubgraphInput = {
  /** Max BFS depth */
  maxDepth?: InputMaybe<Scalars['Int']['input']>;
  /** Max nodes returned */
  maxNodes?: InputMaybe<Scalars['Int']['input']>;
  /** Restrict edge types */
  relationTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Seed entity name */
  seedName: Scalars['String']['input'];
  /** Optional seed entity type override */
  seedType?: InputMaybe<Scalars['String']['input']>;
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
  createItemFromCrawlResult: ItemModel;
  createOrg: OrgModel;
  createRole: RoleModel;
  deleteAlertChannel: Scalars['Boolean']['output'];
  deleteAlertRule: Scalars['Boolean']['output'];
  deleteAssistantRun: Scalars['Boolean']['output'];
  deleteCrawlTask: Scalars['Boolean']['output'];
  deleteDashboard: Scalars['Boolean']['output'];
  ingestCrawlTaskResultsToItems: CrawlIngestBatchModel;
  markAllNotificationsRead: Scalars['Boolean']['output'];
  markNotificationRead?: Maybe<NotificationModel>;
  refreshNewsIndicatorAssociations: Scalars['Boolean']['output'];
  requestAnomalyExplanation: AnalysisResultModel;
  requestAssistantForecast: AssistantRunModel;
  requestAssistantQuery: AssistantRunModel;
  requestAssistantReport: AssistantRunModel;
  requestCorrelationAnalysis: AnalysisResultModel;
  requestGeoTransportAnalysis: AnalysisResultModel;
  resetNewsEventSourcePolicy: NewsEventSourcePolicySettingsModel;
  retryCrawlTask: CrawlTaskModel;
  reviewKnowledgeGraphEvidence?: Maybe<KnowledgeGraphEvidenceReviewItemModel>;
  rollbackNewsEventSourcePolicy: NewsEventSourcePolicySettingsModel;
  setOrgActive: OrgModel;
  setUserActive: UserModel;
  translateRssItems: TranslateRssItemsPayloadModel;
  triggerAlertRule: Scalars['Boolean']['output'];
  triggerDataFetch: Scalars['Boolean']['output'];
  triggerEconomicDataRefreshPreset: Scalars['Boolean']['output'];
  updateAlertChannel: AlertChannelModel;
  updateAlertEventStatus: AlertEventModel;
  updateAuditLogRetention: AuditLogRetentionModel;
  updateAuthCacheSettings: AuthCacheSettingsModel;
  updateClassificationQualitySettings: ClassificationQualitySettingsModel;
  updateCrawlClientSettings: CrawlClientSettingsModel;
  updateCrawlTaskIngestToItems: CrawlTaskModel;
  updateEconomicDataFetchConfig: EconomicDataFetchConfigModel;
  updateEntityImpactGraphSettings: EntityImpactGraphSettingsModel;
  updateItem: ItemModel;
  updateKnowledgeGraphSettings: KnowledgeGraphSettingsModel;
  updateMembershipRoles: UserModel;
  updateNewsClassificationSettings: NewsClassificationSettingsModel;
  updateNewsDedupeSettings: NewsDedupeSettingsModel;
  updateNewsEventSettings: NewsEventSettingsModel;
  updateNewsEventSourcePolicy: NewsEventSourcePolicySettingsModel;
  updateNewsEventSourcePolicyPresets: NewsEventSourcePolicyPresetSettingsModel;
  updateNewsIndicatorSettings: NewsIndicatorSettingsModel;
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


export type MutationCreateItemFromCrawlResultArgs = {
  resultId: Scalars['String']['input'];
};


export type MutationCreateOrgArgs = {
  input: CreateOrgInput;
};


export type MutationCreateRoleArgs = {
  input: CreateRoleInput;
};


export type MutationDeleteAlertChannelArgs = {
  channelId: Scalars['String']['input'];
};


export type MutationDeleteAlertRuleArgs = {
  ruleId: Scalars['String']['input'];
};


export type MutationDeleteAssistantRunArgs = {
  runId: Scalars['String']['input'];
};


export type MutationDeleteCrawlTaskArgs = {
  id: Scalars['String']['input'];
};


export type MutationDeleteDashboardArgs = {
  id: Scalars['String']['input'];
};


export type MutationIngestCrawlTaskResultsToItemsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Float']['input']>;
  onlyMissing?: InputMaybe<Scalars['Boolean']['input']>;
  taskId: Scalars['String']['input'];
};


export type MutationMarkNotificationReadArgs = {
  id: Scalars['String']['input'];
};


export type MutationRequestAnomalyExplanationArgs = {
  input: AnomalyAnalysisInput;
};


export type MutationRequestAssistantForecastArgs = {
  input: AssistantForecastInput;
};


export type MutationRequestAssistantQueryArgs = {
  input: AssistantQueryInput;
};


export type MutationRequestAssistantReportArgs = {
  input: AssistantReportInput;
};


export type MutationRequestCorrelationAnalysisArgs = {
  input: CorrelationAnalysisInput;
};


export type MutationRequestGeoTransportAnalysisArgs = {
  input: GeoTransportAnalysisInput;
};


export type MutationResetNewsEventSourcePolicyArgs = {
  input: ResetNewsEventSourcePolicyInput;
};


export type MutationRetryCrawlTaskArgs = {
  id: Scalars['String']['input'];
};


export type MutationReviewKnowledgeGraphEvidenceArgs = {
  input: ReviewKnowledgeGraphEvidenceInput;
};


export type MutationRollbackNewsEventSourcePolicyArgs = {
  input: RollbackNewsEventSourcePolicyInput;
};


export type MutationSetOrgActiveArgs = {
  input: SetOrgActiveInput;
};


export type MutationSetUserActiveArgs = {
  input: SetUserActiveInput;
};


export type MutationTranslateRssItemsArgs = {
  input: TranslateRssItemsInput;
};


export type MutationTriggerAlertRuleArgs = {
  ruleId: Scalars['String']['input'];
};


export type MutationTriggerDataFetchArgs = {
  input: TriggerDataFetchInput;
};


export type MutationTriggerEconomicDataRefreshPresetArgs = {
  preset: EconomicDashboardRefreshPreset;
};


export type MutationUpdateAlertChannelArgs = {
  input: UpdateAlertChannelInput;
};


export type MutationUpdateAlertEventStatusArgs = {
  input: UpdateAlertEventStatusInput;
};


export type MutationUpdateAuditLogRetentionArgs = {
  input: UpdateAuditLogRetentionInput;
};


export type MutationUpdateAuthCacheSettingsArgs = {
  input: UpdateAuthCacheSettingsInput;
};


export type MutationUpdateClassificationQualitySettingsArgs = {
  input: UpdateClassificationQualitySettingsInput;
};


export type MutationUpdateCrawlClientSettingsArgs = {
  input: UpdateCrawlClientSettingsInput;
};


export type MutationUpdateCrawlTaskIngestToItemsArgs = {
  enabled: Scalars['Boolean']['input'];
  id: Scalars['String']['input'];
};


export type MutationUpdateEconomicDataFetchConfigArgs = {
  frequency?: InputMaybe<EconomicDataFrequency>;
  isEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  repeatCron?: InputMaybe<Scalars['String']['input']>;
  slug: Scalars['String']['input'];
};


export type MutationUpdateEntityImpactGraphSettingsArgs = {
  input: UpdateEntityImpactGraphSettingsInput;
};


export type MutationUpdateItemArgs = {
  input: UpdateItemInput;
};


export type MutationUpdateKnowledgeGraphSettingsArgs = {
  input: UpdateKnowledgeGraphSettingsInput;
};


export type MutationUpdateMembershipRolesArgs = {
  input: UpdateMembershipRolesInput;
};


export type MutationUpdateNewsClassificationSettingsArgs = {
  input: UpdateNewsClassificationSettingsInput;
};


export type MutationUpdateNewsDedupeSettingsArgs = {
  input: UpdateNewsDedupeSettingsInput;
};


export type MutationUpdateNewsEventSettingsArgs = {
  input: UpdateNewsEventSettingsInput;
};


export type MutationUpdateNewsEventSourcePolicyArgs = {
  input: UpdateNewsEventSourcePolicyInput;
};


export type MutationUpdateNewsEventSourcePolicyPresetsArgs = {
  input: UpdateNewsEventSourcePolicyPresetInput;
};


export type MutationUpdateNewsIndicatorSettingsArgs = {
  input: UpdateNewsIndicatorSettingsInput;
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

export type NewsClassificationSettingsModel = {
  __typename?: 'NewsClassificationSettingsModel';
  cacheTtlSeconds: Scalars['Int']['output'];
  embeddingTopK: Scalars['Int']['output'];
  enableEmbedding: Scalars['Boolean']['output'];
  enableLlm: Scalars['Boolean']['output'];
  enableRerank: Scalars['Boolean']['output'];
  enabled: Scalars['Boolean']['output'];
  llmModel?: Maybe<Scalars['String']['output']>;
  minConfidence: Scalars['Float']['output'];
  rerankTopN: Scalars['Int']['output'];
  strictFail: Scalars['Boolean']['output'];
  taxonomy: Array<NewsClassificationTaxonomyNodeModel>;
  taxonomyVersion: Scalars['String']['output'];
};

export type NewsClassificationTaxonomyNodeInput = {
  description: Scalars['String']['input'];
  displayName: Scalars['String']['input'];
  keywords?: InputMaybe<Array<Scalars['String']['input']>>;
  legacyCategory: Scalars['String']['input'];
  path: Scalars['String']['input'];
  synonyms?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type NewsClassificationTaxonomyNodeModel = {
  __typename?: 'NewsClassificationTaxonomyNodeModel';
  description: Scalars['String']['output'];
  displayName: Scalars['String']['output'];
  keywords: Array<Scalars['String']['output']>;
  legacyCategory: Scalars['String']['output'];
  path: Scalars['String']['output'];
  synonyms: Array<Scalars['String']['output']>;
};

export type NewsDedupeScopedThresholdInput = {
  categoryPath?: InputMaybe<Scalars['String']['input']>;
  language?: InputMaybe<Scalars['String']['input']>;
  sourceId?: InputMaybe<Scalars['String']['input']>;
  threshold: Scalars['Float']['input'];
};

export type NewsDedupeScopedThresholdModel = {
  __typename?: 'NewsDedupeScopedThresholdModel';
  categoryPath?: Maybe<Scalars['String']['output']>;
  language?: Maybe<Scalars['String']['output']>;
  sourceId?: Maybe<Scalars['String']['output']>;
  threshold: Scalars['Float']['output'];
};

export type NewsDedupeSettingsModel = {
  __typename?: 'NewsDedupeSettingsModel';
  defaultThreshold: Scalars['Float']['output'];
  llmJudgeCandidateChars: Scalars['Int']['output'];
  llmJudgeConcurrency: Scalars['Int']['output'];
  llmJudgeInstructions?: Maybe<Scalars['String']['output']>;
  llmJudgeMaxComparisons: Scalars['Int']['output'];
  llmJudgeModel?: Maybe<Scalars['String']['output']>;
  llmJudgePromptVersion: Scalars['String']['output'];
  llmJudgeSystemPromptTemplate: Scalars['String']['output'];
  llmJudgeUserPromptTemplate: Scalars['String']['output'];
  scopedThresholds: Array<NewsDedupeScopedThresholdModel>;
  useEmbeddings: Scalars['Boolean']['output'];
};

export type NewsEventArticleModel = {
  __typename?: 'NewsEventArticleModel';
  crawlAt: Scalars['DateTime']['output'];
  id: Scalars['String']['output'];
  sourceLabel?: Maybe<Scalars['String']['output']>;
  url: Scalars['String']['output'];
};

export enum NewsEventAssignmentMethod {
  Manual = 'manual',
  Overlap = 'overlap',
  Vector = 'vector'
}

export type NewsEventBriefComparisonModel = {
  __typename?: 'NewsEventBriefComparisonModel';
  consensus: Array<NewsEventBriefPointModel>;
  divergence: Array<NewsEventBriefPointModel>;
};

export type NewsEventBriefModel = {
  __typename?: 'NewsEventBriefModel';
  comparison?: Maybe<NewsEventBriefComparisonModel>;
  detailedSummary: Scalars['String']['output'];
  generatedAt: Scalars['DateTime']['output'];
  keyPoints: Array<NewsEventBriefPointModel>;
  language: Scalars['String']['output'];
  latestUpdate?: Maybe<NewsEventBriefPointModel>;
  limitations?: Maybe<Scalars['String']['output']>;
  sources: Array<NewsEventBriefSourceModel>;
  tldr: Scalars['String']['output'];
  version: Scalars['Int']['output'];
  whatToWatch: Array<NewsEventBriefPointModel>;
  whyItMatters: Array<NewsEventBriefPointModel>;
};

export type NewsEventBriefPointModel = {
  __typename?: 'NewsEventBriefPointModel';
  citations: Array<Scalars['Int']['output']>;
  text: Scalars['String']['output'];
};

export type NewsEventBriefSourceModel = {
  __typename?: 'NewsEventBriefSourceModel';
  index: Scalars['Int']['output'];
  processedArticleId?: Maybe<Scalars['String']['output']>;
  processedItemId?: Maybe<Scalars['String']['output']>;
  publishedAt?: Maybe<Scalars['DateTime']['output']>;
  sourceLabel?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  url: Scalars['String']['output'];
};

export type NewsEventItemModel = {
  __typename?: 'NewsEventItemModel';
  assignedBy: NewsEventAssignmentMethod;
  createdAt: Scalars['DateTime']['output'];
  eventId: Scalars['String']['output'];
  id: Scalars['String']['output'];
  itemMetaId?: Maybe<Scalars['String']['output']>;
  processedArticle: NewsEventProcessedArticleModel;
  processedArticleId: Scalars['String']['output'];
  processedItemId?: Maybe<Scalars['String']['output']>;
  similarity?: Maybe<Scalars['Float']['output']>;
};

export type NewsEventModel = {
  __typename?: 'NewsEventModel';
  /** Whether this event is considered breaking news */
  breaking: Scalars['Boolean']['output'];
  categoryDistribution?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  /** Credibility score based on source corroboration (0-100) */
  credibilityScore: Scalars['Float']['output'];
  /** Heat score indicating event urgency (0-10+) */
  heatScore: Scalars['Float']['output'];
  id: Scalars['String']['output'];
  itemCount: Scalars['Int']['output'];
  items?: Maybe<Array<NewsEventItemModel>>;
  language?: Maybe<Scalars['String']['output']>;
  lastAt: Scalars['DateTime']['output'];
  metadata?: Maybe<Scalars['JSON']['output']>;
  primaryEntity?: Maybe<Scalars['String']['output']>;
  primaryTopic?: Maybe<Scalars['String']['output']>;
  representativeProcessedArticleId?: Maybe<Scalars['String']['output']>;
  representativeProcessedItemId?: Maybe<Scalars['String']['output']>;
  /** Source corroboration evidence for explainability */
  sourceEvidence: NewsEventSourceEvidenceModel;
  /** Source classification for authority filtering */
  sourceType: NewsEventSourceType;
  startAt: Scalars['DateTime']['output'];
  status: NewsEventStatus;
  subEvents?: Maybe<Scalars['JSON']['output']>;
  summary?: Maybe<Scalars['String']['output']>;
  timeline?: Maybe<Array<NewsEventTimelineEntryModel>>;
  timelinePhases?: Maybe<Scalars['JSON']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  topicDriftSummary?: Maybe<Scalars['String']['output']>;
  topicDriftWarning?: Maybe<Scalars['Boolean']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type NewsEventProcessedArticleModel = {
  __typename?: 'NewsEventProcessedArticleModel';
  article: NewsEventArticleModel;
  articleId: Scalars['String']['output'];
  id: Scalars['String']['output'];
  language?: Maybe<Scalars['String']['output']>;
  processedAt: Scalars['DateTime']['output'];
  publishedAt?: Maybe<Scalars['DateTime']['output']>;
  summary?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
};

export type NewsEventReferencedArticleModel = {
  __typename?: 'NewsEventReferencedArticleModel';
  crawlAt: Scalars['DateTime']['output'];
  id: Scalars['String']['output'];
  processedArticleId: Scalars['String']['output'];
  processedAt: Scalars['DateTime']['output'];
  publishedAt?: Maybe<Scalars['DateTime']['output']>;
  sourceLabel?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  url: Scalars['String']['output'];
};

export type NewsEventSettingsModel = {
  __typename?: 'NewsEventSettingsModel';
  backfillDays: Scalars['Int']['output'];
  cacheTtlSeconds: Scalars['Int']['output'];
  categoryConflictReject: Scalars['Boolean']['output'];
  categorySoftPenalty: Scalars['Float']['output'];
  classificationGateEnabled: Scalars['Boolean']['output'];
  crossLanguagePenalty: Scalars['Float']['output'];
  enabled: Scalars['Boolean']['output'];
  forceAuthoritativeMode: Scalars['Boolean']['output'];
  forceMinAuthoritativeSources: Scalars['Int']['output'];
  ingestionEnabled: Scalars['Boolean']['output'];
  lookbackDays: Scalars['Int']['output'];
  maxBatchSize: Scalars['Int']['output'];
  minCategoryConfidenceForGate: Scalars['Float']['output'];
  timelineCrossCategoryWarningShare: Scalars['Float']['output'];
  timelineDriftKlThreshold: Scalars['Float']['output'];
  timelineEnabled: Scalars['Boolean']['output'];
  timelineHighConfidenceThreshold: Scalars['Float']['output'];
  timelineLowConfidenceThreshold: Scalars['Float']['output'];
  timelineMaxCategoryDistributionItems: Scalars['Int']['output'];
  timelineMaxEventsPerRun: Scalars['Int']['output'];
  timelineMaxPhaseSummaries: Scalars['Int']['output'];
  timelineMinBucketItemsForDrift: Scalars['Int']['output'];
  timelinePresetCustomDistanceThreshold: Scalars['Float']['output'];
  vectorMinScore: Scalars['Float']['output'];
};

export enum NewsEventSortBy {
  Credibility = 'credibility',
  Heat = 'heat',
  Latest = 'latest'
}

export type NewsEventSourceCategoryAuthorityDomainBoostInput = {
  delta: Scalars['Float']['input'];
  domain: Scalars['String']['input'];
};

export type NewsEventSourceCategoryAuthorityDomainBoostModel = {
  __typename?: 'NewsEventSourceCategoryAuthorityDomainBoostModel';
  delta: Scalars['Float']['output'];
  domain: Scalars['String']['output'];
};

export type NewsEventSourceCategoryAuthorityRuleInput = {
  authoritativeBoost: Scalars['Float']['input'];
  blogPenalty: Scalars['Float']['input'];
  categoryPrefix: Scalars['String']['input'];
  domainBoosts?: InputMaybe<Array<NewsEventSourceCategoryAuthorityDomainBoostInput>>;
  minConfidenceFloor?: InputMaybe<Scalars['Float']['input']>;
  mismatchPenalty?: InputMaybe<Scalars['Float']['input']>;
  unknownPenalty: Scalars['Float']['input'];
};

export type NewsEventSourceCategoryAuthorityRuleModel = {
  __typename?: 'NewsEventSourceCategoryAuthorityRuleModel';
  authoritativeBoost: Scalars['Float']['output'];
  blogPenalty: Scalars['Float']['output'];
  categoryPrefix: Scalars['String']['output'];
  domainBoosts: Array<NewsEventSourceCategoryAuthorityDomainBoostModel>;
  minConfidenceFloor: Scalars['Float']['output'];
  mismatchPenalty: Scalars['Float']['output'];
  unknownPenalty: Scalars['Float']['output'];
};

export type NewsEventSourceEvidenceModel = {
  __typename?: 'NewsEventSourceEvidenceModel';
  authoritativeSourceCount: Scalars['Int']['output'];
  blogSourceCount: Scalars['Int']['output'];
  corroborated: Scalars['Boolean']['output'];
  uniqueSourceCount: Scalars['Int']['output'];
};

export type NewsEventSourcePolicyConflictModel = {
  __typename?: 'NewsEventSourcePolicyConflictModel';
  domainConflicts: Array<Scalars['String']['output']>;
  hasConflicts: Scalars['Boolean']['output'];
  labelConflicts: Array<Scalars['String']['output']>;
};

export type NewsEventSourcePolicyDeltaModel = {
  __typename?: 'NewsEventSourcePolicyDeltaModel';
  authoritativeDomainsAdd: Array<Scalars['String']['output']>;
  authoritativeDomainsRemove: Array<Scalars['String']['output']>;
  authoritativeLabelsAdd: Array<Scalars['String']['output']>;
  authoritativeLabelsRemove: Array<Scalars['String']['output']>;
  blogDomainsAdd: Array<Scalars['String']['output']>;
  blogDomainsRemove: Array<Scalars['String']['output']>;
  blogLabelsAdd: Array<Scalars['String']['output']>;
  blogLabelsRemove: Array<Scalars['String']['output']>;
};

export type NewsEventSourcePolicyPresetSettingsModel = {
  __typename?: 'NewsEventSourcePolicyPresetSettingsModel';
  authoritativeDomains: Array<Scalars['String']['output']>;
  authoritativeLabels: Array<Scalars['String']['output']>;
  blogDomains: Array<Scalars['String']['output']>;
  blogLabels: Array<Scalars['String']['output']>;
  categoryAuthority: Array<NewsEventSourceCategoryAuthorityRuleModel>;
  syncWarnings: Array<Scalars['String']['output']>;
  updatedAt?: Maybe<Scalars['DateTime']['output']>;
};

export type NewsEventSourcePolicyRevisionDiffModel = {
  __typename?: 'NewsEventSourcePolicyRevisionDiffModel';
  authoritativeDomainsAdd: Array<Scalars['String']['output']>;
  authoritativeDomainsRemove: Array<Scalars['String']['output']>;
  authoritativeLabelsAdd: Array<Scalars['String']['output']>;
  authoritativeLabelsRemove: Array<Scalars['String']['output']>;
  baseRevision: Scalars['Int']['output'];
  blogDomainsAdd: Array<Scalars['String']['output']>;
  blogDomainsRemove: Array<Scalars['String']['output']>;
  blogLabelsAdd: Array<Scalars['String']['output']>;
  blogLabelsRemove: Array<Scalars['String']['output']>;
  targetRevision: Scalars['Int']['output'];
};

export type NewsEventSourcePolicyRevisionModel = {
  __typename?: 'NewsEventSourcePolicyRevisionModel';
  actorId?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  delta: NewsEventSourcePolicyDeltaModel;
  note?: Maybe<Scalars['String']['output']>;
  operation: NewsEventSourcePolicyRevisionOperation;
  revision: Scalars['Int']['output'];
};

export enum NewsEventSourcePolicyRevisionOperation {
  Reset = 'reset',
  Rollback = 'rollback',
  Update = 'update'
}

export type NewsEventSourcePolicySettingsModel = {
  __typename?: 'NewsEventSourcePolicySettingsModel';
  activeRevision: Scalars['Int']['output'];
  authoritativeDomains: Array<Scalars['String']['output']>;
  authoritativeLabels: Array<Scalars['String']['output']>;
  blogDomains: Array<Scalars['String']['output']>;
  blogLabels: Array<Scalars['String']['output']>;
  categoryAuthority: Array<NewsEventSourceCategoryAuthorityRuleModel>;
  overrides: NewsEventSourcePolicyDeltaModel;
  revisions: Array<NewsEventSourcePolicyRevisionModel>;
  syncWarnings: Array<Scalars['String']['output']>;
  updatedAt?: Maybe<Scalars['DateTime']['output']>;
  warnings: NewsEventSourcePolicyConflictModel;
};

export type NewsEventSourcePolicySyncStatusModel = {
  __typename?: 'NewsEventSourcePolicySyncStatusModel';
  degraded: Scalars['Boolean']['output'];
  forceAuthoritativeMode: Scalars['Boolean']['output'];
  forceMinAuthoritativeSources: Scalars['Int']['output'];
  policyCacheStale: Scalars['Boolean']['output'];
  presetCacheStale: Scalars['Boolean']['output'];
  warningCodes: Array<Scalars['String']['output']>;
};

export enum NewsEventSourceType {
  All = 'all',
  Authoritative = 'authoritative',
  Blog = 'blog',
  Mixed = 'mixed',
  Unknown = 'unknown'
}

export enum NewsEventStatus {
  Active = 'active',
  Archived = 'archived'
}

export type NewsEventTimelineEntryModel = {
  __typename?: 'NewsEventTimelineEntryModel';
  anchor?: Maybe<Scalars['Boolean']['output']>;
  bucketStart: Scalars['DateTime']['output'];
  categoryConfidence?: Maybe<Scalars['Float']['output']>;
  categoryPath?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  eventId: Scalars['String']['output'];
  id: Scalars['String']['output'];
  keyPoints?: Maybe<Scalars['JSON']['output']>;
  referencedArticleIds?: Maybe<Scalars['JSON']['output']>;
  summary?: Maybe<Scalars['String']['output']>;
  tentative?: Maybe<Scalars['Boolean']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type NewsIndicatorAssociationBacktestRunModel = {
  __typename?: 'NewsIndicatorAssociationBacktestRunModel';
  config?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  error?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  metrics?: Maybe<Scalars['JSON']['output']>;
  status: NewsIndicatorBacktestStatus;
  updatedAt: Scalars['DateTime']['output'];
  windowEnd: Scalars['DateTime']['output'];
  windowStart: Scalars['DateTime']['output'];
};

export type NewsIndicatorAssociationModel = {
  __typename?: 'NewsIndicatorAssociationModel';
  analyzedEndAt: Scalars['DateTime']['output'];
  analyzedStartAt: Scalars['DateTime']['output'];
  backtests?: Maybe<Array<NewsIndicatorAssociationBacktestRunModel>>;
  correlation: Scalars['Float']['output'];
  featureMetric: NewsIndicatorFeatureMetric;
  id: Scalars['String']['output'];
  indicator: EconomicDataItemModel;
  lagDays: Scalars['Int']['output'];
  lastEvaluatedAt: Scalars['DateTime']['output'];
  latestBacktest?: Maybe<NewsIndicatorAssociationBacktestRunModel>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  pValue?: Maybe<Scalars['Float']['output']>;
  sampleSize: Scalars['Int']['output'];
  scopeKey: Scalars['String']['output'];
  scopeKeyType: Scalars['String']['output'];
  scopeType: NewsIndicatorScopeType;
  windowDays: Scalars['Int']['output'];
};

export enum NewsIndicatorBacktestStatus {
  Completed = 'completed',
  Failed = 'failed',
  Pending = 'pending',
  Running = 'running'
}

export enum NewsIndicatorFeatureMetric {
  AvgScore = 'avg_score',
  NegativeRatio = 'negative_ratio',
  Volume = 'volume'
}

export enum NewsIndicatorScopeType {
  Entity = 'entity',
  Topic = 'topic'
}

export type NewsIndicatorSettingsModel = {
  __typename?: 'NewsIndicatorSettingsModel';
  backtestBaselineDays: Scalars['Int']['output'];
  backtestHoldoutDays: Scalars['Int']['output'];
  backtestTriggerZScore: Scalars['Float']['output'];
  cacheTtlSeconds: Scalars['Int']['output'];
  enabled: Scalars['Boolean']['output'];
  indicatorSlugs: Array<Scalars['String']['output']>;
  ingestionEnabled: Scalars['Boolean']['output'];
  maxAssociationsPerIndicator: Scalars['Int']['output'];
  maxLagDays: Scalars['Int']['output'];
  maxPValue: Scalars['Float']['output'];
  minAbsCorrelation: Scalars['Float']['output'];
  minSampleSize: Scalars['Int']['output'];
  topEntities: Scalars['Int']['output'];
  topTopics: Scalars['Int']['output'];
  windowDays: Scalars['Int']['output'];
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

/** Paginated economic data points result */
export type PaginatedEconomicDataPointsModel = {
  __typename?: 'PaginatedEconomicDataPointsModel';
  /** Array of economic data points */
  data: Array<EconomicDataPointModel>;
  /** Pagination metadata */
  pagination: PaginationMetaModel;
};

export type PaginationInput = {
  /** Cursor for pagination */
  cursor?: InputMaybe<Scalars['String']['input']>;
  /** Number of items to return (default: 100, max: 1000) */
  limit?: InputMaybe<Scalars['Int']['input']>;
};

/** Pagination metadata for cursor-based pagination */
export type PaginationMetaModel = {
  __typename?: 'PaginationMetaModel';
  /** Whether there are more results available */
  hasMore: Scalars['Boolean']['output'];
  /** Cursor for fetching the next page */
  nextCursor?: Maybe<Scalars['String']['output']>;
  /** Total count of items (optional) */
  totalCount?: Maybe<Scalars['Int']['output']>;
};

export type PermissionModel = {
  __typename?: 'PermissionModel';
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

export type PolicyEventImpactInput = {
  includeLprSnapshot?: InputMaybe<Scalars['Boolean']['input']>;
  maxCandidates?: InputMaybe<Scalars['Int']['input']>;
  policyName: Scalars['String']['input'];
};

export type ProcessedItemErrorModelGraph = {
  __typename?: 'ProcessedItemErrorModelGraph';
  message: Scalars['String']['output'];
  name?: Maybe<Scalars['String']['output']>;
};

export type ProcessedItemLlmModel = {
  __typename?: 'ProcessedItemLlmModel';
  completionTokens?: Maybe<Scalars['Float']['output']>;
  costUsd?: Maybe<Scalars['Float']['output']>;
  latencyMs?: Maybe<Scalars['Float']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  promptTokens?: Maybe<Scalars['Float']['output']>;
  promptVersion?: Maybe<Scalars['String']['output']>;
  totalTokens?: Maybe<Scalars['Float']['output']>;
};

export type ProcessedItemModelGraph = {
  __typename?: 'ProcessedItemModelGraph';
  createdAt: Scalars['DateTime']['output'];
  duplicateOf?: Maybe<Scalars['String']['output']>;
  duplicateSimilarity?: Maybe<Scalars['Float']['output']>;
  error?: Maybe<ProcessedItemErrorModelGraph>;
  /** Associated news event ID */
  eventId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  itemMetaId: Scalars['String']['output'];
  llm?: Maybe<ProcessedItemLlmModel>;
  result?: Maybe<Scalars['String']['output']>;
  /** Processed result JSON object */
  resultJson?: Maybe<Scalars['JSON']['output']>;
  status: Scalars['String']['output'];
  /** Summary embedding vector dimensions */
  summaryEmbeddingDimensions?: Maybe<Scalars['Int']['output']>;
  /** Embedding model used for summary dedupe */
  summaryEmbeddingModel?: Maybe<Scalars['String']['output']>;
  tags: Array<Scalars['String']['output']>;
};

export type ProcessedItemPreviewModelGraph = {
  __typename?: 'ProcessedItemPreviewModelGraph';
  contentType?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  duplicateOf?: Maybe<Scalars['String']['output']>;
  duplicateSimilarity?: Maybe<Scalars['Float']['output']>;
  entities: Array<Scalars['String']['output']>;
  /** Associated news event ID */
  eventId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  itemMetaId: Scalars['String']['output'];
  language?: Maybe<Scalars['String']['output']>;
  llm?: Maybe<ProcessedItemLlmModel>;
  location?: Maybe<Scalars['String']['output']>;
  /** Content published time (ISO8601) */
  publishedAt?: Maybe<Scalars['String']['output']>;
  qualityScore?: Maybe<Scalars['Float']['output']>;
  sentiment?: Maybe<Scalars['String']['output']>;
  source?: Maybe<Scalars['String']['output']>;
  status: Scalars['String']['output'];
  summary?: Maybe<Scalars['String']['output']>;
  tags: Array<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  topics: Array<Scalars['String']['output']>;
};

export type Query = {
  __typename?: 'Query';
  alertChannels: Array<AlertChannelModel>;
  alertEventReplay?: Maybe<AlertEventReplayModel>;
  alertEvents: Array<AlertEventModel>;
  alertRuleTuningSuggestion?: Maybe<AlertRuleTuningSuggestionModel>;
  alertRules: Array<AlertRuleModel>;
  analysisResults: Array<AnalysisResultModel>;
  archiveCalendar: Array<ArchiveCalendarDayModel>;
  archiveDetail?: Maybe<ArchiveDetailModel>;
  archiveDigest: ArchiveDigestModel;
  articleEntityLinks: Array<ArticleEntityLinkModel>;
  assistantEconomicSeriesSuggestions: Array<EconomicSeriesSuggestion>;
  assistantRuns: Array<AssistantRunModel>;
  assistantRuntimeCapabilities: AssistantRuntimeCapabilitiesModel;
  auditLogRetention: AuditLogRetentionModel;
  authCacheSettings: AuthCacheSettingsModel;
  classificationQualitySettings: ClassificationQualitySettingsModel;
  crawlClientSettings: CrawlClientSettingsModel;
  crawlMetadata: Array<CrawlMetadataResultModel>;
  crawlTask?: Maybe<CrawlTaskModel>;
  crawlTasks: CrawlTaskConnection;
  dashboards: Array<DashboardModel>;
  economicDataFetchConfigs: Array<EconomicDataFetchConfigModel>;
  economicDataRefreshPresetStatus: EconomicDataRefreshPresetStatusModel;
  entityImpactGraphSettings: EntityImpactGraphSettingsModel;
  entitySentimentSeries: Array<EntitySentimentSnapshotModel>;
  eventGroups: Array<EventGroupModel>;
  getCommodityMoveImpact?: Maybe<KnowledgeGraphImpactAnalysisModel>;
  getEconomicData: Array<EconomicDataPointModel>;
  getEconomicDataInsights: Array<EconomicSeriesInsightModel>;
  getEconomicDataPaginated: PaginatedEconomicDataPointsModel;
  getEconomicDataWithInsights: EconomicDataWithInsightsModel;
  /** Get entity impact graph data for visualization */
  getEntityImpactGraph: EntityImpactGraphModel;
  getExecutiveChangeImpact?: Maybe<KnowledgeGraphImpactAnalysisModel>;
  /** Get a knowledge graph subgraph for a seed entity */
  getKnowledgeGraphSubgraph?: Maybe<KnowledgeGraphModel>;
  getPolicyEventImpact?: Maybe<KnowledgeGraphImpactAnalysisModel>;
  item?: Maybe<ItemModel>;
  itemFacets: ItemFacets;
  items: ItemConnection;
  knowledgeGraphEvidenceReviewQueue: Array<KnowledgeGraphEvidenceReviewItemModel>;
  knowledgeGraphSettings: KnowledgeGraphSettingsModel;
  me: UserModel;
  memberships: Array<MembershipModel>;
  myOrganizations: Array<OrgModel>;
  newsClassificationSettings: NewsClassificationSettingsModel;
  newsDedupeSettings: NewsDedupeSettingsModel;
  newsEvent?: Maybe<NewsEventModel>;
  newsEventBrief?: Maybe<NewsEventBriefModel>;
  newsEventReferencedArticles: Array<NewsEventReferencedArticleModel>;
  newsEventSettings: NewsEventSettingsModel;
  newsEventSourcePolicy: NewsEventSourcePolicySettingsModel;
  newsEventSourcePolicyPresets: NewsEventSourcePolicyPresetSettingsModel;
  newsEventSourcePolicyRevisionDiff: NewsEventSourcePolicyRevisionDiffModel;
  newsEventSourcePolicySyncStatus: NewsEventSourcePolicySyncStatusModel;
  newsEvents: Array<NewsEventModel>;
  newsIndicatorAssociation?: Maybe<NewsIndicatorAssociationModel>;
  newsIndicatorAssociations: Array<NewsIndicatorAssociationModel>;
  newsIndicatorSettings: NewsIndicatorSettingsModel;
  newsPromptConfig: NewsPromptConfigModel;
  notifications: Array<NotificationModel>;
  permissions: Array<PermissionModel>;
  processedItemById?: Maybe<ProcessedItemModelGraph>;
  queueStats: QueueStatsModel;
  rateLimitSettings: RateLimitSettingsModel;
  roles: Array<RoleModel>;
  rssSources: Array<RssSourceOptionModel>;
  rssTranslationStatus: Array<RssTranslationProviderStatusModel>;
  searchSuggestions: Array<SearchSuggestionModel>;
  topicGroups: Array<TopicGroupModel>;
  topicSentimentSeries: Array<TopicSentimentSnapshotModel>;
  unreadNotificationCount: Scalars['Int']['output'];
  userLoginRecords: Array<UserLoginRecordModel>;
  users: Array<UserModel>;
};


export type QueryAlertEventReplayArgs = {
  eventId: Scalars['String']['input'];
  windowDays?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryAlertEventsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  metricSlug?: InputMaybe<Scalars['String']['input']>;
};


export type QueryAlertRuleTuningSuggestionArgs = {
  ruleId: Scalars['String']['input'];
  windowDays?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryAnalysisResultsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryArchiveCalendarArgs = {
  input: ArchiveCalendarInput;
};


export type QueryArchiveDetailArgs = {
  processedArticleId: Scalars['String']['input'];
};


export type QueryArchiveDigestArgs = {
  input: ArchiveQueryInput;
};


export type QueryArticleEntityLinksArgs = {
  articleId: Scalars['String']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryAssistantEconomicSeriesSuggestionsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  term: Scalars['String']['input'];
};


export type QueryAssistantRunsArgs = {
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


export type QueryEconomicDataRefreshPresetStatusArgs = {
  preset: EconomicDashboardRefreshPreset;
};


export type QueryEntitySentimentSeriesArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
  entityName: Scalars['String']['input'];
  entityType?: InputMaybe<Scalars['String']['input']>;
};


export type QueryEventGroupsArgs = {
  itemsPerGroup?: InputMaybe<Scalars['Int']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  minGroupSize?: InputMaybe<Scalars['Int']['input']>;
  windowDays?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryGetCommodityMoveImpactArgs = {
  input: CommodityMoveImpactInput;
};


export type QueryGetEconomicDataArgs = {
  category: Scalars['String']['input'];
  granularity?: InputMaybe<TimeGranularity>;
  timeRange: DateRangeInput;
};


export type QueryGetEconomicDataInsightsArgs = {
  category: Scalars['String']['input'];
  granularity?: InputMaybe<TimeGranularity>;
  timeRange: DateRangeInput;
};


export type QueryGetEconomicDataPaginatedArgs = {
  category: Scalars['String']['input'];
  granularity?: InputMaybe<TimeGranularity>;
  pagination?: InputMaybe<PaginationInput>;
  timeRange: DateRangeInput;
};


export type QueryGetEconomicDataWithInsightsArgs = {
  category: Scalars['String']['input'];
  granularity?: InputMaybe<TimeGranularity>;
  timeRange: DateRangeInput;
};


export type QueryGetEntityImpactGraphArgs = {
  input?: InputMaybe<EntityImpactGraphInput>;
};


export type QueryGetExecutiveChangeImpactArgs = {
  input: ExecutiveChangeImpactInput;
};


export type QueryGetKnowledgeGraphSubgraphArgs = {
  input: KnowledgeGraphSubgraphInput;
};


export type QueryGetPolicyEventImpactArgs = {
  input: PolicyEventImpactInput;
};


export type QueryItemArgs = {
  id: Scalars['String']['input'];
};


export type QueryItemFacetsArgs = {
  filters?: InputMaybe<ItemsFiltersInput>;
  search?: InputMaybe<Scalars['String']['input']>;
};


export type QueryItemsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  filters?: InputMaybe<ItemsFiltersInput>;
  first?: Scalars['Int']['input'];
  orderBy?: ItemsOrderBy;
  page?: InputMaybe<Scalars['Int']['input']>;
  rankingMode?: InputMaybe<ItemsRankingMode>;
  search?: InputMaybe<Scalars['String']['input']>;
};


export type QueryKnowledgeGraphEvidenceReviewQueueArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  maxConfidence?: InputMaybe<Scalars['Float']['input']>;
  onlyUnreviewed?: InputMaybe<Scalars['Boolean']['input']>;
};


export type QueryNewsEventArgs = {
  id: Scalars['String']['input'];
  itemsLimit?: InputMaybe<Scalars['Int']['input']>;
  timelineLimit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryNewsEventBriefArgs = {
  eventId: Scalars['String']['input'];
  forceRefresh?: InputMaybe<Scalars['Boolean']['input']>;
  language?: InputMaybe<Scalars['String']['input']>;
  maxSources?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryNewsEventReferencedArticlesArgs = {
  articleIds: Array<Scalars['String']['input']>;
  eventId: Scalars['String']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryNewsEventSourcePolicyRevisionDiffArgs = {
  baseRevision: Scalars['Int']['input'];
  targetRevision: Scalars['Int']['input'];
};


export type QueryNewsEventsArgs = {
  dedupeSimilar?: InputMaybe<Scalars['Boolean']['input']>;
  entity?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  minAuthoritativeSources?: InputMaybe<Scalars['Int']['input']>;
  minCredibilityScore?: InputMaybe<Scalars['Float']['input']>;
  minHeatScore?: InputMaybe<Scalars['Float']['input']>;
  sortBy?: InputMaybe<NewsEventSortBy>;
  sourceType?: InputMaybe<NewsEventSourceType>;
  status?: InputMaybe<NewsEventStatus>;
  windowDays?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryNewsIndicatorAssociationArgs = {
  backtestsLimit?: InputMaybe<Scalars['Int']['input']>;
  id: Scalars['String']['input'];
};


export type QueryNewsIndicatorAssociationsArgs = {
  featureMetric?: InputMaybe<NewsIndicatorFeatureMetric>;
  indicatorSlug?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  scopeKey?: InputMaybe<Scalars['String']['input']>;
  scopeType?: InputMaybe<NewsIndicatorScopeType>;
};


export type QueryNotificationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryProcessedItemByIdArgs = {
  id: Scalars['ID']['input'];
};


export type QueryRolesArgs = {
  includeSystem?: InputMaybe<Scalars['Boolean']['input']>;
};


export type QueryRssSourcesArgs = {
  onlyWithItems?: InputMaybe<Scalars['Boolean']['input']>;
  windowDays?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryRssTranslationStatusArgs = {
  targetLanguage?: InputMaybe<Scalars['String']['input']>;
};


export type QuerySearchSuggestionsArgs = {
  limit?: InputMaybe<Scalars['Float']['input']>;
  prefix: Scalars['String']['input'];
};


export type QueryTopicGroupsArgs = {
  itemsPerGroup?: InputMaybe<Scalars['Int']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  windowDays?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryTopicSentimentSeriesArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
  topic: Scalars['String']['input'];
};


export type QueryUserLoginRecordsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  userId: Scalars['String']['input'];
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

export type RawItemPreviewModelGraph = {
  __typename?: 'RawItemPreviewModelGraph';
  changePercent?: Maybe<Scalars['Float']['output']>;
  history?: Maybe<Array<SeriesPointModel>>;
  location?: Maybe<Scalars['String']['output']>;
  price?: Maybe<Scalars['Float']['output']>;
  region?: Maybe<Scalars['String']['output']>;
  sentiment?: Maybe<Scalars['String']['output']>;
  /** Publisher/source name from raw payload */
  sourceName?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['String']['output']>;
  /** Preview thumbnail URL */
  thumbnail?: Maybe<Scalars['String']['output']>;
  ticker?: Maybe<Scalars['String']['output']>;
  /** Original content URL */
  url?: Maybe<Scalars['String']['output']>;
};

export type ResetNewsEventSourcePolicyInput = {
  expectedRevision?: InputMaybe<Scalars['Int']['input']>;
  note?: InputMaybe<Scalars['String']['input']>;
};

export type ReviewKnowledgeGraphEvidenceInput = {
  correctedRelation?: InputMaybe<Scalars['JSON']['input']>;
  evidenceId: Scalars['String']['input'];
  note?: InputMaybe<Scalars['String']['input']>;
  status: Scalars['String']['input'];
};

export type RoleModel = {
  __typename?: 'RoleModel';
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  isSystem: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  permissions: Array<PermissionModel>;
};

export type RollbackNewsEventSourcePolicyInput = {
  expectedRevision?: InputMaybe<Scalars['Int']['input']>;
  note?: InputMaybe<Scalars['String']['input']>;
  revision: Scalars['Int']['input'];
};

export type RssItemTranslationModel = {
  __typename?: 'RssItemTranslationModel';
  cleanedMarkdown?: Maybe<Scalars['String']['output']>;
  itemId: Scalars['String']['output'];
  keyPoints?: Maybe<Array<Scalars['String']['output']>>;
  summary?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
};

export type RssSourceOptionModel = {
  __typename?: 'RssSourceOptionModel';
  feedUrl: Scalars['String']['output'];
  id: Scalars['String']['output'];
  itemCountWindow: Scalars['Int']['output'];
  language?: Maybe<Scalars['String']['output']>;
  latestItemAt?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  siteUrl: Scalars['String']['output'];
};

export enum RssTranslationField {
  CleanedMarkdown = 'cleaned_markdown',
  KeyPoints = 'key_points',
  Summary = 'summary',
  Title = 'title'
}

export enum RssTranslationProvider {
  Deeplx = 'deeplx',
  Llm = 'llm'
}

export type RssTranslationProviderStatusModel = {
  __typename?: 'RssTranslationProviderStatusModel';
  available: Scalars['Boolean']['output'];
  message?: Maybe<Scalars['String']['output']>;
  provider: RssTranslationProvider;
  targetLanguageSupported: Scalars['Boolean']['output'];
};

export type SearchSuggestionModel = {
  __typename?: 'SearchSuggestionModel';
  origin: SearchSuggestionOrigin;
  type: SearchSuggestionType;
  value: Scalars['String']['output'];
};

/** How the suggestion was produced */
export enum SearchSuggestionOrigin {
  Hybrid = 'HYBRID',
  Lexical = 'LEXICAL',
  Semantic = 'SEMANTIC'
}

/** Type of search suggestion */
export enum SearchSuggestionType {
  Region = 'REGION',
  Sentiment = 'SENTIMENT',
  Source = 'SOURCE',
  Topic = 'TOPIC'
}

export type SeriesPointInput = {
  timestamp: Scalars['String']['input'];
  value: Scalars['Float']['input'];
};

export type SeriesPointModel = {
  __typename?: 'SeriesPointModel';
  timestamp: Scalars['String']['output'];
  value: Scalars['Float']['output'];
};

export type SetOrgActiveInput = {
  id: Scalars['String']['input'];
  isActive: Scalars['Boolean']['input'];
};

export type SetUserActiveInput = {
  isActive: Scalars['Boolean']['input'];
  userId: Scalars['String']['input'];
};

export type Subscription = {
  __typename?: 'Subscription';
  alertEvents: AlertEventModel;
  analysisEvents: AnalysisResultModel;
  assistantEvents: AssistantRunModel;
  queueEvents: QueueEventModel;
};

export enum TimeGranularity {
  Day = 'day',
  Hour = 'hour',
  Minute = 'minute',
  Month = 'month',
  Quarter = 'quarter',
  Realtime = 'realtime',
  Week = 'week',
  Year = 'year'
}

export type TopicGroupModel = {
  __typename?: 'TopicGroupModel';
  count: Scalars['Int']['output'];
  items: Array<TopicItemModel>;
  latestAt: Scalars['DateTime']['output'];
  topic: Scalars['String']['output'];
};

export type TopicItemModel = {
  __typename?: 'TopicItemModel';
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  itemMetaId: Scalars['String']['output'];
  publishedAt?: Maybe<Scalars['String']['output']>;
  source?: Maybe<Scalars['String']['output']>;
  summary?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
};

export type TopicSentimentSnapshotModel = {
  __typename?: 'TopicSentimentSnapshotModel';
  avgScore: Scalars['Float']['output'];
  bucketStart: Scalars['DateTime']['output'];
  evidenceProcessedItemIds?: Maybe<Scalars['JSON']['output']>;
  negativeDocs: Scalars['Int']['output'];
  negativeRatio: Scalars['Float']['output'];
  neutralDocs: Scalars['Int']['output'];
  positiveDocs: Scalars['Int']['output'];
  scoreSum: Scalars['Int']['output'];
  topic: Scalars['String']['output'];
  totalDocs: Scalars['Int']['output'];
};

export type TranslateRssItemsInput = {
  fields?: InputMaybe<Array<RssTranslationField>>;
  itemIds: Array<Scalars['String']['input']>;
  provider?: RssTranslationProvider;
  targetLanguage?: Scalars['String']['input'];
};

export type TranslateRssItemsPayloadModel = {
  __typename?: 'TranslateRssItemsPayloadModel';
  provider: RssTranslationProvider;
  targetLanguage: Scalars['String']['output'];
  translations: Array<RssItemTranslationModel>;
};

export type TriggerDataFetchInput = {
  slugs: Array<Scalars['String']['input']>;
};

export type UpdateAlertChannelInput = {
  config?: InputMaybe<Scalars['JSON']['input']>;
  id: Scalars['String']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  target?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateAlertEventStatusInput = {
  eventId: Scalars['String']['input'];
  note?: InputMaybe<Scalars['String']['input']>;
  status: AlertEventStatus;
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

export type UpdateClassificationQualitySettingsInput = {
  cacheTtlSeconds?: InputMaybe<Scalars['Int']['input']>;
  embeddingP95LatencyWarnMs?: InputMaybe<Scalars['Int']['input']>;
  gatePenalizedRateWarn?: InputMaybe<Scalars['Float']['input']>;
  gateRejectRateWarn?: InputMaybe<Scalars['Float']['input']>;
  llmP95LatencyWarnMs?: InputMaybe<Scalars['Int']['input']>;
  lowConfidenceThreshold?: InputMaybe<Scalars['Float']['input']>;
  reportMinPairCount?: InputMaybe<Scalars['Int']['input']>;
  reportMinPairErrorRate?: InputMaybe<Scalars['Float']['input']>;
  rerankP95LatencyWarnMs?: InputMaybe<Scalars['Int']['input']>;
};

export type UpdateCrawlClientSettingsInput = {
  adaptiveConcurrencyEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  adaptiveCooldownMinutes?: InputMaybe<Scalars['Int']['input']>;
  adaptiveErrorRateThreshold?: InputMaybe<Scalars['Float']['input']>;
  adaptiveLatencyThresholdRatio?: InputMaybe<Scalars['Float']['input']>;
  adaptiveMemoryHeadroomThreshold?: InputMaybe<Scalars['Float']['input']>;
  adaptiveWindowMinutes?: InputMaybe<Scalars['Int']['input']>;
  conditionalRequestEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  conditionalRequestMaxRetries?: InputMaybe<Scalars['Int']['input']>;
  conditionalRequestTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  detailPublishSignalHeadFetchConcurrency?: InputMaybe<Scalars['Int']['input']>;
  detailPublishSignalHeadFetchMaxReadBytes?: InputMaybe<Scalars['Int']['input']>;
  detailPublishSignalHeadFetchTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  healthCheckTtlMs: Scalars['Int']['input'];
  maxRetries: Scalars['Int']['input'];
  queueOverloadCooldownMs: Scalars['Int']['input'];
  requestTimeoutHotMs?: InputMaybe<Scalars['Int']['input']>;
  requestTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  requestTimeoutNormalMs?: InputMaybe<Scalars['Int']['input']>;
  retryBackoffMs: Scalars['Int']['input'];
};

export type UpdateEntityImpactGraphSettingsInput = {
  cacheTtlSeconds: Scalars['Int']['input'];
  categories: Array<Scalars['String']['input']>;
  enabled: Scalars['Boolean']['input'];
  maxNodes: Scalars['Int']['input'];
  minCoOccurrence: Scalars['Int']['input'];
  minCorrelation: Scalars['Float']['input'];
  minEntityConfidence: Scalars['Float']['input'];
};

export type UpdateItemInput = {
  id: Scalars['String']['input'];
  payload?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateKnowledgeGraphSettingsInput = {
  cacheTtlSeconds: Scalars['Int']['input'];
  dynamicEdgeConfidenceEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  dynamicEdgeConfidenceQuantile?: InputMaybe<Scalars['Float']['input']>;
  enabled: Scalars['Boolean']['input'];
  entityDisambiguationEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  entityDisambiguationMaxCandidates?: InputMaybe<Scalars['Int']['input']>;
  ingestionEnabled: Scalars['Boolean']['input'];
  maxBatchSize: Scalars['Int']['input'];
  maxRelationsPerArticle: Scalars['Int']['input'];
  minEdgeConfidence?: InputMaybe<Scalars['Float']['input']>;
  multiModelValidationEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  multiModelValidationMaxRelationsPerArticle?: InputMaybe<Scalars['Int']['input']>;
  multiModelValidationModelCount?: InputMaybe<Scalars['Int']['input']>;
  multiModelValidationModels?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type UpdateMembershipRolesInput = {
  primaryRoleId: Scalars['String']['input'];
  roleIds: Array<Scalars['String']['input']>;
  userId: Scalars['String']['input'];
};

export type UpdateNewsClassificationSettingsInput = {
  cacheTtlSeconds?: InputMaybe<Scalars['Int']['input']>;
  embeddingTopK?: InputMaybe<Scalars['Int']['input']>;
  enableEmbedding?: InputMaybe<Scalars['Boolean']['input']>;
  enableLlm?: InputMaybe<Scalars['Boolean']['input']>;
  enableRerank?: InputMaybe<Scalars['Boolean']['input']>;
  enabled?: InputMaybe<Scalars['Boolean']['input']>;
  llmModel?: InputMaybe<Scalars['String']['input']>;
  minConfidence?: InputMaybe<Scalars['Float']['input']>;
  rerankTopN?: InputMaybe<Scalars['Int']['input']>;
  strictFail?: InputMaybe<Scalars['Boolean']['input']>;
  taxonomy?: InputMaybe<Array<NewsClassificationTaxonomyNodeInput>>;
  taxonomyVersion?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateNewsDedupeSettingsInput = {
  defaultThreshold: Scalars['Float']['input'];
  llmJudgeCandidateChars?: InputMaybe<Scalars['Int']['input']>;
  llmJudgeConcurrency?: InputMaybe<Scalars['Int']['input']>;
  llmJudgeInstructions?: InputMaybe<Scalars['String']['input']>;
  llmJudgeMaxComparisons?: InputMaybe<Scalars['Int']['input']>;
  llmJudgeModel?: InputMaybe<Scalars['String']['input']>;
  llmJudgePromptVersion?: InputMaybe<Scalars['String']['input']>;
  llmJudgeSystemPromptTemplate?: InputMaybe<Scalars['String']['input']>;
  llmJudgeUserPromptTemplate?: InputMaybe<Scalars['String']['input']>;
  scopedThresholds: Array<NewsDedupeScopedThresholdInput>;
  useEmbeddings: Scalars['Boolean']['input'];
};

export type UpdateNewsEventSettingsInput = {
  backfillDays: Scalars['Int']['input'];
  cacheTtlSeconds: Scalars['Int']['input'];
  categoryConflictReject?: InputMaybe<Scalars['Boolean']['input']>;
  categorySoftPenalty?: InputMaybe<Scalars['Float']['input']>;
  classificationGateEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  crossLanguagePenalty: Scalars['Float']['input'];
  enabled: Scalars['Boolean']['input'];
  forceAuthoritativeMode?: InputMaybe<Scalars['Boolean']['input']>;
  forceMinAuthoritativeSources?: InputMaybe<Scalars['Int']['input']>;
  ingestionEnabled: Scalars['Boolean']['input'];
  lookbackDays: Scalars['Int']['input'];
  maxBatchSize: Scalars['Int']['input'];
  minCategoryConfidenceForGate?: InputMaybe<Scalars['Float']['input']>;
  timelineCrossCategoryWarningShare?: InputMaybe<Scalars['Float']['input']>;
  timelineDriftKlThreshold?: InputMaybe<Scalars['Float']['input']>;
  timelineEnabled: Scalars['Boolean']['input'];
  timelineHighConfidenceThreshold?: InputMaybe<Scalars['Float']['input']>;
  timelineLowConfidenceThreshold?: InputMaybe<Scalars['Float']['input']>;
  timelineMaxCategoryDistributionItems?: InputMaybe<Scalars['Int']['input']>;
  timelineMaxEventsPerRun: Scalars['Int']['input'];
  timelineMaxPhaseSummaries?: InputMaybe<Scalars['Int']['input']>;
  timelineMinBucketItemsForDrift?: InputMaybe<Scalars['Int']['input']>;
  timelinePresetCustomDistanceThreshold?: InputMaybe<Scalars['Float']['input']>;
  vectorMinScore: Scalars['Float']['input'];
};

export type UpdateNewsEventSourcePolicyInput = {
  authoritativeDomains: Array<Scalars['String']['input']>;
  authoritativeLabels: Array<Scalars['String']['input']>;
  blogDomains: Array<Scalars['String']['input']>;
  blogLabels: Array<Scalars['String']['input']>;
  categoryAuthority?: InputMaybe<Array<NewsEventSourceCategoryAuthorityRuleInput>>;
  expectedRevision?: InputMaybe<Scalars['Int']['input']>;
  note?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateNewsEventSourcePolicyPresetInput = {
  authoritativeDomains: Array<Scalars['String']['input']>;
  authoritativeLabels: Array<Scalars['String']['input']>;
  blogDomains: Array<Scalars['String']['input']>;
  blogLabels: Array<Scalars['String']['input']>;
  categoryAuthority?: InputMaybe<Array<NewsEventSourceCategoryAuthorityRuleInput>>;
  expectedUpdatedAt?: InputMaybe<Scalars['String']['input']>;
  note?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateNewsIndicatorSettingsInput = {
  backtestBaselineDays: Scalars['Int']['input'];
  backtestHoldoutDays: Scalars['Int']['input'];
  backtestTriggerZScore: Scalars['Float']['input'];
  cacheTtlSeconds: Scalars['Int']['input'];
  enabled: Scalars['Boolean']['input'];
  indicatorSlugs: Array<Scalars['String']['input']>;
  ingestionEnabled: Scalars['Boolean']['input'];
  maxAssociationsPerIndicator: Scalars['Int']['input'];
  maxLagDays: Scalars['Int']['input'];
  maxPValue: Scalars['Float']['input'];
  minAbsCorrelation: Scalars['Float']['input'];
  minSampleSize: Scalars['Int']['input'];
  topEntities: Scalars['Int']['input'];
  topTopics: Scalars['Int']['input'];
  windowDays: Scalars['Int']['input'];
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

export type UserLoginRecordModel = {
  __typename?: 'UserLoginRecordModel';
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['String']['output'];
  ipAddress?: Maybe<Scalars['String']['output']>;
  method: Scalars['String']['output'];
  userAgent?: Maybe<Scalars['String']['output']>;
};

export type UserModel = {
  __typename?: 'UserModel';
  avatarUrl?: Maybe<Scalars['String']['output']>;
  email: Scalars['String']['output'];
  emailVerified?: Maybe<Scalars['DateTime']['output']>;
  firstName: Scalars['String']['output'];
  id: Scalars['String']['output'];
  isActive: Scalars['Boolean']['output'];
  lastLoginAt?: Maybe<Scalars['DateTime']['output']>;
  lastName: Scalars['String']['output'];
  orgId: Scalars['String']['output'];
  permissions: Array<Scalars['String']['output']>;
  planTier?: Maybe<Scalars['String']['output']>;
  primaryRoleId?: Maybe<Scalars['String']['output']>;
  roleIds: Array<Scalars['String']['output']>;
  subscriptionStatus?: Maybe<Scalars['String']['output']>;
};

export type AlertRulesQueryVariables = Exact<{ [key: string]: never; }>;


export type AlertRulesQuery = { __typename?: 'Query', alertRules: Array<{ __typename?: 'AlertRuleModel', id: string, name: string, description?: string | null, severity: AlertSeverity, status: AlertStatus, metricProvider: AlertMetricProvider, metricSlug: string, operator: AlertOperator, thresholdValue?: number | null, thresholdLower?: number | null, thresholdUpper?: number | null, changeWindowMin?: number | null, cooldownSeconds: number, checkIntervalSec: number, lastTriggeredAt?: any | null, metadata?: any | null, channels: Array<{ __typename?: 'AlertChannelModel', id: string, name: string, type: AlertChannelType, target: string }> }> };

export type AlertChannelsQueryVariables = Exact<{ [key: string]: never; }>;


export type AlertChannelsQuery = { __typename?: 'Query', alertChannels: Array<{ __typename?: 'AlertChannelModel', id: string, name: string, type: AlertChannelType, target: string, isActive: boolean, config?: any | null }> };

export type AlertEventsQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
}>;


export type AlertEventsQuery = { __typename?: 'Query', alertEvents: Array<{ __typename?: 'AlertEventModel', id: string, triggeredAt: any, metricValue: number, changePercent?: number | null, severity: AlertSeverity, status: AlertEventStatus, message?: string | null, ruleId?: string | null, ruleName?: string | null, metricProvider?: AlertMetricProvider | null, metricSlug?: string | null, operator?: AlertOperator | null, thresholdValue?: number | null, thresholdLower?: number | null, thresholdUpper?: number | null, changeWindowMin?: number | null, context?: any | null, deliveries: Array<{ __typename?: 'AlertDeliveryModel', id: string, status: AlertDeliveryStatus, channelType: AlertChannelType, channelName?: string | null, target?: string | null, sentAt?: any | null, error?: string | null }> }> };

export type UpsertAlertRuleMutationVariables = Exact<{
  input: UpsertAlertRuleInput;
}>;


export type UpsertAlertRuleMutation = { __typename?: 'Mutation', upsertAlertRule: { __typename?: 'AlertRuleModel', id: string, name: string } };

export type CreateAlertChannelMutationVariables = Exact<{
  input: AlertChannelInput;
}>;


export type CreateAlertChannelMutation = { __typename?: 'Mutation', createAlertChannel: { __typename?: 'AlertChannelModel', id: string, name: string, type: AlertChannelType, target: string, isActive: boolean, config?: any | null } };

export type UpdateAlertChannelMutationVariables = Exact<{
  input: UpdateAlertChannelInput;
}>;


export type UpdateAlertChannelMutation = { __typename?: 'Mutation', updateAlertChannel: { __typename?: 'AlertChannelModel', id: string, name: string, type: AlertChannelType, target: string, isActive: boolean, config?: any | null } };

export type DeleteAlertChannelMutationVariables = Exact<{
  channelId: Scalars['String']['input'];
}>;


export type DeleteAlertChannelMutation = { __typename?: 'Mutation', deleteAlertChannel: boolean };

export type TriggerAlertRuleMutationVariables = Exact<{
  ruleId: Scalars['String']['input'];
}>;


export type TriggerAlertRuleMutation = { __typename?: 'Mutation', triggerAlertRule: boolean };

export type UpdateAlertEventStatusMutationVariables = Exact<{
  input: UpdateAlertEventStatusInput;
}>;


export type UpdateAlertEventStatusMutation = { __typename?: 'Mutation', updateAlertEventStatus: { __typename?: 'AlertEventModel', id: string, status: AlertEventStatus } };

export type AlertEventReplayQueryVariables = Exact<{
  eventId: Scalars['String']['input'];
  windowDays?: InputMaybe<Scalars['Int']['input']>;
}>;


export type AlertEventReplayQuery = { __typename?: 'Query', alertEventReplay?: { __typename?: 'AlertEventReplayModel', eventId: string, metricProvider: AlertMetricProvider, metricSlug: string, unit?: string | null, points: Array<{ __typename?: 'AlertEventReplayPointModel', timestamp: any, value: number }> } | null };

export type AlertRuleTuningSuggestionQueryVariables = Exact<{
  ruleId: Scalars['String']['input'];
  windowDays?: InputMaybe<Scalars['Int']['input']>;
}>;


export type AlertRuleTuningSuggestionQuery = { __typename?: 'Query', alertRuleTuningSuggestion?: { __typename?: 'AlertRuleTuningSuggestionModel', ruleId: string, windowDays: number, totalEvents: number, reviewedEvents: number, confirmedEvents: number, ignoredEvents: number, falsePositiveRate?: number | null, action: AlertTuningAction, message?: string | null, suggestedThresholdValue?: number | null, suggestedThresholdLower?: number | null, suggestedThresholdUpper?: number | null } | null };

export type AlertEventsStreamSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type AlertEventsStreamSubscription = { __typename?: 'Subscription', alertEvents: { __typename?: 'AlertEventModel', id: string, triggeredAt: any, severity: AlertSeverity, message?: string | null, metricValue: number, changePercent?: number | null, ruleName?: string | null, metricSlug?: string | null, context?: any | null } };

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

export type RequestGeoTransportMutationVariables = Exact<{
  input: GeoTransportAnalysisInput;
}>;


export type RequestGeoTransportMutation = { __typename?: 'Mutation', requestGeoTransportAnalysis: { __typename?: 'AnalysisResultModel', id: string, status: AnalysisStatus, type: AnalysisType } };

export type CrawlTasksQueryVariables = Exact<{
  first: Scalars['Int']['input'];
  after?: InputMaybe<Scalars['String']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<CrawlTaskStatus>;
}>;


export type CrawlTasksQuery = { __typename?: 'Query', crawlTasks: { __typename?: 'CrawlTaskConnection', totalCount: number, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null }, edges: Array<{ __typename?: 'CrawlTaskEdge', cursor: string, node: { __typename?: 'CrawlTaskModel', id: string, displayName?: string | null, targetUrl: string, status: CrawlTaskStatus, concurrency: number, runCount: number, resultCount: number, lastRunAt?: any | null, lastSuccessAt?: any | null, lastError?: string | null, createdAt: any, config?: string | null, lastPeakMemoryMb?: number | null, lastMemoryEfficiency?: number | null } }> } };

export type CrawlTaskQueryVariables = Exact<{
  id: Scalars['ID']['input'];
  resultLimit?: InputMaybe<Scalars['Int']['input']>;
  resultSearch?: InputMaybe<Scalars['String']['input']>;
}>;


export type CrawlTaskQuery = { __typename?: 'Query', crawlTask?: { __typename?: 'CrawlTaskModel', id: string, displayName?: string | null, targetUrl: string, status: CrawlTaskStatus, keywords: Array<string>, concurrency: number, runCount: number, lastRunAt?: any | null, lastSuccessAt?: any | null, lastResultAt?: any | null, lastError?: string | null, config?: string | null, lastServerMemoryMb?: number | null, lastPeakMemoryMb?: number | null, lastMemoryEfficiency?: number | null, lastRunSummary?: { __typename?: 'CrawlExecutionSummaryModel', inserted: number, skipped: number, itemsQueued?: number | null, itemsQueueFailed?: number | null, lastFetchedAt?: any | null, runId?: string | null, retryableFailures?: number | null } | null, results?: Array<{ __typename?: 'CrawlResultModel', id: string, itemId?: string | null, itemStatus?: string | null, sourceUrl: string, fetchedAt: any, markdown: string, markdownWithCitations?: string | null, referencesMarkdown?: string | null, fitMarkdown?: string | null, metadata?: string | null, media?: string | null, mediaAssets?: string | null, tables?: any | null, linkAnalysis?: { __typename?: 'CrawlLinkAnalysisModel', stats: { __typename?: 'CrawlLinkStatsModel', totalLinks: number, internalLinks: number, externalLinks: number, averageIntrinsicScore?: number | null, highQualityLinks?: number | null, lowQualityLinks?: number | null }, topLinks: Array<{ __typename?: 'CrawlLinkModel', href: string, text?: string | null, title?: string | null, baseDomain?: string | null, type?: string | null, intrinsicScore?: number | null, contextualScore?: number | null, totalScore?: number | null }>, lowQualityLinks: Array<{ __typename?: 'CrawlLinkModel', href: string, text?: string | null, title?: string | null, intrinsicScore?: number | null, baseDomain?: string | null }>, buckets: Array<{ __typename?: 'CrawlLinkBucketModel', kind: string, links: Array<{ __typename?: 'CrawlLinkModel', href: string, text?: string | null, title?: string | null, baseDomain?: string | null, type?: string | null, intrinsicScore?: number | null, contextualScore?: number | null, totalScore?: number | null }> }> } | null }> | null, memoryStats?: { __typename?: 'CrawlMemoryStatsModel', serverMemoryMb?: number | null, peakMemoryMb?: number | null, efficiencyPercent?: number | null } | null } | null };

export type CreateCrawlTaskMutationVariables = Exact<{
  input: CreateCrawlTaskInput;
}>;


export type CreateCrawlTaskMutation = { __typename?: 'Mutation', createCrawlTask: { __typename?: 'CrawlTaskModel', id: string, displayName?: string | null, targetUrl: string, status: CrawlTaskStatus, concurrency: number, runCount: number, resultCount: number, lastRunAt?: any | null, lastSuccessAt?: any | null, lastError?: string | null, createdAt: any } };

export type RetryCrawlTaskMutationVariables = Exact<{
  id: Scalars['String']['input'];
}>;


export type RetryCrawlTaskMutation = { __typename?: 'Mutation', retryCrawlTask: { __typename?: 'CrawlTaskModel', id: string, status: CrawlTaskStatus, lastRunAt?: any | null, lastError?: string | null, runCount: number } };

export type UpdateCrawlTaskIngestToItemsMutationVariables = Exact<{
  id: Scalars['String']['input'];
  enabled: Scalars['Boolean']['input'];
}>;


export type UpdateCrawlTaskIngestToItemsMutation = { __typename?: 'Mutation', updateCrawlTaskIngestToItems: { __typename?: 'CrawlTaskModel', id: string, config?: string | null } };

export type IngestCrawlTaskResultsToItemsMutationVariables = Exact<{
  taskId: Scalars['String']['input'];
  after?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Float']['input']>;
  onlyMissing?: InputMaybe<Scalars['Boolean']['input']>;
}>;


export type IngestCrawlTaskResultsToItemsMutation = { __typename?: 'Mutation', ingestCrawlTaskResultsToItems: { __typename?: 'CrawlIngestBatchModel', taskId: string, scanned: number, attempted: number, ingested: number, skippedExisting: number, failed: number, nextCursor?: string | null, hasMore: boolean } };

export type CrawlMetadataQueryVariables = Exact<{
  input: CrawlMetadataInput;
}>;


export type CrawlMetadataQuery = { __typename?: 'Query', crawlMetadata: Array<{ __typename?: 'CrawlMetadataResultModel', url: string, status: string, httpStatus?: number | null, fetchedAt?: any | null, title?: string | null, description?: string | null, keywords?: Array<string> | null, author?: string | null, relevanceScore?: number | null, error?: string | null, jsonLd: Array<string>, metaTags: Array<{ __typename?: 'CrawlMetadataTagModel', name: string, value: string }>, openGraph: Array<{ __typename?: 'CrawlMetadataTagModel', name: string, value: string }> }> };

export type DashboardHeroMetricsQueryVariables = Exact<{
  start: Scalars['DateTime']['input'];
  end: Scalars['DateTime']['input'];
  granularity?: InputMaybe<TimeGranularity>;
}>;


export type DashboardHeroMetricsQuery = { __typename?: 'Query', conflict: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, effectiveGranularity: TimeGranularity, value: number, unit?: string | null, dataType: EconomicDataValueType, item: { __typename?: 'EconomicDataItemModel', displayName: string, defaultUnit?: string | null } }>, market: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, effectiveGranularity: TimeGranularity, sourceField?: string | null, value: number, unit?: string | null, dataType: EconomicDataValueType, item: { __typename?: 'EconomicDataItemModel', slug: string, displayName: string, defaultUnit?: string | null } }>, resource: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, effectiveGranularity: TimeGranularity, value: number, unit?: string | null, dataType: EconomicDataValueType, item: { __typename?: 'EconomicDataItemModel', displayName: string, defaultUnit?: string | null } }>, supply: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, effectiveGranularity: TimeGranularity, value: number, unit?: string | null, dataType: EconomicDataValueType, item: { __typename?: 'EconomicDataItemModel', displayName: string, defaultUnit?: string | null } }> };

export type MetricDrillDownDetailsQueryVariables = Exact<{
  category: Scalars['String']['input'];
  start: Scalars['DateTime']['input'];
  end: Scalars['DateTime']['input'];
  granularity?: InputMaybe<TimeGranularity>;
}>;


export type MetricDrillDownDetailsQuery = { __typename?: 'Query', history: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, effectiveGranularity: TimeGranularity, value: number, unit?: string | null, dataType: EconomicDataValueType, item: { __typename?: 'EconomicDataItemModel', displayName: string, defaultUnit?: string | null } }>, relatedAlerts: Array<{ __typename?: 'AlertEventModel', id: string, severity: AlertSeverity, message?: string | null, triggeredAt: any, status: AlertEventStatus, metricValue: number, context?: any | null }> };

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


export type EconomicDataQuery = { __typename?: 'Query', getEconomicData: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, effectiveGranularity: TimeGranularity, value: number, unit?: string | null, sourceField?: string | null, dataType: EconomicDataValueType, item: { __typename?: 'EconomicDataItemModel', slug: string, displayName: string, groupLabel?: string | null, defaultUnit?: string | null, metadata?: any | null } }> };

export type EconomicDataWithInsightsQueryVariables = Exact<{
  category: Scalars['String']['input'];
  timeRange: DateRangeInput;
  granularity?: InputMaybe<TimeGranularity>;
}>;


export type EconomicDataWithInsightsQuery = { __typename?: 'Query', getEconomicDataWithInsights: { __typename?: 'EconomicDataWithInsightsModel', points: Array<{ __typename?: 'EconomicDataPointModel', timestamp: any, effectiveGranularity: TimeGranularity, value: number, unit?: string | null, sourceField?: string | null, dataType: EconomicDataValueType, item: { __typename?: 'EconomicDataItemModel', slug: string, displayName: string, groupLabel?: string | null, defaultUnit?: string | null, metadata?: any | null } }>, insights: Array<{ __typename?: 'EconomicSeriesInsightModel', itemSlug: string, seriesKey: string, sourceField?: string | null, unit?: string | null, sampleCount: number, currentValue?: number | null, previousValue?: number | null, change?: number | null, percentChange?: number | null, mean?: number | null, stdDev?: number | null, zScore?: number | null, direction: EconomicInsightDirection, classification: EconomicInsightClassification, message: string }> } };

export type EconomicFetchConfigsQueryVariables = Exact<{ [key: string]: never; }>;


export type EconomicFetchConfigsQuery = { __typename?: 'Query', economicDataFetchConfigs: Array<{ __typename?: 'EconomicDataFetchConfigModel', id: string, frequency: EconomicDataFrequency, repeatCron?: string | null, isEnabled: boolean, lastRunAt?: any | null, lastStatus?: EconomicDataRunStatus | null, lastError?: string | null, item: { __typename?: 'EconomicDataItemModel', slug: string, displayName: string, groupLabel?: string | null, defaultUnit?: string | null, metadata?: any | null } }> };

export type EconomicDataRefreshPresetStatusQueryVariables = Exact<{
  preset: EconomicDashboardRefreshPreset;
}>;


export type EconomicDataRefreshPresetStatusQuery = { __typename?: 'Query', economicDataRefreshPresetStatus: { __typename?: 'EconomicDataRefreshPresetStatusModel', preset: EconomicDashboardRefreshPreset, categoryKey: string, totalItems: number, enabledItems: number, lastRunAt?: any | null, lastStatus?: EconomicDataRunStatus | null, lastError?: string | null } };

export type UpdateEconomicFetchConfigMutationVariables = Exact<{
  slug: Scalars['String']['input'];
  frequency?: InputMaybe<EconomicDataFrequency>;
  repeatCron?: InputMaybe<Scalars['String']['input']>;
  isEnabled?: InputMaybe<Scalars['Boolean']['input']>;
}>;


export type UpdateEconomicFetchConfigMutation = { __typename?: 'Mutation', updateEconomicDataFetchConfig: { __typename?: 'EconomicDataFetchConfigModel', id: string, frequency: EconomicDataFrequency, repeatCron?: string | null, isEnabled: boolean, lastRunAt?: any | null, lastStatus?: EconomicDataRunStatus | null, lastError?: string | null, item: { __typename?: 'EconomicDataItemModel', slug: string, displayName: string, groupLabel?: string | null, defaultUnit?: string | null, metadata?: any | null } } };

export type TriggerEconomicDataFetchMutationVariables = Exact<{
  slugs: Array<Scalars['String']['input']> | Scalars['String']['input'];
}>;


export type TriggerEconomicDataFetchMutation = { __typename?: 'Mutation', triggerDataFetch: boolean };

export type TriggerEconomicDataRefreshPresetMutationVariables = Exact<{
  preset: EconomicDashboardRefreshPreset;
}>;


export type TriggerEconomicDataRefreshPresetMutation = { __typename?: 'Mutation', triggerEconomicDataRefreshPreset: boolean };

export type GetEntityImpactGraphQueryVariables = Exact<{
  input?: InputMaybe<EntityImpactGraphInput>;
}>;


export type GetEntityImpactGraphQuery = { __typename?: 'Query', getEntityImpactGraph: { __typename?: 'EntityImpactGraphModel', nodes: Array<{ __typename?: 'EntityImpactNodeModel', id: string, name: string, category: string, type: string, value: number }>, links: Array<{ __typename?: 'EntityImpactLinkModel', source: string, target: string, value: number, type: string }>, metadata: { __typename?: 'EntityImpactMetadataModel', totalNodes: number, totalLinks: number, generatedAt: any } } };

export type ItemsQueryVariables = Exact<{
  first: Scalars['Int']['input'];
  after?: InputMaybe<Scalars['String']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  filters?: InputMaybe<ItemsFiltersInput>;
  orderBy?: InputMaybe<ItemsOrderBy>;
  rankingMode?: InputMaybe<ItemsRankingMode>;
}>;


export type ItemsQuery = { __typename?: 'Query', items: { __typename?: 'ItemConnection', totalCount: number, edges: Array<{ __typename?: 'ItemEdge', cursor: string, node: { __typename?: 'ItemModel', id: string, title: string, status: string, createdAt: any, ingestedAt: any, publishedAt?: string | null, relevanceScore?: number | null, processedPreview?: { __typename?: 'ProcessedItemPreviewModelGraph', id: string, itemMetaId: string, status: string, tags: Array<string>, duplicateOf?: string | null, duplicateSimilarity?: number | null, source?: string | null, title?: string | null, language?: string | null, publishedAt?: string | null, summary?: string | null, contentType?: string | null, sentiment?: string | null, topics: Array<string>, entities: Array<string>, qualityScore?: number | null, location?: string | null, createdAt: any, eventId?: string | null, llm?: { __typename?: 'ProcessedItemLlmModel', model?: string | null, promptVersion?: string | null, promptTokens?: number | null, completionTokens?: number | null, totalTokens?: number | null, costUsd?: number | null, latencyMs?: number | null } | null } | null, rawPreview?: { __typename?: 'RawItemPreviewModelGraph', url?: string | null, sourceName?: string | null, thumbnail?: string | null, summary?: string | null, sentiment?: string | null, region?: string | null, location?: string | null, ticker?: string | null, price?: number | null, changePercent?: number | null, history?: Array<{ __typename?: 'SeriesPointModel', timestamp: string, value: number }> | null } | null } }>, pageInfo: { __typename?: 'PageInfo', hasNextPage: boolean, endCursor?: string | null } } };

export type ItemFacetsQueryVariables = Exact<{
  search?: InputMaybe<Scalars['String']['input']>;
  filters?: InputMaybe<ItemsFiltersInput>;
}>;


export type ItemFacetsQuery = { __typename?: 'Query', itemFacets: { __typename?: 'ItemFacets', regions: Array<{ __typename?: 'ItemFacetOption', value: string, count: number }>, topics: Array<{ __typename?: 'ItemFacetOption', value: string, count: number }>, sentiments: Array<{ __typename?: 'ItemFacetOption', value: string, count: number }>, contentTypes: Array<{ __typename?: 'ItemFacetOption', value: string, count: number }> } };

export type ItemQueryVariables = Exact<{
  id: Scalars['String']['input'];
}>;


export type ItemQuery = { __typename?: 'Query', item?: { __typename?: 'ItemModel', id: string, title: string, status: string, createdAt: any, updatedAt: any, ingestedAt: any, publishedAt?: string | null, meta: { __typename?: 'ItemMetaModel', id: string, externalId: string, name: string, status: string, createdAt: any, updatedAt: any }, raw?: { __typename?: 'RawItemModelGraph', id: string, payload: string, source?: string | null, createdAt: any, updatedAt: any } | null, processed?: { __typename?: 'ProcessedItemModelGraph', id: string, status: string, tags: Array<string>, duplicateOf?: string | null, duplicateSimilarity?: number | null, summaryEmbeddingModel?: string | null, summaryEmbeddingDimensions?: number | null, result?: string | null, resultJson?: any | null, createdAt: any, error?: { __typename?: 'ProcessedItemErrorModelGraph', message: string, name?: string | null } | null, llm?: { __typename?: 'ProcessedItemLlmModel', model?: string | null, promptVersion?: string | null, promptTokens?: number | null, completionTokens?: number | null, totalTokens?: number | null, costUsd?: number | null, latencyMs?: number | null } | null } | null } | null };

export type KnowledgeGraphEvidenceReviewQueueQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
  maxConfidence?: InputMaybe<Scalars['Float']['input']>;
  onlyUnreviewed?: InputMaybe<Scalars['Boolean']['input']>;
}>;


export type KnowledgeGraphEvidenceReviewQueueQuery = { __typename?: 'Query', knowledgeGraphEvidenceReviewQueue: Array<{ __typename?: 'KnowledgeGraphEvidenceReviewItemModel', id: string, confidence?: number | null, extractorVersion?: string | null, createdAt: any, evidence?: any | null, edge: { __typename?: 'KnowledgeGraphReviewEdgeModel', id: string, type: string, confidence: number, weight: number, properties?: any | null, fromEntity: { __typename?: 'KnowledgeGraphNodeModel', id: string, name: string, type: string }, toEntity: { __typename?: 'KnowledgeGraphNodeModel', id: string, name: string, type: string } }, article: { __typename?: 'KnowledgeGraphReviewArticleModel', id: string, url: string, title?: string | null, summary?: string | null, language?: string | null, crawlAt: any } }> };

export type ReviewKnowledgeGraphEvidenceMutationVariables = Exact<{
  input: ReviewKnowledgeGraphEvidenceInput;
}>;


export type ReviewKnowledgeGraphEvidenceMutation = { __typename?: 'Mutation', reviewKnowledgeGraphEvidence?: { __typename?: 'KnowledgeGraphEvidenceReviewItemModel', id: string, confidence?: number | null, extractorVersion?: string | null, createdAt: any, evidence?: any | null } | null };

export type GetKnowledgeGraphSubgraphQueryVariables = Exact<{
  input: KnowledgeGraphSubgraphInput;
}>;


export type GetKnowledgeGraphSubgraphQuery = { __typename?: 'Query', getKnowledgeGraphSubgraph?: { __typename?: 'KnowledgeGraphModel', seed: { __typename?: 'KnowledgeGraphNodeModel', id: string, name: string, type: string, properties?: any | null }, nodes: Array<{ __typename?: 'KnowledgeGraphNodeModel', id: string, name: string, type: string, properties?: any | null }>, edges: Array<{ __typename?: 'KnowledgeGraphEdgeModel', id: string, from: string, to: string, type: string, weight: number, confidence: number, properties?: any | null }>, metadata: { __typename?: 'KnowledgeGraphMetadataModel', totalNodes: number, totalEdges: number, generatedAt: any } } | null };

export type MeQueryVariables = Exact<{ [key: string]: never; }>;


export type MeQuery = { __typename?: 'Query', me: { __typename?: 'UserModel', id: string, email: string, firstName: string, lastName: string, orgId: string, permissions: Array<string> } };

export type NewsEventBriefQueryVariables = Exact<{
  eventId: Scalars['String']['input'];
  language?: InputMaybe<Scalars['String']['input']>;
  maxSources?: InputMaybe<Scalars['Int']['input']>;
  forceRefresh?: InputMaybe<Scalars['Boolean']['input']>;
}>;


export type NewsEventBriefQuery = { __typename?: 'Query', newsEventBrief?: { __typename?: 'NewsEventBriefModel', version: number, generatedAt: any, language: string, detailedSummary: string, tldr: string, limitations?: string | null, keyPoints: Array<{ __typename?: 'NewsEventBriefPointModel', text: string, citations: Array<number> }>, whyItMatters: Array<{ __typename?: 'NewsEventBriefPointModel', text: string, citations: Array<number> }>, latestUpdate?: { __typename?: 'NewsEventBriefPointModel', text: string, citations: Array<number> } | null, whatToWatch: Array<{ __typename?: 'NewsEventBriefPointModel', text: string, citations: Array<number> }>, comparison?: { __typename?: 'NewsEventBriefComparisonModel', consensus: Array<{ __typename?: 'NewsEventBriefPointModel', text: string, citations: Array<number> }>, divergence: Array<{ __typename?: 'NewsEventBriefPointModel', text: string, citations: Array<number> }> } | null, sources: Array<{ __typename?: 'NewsEventBriefSourceModel', index: number, url: string, sourceLabel?: string | null, title?: string | null, publishedAt?: any | null, processedItemId?: string | null, processedArticleId?: string | null }> } | null };

export type NewsEventsQueryVariables = Exact<{
  limit?: InputMaybe<Scalars['Int']['input']>;
  windowDays?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<NewsEventStatus>;
  sourceType?: InputMaybe<NewsEventSourceType>;
  minHeatScore?: InputMaybe<Scalars['Float']['input']>;
  minCredibilityScore?: InputMaybe<Scalars['Float']['input']>;
  sortBy?: InputMaybe<NewsEventSortBy>;
}>;


export type NewsEventsQuery = { __typename?: 'Query', newsEvents: Array<{ __typename?: 'NewsEventModel', id: string, title?: string | null, status: NewsEventStatus, language?: string | null, primaryTopic?: string | null, primaryEntity?: string | null, summary?: string | null, startAt: any, lastAt: any, itemCount: number, representativeProcessedArticleId?: string | null, representativeProcessedItemId?: string | null, metadata?: any | null, createdAt: any, updatedAt: any, breaking: boolean, heatScore: number, credibilityScore: number, sourceType: NewsEventSourceType, sourceEvidence: { __typename?: 'NewsEventSourceEvidenceModel', uniqueSourceCount: number, authoritativeSourceCount: number, blogSourceCount: number, corroborated: boolean } }> };

export type NewsEventQueryVariables = Exact<{
  id: Scalars['String']['input'];
  itemsLimit?: InputMaybe<Scalars['Int']['input']>;
  timelineLimit?: InputMaybe<Scalars['Int']['input']>;
}>;


export type NewsEventQuery = { __typename?: 'Query', newsEvent?: { __typename?: 'NewsEventModel', id: string, title?: string | null, status: NewsEventStatus, language?: string | null, primaryTopic?: string | null, primaryEntity?: string | null, summary?: string | null, startAt: any, lastAt: any, itemCount: number, representativeProcessedArticleId?: string | null, representativeProcessedItemId?: string | null, metadata?: any | null, createdAt: any, updatedAt: any, breaking: boolean, heatScore: number, credibilityScore: number, sourceType: NewsEventSourceType, sourceEvidence: { __typename?: 'NewsEventSourceEvidenceModel', uniqueSourceCount: number, authoritativeSourceCount: number, blogSourceCount: number, corroborated: boolean }, items?: Array<{ __typename?: 'NewsEventItemModel', id: string, eventId: string, processedArticleId: string, itemMetaId?: string | null, processedItemId?: string | null, similarity?: number | null, assignedBy: NewsEventAssignmentMethod, createdAt: any, processedArticle: { __typename?: 'NewsEventProcessedArticleModel', id: string, articleId: string, title?: string | null, summary?: string | null, publishedAt?: any | null, language?: string | null, processedAt: any, article: { __typename?: 'NewsEventArticleModel', id: string, url: string, sourceLabel?: string | null, crawlAt: any } } }> | null, timeline?: Array<{ __typename?: 'NewsEventTimelineEntryModel', id: string, eventId: string, bucketStart: any, title?: string | null, summary?: string | null, keyPoints?: any | null, referencedArticleIds?: any | null, createdAt: any, updatedAt: any }> | null } | null };

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

export type ProcessedItemByIdQueryVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type ProcessedItemByIdQuery = { __typename?: 'Query', processedItemById?: { __typename?: 'ProcessedItemModelGraph', id: string, itemMetaId: string, status: string, tags: Array<string>, resultJson?: any | null, createdAt: any } | null };

export type QueueStatsQueryVariables = Exact<{ [key: string]: never; }>;


export type QueueStatsQuery = { __typename?: 'Query', queueStats: { __typename?: 'QueueStatsModel', processedCount: number, itemCount: number, counts: { __typename?: 'QueueCountsModel', waiting: number, active: number, completed: number, failed: number, delayed: number }, recentLogs: Array<{ __typename?: 'QueueEventModel', event: string, jobId: string, data?: string | null, timestamp: string }> } };

export type AccessSettingsMetaQueryVariables = Exact<{ [key: string]: never; }>;


export type AccessSettingsMetaQuery = { __typename?: 'Query', roles: Array<{ __typename?: 'RoleModel', id: string, name: string, description?: string | null, isSystem: boolean, permissions: Array<{ __typename?: 'PermissionModel', id: string, name: string, description?: string | null }> }>, permissions: Array<{ __typename?: 'PermissionModel', id: string, name: string, description?: string | null }> };

export type AccessSettingsUsersQueryVariables = Exact<{
  first: Scalars['Int']['input'];
  after?: InputMaybe<Scalars['String']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
}>;


export type AccessSettingsUsersQuery = { __typename?: 'Query', users: Array<{ __typename?: 'UserModel', id: string, email: string, firstName: string, lastName: string, primaryRoleId?: string | null, isActive: boolean, emailVerified?: any | null, lastLoginAt?: any | null, roleIds: Array<string>, permissions: Array<string> }> };

export type UserLoginRecordsQueryVariables = Exact<{
  userId: Scalars['String']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
}>;


export type UserLoginRecordsQuery = { __typename?: 'Query', userLoginRecords: Array<{ __typename?: 'UserLoginRecordModel', id: string, createdAt: any, ipAddress?: string | null, userAgent?: string | null, method: string }> };

export type CreateRoleMutationVariables = Exact<{
  input: CreateRoleInput;
}>;


export type CreateRoleMutation = { __typename?: 'Mutation', createRole: { __typename?: 'RoleModel', id: string, name: string, description?: string | null, isSystem: boolean, permissions: Array<{ __typename?: 'PermissionModel', id: string, name: string, description?: string | null }> } };

export type UpdateRoleMutationVariables = Exact<{
  input: UpdateRoleInput;
}>;


export type UpdateRoleMutation = { __typename?: 'Mutation', updateRole: { __typename?: 'RoleModel', id: string, name: string, description?: string | null, isSystem: boolean, permissions: Array<{ __typename?: 'PermissionModel', id: string, name: string, description?: string | null }> } };

export type UpdateMembershipRolesMutationVariables = Exact<{
  input: UpdateMembershipRolesInput;
}>;


export type UpdateMembershipRolesMutation = { __typename?: 'Mutation', updateMembershipRoles: { __typename?: 'UserModel', id: string, email: string, firstName: string, lastName: string, primaryRoleId?: string | null, isActive: boolean, emailVerified?: any | null, lastLoginAt?: any | null, roleIds: Array<string>, permissions: Array<string> } };

export type SetUserActiveMutationVariables = Exact<{
  input: SetUserActiveInput;
}>;


export type SetUserActiveMutation = { __typename?: 'Mutation', setUserActive: { __typename?: 'UserModel', id: string, email: string, firstName: string, lastName: string, primaryRoleId?: string | null, isActive: boolean, emailVerified?: any | null, lastLoginAt?: any | null, roleIds: Array<string>, permissions: Array<string> } };

export type SearchSuggestionsQueryVariables = Exact<{
  prefix: Scalars['String']['input'];
  limit?: InputMaybe<Scalars['Float']['input']>;
}>;


export type SearchSuggestionsQuery = { __typename?: 'Query', searchSuggestions: Array<{ __typename?: 'SearchSuggestionModel', type: SearchSuggestionType, value: string, origin: SearchSuggestionOrigin }> };

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


export type CrawlClientSettingsQuery = { __typename?: 'Query', crawlClientSettings: { __typename?: 'CrawlClientSettingsModel', healthCheckTtlMs: number, requestTimeoutMs: number, requestTimeoutHotMs: number, requestTimeoutNormalMs: number, conditionalRequestEnabled: boolean, conditionalRequestTimeoutMs: number, conditionalRequestMaxRetries: number, detailPublishSignalHeadFetchTimeoutMs: number, detailPublishSignalHeadFetchConcurrency: number, detailPublishSignalHeadFetchMaxReadBytes: number, maxRetries: number, retryBackoffMs: number, queueOverloadCooldownMs: number, adaptiveConcurrencyEnabled: boolean, adaptiveWindowMinutes: number, adaptiveCooldownMinutes: number, adaptiveLatencyThresholdRatio: number, adaptiveErrorRateThreshold: number, adaptiveMemoryHeadroomThreshold: number } };

export type UpdateCrawlClientSettingsMutationVariables = Exact<{
  input: UpdateCrawlClientSettingsInput;
}>;


export type UpdateCrawlClientSettingsMutation = { __typename?: 'Mutation', updateCrawlClientSettings: { __typename?: 'CrawlClientSettingsModel', healthCheckTtlMs: number, requestTimeoutMs: number, requestTimeoutHotMs: number, requestTimeoutNormalMs: number, conditionalRequestEnabled: boolean, conditionalRequestTimeoutMs: number, conditionalRequestMaxRetries: number, detailPublishSignalHeadFetchTimeoutMs: number, detailPublishSignalHeadFetchConcurrency: number, detailPublishSignalHeadFetchMaxReadBytes: number, maxRetries: number, retryBackoffMs: number, queueOverloadCooldownMs: number, adaptiveConcurrencyEnabled: boolean, adaptiveWindowMinutes: number, adaptiveCooldownMinutes: number, adaptiveLatencyThresholdRatio: number, adaptiveErrorRateThreshold: number, adaptiveMemoryHeadroomThreshold: number } };

export type EntityImpactGraphSettingsQueryVariables = Exact<{ [key: string]: never; }>;


export type EntityImpactGraphSettingsQuery = { __typename?: 'Query', entityImpactGraphSettings: { __typename?: 'EntityImpactGraphSettingsModel', enabled: boolean, minEntityConfidence: number, minCorrelation: number, minCoOccurrence: number, maxNodes: number, categories: Array<string>, cacheTtlSeconds: number } };

export type UpdateEntityImpactGraphSettingsMutationVariables = Exact<{
  input: UpdateEntityImpactGraphSettingsInput;
}>;


export type UpdateEntityImpactGraphSettingsMutation = { __typename?: 'Mutation', updateEntityImpactGraphSettings: { __typename?: 'EntityImpactGraphSettingsModel', enabled: boolean, minEntityConfidence: number, minCorrelation: number, minCoOccurrence: number, maxNodes: number, categories: Array<string>, cacheTtlSeconds: number } };

export type KnowledgeGraphSettingsQueryVariables = Exact<{ [key: string]: never; }>;


export type KnowledgeGraphSettingsQuery = { __typename?: 'Query', knowledgeGraphSettings: { __typename?: 'KnowledgeGraphSettingsModel', enabled: boolean, ingestionEnabled: boolean, maxBatchSize: number, maxRelationsPerArticle: number, minEdgeConfidence: number, dynamicEdgeConfidenceEnabled: boolean, dynamicEdgeConfidenceQuantile: number, multiModelValidationEnabled: boolean, multiModelValidationModels: Array<string>, multiModelValidationModelCount: number, multiModelValidationMaxRelationsPerArticle: number, entityDisambiguationEnabled: boolean, entityDisambiguationMaxCandidates: number, cacheTtlSeconds: number } };

export type UpdateKnowledgeGraphSettingsMutationVariables = Exact<{
  input: UpdateKnowledgeGraphSettingsInput;
}>;


export type UpdateKnowledgeGraphSettingsMutation = { __typename?: 'Mutation', updateKnowledgeGraphSettings: { __typename?: 'KnowledgeGraphSettingsModel', enabled: boolean, ingestionEnabled: boolean, maxBatchSize: number, maxRelationsPerArticle: number, minEdgeConfidence: number, dynamicEdgeConfidenceEnabled: boolean, dynamicEdgeConfidenceQuantile: number, multiModelValidationEnabled: boolean, multiModelValidationModels: Array<string>, multiModelValidationModelCount: number, multiModelValidationMaxRelationsPerArticle: number, entityDisambiguationEnabled: boolean, entityDisambiguationMaxCandidates: number, cacheTtlSeconds: number } };


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
    isActive
    config
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
    ruleId
    ruleName
    metricProvider
    metricSlug
    operator
    thresholdValue
    thresholdLower
    thresholdUpper
    changeWindowMin
    context
    deliveries {
      id
      status
      channelType
      channelName
      target
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
    isActive
    config
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
export const UpdateAlertChannelDocument = gql`
    mutation UpdateAlertChannel($input: UpdateAlertChannelInput!) {
  updateAlertChannel(input: $input) {
    id
    name
    type
    target
    isActive
    config
  }
}
    `;
export type UpdateAlertChannelMutationFn = Apollo.MutationFunction<UpdateAlertChannelMutation, UpdateAlertChannelMutationVariables>;

/**
 * __useUpdateAlertChannelMutation__
 *
 * To run a mutation, you first call `useUpdateAlertChannelMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateAlertChannelMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateAlertChannelMutation, { data, loading, error }] = useUpdateAlertChannelMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateAlertChannelMutation(baseOptions?: Apollo.MutationHookOptions<UpdateAlertChannelMutation, UpdateAlertChannelMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateAlertChannelMutation, UpdateAlertChannelMutationVariables>(UpdateAlertChannelDocument, options);
      }
export type UpdateAlertChannelMutationHookResult = ReturnType<typeof useUpdateAlertChannelMutation>;
export type UpdateAlertChannelMutationResult = Apollo.MutationResult<UpdateAlertChannelMutation>;
export type UpdateAlertChannelMutationOptions = Apollo.BaseMutationOptions<UpdateAlertChannelMutation, UpdateAlertChannelMutationVariables>;
export const DeleteAlertChannelDocument = gql`
    mutation DeleteAlertChannel($channelId: String!) {
  deleteAlertChannel(channelId: $channelId)
}
    `;
export type DeleteAlertChannelMutationFn = Apollo.MutationFunction<DeleteAlertChannelMutation, DeleteAlertChannelMutationVariables>;

/**
 * __useDeleteAlertChannelMutation__
 *
 * To run a mutation, you first call `useDeleteAlertChannelMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useDeleteAlertChannelMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [deleteAlertChannelMutation, { data, loading, error }] = useDeleteAlertChannelMutation({
 *   variables: {
 *      channelId: // value for 'channelId'
 *   },
 * });
 */
export function useDeleteAlertChannelMutation(baseOptions?: Apollo.MutationHookOptions<DeleteAlertChannelMutation, DeleteAlertChannelMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<DeleteAlertChannelMutation, DeleteAlertChannelMutationVariables>(DeleteAlertChannelDocument, options);
      }
export type DeleteAlertChannelMutationHookResult = ReturnType<typeof useDeleteAlertChannelMutation>;
export type DeleteAlertChannelMutationResult = Apollo.MutationResult<DeleteAlertChannelMutation>;
export type DeleteAlertChannelMutationOptions = Apollo.BaseMutationOptions<DeleteAlertChannelMutation, DeleteAlertChannelMutationVariables>;
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
export const UpdateAlertEventStatusDocument = gql`
    mutation UpdateAlertEventStatus($input: UpdateAlertEventStatusInput!) {
  updateAlertEventStatus(input: $input) {
    id
    status
  }
}
    `;
export type UpdateAlertEventStatusMutationFn = Apollo.MutationFunction<UpdateAlertEventStatusMutation, UpdateAlertEventStatusMutationVariables>;

/**
 * __useUpdateAlertEventStatusMutation__
 *
 * To run a mutation, you first call `useUpdateAlertEventStatusMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateAlertEventStatusMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateAlertEventStatusMutation, { data, loading, error }] = useUpdateAlertEventStatusMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateAlertEventStatusMutation(baseOptions?: Apollo.MutationHookOptions<UpdateAlertEventStatusMutation, UpdateAlertEventStatusMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateAlertEventStatusMutation, UpdateAlertEventStatusMutationVariables>(UpdateAlertEventStatusDocument, options);
      }
export type UpdateAlertEventStatusMutationHookResult = ReturnType<typeof useUpdateAlertEventStatusMutation>;
export type UpdateAlertEventStatusMutationResult = Apollo.MutationResult<UpdateAlertEventStatusMutation>;
export type UpdateAlertEventStatusMutationOptions = Apollo.BaseMutationOptions<UpdateAlertEventStatusMutation, UpdateAlertEventStatusMutationVariables>;
export const AlertEventReplayDocument = gql`
    query AlertEventReplay($eventId: String!, $windowDays: Int) {
  alertEventReplay(eventId: $eventId, windowDays: $windowDays) {
    eventId
    metricProvider
    metricSlug
    unit
    points {
      timestamp
      value
    }
  }
}
    `;

/**
 * __useAlertEventReplayQuery__
 *
 * To run a query within a React component, call `useAlertEventReplayQuery` and pass it any options that fit your needs.
 * When your component renders, `useAlertEventReplayQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAlertEventReplayQuery({
 *   variables: {
 *      eventId: // value for 'eventId'
 *      windowDays: // value for 'windowDays'
 *   },
 * });
 */
export function useAlertEventReplayQuery(baseOptions: Apollo.QueryHookOptions<AlertEventReplayQuery, AlertEventReplayQueryVariables> & ({ variables: AlertEventReplayQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<AlertEventReplayQuery, AlertEventReplayQueryVariables>(AlertEventReplayDocument, options);
      }
export function useAlertEventReplayLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<AlertEventReplayQuery, AlertEventReplayQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<AlertEventReplayQuery, AlertEventReplayQueryVariables>(AlertEventReplayDocument, options);
        }
export function useAlertEventReplaySuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<AlertEventReplayQuery, AlertEventReplayQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<AlertEventReplayQuery, AlertEventReplayQueryVariables>(AlertEventReplayDocument, options);
        }
export type AlertEventReplayQueryHookResult = ReturnType<typeof useAlertEventReplayQuery>;
export type AlertEventReplayLazyQueryHookResult = ReturnType<typeof useAlertEventReplayLazyQuery>;
export type AlertEventReplaySuspenseQueryHookResult = ReturnType<typeof useAlertEventReplaySuspenseQuery>;
export type AlertEventReplayQueryResult = Apollo.QueryResult<AlertEventReplayQuery, AlertEventReplayQueryVariables>;
export const AlertRuleTuningSuggestionDocument = gql`
    query AlertRuleTuningSuggestion($ruleId: String!, $windowDays: Int) {
  alertRuleTuningSuggestion(ruleId: $ruleId, windowDays: $windowDays) {
    ruleId
    windowDays
    totalEvents
    reviewedEvents
    confirmedEvents
    ignoredEvents
    falsePositiveRate
    action
    message
    suggestedThresholdValue
    suggestedThresholdLower
    suggestedThresholdUpper
  }
}
    `;

/**
 * __useAlertRuleTuningSuggestionQuery__
 *
 * To run a query within a React component, call `useAlertRuleTuningSuggestionQuery` and pass it any options that fit your needs.
 * When your component renders, `useAlertRuleTuningSuggestionQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAlertRuleTuningSuggestionQuery({
 *   variables: {
 *      ruleId: // value for 'ruleId'
 *      windowDays: // value for 'windowDays'
 *   },
 * });
 */
export function useAlertRuleTuningSuggestionQuery(baseOptions: Apollo.QueryHookOptions<AlertRuleTuningSuggestionQuery, AlertRuleTuningSuggestionQueryVariables> & ({ variables: AlertRuleTuningSuggestionQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<AlertRuleTuningSuggestionQuery, AlertRuleTuningSuggestionQueryVariables>(AlertRuleTuningSuggestionDocument, options);
      }
export function useAlertRuleTuningSuggestionLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<AlertRuleTuningSuggestionQuery, AlertRuleTuningSuggestionQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<AlertRuleTuningSuggestionQuery, AlertRuleTuningSuggestionQueryVariables>(AlertRuleTuningSuggestionDocument, options);
        }
export function useAlertRuleTuningSuggestionSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<AlertRuleTuningSuggestionQuery, AlertRuleTuningSuggestionQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<AlertRuleTuningSuggestionQuery, AlertRuleTuningSuggestionQueryVariables>(AlertRuleTuningSuggestionDocument, options);
        }
export type AlertRuleTuningSuggestionQueryHookResult = ReturnType<typeof useAlertRuleTuningSuggestionQuery>;
export type AlertRuleTuningSuggestionLazyQueryHookResult = ReturnType<typeof useAlertRuleTuningSuggestionLazyQuery>;
export type AlertRuleTuningSuggestionSuspenseQueryHookResult = ReturnType<typeof useAlertRuleTuningSuggestionSuspenseQuery>;
export type AlertRuleTuningSuggestionQueryResult = Apollo.QueryResult<AlertRuleTuningSuggestionQuery, AlertRuleTuningSuggestionQueryVariables>;
export const AlertEventsStreamDocument = gql`
    subscription AlertEventsStream {
  alertEvents {
    id
    triggeredAt
    severity
    message
    metricValue
    changePercent
    ruleName
    metricSlug
    context
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
export const RequestGeoTransportDocument = gql`
    mutation RequestGeoTransport($input: GeoTransportAnalysisInput!) {
  requestGeoTransportAnalysis(input: $input) {
    id
    status
    type
  }
}
    `;
export type RequestGeoTransportMutationFn = Apollo.MutationFunction<RequestGeoTransportMutation, RequestGeoTransportMutationVariables>;

/**
 * __useRequestGeoTransportMutation__
 *
 * To run a mutation, you first call `useRequestGeoTransportMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useRequestGeoTransportMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [requestGeoTransportMutation, { data, loading, error }] = useRequestGeoTransportMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useRequestGeoTransportMutation(baseOptions?: Apollo.MutationHookOptions<RequestGeoTransportMutation, RequestGeoTransportMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<RequestGeoTransportMutation, RequestGeoTransportMutationVariables>(RequestGeoTransportDocument, options);
      }
export type RequestGeoTransportMutationHookResult = ReturnType<typeof useRequestGeoTransportMutation>;
export type RequestGeoTransportMutationResult = Apollo.MutationResult<RequestGeoTransportMutation>;
export type RequestGeoTransportMutationOptions = Apollo.BaseMutationOptions<RequestGeoTransportMutation, RequestGeoTransportMutationVariables>;
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
        config
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
    lastRunSummary {
      inserted
      skipped
      itemsQueued
      itemsQueueFailed
      lastFetchedAt
      runId
      retryableFailures
    }
    results {
      id
      itemId
      itemStatus
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
export const UpdateCrawlTaskIngestToItemsDocument = gql`
    mutation UpdateCrawlTaskIngestToItems($id: String!, $enabled: Boolean!) {
  updateCrawlTaskIngestToItems(id: $id, enabled: $enabled) {
    id
    config
  }
}
    `;
export type UpdateCrawlTaskIngestToItemsMutationFn = Apollo.MutationFunction<UpdateCrawlTaskIngestToItemsMutation, UpdateCrawlTaskIngestToItemsMutationVariables>;

/**
 * __useUpdateCrawlTaskIngestToItemsMutation__
 *
 * To run a mutation, you first call `useUpdateCrawlTaskIngestToItemsMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateCrawlTaskIngestToItemsMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateCrawlTaskIngestToItemsMutation, { data, loading, error }] = useUpdateCrawlTaskIngestToItemsMutation({
 *   variables: {
 *      id: // value for 'id'
 *      enabled: // value for 'enabled'
 *   },
 * });
 */
export function useUpdateCrawlTaskIngestToItemsMutation(baseOptions?: Apollo.MutationHookOptions<UpdateCrawlTaskIngestToItemsMutation, UpdateCrawlTaskIngestToItemsMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateCrawlTaskIngestToItemsMutation, UpdateCrawlTaskIngestToItemsMutationVariables>(UpdateCrawlTaskIngestToItemsDocument, options);
      }
export type UpdateCrawlTaskIngestToItemsMutationHookResult = ReturnType<typeof useUpdateCrawlTaskIngestToItemsMutation>;
export type UpdateCrawlTaskIngestToItemsMutationResult = Apollo.MutationResult<UpdateCrawlTaskIngestToItemsMutation>;
export type UpdateCrawlTaskIngestToItemsMutationOptions = Apollo.BaseMutationOptions<UpdateCrawlTaskIngestToItemsMutation, UpdateCrawlTaskIngestToItemsMutationVariables>;
export const IngestCrawlTaskResultsToItemsDocument = gql`
    mutation IngestCrawlTaskResultsToItems($taskId: String!, $after: String, $limit: Float, $onlyMissing: Boolean) {
  ingestCrawlTaskResultsToItems(
    taskId: $taskId
    after: $after
    limit: $limit
    onlyMissing: $onlyMissing
  ) {
    taskId
    scanned
    attempted
    ingested
    skippedExisting
    failed
    nextCursor
    hasMore
  }
}
    `;
export type IngestCrawlTaskResultsToItemsMutationFn = Apollo.MutationFunction<IngestCrawlTaskResultsToItemsMutation, IngestCrawlTaskResultsToItemsMutationVariables>;

/**
 * __useIngestCrawlTaskResultsToItemsMutation__
 *
 * To run a mutation, you first call `useIngestCrawlTaskResultsToItemsMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useIngestCrawlTaskResultsToItemsMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [ingestCrawlTaskResultsToItemsMutation, { data, loading, error }] = useIngestCrawlTaskResultsToItemsMutation({
 *   variables: {
 *      taskId: // value for 'taskId'
 *      after: // value for 'after'
 *      limit: // value for 'limit'
 *      onlyMissing: // value for 'onlyMissing'
 *   },
 * });
 */
export function useIngestCrawlTaskResultsToItemsMutation(baseOptions?: Apollo.MutationHookOptions<IngestCrawlTaskResultsToItemsMutation, IngestCrawlTaskResultsToItemsMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<IngestCrawlTaskResultsToItemsMutation, IngestCrawlTaskResultsToItemsMutationVariables>(IngestCrawlTaskResultsToItemsDocument, options);
      }
export type IngestCrawlTaskResultsToItemsMutationHookResult = ReturnType<typeof useIngestCrawlTaskResultsToItemsMutation>;
export type IngestCrawlTaskResultsToItemsMutationResult = Apollo.MutationResult<IngestCrawlTaskResultsToItemsMutation>;
export type IngestCrawlTaskResultsToItemsMutationOptions = Apollo.BaseMutationOptions<IngestCrawlTaskResultsToItemsMutation, IngestCrawlTaskResultsToItemsMutationVariables>;
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
    query DashboardHeroMetrics($start: DateTime!, $end: DateTime!, $granularity: TimeGranularity) {
  conflict: getEconomicData(
    category: "global-conflict-index"
    timeRange: {start: $start, end: $end}
    granularity: $granularity
  ) {
    timestamp
    effectiveGranularity
    value
    unit
    dataType
    item {
      displayName
      defaultUnit
    }
  }
  market: getEconomicData(
    category: "market-sentiment"
    timeRange: {start: $start, end: $end}
    granularity: $granularity
  ) {
    timestamp
    effectiveGranularity
    sourceField
    value
    unit
    dataType
    item {
      slug
      displayName
      defaultUnit
    }
  }
  resource: getEconomicData(
    category: "resource-scarcity"
    timeRange: {start: $start, end: $end}
    granularity: $granularity
  ) {
    timestamp
    effectiveGranularity
    value
    unit
    dataType
    item {
      displayName
      defaultUnit
    }
  }
  supply: getEconomicData(
    category: "supply-chain-stability"
    timeRange: {start: $start, end: $end}
    granularity: $granularity
  ) {
    timestamp
    effectiveGranularity
    value
    unit
    dataType
    item {
      displayName
      defaultUnit
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
 *      granularity: // value for 'granularity'
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
    query MetricDrillDownDetails($category: String!, $start: DateTime!, $end: DateTime!, $granularity: TimeGranularity) {
  history: getEconomicData(
    category: $category
    timeRange: {start: $start, end: $end}
    granularity: $granularity
  ) {
    timestamp
    effectiveGranularity
    value
    unit
    dataType
    item {
      displayName
      defaultUnit
    }
  }
  relatedAlerts: alertEvents(limit: 20) {
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
 *      granularity: // value for 'granularity'
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
    effectiveGranularity
    value
    unit
    sourceField
    dataType
    item {
      slug
      displayName
      groupLabel
      defaultUnit
      metadata
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
export const EconomicDataWithInsightsDocument = gql`
    query EconomicDataWithInsights($category: String!, $timeRange: DateRangeInput!, $granularity: TimeGranularity) {
  getEconomicDataWithInsights(
    category: $category
    timeRange: $timeRange
    granularity: $granularity
  ) {
    points {
      timestamp
      effectiveGranularity
      value
      unit
      sourceField
      dataType
      item {
        slug
        displayName
        groupLabel
        defaultUnit
        metadata
      }
    }
    insights {
      itemSlug
      seriesKey
      sourceField
      unit
      sampleCount
      currentValue
      previousValue
      change
      percentChange
      mean
      stdDev
      zScore
      direction
      classification
      message
    }
  }
}
    `;

/**
 * __useEconomicDataWithInsightsQuery__
 *
 * To run a query within a React component, call `useEconomicDataWithInsightsQuery` and pass it any options that fit your needs.
 * When your component renders, `useEconomicDataWithInsightsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useEconomicDataWithInsightsQuery({
 *   variables: {
 *      category: // value for 'category'
 *      timeRange: // value for 'timeRange'
 *      granularity: // value for 'granularity'
 *   },
 * });
 */
export function useEconomicDataWithInsightsQuery(baseOptions: Apollo.QueryHookOptions<EconomicDataWithInsightsQuery, EconomicDataWithInsightsQueryVariables> & ({ variables: EconomicDataWithInsightsQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<EconomicDataWithInsightsQuery, EconomicDataWithInsightsQueryVariables>(EconomicDataWithInsightsDocument, options);
      }
export function useEconomicDataWithInsightsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<EconomicDataWithInsightsQuery, EconomicDataWithInsightsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<EconomicDataWithInsightsQuery, EconomicDataWithInsightsQueryVariables>(EconomicDataWithInsightsDocument, options);
        }
export function useEconomicDataWithInsightsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<EconomicDataWithInsightsQuery, EconomicDataWithInsightsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<EconomicDataWithInsightsQuery, EconomicDataWithInsightsQueryVariables>(EconomicDataWithInsightsDocument, options);
        }
export type EconomicDataWithInsightsQueryHookResult = ReturnType<typeof useEconomicDataWithInsightsQuery>;
export type EconomicDataWithInsightsLazyQueryHookResult = ReturnType<typeof useEconomicDataWithInsightsLazyQuery>;
export type EconomicDataWithInsightsSuspenseQueryHookResult = ReturnType<typeof useEconomicDataWithInsightsSuspenseQuery>;
export type EconomicDataWithInsightsQueryResult = Apollo.QueryResult<EconomicDataWithInsightsQuery, EconomicDataWithInsightsQueryVariables>;
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
      groupLabel
      defaultUnit
      metadata
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
export const EconomicDataRefreshPresetStatusDocument = gql`
    query EconomicDataRefreshPresetStatus($preset: EconomicDashboardRefreshPreset!) {
  economicDataRefreshPresetStatus(preset: $preset) {
    preset
    categoryKey
    totalItems
    enabledItems
    lastRunAt
    lastStatus
    lastError
  }
}
    `;

/**
 * __useEconomicDataRefreshPresetStatusQuery__
 *
 * To run a query within a React component, call `useEconomicDataRefreshPresetStatusQuery` and pass it any options that fit your needs.
 * When your component renders, `useEconomicDataRefreshPresetStatusQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useEconomicDataRefreshPresetStatusQuery({
 *   variables: {
 *      preset: // value for 'preset'
 *   },
 * });
 */
export function useEconomicDataRefreshPresetStatusQuery(baseOptions: Apollo.QueryHookOptions<EconomicDataRefreshPresetStatusQuery, EconomicDataRefreshPresetStatusQueryVariables> & ({ variables: EconomicDataRefreshPresetStatusQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<EconomicDataRefreshPresetStatusQuery, EconomicDataRefreshPresetStatusQueryVariables>(EconomicDataRefreshPresetStatusDocument, options);
      }
export function useEconomicDataRefreshPresetStatusLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<EconomicDataRefreshPresetStatusQuery, EconomicDataRefreshPresetStatusQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<EconomicDataRefreshPresetStatusQuery, EconomicDataRefreshPresetStatusQueryVariables>(EconomicDataRefreshPresetStatusDocument, options);
        }
export function useEconomicDataRefreshPresetStatusSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<EconomicDataRefreshPresetStatusQuery, EconomicDataRefreshPresetStatusQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<EconomicDataRefreshPresetStatusQuery, EconomicDataRefreshPresetStatusQueryVariables>(EconomicDataRefreshPresetStatusDocument, options);
        }
export type EconomicDataRefreshPresetStatusQueryHookResult = ReturnType<typeof useEconomicDataRefreshPresetStatusQuery>;
export type EconomicDataRefreshPresetStatusLazyQueryHookResult = ReturnType<typeof useEconomicDataRefreshPresetStatusLazyQuery>;
export type EconomicDataRefreshPresetStatusSuspenseQueryHookResult = ReturnType<typeof useEconomicDataRefreshPresetStatusSuspenseQuery>;
export type EconomicDataRefreshPresetStatusQueryResult = Apollo.QueryResult<EconomicDataRefreshPresetStatusQuery, EconomicDataRefreshPresetStatusQueryVariables>;
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
      groupLabel
      defaultUnit
      metadata
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
export const TriggerEconomicDataRefreshPresetDocument = gql`
    mutation TriggerEconomicDataRefreshPreset($preset: EconomicDashboardRefreshPreset!) {
  triggerEconomicDataRefreshPreset(preset: $preset)
}
    `;
export type TriggerEconomicDataRefreshPresetMutationFn = Apollo.MutationFunction<TriggerEconomicDataRefreshPresetMutation, TriggerEconomicDataRefreshPresetMutationVariables>;

/**
 * __useTriggerEconomicDataRefreshPresetMutation__
 *
 * To run a mutation, you first call `useTriggerEconomicDataRefreshPresetMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useTriggerEconomicDataRefreshPresetMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [triggerEconomicDataRefreshPresetMutation, { data, loading, error }] = useTriggerEconomicDataRefreshPresetMutation({
 *   variables: {
 *      preset: // value for 'preset'
 *   },
 * });
 */
export function useTriggerEconomicDataRefreshPresetMutation(baseOptions?: Apollo.MutationHookOptions<TriggerEconomicDataRefreshPresetMutation, TriggerEconomicDataRefreshPresetMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<TriggerEconomicDataRefreshPresetMutation, TriggerEconomicDataRefreshPresetMutationVariables>(TriggerEconomicDataRefreshPresetDocument, options);
      }
export type TriggerEconomicDataRefreshPresetMutationHookResult = ReturnType<typeof useTriggerEconomicDataRefreshPresetMutation>;
export type TriggerEconomicDataRefreshPresetMutationResult = Apollo.MutationResult<TriggerEconomicDataRefreshPresetMutation>;
export type TriggerEconomicDataRefreshPresetMutationOptions = Apollo.BaseMutationOptions<TriggerEconomicDataRefreshPresetMutation, TriggerEconomicDataRefreshPresetMutationVariables>;
export const GetEntityImpactGraphDocument = gql`
    query GetEntityImpactGraph($input: EntityImpactGraphInput) {
  getEntityImpactGraph(input: $input) {
    nodes {
      id
      name
      category
      type
      value
    }
    links {
      source
      target
      value
      type
    }
    metadata {
      totalNodes
      totalLinks
      generatedAt
    }
  }
}
    `;

/**
 * __useGetEntityImpactGraphQuery__
 *
 * To run a query within a React component, call `useGetEntityImpactGraphQuery` and pass it any options that fit your needs.
 * When your component renders, `useGetEntityImpactGraphQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useGetEntityImpactGraphQuery({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useGetEntityImpactGraphQuery(baseOptions?: Apollo.QueryHookOptions<GetEntityImpactGraphQuery, GetEntityImpactGraphQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<GetEntityImpactGraphQuery, GetEntityImpactGraphQueryVariables>(GetEntityImpactGraphDocument, options);
      }
export function useGetEntityImpactGraphLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<GetEntityImpactGraphQuery, GetEntityImpactGraphQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<GetEntityImpactGraphQuery, GetEntityImpactGraphQueryVariables>(GetEntityImpactGraphDocument, options);
        }
export function useGetEntityImpactGraphSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<GetEntityImpactGraphQuery, GetEntityImpactGraphQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<GetEntityImpactGraphQuery, GetEntityImpactGraphQueryVariables>(GetEntityImpactGraphDocument, options);
        }
export type GetEntityImpactGraphQueryHookResult = ReturnType<typeof useGetEntityImpactGraphQuery>;
export type GetEntityImpactGraphLazyQueryHookResult = ReturnType<typeof useGetEntityImpactGraphLazyQuery>;
export type GetEntityImpactGraphSuspenseQueryHookResult = ReturnType<typeof useGetEntityImpactGraphSuspenseQuery>;
export type GetEntityImpactGraphQueryResult = Apollo.QueryResult<GetEntityImpactGraphQuery, GetEntityImpactGraphQueryVariables>;
export const ItemsDocument = gql`
    query Items($first: Int!, $after: String, $page: Int, $search: String, $filters: ItemsFiltersInput, $orderBy: ItemsOrderBy = CREATED_DESC, $rankingMode: ItemsRankingMode) {
  items(
    first: $first
    after: $after
    page: $page
    search: $search
    filters: $filters
    orderBy: $orderBy
    rankingMode: $rankingMode
  ) {
    edges {
      node {
        id
        title
        status
        createdAt
        ingestedAt
        publishedAt
        relevanceScore
        processedPreview {
          id
          itemMetaId
          status
          tags
          duplicateOf
          duplicateSimilarity
          source
          title
          language
          publishedAt
          summary
          contentType
          sentiment
          topics
          entities
          qualityScore
          location
          createdAt
          eventId
          llm {
            model
            promptVersion
            promptTokens
            completionTokens
            totalTokens
            costUsd
            latencyMs
          }
        }
        rawPreview {
          url
          sourceName
          thumbnail
          summary
          sentiment
          region
          location
          ticker
          price
          changePercent
          history {
            timestamp
            value
          }
        }
      }
      cursor
    }
    pageInfo {
      hasNextPage
      endCursor
    }
    totalCount
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
 *      page: // value for 'page'
 *      search: // value for 'search'
 *      filters: // value for 'filters'
 *      orderBy: // value for 'orderBy'
 *      rankingMode: // value for 'rankingMode'
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
export const ItemFacetsDocument = gql`
    query ItemFacets($search: String, $filters: ItemsFiltersInput) {
  itemFacets(search: $search, filters: $filters) {
    regions {
      value
      count
    }
    topics {
      value
      count
    }
    sentiments {
      value
      count
    }
    contentTypes {
      value
      count
    }
  }
}
    `;

/**
 * __useItemFacetsQuery__
 *
 * To run a query within a React component, call `useItemFacetsQuery` and pass it any options that fit your needs.
 * When your component renders, `useItemFacetsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useItemFacetsQuery({
 *   variables: {
 *      search: // value for 'search'
 *      filters: // value for 'filters'
 *   },
 * });
 */
export function useItemFacetsQuery(baseOptions?: Apollo.QueryHookOptions<ItemFacetsQuery, ItemFacetsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<ItemFacetsQuery, ItemFacetsQueryVariables>(ItemFacetsDocument, options);
      }
export function useItemFacetsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<ItemFacetsQuery, ItemFacetsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<ItemFacetsQuery, ItemFacetsQueryVariables>(ItemFacetsDocument, options);
        }
export function useItemFacetsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<ItemFacetsQuery, ItemFacetsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<ItemFacetsQuery, ItemFacetsQueryVariables>(ItemFacetsDocument, options);
        }
export type ItemFacetsQueryHookResult = ReturnType<typeof useItemFacetsQuery>;
export type ItemFacetsLazyQueryHookResult = ReturnType<typeof useItemFacetsLazyQuery>;
export type ItemFacetsSuspenseQueryHookResult = ReturnType<typeof useItemFacetsSuspenseQuery>;
export type ItemFacetsQueryResult = Apollo.QueryResult<ItemFacetsQuery, ItemFacetsQueryVariables>;
export const ItemDocument = gql`
    query Item($id: String!) {
  item(id: $id) {
    id
    title
    status
    createdAt
    updatedAt
    ingestedAt
    publishedAt
    meta {
      id
      externalId
      name
      status
      createdAt
      updatedAt
    }
    raw {
      id
      payload
      source
      createdAt
      updatedAt
    }
    processed {
      id
      status
      error {
        message
        name
      }
      tags
      duplicateOf
      duplicateSimilarity
      llm {
        model
        promptVersion
        promptTokens
        completionTokens
        totalTokens
        costUsd
        latencyMs
      }
      summaryEmbeddingModel
      summaryEmbeddingDimensions
      result
      resultJson
      createdAt
    }
  }
}
    `;

/**
 * __useItemQuery__
 *
 * To run a query within a React component, call `useItemQuery` and pass it any options that fit your needs.
 * When your component renders, `useItemQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useItemQuery({
 *   variables: {
 *      id: // value for 'id'
 *   },
 * });
 */
export function useItemQuery(baseOptions: Apollo.QueryHookOptions<ItemQuery, ItemQueryVariables> & ({ variables: ItemQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<ItemQuery, ItemQueryVariables>(ItemDocument, options);
      }
export function useItemLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<ItemQuery, ItemQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<ItemQuery, ItemQueryVariables>(ItemDocument, options);
        }
export function useItemSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<ItemQuery, ItemQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<ItemQuery, ItemQueryVariables>(ItemDocument, options);
        }
export type ItemQueryHookResult = ReturnType<typeof useItemQuery>;
export type ItemLazyQueryHookResult = ReturnType<typeof useItemLazyQuery>;
export type ItemSuspenseQueryHookResult = ReturnType<typeof useItemSuspenseQuery>;
export type ItemQueryResult = Apollo.QueryResult<ItemQuery, ItemQueryVariables>;
export const KnowledgeGraphEvidenceReviewQueueDocument = gql`
    query KnowledgeGraphEvidenceReviewQueue($limit: Int, $maxConfidence: Float, $onlyUnreviewed: Boolean) {
  knowledgeGraphEvidenceReviewQueue(
    limit: $limit
    maxConfidence: $maxConfidence
    onlyUnreviewed: $onlyUnreviewed
  ) {
    id
    confidence
    extractorVersion
    createdAt
    evidence
    edge {
      id
      type
      confidence
      weight
      properties
      fromEntity {
        id
        name
        type
      }
      toEntity {
        id
        name
        type
      }
    }
    article {
      id
      url
      title
      summary
      language
      crawlAt
    }
  }
}
    `;

/**
 * __useKnowledgeGraphEvidenceReviewQueueQuery__
 *
 * To run a query within a React component, call `useKnowledgeGraphEvidenceReviewQueueQuery` and pass it any options that fit your needs.
 * When your component renders, `useKnowledgeGraphEvidenceReviewQueueQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useKnowledgeGraphEvidenceReviewQueueQuery({
 *   variables: {
 *      limit: // value for 'limit'
 *      maxConfidence: // value for 'maxConfidence'
 *      onlyUnreviewed: // value for 'onlyUnreviewed'
 *   },
 * });
 */
export function useKnowledgeGraphEvidenceReviewQueueQuery(baseOptions?: Apollo.QueryHookOptions<KnowledgeGraphEvidenceReviewQueueQuery, KnowledgeGraphEvidenceReviewQueueQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<KnowledgeGraphEvidenceReviewQueueQuery, KnowledgeGraphEvidenceReviewQueueQueryVariables>(KnowledgeGraphEvidenceReviewQueueDocument, options);
      }
export function useKnowledgeGraphEvidenceReviewQueueLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<KnowledgeGraphEvidenceReviewQueueQuery, KnowledgeGraphEvidenceReviewQueueQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<KnowledgeGraphEvidenceReviewQueueQuery, KnowledgeGraphEvidenceReviewQueueQueryVariables>(KnowledgeGraphEvidenceReviewQueueDocument, options);
        }
export function useKnowledgeGraphEvidenceReviewQueueSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<KnowledgeGraphEvidenceReviewQueueQuery, KnowledgeGraphEvidenceReviewQueueQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<KnowledgeGraphEvidenceReviewQueueQuery, KnowledgeGraphEvidenceReviewQueueQueryVariables>(KnowledgeGraphEvidenceReviewQueueDocument, options);
        }
export type KnowledgeGraphEvidenceReviewQueueQueryHookResult = ReturnType<typeof useKnowledgeGraphEvidenceReviewQueueQuery>;
export type KnowledgeGraphEvidenceReviewQueueLazyQueryHookResult = ReturnType<typeof useKnowledgeGraphEvidenceReviewQueueLazyQuery>;
export type KnowledgeGraphEvidenceReviewQueueSuspenseQueryHookResult = ReturnType<typeof useKnowledgeGraphEvidenceReviewQueueSuspenseQuery>;
export type KnowledgeGraphEvidenceReviewQueueQueryResult = Apollo.QueryResult<KnowledgeGraphEvidenceReviewQueueQuery, KnowledgeGraphEvidenceReviewQueueQueryVariables>;
export const ReviewKnowledgeGraphEvidenceDocument = gql`
    mutation ReviewKnowledgeGraphEvidence($input: ReviewKnowledgeGraphEvidenceInput!) {
  reviewKnowledgeGraphEvidence(input: $input) {
    id
    confidence
    extractorVersion
    createdAt
    evidence
  }
}
    `;
export type ReviewKnowledgeGraphEvidenceMutationFn = Apollo.MutationFunction<ReviewKnowledgeGraphEvidenceMutation, ReviewKnowledgeGraphEvidenceMutationVariables>;

/**
 * __useReviewKnowledgeGraphEvidenceMutation__
 *
 * To run a mutation, you first call `useReviewKnowledgeGraphEvidenceMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useReviewKnowledgeGraphEvidenceMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [reviewKnowledgeGraphEvidenceMutation, { data, loading, error }] = useReviewKnowledgeGraphEvidenceMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useReviewKnowledgeGraphEvidenceMutation(baseOptions?: Apollo.MutationHookOptions<ReviewKnowledgeGraphEvidenceMutation, ReviewKnowledgeGraphEvidenceMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<ReviewKnowledgeGraphEvidenceMutation, ReviewKnowledgeGraphEvidenceMutationVariables>(ReviewKnowledgeGraphEvidenceDocument, options);
      }
export type ReviewKnowledgeGraphEvidenceMutationHookResult = ReturnType<typeof useReviewKnowledgeGraphEvidenceMutation>;
export type ReviewKnowledgeGraphEvidenceMutationResult = Apollo.MutationResult<ReviewKnowledgeGraphEvidenceMutation>;
export type ReviewKnowledgeGraphEvidenceMutationOptions = Apollo.BaseMutationOptions<ReviewKnowledgeGraphEvidenceMutation, ReviewKnowledgeGraphEvidenceMutationVariables>;
export const GetKnowledgeGraphSubgraphDocument = gql`
    query GetKnowledgeGraphSubgraph($input: KnowledgeGraphSubgraphInput!) {
  getKnowledgeGraphSubgraph(input: $input) {
    seed {
      id
      name
      type
      properties
    }
    nodes {
      id
      name
      type
      properties
    }
    edges {
      id
      from
      to
      type
      weight
      confidence
      properties
    }
    metadata {
      totalNodes
      totalEdges
      generatedAt
    }
  }
}
    `;

/**
 * __useGetKnowledgeGraphSubgraphQuery__
 *
 * To run a query within a React component, call `useGetKnowledgeGraphSubgraphQuery` and pass it any options that fit your needs.
 * When your component renders, `useGetKnowledgeGraphSubgraphQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useGetKnowledgeGraphSubgraphQuery({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useGetKnowledgeGraphSubgraphQuery(baseOptions: Apollo.QueryHookOptions<GetKnowledgeGraphSubgraphQuery, GetKnowledgeGraphSubgraphQueryVariables> & ({ variables: GetKnowledgeGraphSubgraphQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<GetKnowledgeGraphSubgraphQuery, GetKnowledgeGraphSubgraphQueryVariables>(GetKnowledgeGraphSubgraphDocument, options);
      }
export function useGetKnowledgeGraphSubgraphLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<GetKnowledgeGraphSubgraphQuery, GetKnowledgeGraphSubgraphQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<GetKnowledgeGraphSubgraphQuery, GetKnowledgeGraphSubgraphQueryVariables>(GetKnowledgeGraphSubgraphDocument, options);
        }
export function useGetKnowledgeGraphSubgraphSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<GetKnowledgeGraphSubgraphQuery, GetKnowledgeGraphSubgraphQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<GetKnowledgeGraphSubgraphQuery, GetKnowledgeGraphSubgraphQueryVariables>(GetKnowledgeGraphSubgraphDocument, options);
        }
export type GetKnowledgeGraphSubgraphQueryHookResult = ReturnType<typeof useGetKnowledgeGraphSubgraphQuery>;
export type GetKnowledgeGraphSubgraphLazyQueryHookResult = ReturnType<typeof useGetKnowledgeGraphSubgraphLazyQuery>;
export type GetKnowledgeGraphSubgraphSuspenseQueryHookResult = ReturnType<typeof useGetKnowledgeGraphSubgraphSuspenseQuery>;
export type GetKnowledgeGraphSubgraphQueryResult = Apollo.QueryResult<GetKnowledgeGraphSubgraphQuery, GetKnowledgeGraphSubgraphQueryVariables>;
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
export const NewsEventBriefDocument = gql`
    query NewsEventBrief($eventId: String!, $language: String, $maxSources: Int, $forceRefresh: Boolean) {
  newsEventBrief(
    eventId: $eventId
    language: $language
    maxSources: $maxSources
    forceRefresh: $forceRefresh
  ) {
    version
    generatedAt
    language
    detailedSummary
    tldr
    keyPoints {
      text
      citations
    }
    whyItMatters {
      text
      citations
    }
    latestUpdate {
      text
      citations
    }
    whatToWatch {
      text
      citations
    }
    comparison {
      consensus {
        text
        citations
      }
      divergence {
        text
        citations
      }
    }
    limitations
    sources {
      index
      url
      sourceLabel
      title
      publishedAt
      processedItemId
      processedArticleId
    }
  }
}
    `;

/**
 * __useNewsEventBriefQuery__
 *
 * To run a query within a React component, call `useNewsEventBriefQuery` and pass it any options that fit your needs.
 * When your component renders, `useNewsEventBriefQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useNewsEventBriefQuery({
 *   variables: {
 *      eventId: // value for 'eventId'
 *      language: // value for 'language'
 *      maxSources: // value for 'maxSources'
 *      forceRefresh: // value for 'forceRefresh'
 *   },
 * });
 */
export function useNewsEventBriefQuery(baseOptions: Apollo.QueryHookOptions<NewsEventBriefQuery, NewsEventBriefQueryVariables> & ({ variables: NewsEventBriefQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<NewsEventBriefQuery, NewsEventBriefQueryVariables>(NewsEventBriefDocument, options);
      }
export function useNewsEventBriefLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<NewsEventBriefQuery, NewsEventBriefQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<NewsEventBriefQuery, NewsEventBriefQueryVariables>(NewsEventBriefDocument, options);
        }
export function useNewsEventBriefSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<NewsEventBriefQuery, NewsEventBriefQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<NewsEventBriefQuery, NewsEventBriefQueryVariables>(NewsEventBriefDocument, options);
        }
export type NewsEventBriefQueryHookResult = ReturnType<typeof useNewsEventBriefQuery>;
export type NewsEventBriefLazyQueryHookResult = ReturnType<typeof useNewsEventBriefLazyQuery>;
export type NewsEventBriefSuspenseQueryHookResult = ReturnType<typeof useNewsEventBriefSuspenseQuery>;
export type NewsEventBriefQueryResult = Apollo.QueryResult<NewsEventBriefQuery, NewsEventBriefQueryVariables>;
export const NewsEventsDocument = gql`
    query NewsEvents($limit: Int, $windowDays: Int, $status: NewsEventStatus, $sourceType: NewsEventSourceType, $minHeatScore: Float, $minCredibilityScore: Float, $sortBy: NewsEventSortBy) {
  newsEvents(
    limit: $limit
    windowDays: $windowDays
    status: $status
    sourceType: $sourceType
    minHeatScore: $minHeatScore
    minCredibilityScore: $minCredibilityScore
    sortBy: $sortBy
  ) {
    id
    title
    status
    language
    primaryTopic
    primaryEntity
    summary
    startAt
    lastAt
    itemCount
    representativeProcessedArticleId
    representativeProcessedItemId
    metadata
    createdAt
    updatedAt
    breaking
    heatScore
    credibilityScore
    sourceType
    sourceEvidence {
      uniqueSourceCount
      authoritativeSourceCount
      blogSourceCount
      corroborated
    }
  }
}
    `;

/**
 * __useNewsEventsQuery__
 *
 * To run a query within a React component, call `useNewsEventsQuery` and pass it any options that fit your needs.
 * When your component renders, `useNewsEventsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useNewsEventsQuery({
 *   variables: {
 *      limit: // value for 'limit'
 *      windowDays: // value for 'windowDays'
 *      status: // value for 'status'
 *      sourceType: // value for 'sourceType'
 *      minHeatScore: // value for 'minHeatScore'
 *      minCredibilityScore: // value for 'minCredibilityScore'
 *      sortBy: // value for 'sortBy'
 *   },
 * });
 */
export function useNewsEventsQuery(baseOptions?: Apollo.QueryHookOptions<NewsEventsQuery, NewsEventsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<NewsEventsQuery, NewsEventsQueryVariables>(NewsEventsDocument, options);
      }
export function useNewsEventsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<NewsEventsQuery, NewsEventsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<NewsEventsQuery, NewsEventsQueryVariables>(NewsEventsDocument, options);
        }
export function useNewsEventsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<NewsEventsQuery, NewsEventsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<NewsEventsQuery, NewsEventsQueryVariables>(NewsEventsDocument, options);
        }
export type NewsEventsQueryHookResult = ReturnType<typeof useNewsEventsQuery>;
export type NewsEventsLazyQueryHookResult = ReturnType<typeof useNewsEventsLazyQuery>;
export type NewsEventsSuspenseQueryHookResult = ReturnType<typeof useNewsEventsSuspenseQuery>;
export type NewsEventsQueryResult = Apollo.QueryResult<NewsEventsQuery, NewsEventsQueryVariables>;
export const NewsEventDocument = gql`
    query NewsEvent($id: String!, $itemsLimit: Int, $timelineLimit: Int) {
  newsEvent(id: $id, itemsLimit: $itemsLimit, timelineLimit: $timelineLimit) {
    id
    title
    status
    language
    primaryTopic
    primaryEntity
    summary
    startAt
    lastAt
    itemCount
    representativeProcessedArticleId
    representativeProcessedItemId
    metadata
    createdAt
    updatedAt
    breaking
    heatScore
    credibilityScore
    sourceType
    sourceEvidence {
      uniqueSourceCount
      authoritativeSourceCount
      blogSourceCount
      corroborated
    }
    items {
      id
      eventId
      processedArticleId
      itemMetaId
      processedItemId
      similarity
      assignedBy
      createdAt
      processedArticle {
        id
        articleId
        title
        summary
        publishedAt
        language
        processedAt
        article {
          id
          url
          sourceLabel
          crawlAt
        }
      }
    }
    timeline {
      id
      eventId
      bucketStart
      title
      summary
      keyPoints
      referencedArticleIds
      createdAt
      updatedAt
    }
  }
}
    `;

/**
 * __useNewsEventQuery__
 *
 * To run a query within a React component, call `useNewsEventQuery` and pass it any options that fit your needs.
 * When your component renders, `useNewsEventQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useNewsEventQuery({
 *   variables: {
 *      id: // value for 'id'
 *      itemsLimit: // value for 'itemsLimit'
 *      timelineLimit: // value for 'timelineLimit'
 *   },
 * });
 */
export function useNewsEventQuery(baseOptions: Apollo.QueryHookOptions<NewsEventQuery, NewsEventQueryVariables> & ({ variables: NewsEventQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<NewsEventQuery, NewsEventQueryVariables>(NewsEventDocument, options);
      }
export function useNewsEventLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<NewsEventQuery, NewsEventQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<NewsEventQuery, NewsEventQueryVariables>(NewsEventDocument, options);
        }
export function useNewsEventSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<NewsEventQuery, NewsEventQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<NewsEventQuery, NewsEventQueryVariables>(NewsEventDocument, options);
        }
export type NewsEventQueryHookResult = ReturnType<typeof useNewsEventQuery>;
export type NewsEventLazyQueryHookResult = ReturnType<typeof useNewsEventLazyQuery>;
export type NewsEventSuspenseQueryHookResult = ReturnType<typeof useNewsEventSuspenseQuery>;
export type NewsEventQueryResult = Apollo.QueryResult<NewsEventQuery, NewsEventQueryVariables>;
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
export const ProcessedItemByIdDocument = gql`
    query ProcessedItemById($id: ID!) {
  processedItemById(id: $id) {
    id
    itemMetaId
    status
    tags
    resultJson
    createdAt
  }
}
    `;

/**
 * __useProcessedItemByIdQuery__
 *
 * To run a query within a React component, call `useProcessedItemByIdQuery` and pass it any options that fit your needs.
 * When your component renders, `useProcessedItemByIdQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useProcessedItemByIdQuery({
 *   variables: {
 *      id: // value for 'id'
 *   },
 * });
 */
export function useProcessedItemByIdQuery(baseOptions: Apollo.QueryHookOptions<ProcessedItemByIdQuery, ProcessedItemByIdQueryVariables> & ({ variables: ProcessedItemByIdQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<ProcessedItemByIdQuery, ProcessedItemByIdQueryVariables>(ProcessedItemByIdDocument, options);
      }
export function useProcessedItemByIdLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<ProcessedItemByIdQuery, ProcessedItemByIdQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<ProcessedItemByIdQuery, ProcessedItemByIdQueryVariables>(ProcessedItemByIdDocument, options);
        }
export function useProcessedItemByIdSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<ProcessedItemByIdQuery, ProcessedItemByIdQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<ProcessedItemByIdQuery, ProcessedItemByIdQueryVariables>(ProcessedItemByIdDocument, options);
        }
export type ProcessedItemByIdQueryHookResult = ReturnType<typeof useProcessedItemByIdQuery>;
export type ProcessedItemByIdLazyQueryHookResult = ReturnType<typeof useProcessedItemByIdLazyQuery>;
export type ProcessedItemByIdSuspenseQueryHookResult = ReturnType<typeof useProcessedItemByIdSuspenseQuery>;
export type ProcessedItemByIdQueryResult = Apollo.QueryResult<ProcessedItemByIdQuery, ProcessedItemByIdQueryVariables>;
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
export const AccessSettingsMetaDocument = gql`
    query AccessSettingsMeta {
  roles(includeSystem: true) {
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
}
    `;

/**
 * __useAccessSettingsMetaQuery__
 *
 * To run a query within a React component, call `useAccessSettingsMetaQuery` and pass it any options that fit your needs.
 * When your component renders, `useAccessSettingsMetaQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAccessSettingsMetaQuery({
 *   variables: {
 *   },
 * });
 */
export function useAccessSettingsMetaQuery(baseOptions?: Apollo.QueryHookOptions<AccessSettingsMetaQuery, AccessSettingsMetaQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<AccessSettingsMetaQuery, AccessSettingsMetaQueryVariables>(AccessSettingsMetaDocument, options);
      }
export function useAccessSettingsMetaLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<AccessSettingsMetaQuery, AccessSettingsMetaQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<AccessSettingsMetaQuery, AccessSettingsMetaQueryVariables>(AccessSettingsMetaDocument, options);
        }
export function useAccessSettingsMetaSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<AccessSettingsMetaQuery, AccessSettingsMetaQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<AccessSettingsMetaQuery, AccessSettingsMetaQueryVariables>(AccessSettingsMetaDocument, options);
        }
export type AccessSettingsMetaQueryHookResult = ReturnType<typeof useAccessSettingsMetaQuery>;
export type AccessSettingsMetaLazyQueryHookResult = ReturnType<typeof useAccessSettingsMetaLazyQuery>;
export type AccessSettingsMetaSuspenseQueryHookResult = ReturnType<typeof useAccessSettingsMetaSuspenseQuery>;
export type AccessSettingsMetaQueryResult = Apollo.QueryResult<AccessSettingsMetaQuery, AccessSettingsMetaQueryVariables>;
export const AccessSettingsUsersDocument = gql`
    query AccessSettingsUsers($first: Int!, $after: String, $search: String) {
  users(first: $first, after: $after, search: $search) {
    id
    email
    firstName
    lastName
    primaryRoleId
    isActive
    emailVerified
    lastLoginAt
    roleIds
    permissions
  }
}
    `;

/**
 * __useAccessSettingsUsersQuery__
 *
 * To run a query within a React component, call `useAccessSettingsUsersQuery` and pass it any options that fit your needs.
 * When your component renders, `useAccessSettingsUsersQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAccessSettingsUsersQuery({
 *   variables: {
 *      first: // value for 'first'
 *      after: // value for 'after'
 *      search: // value for 'search'
 *   },
 * });
 */
export function useAccessSettingsUsersQuery(baseOptions: Apollo.QueryHookOptions<AccessSettingsUsersQuery, AccessSettingsUsersQueryVariables> & ({ variables: AccessSettingsUsersQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<AccessSettingsUsersQuery, AccessSettingsUsersQueryVariables>(AccessSettingsUsersDocument, options);
      }
export function useAccessSettingsUsersLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<AccessSettingsUsersQuery, AccessSettingsUsersQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<AccessSettingsUsersQuery, AccessSettingsUsersQueryVariables>(AccessSettingsUsersDocument, options);
        }
export function useAccessSettingsUsersSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<AccessSettingsUsersQuery, AccessSettingsUsersQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<AccessSettingsUsersQuery, AccessSettingsUsersQueryVariables>(AccessSettingsUsersDocument, options);
        }
export type AccessSettingsUsersQueryHookResult = ReturnType<typeof useAccessSettingsUsersQuery>;
export type AccessSettingsUsersLazyQueryHookResult = ReturnType<typeof useAccessSettingsUsersLazyQuery>;
export type AccessSettingsUsersSuspenseQueryHookResult = ReturnType<typeof useAccessSettingsUsersSuspenseQuery>;
export type AccessSettingsUsersQueryResult = Apollo.QueryResult<AccessSettingsUsersQuery, AccessSettingsUsersQueryVariables>;
export const UserLoginRecordsDocument = gql`
    query UserLoginRecords($userId: String!, $limit: Int) {
  userLoginRecords(userId: $userId, limit: $limit) {
    id
    createdAt
    ipAddress
    userAgent
    method
  }
}
    `;

/**
 * __useUserLoginRecordsQuery__
 *
 * To run a query within a React component, call `useUserLoginRecordsQuery` and pass it any options that fit your needs.
 * When your component renders, `useUserLoginRecordsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useUserLoginRecordsQuery({
 *   variables: {
 *      userId: // value for 'userId'
 *      limit: // value for 'limit'
 *   },
 * });
 */
export function useUserLoginRecordsQuery(baseOptions: Apollo.QueryHookOptions<UserLoginRecordsQuery, UserLoginRecordsQueryVariables> & ({ variables: UserLoginRecordsQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<UserLoginRecordsQuery, UserLoginRecordsQueryVariables>(UserLoginRecordsDocument, options);
      }
export function useUserLoginRecordsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<UserLoginRecordsQuery, UserLoginRecordsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<UserLoginRecordsQuery, UserLoginRecordsQueryVariables>(UserLoginRecordsDocument, options);
        }
export function useUserLoginRecordsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<UserLoginRecordsQuery, UserLoginRecordsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<UserLoginRecordsQuery, UserLoginRecordsQueryVariables>(UserLoginRecordsDocument, options);
        }
export type UserLoginRecordsQueryHookResult = ReturnType<typeof useUserLoginRecordsQuery>;
export type UserLoginRecordsLazyQueryHookResult = ReturnType<typeof useUserLoginRecordsLazyQuery>;
export type UserLoginRecordsSuspenseQueryHookResult = ReturnType<typeof useUserLoginRecordsSuspenseQuery>;
export type UserLoginRecordsQueryResult = Apollo.QueryResult<UserLoginRecordsQuery, UserLoginRecordsQueryVariables>;
export const CreateRoleDocument = gql`
    mutation CreateRole($input: CreateRoleInput!) {
  createRole(input: $input) {
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
export type CreateRoleMutationFn = Apollo.MutationFunction<CreateRoleMutation, CreateRoleMutationVariables>;

/**
 * __useCreateRoleMutation__
 *
 * To run a mutation, you first call `useCreateRoleMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useCreateRoleMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [createRoleMutation, { data, loading, error }] = useCreateRoleMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useCreateRoleMutation(baseOptions?: Apollo.MutationHookOptions<CreateRoleMutation, CreateRoleMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<CreateRoleMutation, CreateRoleMutationVariables>(CreateRoleDocument, options);
      }
export type CreateRoleMutationHookResult = ReturnType<typeof useCreateRoleMutation>;
export type CreateRoleMutationResult = Apollo.MutationResult<CreateRoleMutation>;
export type CreateRoleMutationOptions = Apollo.BaseMutationOptions<CreateRoleMutation, CreateRoleMutationVariables>;
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
export const UpdateMembershipRolesDocument = gql`
    mutation UpdateMembershipRoles($input: UpdateMembershipRolesInput!) {
  updateMembershipRoles(input: $input) {
    id
    email
    firstName
    lastName
    primaryRoleId
    isActive
    emailVerified
    lastLoginAt
    roleIds
    permissions
  }
}
    `;
export type UpdateMembershipRolesMutationFn = Apollo.MutationFunction<UpdateMembershipRolesMutation, UpdateMembershipRolesMutationVariables>;

/**
 * __useUpdateMembershipRolesMutation__
 *
 * To run a mutation, you first call `useUpdateMembershipRolesMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateMembershipRolesMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateMembershipRolesMutation, { data, loading, error }] = useUpdateMembershipRolesMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateMembershipRolesMutation(baseOptions?: Apollo.MutationHookOptions<UpdateMembershipRolesMutation, UpdateMembershipRolesMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateMembershipRolesMutation, UpdateMembershipRolesMutationVariables>(UpdateMembershipRolesDocument, options);
      }
export type UpdateMembershipRolesMutationHookResult = ReturnType<typeof useUpdateMembershipRolesMutation>;
export type UpdateMembershipRolesMutationResult = Apollo.MutationResult<UpdateMembershipRolesMutation>;
export type UpdateMembershipRolesMutationOptions = Apollo.BaseMutationOptions<UpdateMembershipRolesMutation, UpdateMembershipRolesMutationVariables>;
export const SetUserActiveDocument = gql`
    mutation SetUserActive($input: SetUserActiveInput!) {
  setUserActive(input: $input) {
    id
    email
    firstName
    lastName
    primaryRoleId
    isActive
    emailVerified
    lastLoginAt
    roleIds
    permissions
  }
}
    `;
export type SetUserActiveMutationFn = Apollo.MutationFunction<SetUserActiveMutation, SetUserActiveMutationVariables>;

/**
 * __useSetUserActiveMutation__
 *
 * To run a mutation, you first call `useSetUserActiveMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useSetUserActiveMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [setUserActiveMutation, { data, loading, error }] = useSetUserActiveMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useSetUserActiveMutation(baseOptions?: Apollo.MutationHookOptions<SetUserActiveMutation, SetUserActiveMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<SetUserActiveMutation, SetUserActiveMutationVariables>(SetUserActiveDocument, options);
      }
export type SetUserActiveMutationHookResult = ReturnType<typeof useSetUserActiveMutation>;
export type SetUserActiveMutationResult = Apollo.MutationResult<SetUserActiveMutation>;
export type SetUserActiveMutationOptions = Apollo.BaseMutationOptions<SetUserActiveMutation, SetUserActiveMutationVariables>;
export const SearchSuggestionsDocument = gql`
    query SearchSuggestions($prefix: String!, $limit: Float) {
  searchSuggestions(prefix: $prefix, limit: $limit) {
    type
    value
    origin
  }
}
    `;

/**
 * __useSearchSuggestionsQuery__
 *
 * To run a query within a React component, call `useSearchSuggestionsQuery` and pass it any options that fit your needs.
 * When your component renders, `useSearchSuggestionsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useSearchSuggestionsQuery({
 *   variables: {
 *      prefix: // value for 'prefix'
 *      limit: // value for 'limit'
 *   },
 * });
 */
export function useSearchSuggestionsQuery(baseOptions: Apollo.QueryHookOptions<SearchSuggestionsQuery, SearchSuggestionsQueryVariables> & ({ variables: SearchSuggestionsQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<SearchSuggestionsQuery, SearchSuggestionsQueryVariables>(SearchSuggestionsDocument, options);
      }
export function useSearchSuggestionsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<SearchSuggestionsQuery, SearchSuggestionsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<SearchSuggestionsQuery, SearchSuggestionsQueryVariables>(SearchSuggestionsDocument, options);
        }
export function useSearchSuggestionsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<SearchSuggestionsQuery, SearchSuggestionsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<SearchSuggestionsQuery, SearchSuggestionsQueryVariables>(SearchSuggestionsDocument, options);
        }
export type SearchSuggestionsQueryHookResult = ReturnType<typeof useSearchSuggestionsQuery>;
export type SearchSuggestionsLazyQueryHookResult = ReturnType<typeof useSearchSuggestionsLazyQuery>;
export type SearchSuggestionsSuspenseQueryHookResult = ReturnType<typeof useSearchSuggestionsSuspenseQuery>;
export type SearchSuggestionsQueryResult = Apollo.QueryResult<SearchSuggestionsQuery, SearchSuggestionsQueryVariables>;
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
    requestTimeoutHotMs
    requestTimeoutNormalMs
    conditionalRequestEnabled
    conditionalRequestTimeoutMs
    conditionalRequestMaxRetries
    detailPublishSignalHeadFetchTimeoutMs
    detailPublishSignalHeadFetchConcurrency
    detailPublishSignalHeadFetchMaxReadBytes
    maxRetries
    retryBackoffMs
    queueOverloadCooldownMs
    adaptiveConcurrencyEnabled
    adaptiveWindowMinutes
    adaptiveCooldownMinutes
    adaptiveLatencyThresholdRatio
    adaptiveErrorRateThreshold
    adaptiveMemoryHeadroomThreshold
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
    requestTimeoutHotMs
    requestTimeoutNormalMs
    conditionalRequestEnabled
    conditionalRequestTimeoutMs
    conditionalRequestMaxRetries
    detailPublishSignalHeadFetchTimeoutMs
    detailPublishSignalHeadFetchConcurrency
    detailPublishSignalHeadFetchMaxReadBytes
    maxRetries
    retryBackoffMs
    queueOverloadCooldownMs
    adaptiveConcurrencyEnabled
    adaptiveWindowMinutes
    adaptiveCooldownMinutes
    adaptiveLatencyThresholdRatio
    adaptiveErrorRateThreshold
    adaptiveMemoryHeadroomThreshold
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
export const EntityImpactGraphSettingsDocument = gql`
    query EntityImpactGraphSettings {
  entityImpactGraphSettings {
    enabled
    minEntityConfidence
    minCorrelation
    minCoOccurrence
    maxNodes
    categories
    cacheTtlSeconds
  }
}
    `;

/**
 * __useEntityImpactGraphSettingsQuery__
 *
 * To run a query within a React component, call `useEntityImpactGraphSettingsQuery` and pass it any options that fit your needs.
 * When your component renders, `useEntityImpactGraphSettingsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useEntityImpactGraphSettingsQuery({
 *   variables: {
 *   },
 * });
 */
export function useEntityImpactGraphSettingsQuery(baseOptions?: Apollo.QueryHookOptions<EntityImpactGraphSettingsQuery, EntityImpactGraphSettingsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<EntityImpactGraphSettingsQuery, EntityImpactGraphSettingsQueryVariables>(EntityImpactGraphSettingsDocument, options);
      }
export function useEntityImpactGraphSettingsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<EntityImpactGraphSettingsQuery, EntityImpactGraphSettingsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<EntityImpactGraphSettingsQuery, EntityImpactGraphSettingsQueryVariables>(EntityImpactGraphSettingsDocument, options);
        }
export function useEntityImpactGraphSettingsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<EntityImpactGraphSettingsQuery, EntityImpactGraphSettingsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<EntityImpactGraphSettingsQuery, EntityImpactGraphSettingsQueryVariables>(EntityImpactGraphSettingsDocument, options);
        }
export type EntityImpactGraphSettingsQueryHookResult = ReturnType<typeof useEntityImpactGraphSettingsQuery>;
export type EntityImpactGraphSettingsLazyQueryHookResult = ReturnType<typeof useEntityImpactGraphSettingsLazyQuery>;
export type EntityImpactGraphSettingsSuspenseQueryHookResult = ReturnType<typeof useEntityImpactGraphSettingsSuspenseQuery>;
export type EntityImpactGraphSettingsQueryResult = Apollo.QueryResult<EntityImpactGraphSettingsQuery, EntityImpactGraphSettingsQueryVariables>;
export const UpdateEntityImpactGraphSettingsDocument = gql`
    mutation UpdateEntityImpactGraphSettings($input: UpdateEntityImpactGraphSettingsInput!) {
  updateEntityImpactGraphSettings(input: $input) {
    enabled
    minEntityConfidence
    minCorrelation
    minCoOccurrence
    maxNodes
    categories
    cacheTtlSeconds
  }
}
    `;
export type UpdateEntityImpactGraphSettingsMutationFn = Apollo.MutationFunction<UpdateEntityImpactGraphSettingsMutation, UpdateEntityImpactGraphSettingsMutationVariables>;

/**
 * __useUpdateEntityImpactGraphSettingsMutation__
 *
 * To run a mutation, you first call `useUpdateEntityImpactGraphSettingsMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateEntityImpactGraphSettingsMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateEntityImpactGraphSettingsMutation, { data, loading, error }] = useUpdateEntityImpactGraphSettingsMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateEntityImpactGraphSettingsMutation(baseOptions?: Apollo.MutationHookOptions<UpdateEntityImpactGraphSettingsMutation, UpdateEntityImpactGraphSettingsMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateEntityImpactGraphSettingsMutation, UpdateEntityImpactGraphSettingsMutationVariables>(UpdateEntityImpactGraphSettingsDocument, options);
      }
export type UpdateEntityImpactGraphSettingsMutationHookResult = ReturnType<typeof useUpdateEntityImpactGraphSettingsMutation>;
export type UpdateEntityImpactGraphSettingsMutationResult = Apollo.MutationResult<UpdateEntityImpactGraphSettingsMutation>;
export type UpdateEntityImpactGraphSettingsMutationOptions = Apollo.BaseMutationOptions<UpdateEntityImpactGraphSettingsMutation, UpdateEntityImpactGraphSettingsMutationVariables>;
export const KnowledgeGraphSettingsDocument = gql`
    query KnowledgeGraphSettings {
  knowledgeGraphSettings {
    enabled
    ingestionEnabled
    maxBatchSize
    maxRelationsPerArticle
    minEdgeConfidence
    dynamicEdgeConfidenceEnabled
    dynamicEdgeConfidenceQuantile
    multiModelValidationEnabled
    multiModelValidationModels
    multiModelValidationModelCount
    multiModelValidationMaxRelationsPerArticle
    entityDisambiguationEnabled
    entityDisambiguationMaxCandidates
    cacheTtlSeconds
  }
}
    `;

/**
 * __useKnowledgeGraphSettingsQuery__
 *
 * To run a query within a React component, call `useKnowledgeGraphSettingsQuery` and pass it any options that fit your needs.
 * When your component renders, `useKnowledgeGraphSettingsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useKnowledgeGraphSettingsQuery({
 *   variables: {
 *   },
 * });
 */
export function useKnowledgeGraphSettingsQuery(baseOptions?: Apollo.QueryHookOptions<KnowledgeGraphSettingsQuery, KnowledgeGraphSettingsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useQuery<KnowledgeGraphSettingsQuery, KnowledgeGraphSettingsQueryVariables>(KnowledgeGraphSettingsDocument, options);
      }
export function useKnowledgeGraphSettingsLazyQuery(baseOptions?: Apollo.LazyQueryHookOptions<KnowledgeGraphSettingsQuery, KnowledgeGraphSettingsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return Apollo.useLazyQuery<KnowledgeGraphSettingsQuery, KnowledgeGraphSettingsQueryVariables>(KnowledgeGraphSettingsDocument, options);
        }
export function useKnowledgeGraphSettingsSuspenseQuery(baseOptions?: Apollo.SkipToken | Apollo.SuspenseQueryHookOptions<KnowledgeGraphSettingsQuery, KnowledgeGraphSettingsQueryVariables>) {
          const options = baseOptions === Apollo.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return Apollo.useSuspenseQuery<KnowledgeGraphSettingsQuery, KnowledgeGraphSettingsQueryVariables>(KnowledgeGraphSettingsDocument, options);
        }
export type KnowledgeGraphSettingsQueryHookResult = ReturnType<typeof useKnowledgeGraphSettingsQuery>;
export type KnowledgeGraphSettingsLazyQueryHookResult = ReturnType<typeof useKnowledgeGraphSettingsLazyQuery>;
export type KnowledgeGraphSettingsSuspenseQueryHookResult = ReturnType<typeof useKnowledgeGraphSettingsSuspenseQuery>;
export type KnowledgeGraphSettingsQueryResult = Apollo.QueryResult<KnowledgeGraphSettingsQuery, KnowledgeGraphSettingsQueryVariables>;
export const UpdateKnowledgeGraphSettingsDocument = gql`
    mutation UpdateKnowledgeGraphSettings($input: UpdateKnowledgeGraphSettingsInput!) {
  updateKnowledgeGraphSettings(input: $input) {
    enabled
    ingestionEnabled
    maxBatchSize
    maxRelationsPerArticle
    minEdgeConfidence
    dynamicEdgeConfidenceEnabled
    dynamicEdgeConfidenceQuantile
    multiModelValidationEnabled
    multiModelValidationModels
    multiModelValidationModelCount
    multiModelValidationMaxRelationsPerArticle
    entityDisambiguationEnabled
    entityDisambiguationMaxCandidates
    cacheTtlSeconds
  }
}
    `;
export type UpdateKnowledgeGraphSettingsMutationFn = Apollo.MutationFunction<UpdateKnowledgeGraphSettingsMutation, UpdateKnowledgeGraphSettingsMutationVariables>;

/**
 * __useUpdateKnowledgeGraphSettingsMutation__
 *
 * To run a mutation, you first call `useUpdateKnowledgeGraphSettingsMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useUpdateKnowledgeGraphSettingsMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [updateKnowledgeGraphSettingsMutation, { data, loading, error }] = useUpdateKnowledgeGraphSettingsMutation({
 *   variables: {
 *      input: // value for 'input'
 *   },
 * });
 */
export function useUpdateKnowledgeGraphSettingsMutation(baseOptions?: Apollo.MutationHookOptions<UpdateKnowledgeGraphSettingsMutation, UpdateKnowledgeGraphSettingsMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return Apollo.useMutation<UpdateKnowledgeGraphSettingsMutation, UpdateKnowledgeGraphSettingsMutationVariables>(UpdateKnowledgeGraphSettingsDocument, options);
      }
export type UpdateKnowledgeGraphSettingsMutationHookResult = ReturnType<typeof useUpdateKnowledgeGraphSettingsMutation>;
export type UpdateKnowledgeGraphSettingsMutationResult = Apollo.MutationResult<UpdateKnowledgeGraphSettingsMutation>;
export type UpdateKnowledgeGraphSettingsMutationOptions = Apollo.BaseMutationOptions<UpdateKnowledgeGraphSettingsMutation, UpdateKnowledgeGraphSettingsMutationVariables>;