import type { Prisma, ItemMeta } from "@prisma/client";
import type { Types } from "mongoose";

import {
  type NormalizedNewsPayload,
} from "../news-pipeline/news-pipeline.schema";

import {
  type ItemReadModelProcessedSnapshotInput,
  type ItemReadModelRawSnapshotInput,
} from "./item-read-model.utils";

export const MAX_CURSOR_PAGE_SIZE = 50;
export const FULLTEXT_MIN_TOKEN_LENGTH = 3;
export const MONGO_MIN_TOKEN_LENGTH = 2;
export const MAX_SEARCH_MATCHES = 5000;
export const MAX_TOPIC_GROUPS = 50;
export const LATEST_PROCESSED_SNAPSHOT_BATCH_SIZE = 500;
export const MAX_TOPIC_ITEMS = 8;
export const DEFAULT_TOPIC_WINDOW_DAYS = 30;
export const MAX_EVENT_GROUPS = 50;
export const MAX_EVENT_ITEMS = 8;
export const DEFAULT_EVENT_WINDOW_DAYS = 30;
export const DEFAULT_EVENT_MIN_GROUP_SIZE = 2;
export const ITEM_READ_MODEL_HYDRATE_BATCH_SIZE = 500;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const ITEMS_FILTERS_SEARCH_PREFIX = "__items_filters__:";
export const MAX_FACET_OPTIONS = 50;
export const ITEMS_VECTOR_SEARCH_PREFIX = "__items_vector_search__:";
export const ITEMS_SEARCH_SUGGESTIONS_PREFIX = "__items_search_suggestions__:";
export const ITEMS_SOURCE_SUGGESTIONS_PREFIX = "__items_source_suggestions__:";
export const VECTOR_SEARCH_CACHE_TTL_SECONDS = 300;
export const VECTOR_SEARCH_MIN_SIMILARITY = 0.78;
export const VECTOR_SEARCH_MAX_RESULTS = 300;
export const VECTOR_SEARCH_MAX_CANDIDATES = 1200;
export const VECTOR_SEARCH_LOOKBACK_DAYS = 30;
export const SEARCH_SUGGESTIONS_CACHE_TTL_SECONDS = 60;
export const SOURCE_SUGGESTIONS_CACHE_TTL_SECONDS = 180;
export const SEARCH_SUGGESTIONS_MAX_SEMANTIC_IDS = 120;
export const SEARCH_SUGGESTIONS_MAX_SOURCE_SCAN = 1000;
export const SEARCH_SUGGESTIONS_MIN_SEMANTIC_CHARS = 6;
export const TOPIC_GROUPS_CACHE_TTL_SECONDS = 120;
export const EVENT_GROUPS_CACHE_TTL_SECONDS = 120;
export const PERSONALIZED_CANDIDATE_MIN = 180;
export const PERSONALIZED_CANDIDATE_MAX = 1600;
export const PERSONALIZED_CANDIDATE_MULTIPLIER = 8;
export const ITEM_READ_MODEL_META_ROW_PROJECTION: Record<string, 1> = {
  orgId: 1,
  itemMetaId: 1,
  "meta.id": 1,
  "meta.externalId": 1,
  "meta.name": 1,
  "meta.status": 1,
  "meta.mongoRef": 1,
  "meta.version": 1,
  "meta.publishedAt": 1,
  "meta.sortAt": 1,
  "meta.createdAt": 1,
  "meta.updatedAt": 1,
};
export const PROCESSED_READ_MODEL_SNAPSHOT_PROJECTION: Record<string, 1> = {
  _id: 1,
  rawItemId: 1,
  itemMetaId: 1,
  pipelineJobId: 1,
  sourceId: 1,
  status: 1,
  error: 1,
  tags: 1,
  result: 1,
  duplicateOf: 1,
  duplicateSimilarity: 1,
  summaryEmbeddingModel: 1,
  summaryEmbeddingDimensions: 1,
  llm: 1,
  createdAt: 1,
  updatedAt: 1,
};
export const DEFAULT_RECENCY_HALFLIFE_HOURS = 48;
export const DEFAULT_WEIGHT_RERANK = 0.55;
export const DEFAULT_WEIGHT_RECENCY = 0.25;
export const DEFAULT_WEIGHT_SOURCE_TRUST = 0.15;
export const DEFAULT_WEIGHT_QUALITY = 0.05;
export const DEFAULT_SOURCE_TRUST_SCORE = 0.6;
export const CRAWL_RESULT_INGEST_CONCURRENCY = 8;
export const SOURCE_TRUST_SCORE_MAP: Record<string, number> = {
  reuters: 0.96,
  bloomberg: 0.95,
  "financial times": 0.94,
  "wall street journal": 0.94,
  wsj: 0.94,
  "associated press": 0.93,
  "ap news": 0.93,
  cnbc: 0.9,
  marketwatch: 0.86,
  nikkei: 0.9,
  xinhua: 0.9
};

export type SearchStrategy =
  | { type: "none" }
  | { type: "fulltext"; query: string }
  | { type: "prefix"; term: string };

export interface ItemDateRangeFilter {
  start?: Date;
  end?: Date;
}

export interface ItemFilters {
  sourceIds?: string[];
  regions?: string[];
  topics?: string[];
  sentiments?: string[];
  contentTypes?: string[];
  excludeDuplicates?: boolean;
  dateRange?: ItemDateRangeFilter;
}

