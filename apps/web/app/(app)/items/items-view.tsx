"use client";

import {
  CloseCircleOutlined,
  InfoCircleOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { gql, useMutation, useQuery } from "@apollo/client";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  Alert,
  Button,
  Col,
  Drawer,
  Grid,
  Input,
  List,
  Pagination,
  Row,
  Segmented,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import dynamic from "next/dynamic";
import {
  type ReadonlyURLSearchParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnalysisToolbar } from "@/components/analysis/analysis-toolbar";
import { AnnotationPanel } from "@/components/analysis/annotation-panel";
import { ArticlePublishedTime } from "@/components/article-published-time";
import { ChartEmptyState } from "@/components/chart-empty-state";
import {
  EnhancedSearchBox,
  type SearchSuggestionStatus,
} from "@/components/enhanced-search-box";
import { RequestErrorBanner } from "@/components/request-error-banner";
import type { ItemsQuery } from "@/graphql/generated";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { resolveDisplaySummary, resolveDisplayTitle } from "@/lib/item-display";
import { formatRatioAsPercent } from "@/lib/metrics-format";
import { buildRequestErrorEmptyState } from "@/lib/request-error-empty-state";
import {
  applyRssTranslationsToListItems,
  resolveItemsViewFiltersWithFixedSources,
} from "@/lib/rss-reader-ui";
import {
  type RssItemTranslation,
  type RssTranslationField,
  type RssTranslationProvider,
  TRANSLATE_RSS_ITEMS_MUTATION,
  type TranslateRssItemsMutation,
  type TranslateRssItemsMutationVariables,
} from "@/lib/rss-translation";
import { safeHttpUrl } from "@/lib/url";
import { useDebounceValue } from "@/lib/use-debounce-value";

import { FacetedSearch, type FilterState } from "./components/faceted-search";
import { NewsCard } from "./components/news-card";
import { type ItemViewType, ViewSwitcher } from "./components/view-switcher";
import { resolveAvailableSentiments } from "./item-facets";
import {
  estimateItemsFeedRowSize,
  shouldUpdateItemsFeedMetric,
  shouldVirtualizeItemsFeed,
} from "./items-feed-virtualization";
import {
  countItemsFilterDimensions,
  resolveItemsViewLayoutState,
  type ItemsDensity,
  type ItemsExperiencePreset,
  type ItemsFilterBehavior,
} from "./items-view-layout";
import {
  DEFAULT_ITEMS_PAGE_SIZE,
  ITEMS_PAGE_SIZE_OPTIONS_STRINGS,
  clampItemsPageSize,
  getItemsLastPage,
  normalizeItemsPaginationChange,
} from "./pagination";

const FinancialCard = dynamic(
  () => import("./components/financial-card").then((mod) => mod.FinancialCard),
  { loading: () => <Skeleton active paragraph={{ rows: 3 }} /> },
);

const EMPTY_FILTERS_STATE: FilterState = {};

const ITEMS_SEARCH_DEBOUNCE_MS = 250;
const ITEMS_FILTERS_URL_DEBOUNCE_MS = 200;
const ITEMS_TABLE_MIN_SCROLL_X = 840;
const ITEMS_TABLE_MIN_BODY_SCROLL_Y = 240;

function ItemsTableLoadingSkeleton({ rows }: { rows: number }) {
  const safeRows = Math.max(1, rows);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-white/70">
      <div className="flex h-[56px] items-center gap-4 border-b border-[var(--border)] px-4">
        <Skeleton.Input active size="small" style={{ width: 180 }} />
        <Skeleton.Input active size="small" style={{ width: 260 }} />
        <Skeleton.Input active size="small" style={{ width: 120 }} />
      </div>
      <div className="divide-y divide-[var(--border)]">
        {Array.from({ length: safeRows }).map((_, idx) => (
          <div key={idx} className="flex h-[56px] items-center gap-4 px-4">
            <Skeleton.Input active size="small" style={{ width: 140 }} />
            <Skeleton.Input active size="small" style={{ width: 420 }} />
            <Skeleton.Input active size="small" style={{ width: 160 }} />
            <div className="ml-auto">
              <Skeleton.Button active size="small" style={{ width: 72 }} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex h-[56px] items-center justify-end gap-2 border-t border-[var(--border)] px-4">
        <Skeleton.Button active size="small" style={{ width: 64 }} />
        <Skeleton.Button active size="small" style={{ width: 64 }} />
        <Skeleton.Button active size="small" style={{ width: 64 }} />
      </div>
    </div>
  );
}

function ItemsCardLoadingSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div className="glass-card overflow-hidden">
      <div className="flex flex-col gap-3 p-[20px]">
        <div className="flex flex-wrap gap-2">
          <Skeleton.Button
            active
            size="small"
            style={{ width: 72, height: 22 }}
          />
          <Skeleton.Button
            active
            size="small"
            style={{ width: 72, height: 22 }}
          />
          <Skeleton.Button
            active
            size="small"
            style={{ width: 72, height: 22 }}
          />
        </div>
        <Skeleton
          active
          title={{ width: "70%" }}
          paragraph={{ rows: compact ? 3 : 5 }}
        />
        {!compact ? (
          <div className="flex items-center justify-between gap-3">
            <Skeleton.Input active size="small" style={{ width: 200 }} />
            <Skeleton.Button active size="small" style={{ width: 92 }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ItemsFeedLoadingSkeleton({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: Math.max(1, count) }).map((_, idx) => (
        <ItemsCardLoadingSkeleton key={idx} />
      ))}
    </div>
  );
}

function ItemsGridLoadingSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: Math.max(1, count) }).map((_, idx) => (
        <ItemsCardLoadingSkeleton key={idx} compact />
      ))}
    </div>
  );
}

function parsePositiveInt(value: string | null, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function collectRequestErrorMessages(error: unknown): string[] {
  if (!error || typeof error !== "object") {
    return [];
  }

  const messages = new Set<string>();
  const pushMessage = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      messages.add(trimmed);
    }
  };

  const record = error as Record<string, unknown>;
  pushMessage(record.message);

  const graphQLErrors = record.graphQLErrors;
  if (Array.isArray(graphQLErrors)) {
    graphQLErrors.forEach((entry) => {
      if (entry && typeof entry === "object") {
        pushMessage((entry as Record<string, unknown>).message);
      }
    });
  }

  const networkError = record.networkError;
  if (networkError && typeof networkError === "object") {
    const networkRecord = networkError as Record<string, unknown>;
    pushMessage(networkRecord.message);

    const result = networkRecord.result;
    if (result && typeof result === "object") {
      const resultErrors = (result as Record<string, unknown>).errors;
      if (Array.isArray(resultErrors)) {
        resultErrors.forEach((entry) => {
          if (entry && typeof entry === "object") {
            pushMessage((entry as Record<string, unknown>).message);
          }
        });
      }
    }
  }

  return Array.from(messages);
}

function collectRequestErrorCodes(error: unknown): string[] {
  if (!error || typeof error !== "object") {
    return [];
  }

  const codes = new Set<string>();
  const pushCode = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim().toUpperCase();
    if (normalized.length > 0) {
      codes.add(normalized);
    }
  };

  const pushExtensionsCodes = (extensions: unknown) => {
    if (!extensions || typeof extensions !== "object") {
      return;
    }
    const ext = extensions as Record<string, unknown>;
    pushCode(ext.appCode);
    pushCode(ext.code);
    const originalError = ext.originalError;
    if (originalError && typeof originalError === "object") {
      pushCode((originalError as Record<string, unknown>).code);
    }
  };

  const record = error as Record<string, unknown>;
  const graphQLErrors = record.graphQLErrors;
  if (Array.isArray(graphQLErrors)) {
    graphQLErrors.forEach((entry) => {
      if (!entry || typeof entry !== "object") {
        return;
      }
      const gqlError = entry as Record<string, unknown>;
      pushExtensionsCodes(gqlError.extensions);
    });
  }

  const networkError = record.networkError;
  if (networkError && typeof networkError === "object") {
    const networkRecord = networkError as Record<string, unknown>;
    const result = networkRecord.result;
    if (result && typeof result === "object") {
      const resultErrors = (result as Record<string, unknown>).errors;
      if (Array.isArray(resultErrors)) {
        resultErrors.forEach((entry) => {
          if (!entry || typeof entry !== "object") {
            return;
          }
          const gqlError = entry as Record<string, unknown>;
          pushExtensionsCodes(gqlError.extensions);
        });
      }
    }
  }

  return Array.from(codes);
}

function extractRerankUnavailableMessage(error: unknown): string | null {
  const errorCodes = collectRequestErrorCodes(error);
  if (errorCodes.includes("RERANK_UNAVAILABLE")) {
    return collectRequestErrorMessages(error)[0] ?? "Reranker unavailable";
  }

  const messages = collectRequestErrorMessages(error);
  const matched = messages.find((message) => {
    const lower = message.toLowerCase();
    const mentionsRerank =
      lower.includes("rerank") ||
      lower.includes("reranker") ||
      lower.includes("re-rank");
    if (!mentionsRerank) {
      return false;
    }
    return (
      lower.includes("unavailable") ||
      lower.includes("failed") ||
      lower.includes("service unavailable")
    );
  });
  return matched ?? null;
}

function resolveRankingModeFromParam(
  value: string | null,
  emptyStateVariant: EmptyStateVariant,
): ItemsRankingMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "relevance") {
    return "RELEVANCE";
  }
  if (normalized === "recency") {
    return "RECENCY";
  }
  return emptyStateVariant === "search" ? "RELEVANCE" : "RECENCY";
}