export interface ParsedSearchPayload {
  search?: string;
  filters?: ItemFilters;
}

export type ItemsOrderBy = "CREATED_DESC" | "PUBLISHED_DESC" | "PERSONALIZED";
export type ItemsRankingMode = "RECENCY" | "RELEVANCE";

export interface ItemsCursorPayload {
  id: string;
  createdAt?: string;
  sortAt?: string;
  offset?: number;
}

export interface ItemMetaRow {
  id: string;
  orgId: string;
  externalId: string;
  name: string;
  status: string;
  mongoRef: string;
  version: number;
  publishedAt: Date | null;
  sortAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ItemSearchHighlights = Record<string, string[]>;
export type ItemListRow = ItemMetaRow & {
  relevanceScore?: number;
  rankOffset?: number;
  searchHighlights?: ItemSearchHighlights | null;
};

export interface ItemPersonalizationProfile {
  positive: {
    sources: Record<string, number>;
    topics: Record<string, number>;
    entities: Record<string, number>;
    items: Record<string, number>;
    events: Record<string, number>;
    domains: Record<string, number>;
  };
  negative: {
    sources: Record<string, number>;
    topics: Record<string, number>;
    entities: Record<string, number>;
    items: Record<string, number>;
    events: Record<string, number>;
    domains: Record<string, number>;
  };
}

export interface PersonalizedCandidateRow {
  id: string;
  createdAt: Date;
  sortAt: Date;
}

export interface PersonalizedCandidateCursor {
  id: string;
  sortAt: Date;
}

export interface RankedItem {
  id: string;
  score: number;
  rankOffset: number;
}

export interface ItemCandidateFeatures {
  source: string | null;
  domain: string | null;
  topics: string[];
  entities: string[];
  eventIds: string[];
}

export interface ItemReadModelHydrationRecord {
  meta: ItemMetaRow;
  raw: ItemReadModelRawSnapshotInput | null;
  processed: ItemReadModelProcessedSnapshotInput | null;
}

export interface ItemReadModelSourceResolutionRecord {
  itemMetaId: string;
  pipelineJobIds: string[];
  crawlResultIds: string[];
}

export const CRAWL_RESULT_ITEM_INGEST_SELECT = {
  id: true,
  taskId: true,
  sourceUrl: true,
  fetchedAt: true,
  contentHash: true,
  metadata: true,
  task: {
    select: {
      id: true,
      displayName: true,
      targetUrl: true,
      keywords: true,
      config: true,
    },
  },
} satisfies Prisma.CrawlResultSelect;

export type CrawlResultItemIngestRow = Prisma.CrawlResultGetPayload<{
  select: typeof CRAWL_RESULT_ITEM_INGEST_SELECT;
}>;

export interface CreateFromCrawlResultsBatchInput {
  crawlResultIds?: string[];
  crawlResults?: CrawlResultItemIngestRow[];
}

export interface CreateFromCrawlResultsBatchResult {
  crawlResultId: string;
  itemMeta?: ItemMeta;
  reason?: unknown;
  status: "fulfilled" | "rejected";
}

export interface PreparedCrawlResultItemIngestInput {
  crawlResult: CrawlResultItemIngestRow;
  externalId: string;
  itemMetaName: string;
  payload: NormalizedNewsPayload;
  pipelineJobId?: string;
  pipelinePriority?: number;
  sourceId?: string;
}

export interface TopicGroupItem {
  processedId: string;
  itemMetaId: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  createdAt: Date;
}

export interface TopicGroup {
  topic: string;
  count: number;
  latestAt: Date;
  items: TopicGroupItem[];
}

export interface CachedTopicGroup {
  topic: string;
  count: number;
  latestAt: string;
  items: (Omit<TopicGroupItem, "createdAt"> & { createdAt: string })[];
}

export interface EventGroupItem {
  processedId: string;
  itemMetaId: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  createdAt: Date;
}

export interface EventGroup {
  eventId: string;
  count: number;
  latestAt: Date;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  topics: string[];
  entities: string[];
  items: EventGroupItem[];
}

export interface CachedEventGroup {
  eventId: string;
  count: number;
  latestAt: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  topics: string[];
  entities: string[];
  items: (Omit<EventGroupItem, "createdAt"> & { createdAt: string })[];
}

export interface LatestProcessedItemSnapshot {
  itemMetaId: string;
  tags?: unknown;
  result?: unknown;
  sourceId?: string | null;
  duplicateOf?: Types.ObjectId | string | null;
  sortAt?: Date | null;
}

export interface LatestProcessedSnapshotRecord {
  _id: Types.ObjectId;
  itemMetaId: string;
  tags?: unknown;
  result?: unknown;
  sourceId?: string | null;
  duplicateOf?: Types.ObjectId | string | null;
  sortAt?: Date | null;
  ingestedAt?: Date | null;
  createdAt?: Date | null;
}

export type SearchCandidateSource =
  | "meta"
  | "processed"
  | "processedArticle"
  | "vector"
  | "elasticsearch";

export interface RssSourceOption {
  id: string;
  name: string;
  language?: string | null;
  siteUrl: string;
  feedUrl: string;
  latestItemAt?: string | null;
  itemCountWindow: number;
}