function resolveSortModeFromParam(value: string | null): ItemsSortMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "published" || normalized === "publisheddesc") {
    return "publishedDesc";
  }
  if (normalized === "personalized") {
    return "personalized";
  }
  return "default";
}

function normalizeRssTranslationFields(
  fields?: RssTranslationField[],
): RssTranslationField[] {
  if (!fields || fields.length === 0) {
    return ["title", "summary"] satisfies RssTranslationField[];
  }
  const normalized = fields
    .map((field) => (typeof field === "string" ? field.trim() : ""))
    .filter((field): field is RssTranslationField => Boolean(field));
  return Array.from(new Set(normalized));
}

function normalizeFilterList(
  values?: string[],
  options?: { lowerCase?: boolean },
): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => (options?.lowerCase ? value.toLowerCase() : value));
  if (normalized.length === 0) {
    return undefined;
  }
  return Array.from(new Set(normalized));
}

const CANONICAL_CONTENT_TYPES = [
  "news_fact",
  "opinion",
  "analysis",
  "mixed",
] as const;
type CanonicalContentType = (typeof CANONICAL_CONTENT_TYPES)[number];

const CONTENT_TYPE_ORDER = new Map<CanonicalContentType, number>(
  CANONICAL_CONTENT_TYPES.map((value, index) => [value, index]),
);

const CONTENT_TYPE_ALIASES = new Map<string, CanonicalContentType>([
  ["news_fact", "news_fact"],
  ["news-fact", "news_fact"],
  ["newsfact", "news_fact"],
  ["fact", "news_fact"],
  ["factual", "news_fact"],
  ["report", "news_fact"],
  ["reporting", "news_fact"],
  ["opinion", "opinion"],
  ["op-ed", "opinion"],
  ["oped", "opinion"],
  ["commentary", "opinion"],
  ["editorial", "opinion"],
  ["analysis", "analysis"],
  ["analytical", "analysis"],
  ["explainer", "analysis"],
  ["insight", "analysis"],
  ["deep-dive", "analysis"],
  ["deep_dive", "analysis"],
  ["mixed", "mixed"],
  ["mixed-content", "mixed"],
  ["mixed_content", "mixed"],
  ["hybrid", "mixed"],
]);

function normalizeContentType(value: string): CanonicalContentType | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return CONTENT_TYPE_ALIASES.get(normalized);
}

function normalizeContentTypeList(
  values?: string[],
): CanonicalContentType[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((value) => normalizeContentType(value))
    .filter((value): value is CanonicalContentType => Boolean(value));
  if (normalized.length === 0) {
    return undefined;
  }
  const unique = Array.from(new Set(normalized));
  unique.sort((a, b) => {
    const left = CONTENT_TYPE_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER;
    const right = CONTENT_TYPE_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
  return unique;
}

const ITEMS_FILTER_QUERY_KEYS = {
  region: "region",
  topic: "topic",
  sentiment: "sentiment",
  contentType: "contentType",
  dedup: "dedup",
  from: "from",
  to: "to",
} as const;
const ITEMS_ORDER_QUERY_KEY = "order";

function normalizeFiltersState(filters: FilterState): FilterState {
  const regions = normalizeFilterList(filters.regions)?.sort((a, b) =>
    a.localeCompare(b),
  );
  const topics = normalizeFilterList(filters.topics)?.sort((a, b) =>
    a.localeCompare(b),
  );
  const sentiments = normalizeFilterList(filters.sentiments, {
    lowerCase: true,
  })?.sort((a, b) => a.localeCompare(b));
  const contentTypes = normalizeContentTypeList(filters.contentTypes);
  const excludeDuplicates = filters.excludeDuplicates === true;

  const start = filters.dateRange?.[0] ?? null;
  const end = filters.dateRange?.[1] ?? null;
  const dateRange: FilterState["dateRange"] | undefined =
    start &&
    end &&
    start.isValid() &&
    end.isValid() &&
    (start.isBefore(end) || start.isSame(end))
      ? [start, end]
      : undefined;

  return {
    ...(regions ? { regions } : {}),
    ...(topics ? { topics } : {}),
    ...(sentiments ? { sentiments } : {}),
    ...(contentTypes ? { contentTypes } : {}),
    ...(excludeDuplicates ? { excludeDuplicates: true } : {}),
    ...(dateRange ? { dateRange } : {}),
  };
}

function fingerprintFilters(filters: FilterState): string {
  const normalized = normalizeFiltersState(filters);
  const dateRange = normalized.dateRange;
  return JSON.stringify({
    regions: normalized.regions ?? [],
    topics: normalized.topics ?? [],
    sentiments: normalized.sentiments ?? [],
    contentTypes: normalized.contentTypes ?? [],
    excludeDuplicates: normalized.excludeDuplicates === true,
    from: dateRange?.[0]?.toISOString?.() ?? null,
    to: dateRange?.[1]?.toISOString?.() ?? null,
  });
}

function parseDateRangeParam(params: ReadonlyURLSearchParams): {
  dateRange?: FilterState["dateRange"];
} {
  const rawFrom = params.get(ITEMS_FILTER_QUERY_KEYS.from);
  const rawTo = params.get(ITEMS_FILTER_QUERY_KEYS.to);
  if (!rawFrom || !rawTo) {
    return {};
  }
  const parsedFrom = dayjs(rawFrom);
  const parsedTo = dayjs(rawTo);
  if (!parsedFrom.isValid() || !parsedTo.isValid()) {
    return {};
  }
  if (parsedFrom.isAfter(parsedTo)) {
    return {};
  }
  return { dateRange: [parsedFrom, parsedTo] };
}

function parseFiltersFromSearchParams(
  params: ReadonlyURLSearchParams,
  baseFilters: FilterState,
): FilterState {
  const base = normalizeFiltersState(baseFilters);

  const regions = params.has(ITEMS_FILTER_QUERY_KEYS.region)
    ? normalizeFilterList(params.getAll(ITEMS_FILTER_QUERY_KEYS.region))?.sort(
        (a, b) => a.localeCompare(b),
      )
    : undefined;
  const topics = params.has(ITEMS_FILTER_QUERY_KEYS.topic)
    ? normalizeFilterList(params.getAll(ITEMS_FILTER_QUERY_KEYS.topic))?.sort(
        (a, b) => a.localeCompare(b),
      )
    : undefined;
  const sentiments = params.has(ITEMS_FILTER_QUERY_KEYS.sentiment)
    ? normalizeFilterList(params.getAll(ITEMS_FILTER_QUERY_KEYS.sentiment), {
        lowerCase: true,
      })?.sort((a, b) => a.localeCompare(b))
    : undefined;
  const contentTypes = params.has(ITEMS_FILTER_QUERY_KEYS.contentType)
    ? normalizeContentTypeList(
        params.getAll(ITEMS_FILTER_QUERY_KEYS.contentType),
      )
    : undefined;
  const dedupeParam = (params.get(ITEMS_FILTER_QUERY_KEYS.dedup) ?? "")
    .trim()
    .toLowerCase();
  const excludeDuplicates =
    dedupeParam === "1" || dedupeParam === "true" || dedupeParam === "hide";

  const dateOverride = parseDateRangeParam(params).dateRange;

  return {
    ...(base.regions ? { regions: base.regions } : {}),
    ...(base.topics ? { topics: base.topics } : {}),
    ...(base.sentiments ? { sentiments: base.sentiments } : {}),
    ...(base.contentTypes ? { contentTypes: base.contentTypes } : {}),
    ...(base.dateRange ? { dateRange: base.dateRange } : {}),
    ...(regions !== undefined ? { regions } : {}),
    ...(topics !== undefined ? { topics } : {}),
    ...(sentiments !== undefined ? { sentiments } : {}),
    ...(contentTypes !== undefined ? { contentTypes } : {}),
    ...(excludeDuplicates ? { excludeDuplicates: true } : {}),
    ...(dateOverride ? { dateRange: dateOverride } : {}),
  };
}

function applyFiltersToSearchParams(
  next: URLSearchParams,
  filters: FilterState | null,
) {
  next.delete(ITEMS_FILTER_QUERY_KEYS.region);
  next.delete(ITEMS_FILTER_QUERY_KEYS.topic);
  next.delete(ITEMS_FILTER_QUERY_KEYS.sentiment);
  next.delete(ITEMS_FILTER_QUERY_KEYS.contentType);
  next.delete(ITEMS_FILTER_QUERY_KEYS.dedup);
  next.delete(ITEMS_FILTER_QUERY_KEYS.from);
  next.delete(ITEMS_FILTER_QUERY_KEYS.to);

  if (!filters) {
    return;
  }

  const normalized = normalizeFiltersState(filters);
  for (const value of normalized.regions ?? []) {
    next.append(ITEMS_FILTER_QUERY_KEYS.region, value);
  }
  for (const value of normalized.topics ?? []) {
    next.append(ITEMS_FILTER_QUERY_KEYS.topic, value);
  }
  for (const value of normalized.sentiments ?? []) {
    next.append(ITEMS_FILTER_QUERY_KEYS.sentiment, value);
  }
  for (const value of normalized.contentTypes ?? []) {
    next.append(ITEMS_FILTER_QUERY_KEYS.contentType, value);
  }
  if (normalized.excludeDuplicates) {
    next.set(ITEMS_FILTER_QUERY_KEYS.dedup, "hide");
  }

  const dateRange = normalized.dateRange;
  if (dateRange && dateRange[0] && dateRange[1]) {
    next.set(ITEMS_FILTER_QUERY_KEYS.from, dateRange[0].toISOString());
    next.set(ITEMS_FILTER_QUERY_KEYS.to, dateRange[1].toISOString());
  }
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function withMetricTooltip(label: string, tooltip: string) {
  return (
    <Space size={6}>
      <span>{label}</span>
      <Tooltip title={tooltip}>
        <InfoCircleOutlined className="text-slate-400" />
      </Tooltip>
    </Space>
  );
}

interface ItemsDateRangeInput {
  start?: string;
  end?: string;
}

interface ItemsFiltersInput {
  sourceIds?: string[];
  regions?: string[];
  topics?: string[];
  sentiments?: string[];
  contentTypes?: string[];
  excludeDuplicates?: boolean;
  dateRange?: ItemsDateRangeInput;
}

type ItemsOrderBy = "CREATED_DESC" | "PUBLISHED_DESC" | "PERSONALIZED";
type ItemsSortMode = "default" | "publishedDesc" | "personalized";
type ItemsRankingMode = "RECENCY" | "RELEVANCE";

interface ItemsQueryVariables {
  first: number;
  after?: string | null;
  page?: number | null;
  search?: string | null;
  filters?: ItemsFiltersInput | null;
  orderBy?: ItemsOrderBy | null;
  rankingMode?: ItemsRankingMode | null;
}

interface ItemFacetOption {
  value: string;
  count: number;
}

interface ItemFacetsQuery {
  itemFacets: {
    regions: ItemFacetOption[];
    topics: ItemFacetOption[];
    sentiments: ItemFacetOption[];
    contentTypes: ItemFacetOption[];
  };
}

interface ItemFacetsQueryVariables {
  search?: string | null;
  filters?: ItemsFiltersInput | null;
}

const ITEMS_QUERY = gql`
  query Items(
    $first: Int!
    $after: String
    $page: Int
    $search: String
    $filters: ItemsFiltersInput
    $orderBy: ItemsOrderBy
    $rankingMode: ItemsRankingMode
  ) {
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
          searchHighlights {
            field
            snippets
          }
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

const ITEM_FACETS_QUERY = gql`
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

function buildFiltersInput(filters: FilterState): ItemsFiltersInput | null {
  const sourceIds = normalizeFilterList(filters.sourceIds);
  const regions = normalizeFilterList(filters.regions);
  const topics = normalizeFilterList(filters.topics);
  const sentiments = normalizeFilterList(filters.sentiments, {
    lowerCase: true,
  });
  const contentTypes = normalizeContentTypeList(filters.contentTypes);
  const excludeDuplicates = filters.excludeDuplicates === true;
  const rangeStart = filters.dateRange?.[0]?.startOf("day");
  const rangeEnd = filters.dateRange?.[1]?.endOf("day");
  const dateRange =
    rangeStart || rangeEnd
      ? {
          ...(rangeStart ? { start: rangeStart.toISOString() } : {}),
          ...(rangeEnd ? { end: rangeEnd.toISOString() } : {}),
        }
      : undefined;

  if (
    !sourceIds &&
    !regions &&
    !topics &&
    !sentiments &&
    !contentTypes &&
    !excludeDuplicates &&
    !dateRange
  ) {
    return null;
  }

  return {
    ...(sourceIds ? { sourceIds } : {}),
    ...(regions ? { regions } : {}),
    ...(topics ? { topics } : {}),
    ...(sentiments ? { sentiments } : {}),
    ...(contentTypes ? { contentTypes } : {}),
    ...(excludeDuplicates ? { excludeDuplicates: true } : {}),
    ...(dateRange ? { dateRange } : {}),
  };
}

type ItemEdge = ItemsQuery["items"]["edges"][number];

const EMPTY_EDGES: ItemEdge[] = [];

type EmptyStateVariant = "default" | "today" | "search";
interface ItemsRssTranslationConfig {
  enabled: boolean;
  provider: RssTranslationProvider;
  targetLanguage: string;
  fields?: RssTranslationField[];
  showOriginal?: boolean;
}

interface ItemsViewProps {
  initialView?: ItemViewType;
  lockedView?: ItemViewType;
  emptyStateVariant?: EmptyStateVariant;
  sortMode?: ItemsSortMode;
  experiencePreset?: ItemsExperiencePreset;
  density?: ItemsDensity;
  filterBehavior?: ItemsFilterBehavior;
  initialData?: ItemsQuery | null;
  initialFilters?: FilterState;
  fixedSourceIds?: string[];
  rssTranslationConfig?: ItemsRssTranslationConfig;
  onTranslationError?: (message: string | null) => void;
  onSearchSuggestionStatusChange?: (status: SearchSuggestionStatus) => void;
  hideSearchControl?: boolean;
  hideQuickNav?: boolean;
}

interface ParsedItem {
  id: string;
  title: string;
  name: string;
  status: string;
  createdAt: string;
  publishedAt?: string;
  ingestedAt?: string;
  sentiment?: string;
  summary?: string;
  thumbnail?: string;
  source?: string;
  contentType?: CanonicalContentType;
  relevanceScore?: number;
  searchHighlights?: { field: string; snippets: string[] }[];
  price?: number;
  change?: number;
  ticker?: string;
  region?: string;
  location?: string;
  language?: string;
  topics?: string[];
  entities?: string[];
  qualityScore?: number;
  duplicateSimilarity?: number;
  duplicateOf?: string | null;
  llm?: {
    model?: string | null;
    promptVersion?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
    latencyMs?: number | null;
  };
  url?: string;
  history?: { timestamp: string; value: number }[];
  eventId?: string | null;
  rssHasTranslation?: boolean;
  rssTranslationState?: "translated" | "original";
}

export function ItemsView({
  initialView = "feed",
  lockedView,
  emptyStateVariant = "default",
  sortMode = "default",
  experiencePreset,
  density,
  filterBehavior,
  initialData = null,
  initialFilters = EMPTY_FILTERS_STATE,
  fixedSourceIds,
  rssTranslationConfig,
  onTranslationError,
  onSearchSuggestionStatusChange,
  hideSearchControl = false,
  hideQuickNav = false,
}: ItemsViewProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const timeZone = process.env.NEXT_PUBLIC_TIME_ZONE ?? "Asia/Shanghai";
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const screens = Grid.useBreakpoint();
  const layoutState = resolveItemsViewLayoutState({
    experiencePreset,
    density,
    filterBehavior,
  });
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageCrawl =
    permissions.includes("crawl.read") || permissions.includes("crawl.write");

  // URL State
  const urlSearch = (searchParams.get("q") ?? "").trim();
  const urlFilters = useMemo(
    () => parseFiltersFromSearchParams(searchParams, initialFilters),
    [initialFilters, searchParams],
  );
  const urlFiltersFingerprint = useMemo(
    () => fingerprintFilters(urlFilters),
    [urlFilters],
  );
  const urlPage = parsePositiveInt(searchParams.get("page"), 1);
  const urlRawPageSize = parsePositiveInt(
    searchParams.get("pageSize"),
    DEFAULT_ITEMS_PAGE_SIZE,
  );
  const urlPageSize = clampItemsPageSize(urlRawPageSize);
  const urlRanking = searchParams.get("ranking");
  const urlOrder = searchParams.get(ITEMS_ORDER_QUERY_KEY);
  const savedViewId = useMemo(() => {
    const value = searchParams.get("savedView")?.trim();
    return value ? value : null;
  }, [searchParams]);

  // Local State (UI + query source of truth)
  const [searchInput, setSearchInput] = useState(urlSearch);
  const [search, setSearch] = useState(urlSearch);
  const [rankingMode, setRankingMode] = useState<ItemsRankingMode>(() =>
    resolveRankingModeFromParam(urlRanking, emptyStateVariant),
  );
  const [activeSortMode, setActiveSortMode] = useState<ItemsSortMode>(() =>
    sortMode === "default" ? resolveSortModeFromParam(urlOrder) : sortMode,
  );
  const [view, setView] = useState<ItemViewType>(lockedView ?? initialView);
  const [filters, setFilters] = useState<FilterState>(() =>
    parseFiltersFromSearchParams(searchParams, initialFilters),
  );
  const [page, setPage] = useState(urlPage);
  const [pageSize, setPageSize] = useState(urlPageSize);
  const [showFilters, setShowFilters] = useState(false);
  const [showDelayHint, setShowDelayHint] = useState(false);
  const [translatedByItemId, setTranslatedByItemId] = useState<
    Record<string, Omit<RssItemTranslation, "itemId">>
  >({});
  const translationRequestKeyRef = useRef("");
  const translationRequestSeqRef = useRef(0);
  const listTableContainerRef = useRef<HTMLDivElement | null>(null);
  const feedListRef = useRef<HTMLDivElement | null>(null);
  const [listTableScrollX, setListTableScrollX] = useState<number | null>(null);
  const [listTableScrollY, setListTableScrollY] = useState<number | null>(null);
  const [feedScrollMargin, setFeedScrollMargin] = useState(0);
  const urlFiltersRef = useRef(urlFilters);
  const [translateRssItems] = useMutation<
    TranslateRssItemsMutation,
    TranslateRssItemsMutationVariables
  >(TRANSLATE_RSS_ITEMS_MUTATION);
  const { queryFilters, displayFilters, normalizedFixedSourceIds } = useMemo(
    () =>
      resolveItemsViewFiltersWithFixedSources({
        filters,
        fixedSourceIds,
      }),
    [filters, fixedSourceIds],
  );

  const updateListTableScroll = useCallback(() => {
    const container = listTableContainerRef.current;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 0;
    const headerEl = container.querySelector(
      ".ant-table-thead",
    ) as HTMLElement | null;
    const paginationEl = container.querySelector(
      ".ant-table-pagination",
    ) as HTMLElement | null;

    const headerHeight = headerEl?.getBoundingClientRect().height ?? 0;
    const paginationHeight = paginationEl?.getBoundingClientRect().height ?? 0;

    // `items-view` lives inside the ShellLayout scrolling container. Reserve some padding so the
    // virtualized table doesn't butt up against the bottom of the viewport.
    const bottomPadding = 24;
    const available = viewportHeight - rect.top - bottomPadding;

    const nextScrollY = Math.max(
      ITEMS_TABLE_MIN_BODY_SCROLL_Y,
      Math.floor(available - headerHeight - paginationHeight),
    );
    const nextScrollX = Math.max(
      ITEMS_TABLE_MIN_SCROLL_X,
      Math.floor(container.clientWidth),
    );

    setListTableScrollX((prev) => (prev === nextScrollX ? prev : nextScrollX));
    setListTableScrollY((prev) => (prev === nextScrollY ? prev : nextScrollY));
  }, []);

  const updateFeedMetrics = useCallback(() => {
    const container = feedListRef.current;
    if (!container || typeof window === "undefined") {
      return;
    }
    const nextScrollMargin = container.getBoundingClientRect().top + window.scrollY;
    setFeedScrollMargin((previous) =>
      shouldUpdateItemsFeedMetric(previous, nextScrollMargin)
        ? nextScrollMargin
        : previous,
    );
  }, []);

  useEffect(() => {
    if (!lockedView) {
      return;
    }
    setView(lockedView);
  }, [lockedView]);

  useEffect(() => {
    if (lockedView) {
      return;
    }
    if (!screens.lg && view !== "feed") {
      setView("feed");
    }
  }, [lockedView, screens.lg, view]);

  useEffect(() => {
    setPage(1);
  }, [normalizedFixedSourceIds]);

  useEffect(() => {
    translationRequestSeqRef.current += 1;
    setTranslatedByItemId({});
    translationRequestKeyRef.current = "";
  }, [
    rssTranslationConfig?.enabled,
    rssTranslationConfig?.provider,
    rssTranslationConfig?.targetLanguage,
  ]);

  useEffect(() => {
    if (view !== "list") {
      setListTableScrollX(null);
      setListTableScrollY(null);
      return;
    }

    let rafId: number | null = null;

    const handleResize = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => updateListTableScroll());
    };

    handleResize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [updateListTableScroll, view]);

  useEffect(() => {
    urlFiltersRef.current = urlFilters;
  }, [urlFilters]);

  useEffect(() => {
    setSearchInput(urlSearch);
    setSearch(urlSearch);
  }, [urlSearch]);

  useEffect(() => {
    setFilters((currentFilters) => {
      return fingerprintFilters(currentFilters) === urlFiltersFingerprint
        ? currentFilters
        : urlFiltersRef.current;
    });
  }, [urlFiltersFingerprint]);

  useEffect(() => {
    setPage(urlPage);
  }, [urlPage]);

  useEffect(() => {
    setPageSize(urlPageSize);
  }, [urlPageSize]);

  useEffect(() => {
    const nextRankingMode = resolveRankingModeFromParam(
      urlRanking,
      emptyStateVariant,
    );
    setRankingMode((current) =>
      current === nextRankingMode ? current : nextRankingMode,
    );
  }, [emptyStateVariant, urlRanking]);

  useEffect(() => {
    if (sortMode !== "default") {
      setActiveSortMode((current) =>
        current === sortMode ? current : sortMode,
      );
      return;
    }
    const nextSortMode = resolveSortModeFromParam(urlOrder);
    setActiveSortMode((current) =>
      current === nextSortMode ? current : nextSortMode,
    );
  }, [sortMode, urlOrder]);

  const debouncedSearchInput = useDebounceValue(
    searchInput,
    ITEMS_SEARCH_DEBOUNCE_MS,
  );
  const debouncedFilters = useDebounceValue(
    filters,
    ITEMS_FILTERS_URL_DEBOUNCE_MS,
  );
  const debouncedFiltersFingerprint = useMemo(
    () => fingerprintFilters(debouncedFilters),
    [debouncedFilters],
  );

  useEffect(() => {
    const nextSearch = debouncedSearchInput.trim();
    if (nextSearch === search) {
      return;
    }
    setSearch(nextSearch);
    setPage(1);
  }, [debouncedSearchInput, search]);

  const queryFiltersInput = useMemo(
    () => buildFiltersInput(queryFilters),
    [queryFilters],
  );
  const displayFiltersInput = useMemo(
    () => buildFiltersInput(displayFilters),
    [displayFilters],
  );
  const hasQueryFilters = queryFiltersInput !== null;
  const hasVisibleFilters = displayFiltersInput !== null;
  const activeFilterDimensionCount = useMemo(
    () => countItemsFilterDimensions(displayFilters),
    [displayFilters],
  );
  const isUnsearched =
    emptyStateVariant === "search" && search.length === 0 && !hasQueryFilters;
  const defaultRankingMode: ItemsRankingMode =
    emptyStateVariant === "search" ? "RELEVANCE" : "RECENCY";
  const rankingModeQueryValue =
    rankingMode === defaultRankingMode
      ? null
      : rankingMode === "RELEVANCE"
        ? "relevance"
        : "recency";
  const listTableScroll =
    typeof listTableScrollX === "number" && typeof listTableScrollY === "number"
      ? {
          x: listTableScrollX,
          y: listTableScrollY,
          scrollToFirstRowOnChange: true,
        }
      : undefined;
  const effectiveSortMode = sortMode === "default" ? activeSortMode : sortMode;
  const orderQueryValue =
    sortMode !== "default"
      ? null
      : effectiveSortMode === "publishedDesc"
        ? "published"
        : effectiveSortMode === "personalized"
          ? "personalized"
          : null;
  const orderBy = useMemo<ItemsOrderBy>(
    () =>
      effectiveSortMode === "publishedDesc"
        ? "PUBLISHED_DESC"
        : effectiveSortMode === "personalized"
          ? "PERSONALIZED"
          : "CREATED_DESC",
    [effectiveSortMode],
  );

  const setQueryParams = useCallback(
    (updates: {
      q?: string | null;
      page?: number | null;
      pageSize?: number | null;
      filters?: FilterState | null;
      ranking?: "relevance" | "recency" | null;
      order?: "published" | "personalized" | null;
    }) => {
      const currentQuery = window.location.search.startsWith("?")
        ? window.location.search.slice(1)
        : window.location.search;
      const next = new URLSearchParams(currentQuery);
      if (updates.q !== undefined) {
        const value = updates.q?.trim() ?? "";
        if (value) {
          next.set("q", value);
        } else {
          next.delete("q");
        }
      }
      if (updates.page !== undefined) {
        const value = updates.page ?? 1;
        if (value > 1) {
          next.set("page", String(value));
        } else {
          next.delete("page");
        }
      }
      if (updates.pageSize !== undefined) {
        const value = updates.pageSize ?? DEFAULT_ITEMS_PAGE_SIZE;
        if (value !== DEFAULT_ITEMS_PAGE_SIZE) {
          next.set("pageSize", String(value));
        } else {
          next.delete("pageSize");
        }
      }
      if (updates.filters !== undefined) {
        applyFiltersToSearchParams(next, updates.filters);
      }
      if (updates.ranking !== undefined) {
        if (updates.ranking) {
          next.set("ranking", updates.ranking);
        } else {
          next.delete("ranking");
        }
      }
      if (updates.order !== undefined) {
        if (updates.order) {
          next.set(ITEMS_ORDER_QUERY_KEY, updates.order);
        } else {
          next.delete(ITEMS_ORDER_QUERY_KEY);
        }
      }
      const nextQuery = next.toString();
      if (nextQuery === currentQuery) {
        return;
      }
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
    },
    [pathname, router],
  );

  useEffect(() => {
    const currentParams = new URLSearchParams(window.location.search);
    const currentSearch = (currentParams.get("q") ?? "").trim();
    const currentSearchParam = currentSearch.length > 0 ? currentSearch : null;
    const currentFiltersFingerprint = fingerprintFilters(
      parseFiltersFromSearchParams(
        currentParams as unknown as ReadonlyURLSearchParams,
        initialFilters,
      ),
    );

    const nextSearchParam = search.length > 0 ? search : null;
    const currentRankingRaw = (currentParams.get("ranking") ?? "")
      .trim()
      .toLowerCase();
    const currentRankingParam =
      currentRankingRaw === "relevance" || currentRankingRaw === "recency"
        ? currentRankingRaw
        : null;
    const nextRankingParam = rankingModeQueryValue;
    const currentOrderRaw = (currentParams.get(ITEMS_ORDER_QUERY_KEY) ?? "")
      .trim()
      .toLowerCase();
    const currentOrderParam =
      currentOrderRaw === "published" || currentOrderRaw === "personalized"
        ? currentOrderRaw
        : null;
    const nextOrderParam = orderQueryValue;

    const shouldUpdateSearch = nextSearchParam !== currentSearchParam;
    const shouldUpdateFilters =
      debouncedFiltersFingerprint !== currentFiltersFingerprint;
    const shouldUpdateRanking = nextRankingParam !== currentRankingParam;
    const shouldUpdateOrder = nextOrderParam !== currentOrderParam;

    if (
      !shouldUpdateSearch &&
      !shouldUpdateFilters &&
      !shouldUpdateRanking &&
      !shouldUpdateOrder
    ) {
      return;
    }

    setQueryParams({
      ...(shouldUpdateSearch ? { q: nextSearchParam } : {}),
      ...(shouldUpdateFilters ? { filters: debouncedFilters } : {}),
      ...(shouldUpdateRanking ? { ranking: nextRankingParam } : {}),
      ...(shouldUpdateOrder ? { order: nextOrderParam } : {}),
      page: 1,
    });
  }, [
    debouncedFilters,
    debouncedFiltersFingerprint,
    initialFilters,
    orderQueryValue,
    rankingModeQueryValue,
    search,
    setQueryParams,
  ]);

  useEffect(() => {
    if (urlRawPageSize === urlPageSize) {
      return;
    }
    setPage(1);
    setPageSize(urlPageSize);
    setQueryParams({ page: 1, pageSize: urlPageSize });
  }, [setQueryParams, urlPageSize, urlRawPageSize]);

  const handleFilterChange = useCallback((nextFilters: FilterState) => {
    const normalized = normalizeFiltersState(nextFilters);
    setFilters(normalized);
    setPage(1);
  }, []);
  const handleExcludeDuplicatesChange = useCallback((checked: boolean) => {
    setFilters((current) =>
      normalizeFiltersState({
        ...current,
        ...(checked
          ? { excludeDuplicates: true }
          : { excludeDuplicates: undefined }),
      }),
    );
    setPage(1);
  }, []);

  const { data, loading, error, refetch } = useQuery<
    ItemsQuery,
    ItemsQueryVariables
  >(ITEMS_QUERY, {
    skip: isUnsearched,
    variables: {
      first: pageSize,
      after: null,
      page,
      search: search || null,
      filters: queryFiltersInput,
      orderBy,
      rankingMode,
    },
    notifyOnNetworkStatusChange: true,
  });
  const rerankUnavailableMessage = useMemo(
    () => extractRerankUnavailableMessage(error),
    [error],
  );
  const relevanceRankingUnavailable = Boolean(rerankUnavailableMessage);

  const handleSwitchToRecencyRanking = useCallback(() => {
    setRankingMode("RECENCY");
    setPage(1);
  }, []);

  const { data: facetsData } = useQuery<
    ItemFacetsQuery,
    ItemFacetsQueryVariables
  >(ITEM_FACETS_QUERY, {
    variables: {
      search: search || null,
      filters: queryFiltersInput,
    },
    fetchPolicy: "cache-and-network",
  });

  useEffect(() => {
    if (!loading) {
      setShowDelayHint(false);
      return;
    }
    const timeout = setTimeout(() => setShowDelayHint(true), 1200);
    return () => clearTimeout(timeout);
  }, [loading]);

  const resolvedData = isUnsearched
    ? undefined
    : (data ??
      (queryFiltersInput === null ? (initialData ?? undefined) : undefined));
  const edges = resolvedData?.items.edges ?? EMPTY_EDGES;
  const resolvedTotalCount = resolvedData?.items.totalCount;
  const totalCount =
    typeof resolvedTotalCount === "number" ? resolvedTotalCount : 0;
  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (displayFiltersInput?.sourceIds?.length) {
      parts.push(
        `${t("pages.rss.sourceLabel")}: ${displayFiltersInput.sourceIds.length.toLocaleString(locale)}`,
      );
    }
    if (displayFiltersInput?.regions?.length) {
      parts.push(
        `${t("items.filters.region")}: ${displayFiltersInput.regions.length.toLocaleString(locale)}`,
      );
    }
    if (displayFiltersInput?.topics?.length) {
      parts.push(
        `${t("items.filters.topic")}: ${displayFiltersInput.topics.length.toLocaleString(locale)}`,
      );
    }
    if (displayFiltersInput?.sentiments?.length) {
      parts.push(
        `${t("items.filters.sentiment")}: ${displayFiltersInput.sentiments.length.toLocaleString(locale)}`,
      );
    }
    if (displayFiltersInput?.contentTypes?.length) {
      parts.push(
        `${t("items.filters.contentType")}: ${displayFiltersInput.contentTypes.length.toLocaleString(locale)}`,
      );
    }
    if (displayFiltersInput?.excludeDuplicates) {
      parts.push(t("items.filters.excludeDuplicates"));
    }
    if (displayFiltersInput?.dateRange) {
      parts.push(`${t("items.filters.date")}: 1`);
    }
    return {
      parts,
      text: parts.join(" | "),
    };
  }, [displayFiltersInput, locale, t]);

  const showingRange = useMemo(() => {
    if (totalCount === 0 || edges.length === 0) {
      return null;
    }
    const from = (page - 1) * pageSize + 1;
    const to = Math.min(from + edges.length - 1, totalCount);
    return { from, to };
  }, [edges.length, page, pageSize, totalCount]);

  useEffect(() => {
    if (isUnsearched || loading || error) {
      return;
    }
    if (typeof resolvedTotalCount !== "number") {
      return;
    }
    const lastPage = getItemsLastPage(resolvedTotalCount, pageSize);
    if (page > lastPage) {
      setPage(lastPage);
      setQueryParams({ page: lastPage });
    }
  }, [
    error,
    isUnsearched,
    loading,
    page,
    pageSize,
    resolvedTotalCount,
    setQueryParams,
  ]);

  const basePageData = useMemo<ParsedItem[]>(() => {
    return edges.map((edge) => {
      const processed = edge.node.processedPreview;
      const raw = edge.node.rawPreview;
      const summary = resolveDisplaySummary({
        processedSummary: processed?.summary,
        rawSummary: raw?.summary,
      });
      const sentiment =
        toNonEmptyString(processed?.sentiment) ??
        toNonEmptyString(raw?.sentiment) ??
        undefined;
      const region = toNonEmptyString(raw?.region) ?? undefined;
      const location =
        toNonEmptyString(processed?.location) ??
        toNonEmptyString(raw?.location) ??
        undefined;
      const ticker = toNonEmptyString(raw?.ticker) ?? undefined;
      const price =
        typeof raw?.price === "number" && Number.isFinite(raw.price)
          ? raw.price
          : undefined;
      const change =
        typeof raw?.changePercent === "number" &&
        Number.isFinite(raw.changePercent)
          ? raw.changePercent
          : undefined;
      const history = Array.isArray(raw?.history)
        ? raw.history
            .map((point) => {
              const timestamp =
                typeof point?.timestamp === "string"
                  ? point.timestamp.trim()
                  : "";
              const value =
                typeof point?.value === "number" && Number.isFinite(point.value)
                  ? point.value
                  : null;
              if (!timestamp || value === null) {
                return null;
              }
              return { timestamp, value };
            })
            .filter((point): point is { timestamp: string; value: number } =>
              Boolean(point),
            )
        : undefined;
      const url = safeHttpUrl(raw?.url) ?? undefined;
      const thumbnail = safeHttpUrl(raw?.thumbnail) ?? undefined;

      const publishedAt =
        toNonEmptyString(edge.node.publishedAt) ??
        toNonEmptyString(processed?.publishedAt) ??
        undefined;
      const ingestedAt = dayjs(
        edge.node.ingestedAt ?? edge.node.createdAt,
      ).toISOString();
      const topics = Array.from(
        new Set(
          (processed?.topics ?? [])
            .map((topic) => topic.trim())
            .filter((topic) => topic.length > 0),
        ),
      );
      const entities = Array.from(
        new Set(
          (processed?.entities ?? [])
            .map((entity) => entity.trim())
            .filter((entity) => entity.length > 0),
        ),
      );
      const source =
        toNonEmptyString(processed?.source) ??
        toNonEmptyString(raw?.sourceName) ??
        undefined;
      const contentType = normalizeContentType(
        toNonEmptyString(processed?.contentType) ?? "",
      );
      const displayTitle = resolveDisplayTitle({
        processedTitle: processed?.title,
        itemTitle: edge.node.title,
        source,
        originalUrl: raw?.url,
      });

      return {
        id: edge.node.id,
        title: displayTitle,
        status: edge.node.status,
        name: displayTitle,
        summary,
        thumbnail: thumbnail ?? undefined,
        sentiment,
        ticker,
        price,
        change,
        history,
        publishedAt,
        ingestedAt,
        createdAt: ingestedAt,
        source,
        contentType,
        language: toNonEmptyString(processed?.language) ?? undefined,
        topics,
        entities,
        region,
        relevanceScore:
          typeof edge.node.relevanceScore === "number" &&
          Number.isFinite(edge.node.relevanceScore)
            ? edge.node.relevanceScore
            : undefined,
        searchHighlights: Array.isArray(edge.node.searchHighlights)
          ? edge.node.searchHighlights
              .map((entry) => ({
                field: entry.field,
                snippets: entry.snippets.filter((snippet) => snippet.trim().length > 0),
              }))
              .filter((entry) => entry.snippets.length > 0)
          : undefined,
        qualityScore:
          typeof processed?.qualityScore === "number"
            ? processed.qualityScore
            : undefined,
        duplicateSimilarity:
          typeof processed?.duplicateSimilarity === "number"
            ? processed.duplicateSimilarity
            : undefined,
        duplicateOf: processed?.duplicateOf ?? null,
        llm: processed?.llm ?? undefined,
        url: url ?? undefined,
        location,
        eventId: processed?.eventId ?? null,
      } as ParsedItem;
    });
  }, [edges]);

  useEffect(() => {
    if (!rssTranslationConfig?.enabled) {
      onTranslationError?.(null);
      return;
    }
    if (loading || error) {
      return;
    }
    if (!basePageData || basePageData.length === 0) {
      return;
    }

    const targetLanguage =
      rssTranslationConfig.targetLanguage?.trim() || "zh-CN";
    const provider = rssTranslationConfig.provider;
    const fields = normalizeRssTranslationFields(rssTranslationConfig.fields);
    const itemIds = basePageData.map((item) => item.id);

    const requestKey = JSON.stringify({
      provider,
      targetLanguage,
      fields,
      itemIds,
    });
    if (translationRequestKeyRef.current === requestKey) {
      return;
    }
    const requestSeq = translationRequestSeqRef.current + 1;
    translationRequestSeqRef.current = requestSeq;
    translationRequestKeyRef.current = requestKey;

    translateRssItems({
      variables: {
        input: {
          itemIds,
          provider,
          targetLanguage,
          fields,
        },
      },
    })
      .then((response) => {
        if (translationRequestSeqRef.current !== requestSeq) {
          return;
        }
        onTranslationError?.(null);
        const translations =
          response.data?.translateRssItems.translations ?? [];
        if (translations.length === 0) {
          return;
        }
        setTranslatedByItemId((prev) => {
          const next = { ...prev };
          translations.forEach((entry) => {
            const existing = next[entry.itemId] ?? {};
            next[entry.itemId] = {
              ...existing,
              ...(entry.title ? { title: entry.title } : {}),
              ...(entry.summary ? { summary: entry.summary } : {}),
              ...(entry.keyPoints ? { keyPoints: entry.keyPoints } : {}),
              ...(entry.cleanedMarkdown
                ? { cleanedMarkdown: entry.cleanedMarkdown }
                : {}),
            };
          });
          return next;
        });
      })
      .catch((err) => {
        if (translationRequestSeqRef.current !== requestSeq) {
          return;
        }
        translationRequestKeyRef.current = "";
        const message =
          err instanceof Error ? err.message : "Translation failed";
        onTranslationError?.(message);
      });
  }, [
    error,
    loading,
    onTranslationError,
    basePageData,
    rssTranslationConfig?.enabled,
    rssTranslationConfig?.fields,
    rssTranslationConfig?.provider,
    rssTranslationConfig?.targetLanguage,
    translateRssItems,
  ]);

  const pageData = useMemo<ParsedItem[]>(() => {
    if (!rssTranslationConfig?.enabled) {
      return basePageData;
    }
    return applyRssTranslationsToListItems({
      items: basePageData,
      translatedByItemId,
      enabled: rssTranslationConfig?.enabled,
      showOriginal: rssTranslationConfig?.showOriginal,
    });
  }, [
    basePageData,
    rssTranslationConfig?.enabled,
    rssTranslationConfig?.showOriginal,
    translatedByItemId,
  ]);
  const shouldVirtualizeFeed =
    view === "feed" && shouldVirtualizeItemsFeed(pageData.length);
  const feedVirtualizer = useWindowVirtualizer({
    count: pageData.length,
    estimateSize: () =>
      estimateItemsFeedRowSize({
        density: layoutState.density,
        isReaderPreset: layoutState.isReaderPreset,
      }),
    overscan: 4,
    enabled: shouldVirtualizeFeed,
    scrollMargin: feedScrollMargin,
  });

  useEffect(() => {
    if (view !== "feed") {
      setFeedScrollMargin(0);
      return;
    }

    let frameId: number | null = null;
    const scheduleUpdate = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => updateFeedMetrics());
    };

    scheduleUpdate();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => scheduleUpdate());

    if (feedListRef.current) {
      resizeObserver?.observe(feedListRef.current);
    }
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, { passive: true });

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate);
    };
  }, [pageData.length, updateFeedMetrics, view]);

  useEffect(() => {
    if (!shouldVirtualizeFeed) {
      return;
    }
    feedVirtualizer.measure();
  }, [feedVirtualizer, pageData.length, shouldVirtualizeFeed]);

  const rssTranslationStats = useMemo(() => {
    if (!rssTranslationConfig?.enabled || pageData.length === 0) {
      return null;
    }

    let translated = 0;
    let original = 0;
    pageData.forEach((item) => {
      if (item.rssTranslationState === "translated") {
        translated += 1;
        return;
      }
      if (item.rssTranslationState === "original") {
        original += 1;
      }
    });

    if (translated === 0 && original === 0) {
      return null;
    }

    return { translated, original };
  }, [pageData, rssTranslationConfig?.enabled]);

  useEffect(() => {
    if (view !== "list") {
      return;
    }
    updateListTableScroll();
  }, [
    error,
    hasVisibleFilters,
    pageData.length,
    search,
    updateListTableScroll,
    view,
  ]);

  const availableRegions = useMemo(() => {
    const regions = facetsData?.itemFacets?.regions;
    if (regions && regions.length > 0) {
      return regions.map((region) => region.value);
    }
    const fallback = pageData
      .map((item) => item.region ?? item.location)
      .filter((value): value is string => Boolean(value));
    return Array.from(new Set(fallback));
  }, [facetsData, pageData]);

  const availableTopics = useMemo(() => {
    const topics = facetsData?.itemFacets?.topics;
    if (topics && topics.length > 0) {
      return topics.map((topic) => topic.value);
    }
    const fallback = pageData
      .flatMap((item) => [...(item.topics ?? [])])
      .filter((value): value is string => Boolean(value));
    return Array.from(new Set(fallback));
  }, [facetsData, pageData]);

  const availableSentiments = useMemo(
    () =>
      resolveAvailableSentiments(
        facetsData?.itemFacets?.sentiments.map((sentiment) => sentiment.value),
        filters.sentiments,
      ),
    [facetsData, filters.sentiments],
  );

  const availableContentTypes = useMemo(() => {
    const facetContentTypes = facetsData?.itemFacets?.contentTypes;
    if (facetContentTypes && facetContentTypes.length > 0) {
      return (
        normalizeContentTypeList(
          facetContentTypes.map((entry) => entry.value),
        ) ?? []
      );
    }
    return (
      normalizeContentTypeList(
        pageData.flatMap((item) =>
          item.contentType ? [item.contentType] : [],
        ),
      ) ?? []
    );
  }, [facetsData, pageData]);

  useEffect(() => {
    const selected = normalizeFilterList(filters.sentiments, {
      lowerCase: true,
    });
    if (
      !selected ||
      selected.length === 0 ||
      availableSentiments.length === 0
    ) {
      return;
    }

    const allowed = new Set(availableSentiments);
    const validSelections = selected.filter((value) => allowed.has(value));
    if (validSelections.length === selected.length) {
      return;
    }

    handleFilterChange({
      ...filters,
      ...(validSelections.length > 0
        ? { sentiments: validSelections }
        : { sentiments: undefined }),
    });
  }, [availableSentiments, filters, handleFilterChange]);

  useEffect(() => {
    const selected = normalizeContentTypeList(filters.contentTypes);
    if (!selected || selected.length === 0) {
      return;
    }
    if (availableContentTypes.length === 0) {
      handleFilterChange({ ...filters, contentTypes: undefined });
      return;
    }
    const allowed = new Set(availableContentTypes);
    const validSelections = selected.filter((value) => allowed.has(value));
    if (validSelections.length === selected.length) {
      return;
    }
    handleFilterChange({
      ...filters,
      ...(validSelections.length > 0
        ? { contentTypes: validSelections }
        : { contentTypes: undefined }),
    });
  }, [availableContentTypes, filters, handleFilterChange]);

  const emptyStateConfig = useMemo(() => {
    if (emptyStateVariant === "today") {
      const action = canManageCrawl
        ? {
            label: t("items.empty.todayActionAdmin"),
            href: "/admin/ops/crawl-tasks",
          }
        : {
            label: t("items.empty.todayActionSubscriber"),
            href: "/subscriptions",
          };
      return {
        title: t("items.empty.todayTitle"),
        description: t("items.empty.todayDescription"),
        actionLabel: action.label,
        actionHref: action.href,
      };
    }

    if (emptyStateVariant === "search") {
      if (isUnsearched) {
        return {
          title: t("items.empty.searchIdleTitle"),
          description: t("items.empty.searchIdleDescription"),
        };
      }
      return {
        title: t("items.empty.searchTitle"),
        description: t("items.empty.searchDescription"),
      };
    }

    return {
      title: t("items.empty.defaultTitle"),
      description: t("items.empty.defaultDescription"),
    };
  }, [canManageCrawl, emptyStateVariant, isUnsearched, t]);

  const handlePaginationChange = useCallback(
    (nextPage: number, nextPageSize?: number) => {
      const { page: normalizedPage, pageSize: normalizedPageSize } =
        normalizeItemsPaginationChange({
          nextPage,
          nextPageSize,
          currentPageSize: pageSize,
          totalCount: resolvedTotalCount,
        });

      setPage(normalizedPage);
      setPageSize(normalizedPageSize);
      setQueryParams({
        page: normalizedPage,
        pageSize: normalizedPageSize,
      });
    },
    [pageSize, resolvedTotalCount, setQueryParams],
  );

  const handleTableChange = (pager: TablePaginationConfig) => {
    handlePaginationChange(pager.current ?? 1, pager.pageSize);
  };

  const handleClearSearch = useCallback(() => {
    setSearchInput("");
    setSearch("");
    setPage(1);
    setQueryParams({
      q: null,
      page: 1,
    });
  }, [setQueryParams]);

  const handleSearch = (value: string) => {
    const nextValue = value.trim();
    if (!nextValue) {
      handleClearSearch();
      return;
    }
    setSearchInput(nextValue);
    setSearch(nextValue);
    setPage(1);
    setQueryParams({
      q: nextValue,
      page: 1,
    });
  };

  const columns = useMemo<ColumnsType<ParsedItem>>(
    () => [
      {
        title: t("items.columns.name"),
        dataIndex: "name",
        key: "name",
        ellipsis: true,
      },
      {
        title: t("items.columns.source"),
        dataIndex: "source",
        key: "source",
        width: 120,
        render: (value: string | undefined) =>
          value ?? t("common.notAvailable"),
      },
      {
        title: t("items.columns.time"),
        dataIndex: "publishedAt",
        key: "publishedAt",
        width: 240,
        render: (_: string | undefined, record) => {
          const ingestedLabel = t("items.time.ingested");
          const ingestedAt = record.ingestedAt ?? record.createdAt;
          return (
            <Space direction="vertical" size={0}>
              <ArticlePublishedTime
                publishedAt={record.publishedAt ?? null}
                locale={locale}
                timeZone={timeZone}
                primaryStrong
                secondaryStyle={{ fontSize: 12 }}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {ingestedLabel}:{" "}
                {formatDateTime(ingestedAt, locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone,
                  timeZoneName: "short",
                })}
              </Typography.Text>
            </Space>
          );
        },
      },
      {
        title: withMetricTooltip(
          t("items.columns.quality"),
          t("items.metrics.quality.tooltip"),
        ),
        dataIndex: "qualityScore",
        key: "qualityScore",
        width: 110,
        render: (value: number | undefined, record) => {
          const formatted = formatRatioAsPercent(value, locale);
          if (!formatted) {
            return <Tag>{t("common.notAvailable")}</Tag>;
          }

          const tooltip = (
            <div className="text-xs">
              <div>{t("items.metrics.quality.tooltip")}</div>
              {record.llm?.model ? (
                <div>
                  {t("items.metrics.model")}: {record.llm.model}
                </div>
              ) : null}
              {record.llm?.promptVersion ? (
                <div>
                  {t("items.metrics.prompt")}: {record.llm.promptVersion}
                </div>
              ) : null}
            </div>
          );

          return (
            <Tooltip title={tooltip}>
              <Tag color="blue">{formatted}</Tag>
            </Tooltip>
          );
        },
      },
      {
        title: withMetricTooltip(
          t("items.columns.duplicate"),
          t("items.metrics.duplicate.tooltip"),
        ),
        dataIndex: "duplicateSimilarity",
        key: "duplicateSimilarity",
        width: 120,
        render: (value: number | undefined, record) => {
          const formatted = formatRatioAsPercent(value, locale);
          if (!formatted) {
            return <Tag>{t("common.notAvailable")}</Tag>;
          }
          const label = record.duplicateOf
            ? t("items.duplicate.duplicate")
            : t("items.duplicate.similarity");

          const tooltip = (
            <div className="text-xs">
              <div>{t("items.metrics.duplicate.tooltip")}</div>
              {record.duplicateOf ? (
                <div>
                  {t("items.duplicate.of")}: {record.duplicateOf}
                </div>
              ) : null}
            </div>
          );

          return (
            <Tooltip title={tooltip}>
              <Tag color="gold">
                {label} {formatted}
              </Tag>
            </Tooltip>
          );
        },
      },
      {
        title: t("items.columns.open"),
        key: "open",
        width: 100,
        render: (_: unknown, record) => (
          <Button
            type="link"
            size="small"
            onClick={() => router.push(`/items/${record.id}`)}
            className="px-0"
          >
            {t("items.detail.openItem")}
          </Button>
        ),
      },
    ],
    [locale, router, t, timeZone],
  );

  const renderContent = () => {
    const rerankUnavailableBanner = rerankUnavailableMessage ? (
      <Alert
        type="error"
        showIcon
        message={t("items.rerankUnavailable.title")}
        description={
          <div>
            <div>{t("items.rerankUnavailable.description")}</div>
            <div className="mt-1 text-xs opacity-80">
              {t("items.rerankUnavailable.detailLabel")}:{" "}
              {rerankUnavailableMessage}
            </div>
            <div className="mt-2">
              <Button size="small" onClick={handleSwitchToRecencyRanking}>
                {t("items.rerankUnavailable.switchToRecency")}
              </Button>
            </div>
          </div>
        }
      />
    ) : null;

    if (loading && !pageData.length) {
      const skeleton =
        view === "list" ? (
          <ItemsTableLoadingSkeleton rows={pageSize} />
        ) : view === "grid" ? (
          <ItemsGridLoadingSkeleton count={pageSize} />
        ) : (
          <ItemsFeedLoadingSkeleton count={pageSize} />
        );

      return (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          {skeleton}
          {showDelayHint ? (
            <ChartEmptyState
              className="h-auto"
              variant="delayed"
              title={t("common.loadingDelayedTitle")}
              description={t("common.loadingDelayed")}
            />
          ) : null}
        </Space>
      );
    }

    if (error && pageData.length === 0) {
      const emptyState = buildRequestErrorEmptyState({
        t,
        error,
        onRetry: () => refetch(),
      });
      return (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {rerankUnavailableBanner}
          <ChartEmptyState className="h-auto" {...emptyState} />
        </Space>
      );
    }

    if (!loading && pageData.length === 0) {
      const isFiltered = Boolean(search.length > 0 || hasVisibleFilters);
      const filteredDescription = isFiltered ? (
        <div className="flex flex-col items-center gap-1">
          <span>{t("items.empty.filteredDescription")}</span>
          {search ? (
            <span className="font-mono text-[10px] opacity-80">
              {t("items.stats.query")}: {search}
            </span>
          ) : null}
          {filterSummary.text ? (
            <span className="font-mono text-[10px] opacity-80">
              {filterSummary.text}
            </span>
          ) : null}
        </div>
      ) : null;

      return (
        <ChartEmptyState
          className="h-auto"
          title={emptyStateConfig.title}
          description={filteredDescription ?? emptyStateConfig.description}
          actionLabel={emptyStateConfig.actionLabel}
          onAction={
            emptyStateConfig.actionLabel && emptyStateConfig.actionHref
              ? () => router.push(emptyStateConfig.actionHref)
              : undefined
          }
        />
      );
    }

    const shouldShowErrorBanner = Boolean(error && pageData.length > 0);
    const errorBanner = shouldShowErrorBanner ? (
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {rerankUnavailableBanner}
        <RequestErrorBanner
          error={error}
          onRetry={() => void refetch()}
          showCachedDataHint
        />
      </Space>
    ) : null;

    if (view === "list") {
      return (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {errorBanner}
          <div ref={listTableContainerRef} className="w-full">
            <Table
              rowKey="id"
              columns={columns}
              dataSource={pageData}
              loading={loading}
              size="large"
              scroll={listTableScroll}
              pagination={{
                current: page,
                pageSize,
                total: totalCount,
                showSizeChanger: true,
                pageSizeOptions: ITEMS_PAGE_SIZE_OPTIONS_STRINGS,
              }}
              onChange={handleTableChange}
            />
          </div>
        </Space>
      );
    }

    if (view === "grid") {
      return (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {errorBanner}
          <List
            className={
              layoutState.isReaderPreset ? "items-reader-feed-list" : undefined
            }
            grid={{ gutter: 16, xs: 1, sm: 2, md: 3, lg: 3, xl: 4, xxl: 4 }}
            dataSource={pageData}
            rowKey="id"
            pagination={{
              current: page,
              pageSize,
              total: totalCount,
              showSizeChanger: true,
              pageSizeOptions: ITEMS_PAGE_SIZE_OPTIONS_STRINGS,
              align: "center",
              onChange: handlePaginationChange,
              onShowSizeChange: handlePaginationChange,
            }}
            renderItem={(item) => (
              <List.Item key={item.id}>
                {/* Naive heuristic to choose card type: if it has price/ticker, assume financial */}
                {item.price !== undefined || item.ticker ? (
                  <FinancialCard item={item} />
                ) : (
                  <NewsCard
                    variant={layoutState.isReaderPreset ? "reader" : "default"}
                    density={layoutState.density}
                    item={item}
                  />
                )}
              </List.Item>
            )}
          />
        </Space>
      );
    }

    if (view === "feed") {
      const renderFeedCard = (item: ParsedItem) => (
        <NewsCard
          variant={layoutState.isReaderPreset ? "reader" : "default"}
          density={layoutState.density}
          item={item}
        />
      );

      const pagination = (
        <div className="flex justify-center">
          <Pagination
            current={page}
            pageSize={pageSize}
            total={totalCount}
            showSizeChanger
            pageSizeOptions={ITEMS_PAGE_SIZE_OPTIONS_STRINGS}
            onChange={handlePaginationChange}
            onShowSizeChange={handlePaginationChange}
          />
        </div>
      );

      if (shouldVirtualizeFeed) {
        const virtualRows = feedVirtualizer.getVirtualItems();
        return (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {errorBanner}
            <div
              ref={feedListRef}
              className={
                layoutState.isReaderPreset ? "items-reader-feed-list" : undefined
              }
              role="list"
            >
              <div
                style={{
                  height: `${feedVirtualizer.getTotalSize()}px`,
                  position: "relative",
                  width: "100%",
                }}
              >
                {virtualRows.map((virtualRow) => {
                  const item = pageData[virtualRow.index];
                  if (!item) {
                    return null;
                  }
                  return (
                    <div
                      key={item.id}
                      data-index={virtualRow.index}
                      ref={feedVirtualizer.measureElement}
                      role="listitem"
                      style={{
                        left: 0,
                        position: "absolute",
                        top: 0,
                        transform: `translateY(${virtualRow.start - feedScrollMargin}px)`,
                        width: "100%",
                      }}
                    >
                      {renderFeedCard(item)}
                    </div>
                  );
                })}
              </div>
            </div>
            {pagination}
          </Space>
        );
      }

      return (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {errorBanner}
          <List
            className={
              layoutState.isReaderPreset ? "items-reader-feed-list" : undefined
            }
            itemLayout="vertical"
            dataSource={pageData}
            rowKey="id"
            pagination={{
              current: page,
              pageSize,
              total: totalCount,
              showSizeChanger: true,
              pageSizeOptions: ITEMS_PAGE_SIZE_OPTIONS_STRINGS,
              align: "center",
              onChange: handlePaginationChange,
              onShowSizeChange: handlePaginationChange,
            }}
            renderItem={(item) => (
              <List.Item key={item.id}>
                {renderFeedCard(item)}
              </List.Item>
            )}
          />
        </Space>
      );
    }

    return null;
  };

  const filterButtonLabel =
    activeFilterDimensionCount > 0
      ? `${t("items.filters.button")} (${activeFilterDimensionCount})`
      : t("items.filters.button");
  const excludeDuplicatesEnabled = displayFilters.excludeDuplicates === true;

  const containerClassName = layoutState.isReaderPreset
    ? "content-card items-reader-shell"
    : "content-card";

  return (
    <div className={containerClassName} style={{ padding: "24px" }}>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {!hideQuickNav ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="small" onClick={() => router.push("/news-hub")}>
              {t("items.quickNav.hub")}
            </Button>
            <Button
              size="small"
              onClick={() => router.push("/newsnow/hottest")}
            >
              {t("items.quickNav.newsnow")}
            </Button>
            <Button size="small" onClick={() => router.push("/events")}>
              {t("items.quickNav.events")}
            </Button>
          </div>
        ) : null}

        <AnalysisToolbar
          surface="items"
          exportTarget="items"
          queryString={searchParams.toString()}
          savedViewId={savedViewId}
        />

        {savedViewId ? (
          <AnnotationPanel subjectType="saved_view" subjectId={savedViewId} />
        ) : null}

        {/* Header Controls */}
        <Row justify="space-between" align="middle" gutter={[16, 16]}>
          <Col flex="auto">
            <Space wrap className="w-full">
              {!hideSearchControl ? (
                layoutState.filterBehavior === "layered" ? (
                  <EnhancedSearchBox
                    className="min-w-0 sm:min-w-[280px]"
                    placeholder={t("items.search.placeholder")}
                    value={searchInput}
                    onChange={(value) => {
                      if (!value) {
                        handleClearSearch();
                        return;
                      }
                      setSearchInput(value);
                    }}
                    onSearch={(query) => handleSearch(query)}
                    navigateOnSearch={false}
                    onSuggestionStatusChange={onSearchSuggestionStatusChange}
                  />
                ) : (
                  <Space.Compact>
                    <Input
                      id="items-search"
                      name="itemsSearch"
                      placeholder={t("items.search.placeholder")}
                      value={searchInput}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (!value) {
                          handleClearSearch();
                          return;
                        }
                        setSearchInput(value);
                      }}
                      onPressEnter={() => handleSearch(searchInput)}
                    />
                    {searchInput.length > 0 || search.length > 0 ? (
                      <Button
                        icon={<CloseCircleOutlined />}
                        aria-label={t("common.clear")}
                        onClick={handleClearSearch}
                      />
                    ) : null}
                    <Button
                      icon={<SearchOutlined />}
                      aria-label={t("items.search.placeholder")}
                      onClick={() => handleSearch(searchInput)}
                    />
                  </Space.Compact>
                )
              ) : null}
              {emptyStateVariant === "search" || search.length > 0 ? (
                <Segmented
                  size="small"
                  value={rankingMode}
                  options={[
                    {
                      label: relevanceRankingUnavailable ? (
                        <Tooltip
                          title={t(
                            "items.rerankUnavailable.relevanceDisabledHint",
                          )}
                        >
                          <span>{t("items.ranking.relevanceUnavailable")}</span>
                        </Tooltip>
                      ) : (
                        t("items.ranking.relevance")
                      ),
                      value: "RELEVANCE",
                      disabled: relevanceRankingUnavailable,
                    },
                    {
                      label: t("items.ranking.recency"),
                      value: "RECENCY",
                    },
                  ]}
                  onChange={(value) => {
                    if (value === "RELEVANCE" && relevanceRankingUnavailable) {
                      return;
                    }
                    setRankingMode(value as ItemsRankingMode);
                    setPage(1);
                  }}
                />
              ) : null}
              {sortMode === "default" ? (
                <Segmented
                  size="small"
                  value={effectiveSortMode}
                  options={[
                    {
                      label: t("items.sort.latest"),
                      value: "default",
                    },
                    {
                      label: t("items.sort.published"),
                      value: "publishedDesc",
                    },
                    {
                      label: t("items.sort.personalized"),
                      value: "personalized",
                    },
                  ]}
                  onChange={(value) => {
                    setActiveSortMode(value as ItemsSortMode);
                    setPage(1);
                  }}
                />
              ) : null}
              <Tooltip title={t("items.filters.excludeDuplicatesHint")}>
                <Space size={6}>
                  <Typography.Text type="secondary">
                    {t("items.filters.excludeDuplicates")}
                  </Typography.Text>
                  <Switch
                    size="small"
                    checked={excludeDuplicatesEnabled}
                    onChange={handleExcludeDuplicatesChange}
                  />
                </Space>
              </Tooltip>
              {!screens.lg && (
                <Button onClick={() => setShowFilters(true)}>
                  {filterButtonLabel}
                </Button>
              )}
            </Space>
          </Col>
          <Col>
            <Space>
              {!lockedView ? (
                <ViewSwitcher view={view} onChange={setView} />
              ) : null}
              <Button
                onClick={() => refetch()}
                loading={loading}
                disabled={isUnsearched}
              >
                {t("common.refresh")}
              </Button>
            </Space>
          </Col>
        </Row>

        {!isUnsearched ? (
          <div className="flex flex-wrap items-center gap-2">
            {search ? (
              <Tooltip title={search}>
                <Tag
                  className="text-xs max-w-[320px] truncate"
                  color="geekblue"
                  closable
                  onClose={() => handleSearch("")}
                >
                  {t("items.stats.query")}: {search}
                </Tag>
              </Tooltip>
            ) : null}
            {filterSummary.text ? (
              <Tooltip title={filterSummary.text}>
                <Tag className="text-xs" color="purple">
                  {t("items.stats.filters")}: {filterSummary.text}
                </Tag>
              </Tooltip>
            ) : null}
            <Tag className="text-xs">
              {t("items.stats.matches")}:{" "}
              {typeof resolvedTotalCount === "number"
                ? totalCount.toLocaleString(locale)
                : t("common.loading")}
            </Tag>
            {showingRange ? (
              <Tag className="text-xs">
                {t("items.stats.showing", {
                  from: showingRange.from,
                  to: showingRange.to,
                  total: totalCount,
                })}
              </Tag>
            ) : null}
            {rssTranslationStats ? (
              <Tag className="text-xs" color="cyan">
                {t("pages.rss.translation.translatedCount", {
                  count: rssTranslationStats.translated,
                })}
              </Tag>
            ) : null}
            {rssTranslationStats ? (
              <Tag className="text-xs">
                {t("pages.rss.translation.originalCount", {
                  count: rssTranslationStats.original,
                })}
              </Tag>
            ) : null}
          </div>
        ) : null}

        {/* Main Layout */}
        <Row gutter={24} align="top">
          {screens.lg && (
            <Col flex="300px">
              <div
                className={
                  layoutState.isLayeredFilters ? "items-filter-rail" : undefined
                }
              >
                <FacetedSearch
                  behavior={layoutState.filterBehavior}
                  stickySummary={layoutState.isLayeredFilters}
                  filters={displayFilters}
                  onFilterChange={handleFilterChange}
                  regions={availableRegions}
                  topics={availableTopics}
                  sentiments={availableSentiments}
                  contentTypes={availableContentTypes}
                />
              </div>
            </Col>
          )}
          <Col
            flex="auto"
            className={
              layoutState.isReaderPreset ? "items-reader-main" : undefined
            }
          >
            {renderContent()}
          </Col>
        </Row>
      </Space>

      <Drawer
        title={t("items.filters.title")}
        placement={screens.lg ? "right" : "bottom"}
        width={screens.lg ? 360 : undefined}
        height={!screens.lg ? "72vh" : undefined}
        onClose={() => setShowFilters(false)}
        open={showFilters}
      >
        <FacetedSearch
          behavior={layoutState.filterBehavior}
          stickySummary={false}
          filters={displayFilters}
          onFilterChange={handleFilterChange}
          regions={availableRegions}
          topics={availableTopics}
          sentiments={availableSentiments}
          contentTypes={availableContentTypes}
        />
      </Drawer>
    </div>
  );
}
