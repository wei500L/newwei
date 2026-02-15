"use client";

import { InfoCircleOutlined, SearchOutlined } from "@ant-design/icons";
import { gql, useMutation, useQuery } from "@apollo/client";
import { Button, Col, Drawer, Grid, Input, List, Row, Skeleton, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import dynamic from "next/dynamic";
import { type ReadonlyURLSearchParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import type { ItemsQuery } from "@/graphql/generated";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import { resolveDisplaySummary, resolveDisplayTitle } from "@/lib/item-display";
import { formatRatioAsPercent } from "@/lib/metrics-format";
import { buildRequestErrorEmptyState } from "@/lib/request-error-empty-state";
import {
  type RssItemTranslation,
  type RssTranslationField,
  type RssTranslationProvider,
  TRANSLATE_RSS_ITEMS_MUTATION,
  type TranslateRssItemsMutation,
  type TranslateRssItemsMutationVariables
} from "@/lib/rss-translation";
import { safeHttpUrl } from "@/lib/url";
import { useDebounceValue } from "@/lib/use-debounce-value";

import { FacetedSearch, type FilterState } from "./components/faceted-search";
import { NewsCard } from "./components/news-card";
import { type ItemViewType, ViewSwitcher } from "./components/view-switcher";
import {
  DEFAULT_ITEMS_PAGE_SIZE,
  ITEMS_PAGE_SIZE_OPTIONS_STRINGS,
  clampItemsPageSize,
  getItemsLastPage,
  normalizeItemsPaginationChange
} from "./pagination";

const FinancialCard = dynamic(
  () => import("./components/financial-card").then((mod) => mod.FinancialCard),
  { loading: () => <Skeleton active paragraph={{ rows: 3 }} /> }
);

const EMPTY_FILTERS_STATE: FilterState = {};

const ITEMS_SEARCH_DEBOUNCE_MS = 400;
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
          <Skeleton.Button active size="small" style={{ width: 72, height: 22 }} />
          <Skeleton.Button active size="small" style={{ width: 72, height: 22 }} />
          <Skeleton.Button active size="small" style={{ width: 72, height: 22 }} />
        </div>
        <Skeleton active title={{ width: "70%" }} paragraph={{ rows: compact ? 3 : 5 }} />
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

function normalizeRssTranslationFields(
  fields?: RssTranslationField[]
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
  options?: { lowerCase?: boolean }
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

const ITEMS_FILTER_QUERY_KEYS = {
  region: "region",
  topic: "topic",
  sentiment: "sentiment",
  from: "from",
  to: "to"
} as const;

function normalizeFiltersState(filters: FilterState): FilterState {
  const regions = normalizeFilterList(filters.regions)?.sort((a, b) => a.localeCompare(b));
  const topics = normalizeFilterList(filters.topics)?.sort((a, b) => a.localeCompare(b));
  const sentiments = normalizeFilterList(filters.sentiments, { lowerCase: true })?.sort((a, b) =>
    a.localeCompare(b)
  );

  const start = filters.dateRange?.[0] ?? null;
  const end = filters.dateRange?.[1] ?? null;
  const dateRange: FilterState["dateRange"] | undefined =
    start && end && start.isValid() && end.isValid() && (start.isBefore(end) || start.isSame(end))
      ? [start, end]
      : undefined;

  return {
    ...(regions ? { regions } : {}),
    ...(topics ? { topics } : {}),
    ...(sentiments ? { sentiments } : {}),
    ...(dateRange ? { dateRange } : {})
  };
}

function fingerprintFilters(filters: FilterState): string {
  const normalized = normalizeFiltersState(filters);
  const dateRange = normalized.dateRange;
  return JSON.stringify({
    regions: normalized.regions ?? [],
    topics: normalized.topics ?? [],
    sentiments: normalized.sentiments ?? [],
    from: dateRange?.[0]?.toISOString?.() ?? null,
    to: dateRange?.[1]?.toISOString?.() ?? null
  });
}

function parseDateRangeParam(
  params: ReadonlyURLSearchParams
): { dateRange?: FilterState["dateRange"] } {
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
  baseFilters: FilterState
): FilterState {
  const base = normalizeFiltersState(baseFilters);

  const regions = params.has(ITEMS_FILTER_QUERY_KEYS.region)
    ? normalizeFilterList(params.getAll(ITEMS_FILTER_QUERY_KEYS.region))?.sort((a, b) =>
        a.localeCompare(b)
      )
    : undefined;
  const topics = params.has(ITEMS_FILTER_QUERY_KEYS.topic)
    ? normalizeFilterList(params.getAll(ITEMS_FILTER_QUERY_KEYS.topic))?.sort((a, b) =>
        a.localeCompare(b)
      )
    : undefined;
  const sentiments = params.has(ITEMS_FILTER_QUERY_KEYS.sentiment)
    ? normalizeFilterList(params.getAll(ITEMS_FILTER_QUERY_KEYS.sentiment), {
        lowerCase: true
      })?.sort((a, b) => a.localeCompare(b))
    : undefined;

  const dateOverride = parseDateRangeParam(params).dateRange;

  return {
    ...(base.regions ? { regions: base.regions } : {}),
    ...(base.topics ? { topics: base.topics } : {}),
    ...(base.sentiments ? { sentiments: base.sentiments } : {}),
    ...(base.dateRange ? { dateRange: base.dateRange } : {}),
    ...(regions !== undefined ? { regions } : {}),
    ...(topics !== undefined ? { topics } : {}),
    ...(sentiments !== undefined ? { sentiments } : {}),
    ...(dateOverride ? { dateRange: dateOverride } : {})
  };
}

function applyFiltersToSearchParams(next: URLSearchParams, filters: FilterState | null) {
  next.delete(ITEMS_FILTER_QUERY_KEYS.region);
  next.delete(ITEMS_FILTER_QUERY_KEYS.topic);
  next.delete(ITEMS_FILTER_QUERY_KEYS.sentiment);
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
  dateRange?: ItemsDateRangeInput;
}

type ItemsOrderBy = "CREATED_DESC" | "PUBLISHED_DESC";

interface ItemsQueryVariables {
  first: number;
  after?: string | null;
  page?: number | null;
  search?: string | null;
  filters?: ItemsFiltersInput | null;
  orderBy?: ItemsOrderBy | null;
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
  };
}

interface ItemFacetsQueryVariables {
  search?: string | null;
  filters?: ItemsFiltersInput | null;
}

const ITEMS_QUERY = gql`
  query Items($first: Int!, $after: String, $page: Int, $search: String, $filters: ItemsFiltersInput, $orderBy: ItemsOrderBy) {
    items(first: $first, after: $after, page: $page, search: $search, filters: $filters, orderBy: $orderBy) {
      edges {
        node {
          id
          title
          status
          createdAt
          ingestedAt
          publishedAt
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
    }
  }
`;

function buildFiltersInput(filters: FilterState): ItemsFiltersInput | null {
  const sourceIds = normalizeFilterList(filters.sourceIds);
  const regions = normalizeFilterList(filters.regions);
  const topics = normalizeFilterList(filters.topics);
  const sentiments = normalizeFilterList(filters.sentiments, { lowerCase: true });
  const rangeStart = filters.dateRange?.[0]?.startOf("day");
  const rangeEnd = filters.dateRange?.[1]?.endOf("day");
  const dateRange =
    rangeStart || rangeEnd
      ? {
          ...(rangeStart ? { start: rangeStart.toISOString() } : {}),
          ...(rangeEnd ? { end: rangeEnd.toISOString() } : {})
        }
      : undefined;

  if (!sourceIds && !regions && !topics && !sentiments && !dateRange) {
    return null;
  }

  return {
    ...(sourceIds ? { sourceIds } : {}),
    ...(regions ? { regions } : {}),
    ...(topics ? { topics } : {}),
    ...(sentiments ? { sentiments } : {}),
    ...(dateRange ? { dateRange } : {})
  };
}

type ItemEdge = ItemsQuery["items"]["edges"][number];

const EMPTY_EDGES: ItemEdge[] = [];

type EmptyStateVariant = "default" | "today" | "search";
type ItemsSortMode = "default" | "publishedDesc";

interface ItemsRssTranslationConfig {
  enabled: boolean;
  provider: RssTranslationProvider;
  targetLanguage: string;
  fields?: RssTranslationField[];
}

interface ItemsViewProps {
  initialView?: ItemViewType;
  lockedView?: ItemViewType;
  emptyStateVariant?: EmptyStateVariant;
  sortMode?: ItemsSortMode;
  initialData?: ItemsQuery | null;
  initialFilters?: FilterState;
  fixedSourceIds?: string[];
  rssTranslationConfig?: ItemsRssTranslationConfig;
  onTranslationError?: (message: string | null) => void;
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
}

export function ItemsView({
  initialView = "feed",
  lockedView,
  emptyStateVariant = "default",
  sortMode = "default",
  initialData = null,
  initialFilters = EMPTY_FILTERS_STATE,
  fixedSourceIds,
  rssTranslationConfig,
  onTranslationError
}: ItemsViewProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const timeZone = process.env.NEXT_PUBLIC_TIME_ZONE ?? "Asia/Shanghai";
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const screens = Grid.useBreakpoint();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageCrawl = permissions.includes("crawl.read") || permissions.includes("crawl.write");

  // URL State
  const urlSearch = (searchParams.get("q") ?? "").trim();
  const urlFilters = useMemo(
    () => parseFiltersFromSearchParams(searchParams, initialFilters),
    [initialFilters, searchParams]
  );
  const urlFiltersFingerprint = useMemo(() => fingerprintFilters(urlFilters), [urlFilters]);
  const urlPage = parsePositiveInt(searchParams.get("page"), 1);
  const urlRawPageSize = parsePositiveInt(searchParams.get("pageSize"), DEFAULT_ITEMS_PAGE_SIZE);
  const urlPageSize = clampItemsPageSize(urlRawPageSize);

  // Local State (UI + query source of truth)
  const [searchInput, setSearchInput] = useState(urlSearch);
  const [search, setSearch] = useState(urlSearch);
  const [view, setView] = useState<ItemViewType>(lockedView ?? initialView);
  const [filters, setFilters] = useState<FilterState>(() =>
    parseFiltersFromSearchParams(searchParams, initialFilters)
  );
  const [page, setPage] = useState(urlPage);
  const [pageSize, setPageSize] = useState(urlPageSize);
  const [showFilters, setShowFilters] = useState(false);
  const [showDelayHint, setShowDelayHint] = useState(false);
  const [translatedByItemId, setTranslatedByItemId] = useState<
    Record<string, Omit<RssItemTranslation, "itemId">>
  >({});
  const translationRequestKeyRef = useRef("");
  const listTableContainerRef = useRef<HTMLDivElement | null>(null);
  const [listTableScrollX, setListTableScrollX] = useState<number | null>(null);
  const [listTableScrollY, setListTableScrollY] = useState<number | null>(null);
  const urlFiltersRef = useRef(urlFilters);
  const [translateRssItems] = useMutation<
    TranslateRssItemsMutation,
    TranslateRssItemsMutationVariables
  >(TRANSLATE_RSS_ITEMS_MUTATION);
  const normalizedFixedSourceIds = useMemo(
    () => normalizeFilterList(fixedSourceIds),
    [fixedSourceIds]
  );
  const effectiveFilters = useMemo<FilterState>(() => {
    if (!normalizedFixedSourceIds || normalizedFixedSourceIds.length === 0) {
      return filters;
    }
    return {
      ...filters,
      sourceIds: normalizedFixedSourceIds
    };
  }, [filters, normalizedFixedSourceIds]);

  const updateListTableScroll = useCallback(() => {
    const container = listTableContainerRef.current;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const viewportHeight = window.innerHeight || 0;
    const headerEl = container.querySelector(".ant-table-thead") as HTMLElement | null;
    const paginationEl = container.querySelector(".ant-table-pagination") as HTMLElement | null;

    const headerHeight = headerEl?.getBoundingClientRect().height ?? 0;
    const paginationHeight = paginationEl?.getBoundingClientRect().height ?? 0;

    // `items-view` lives inside the ShellLayout scrolling container. Reserve some padding so the
    // virtualized table doesn't butt up against the bottom of the viewport.
    const bottomPadding = 24;
    const available = viewportHeight - rect.top - bottomPadding;

    const nextScrollY = Math.max(
      ITEMS_TABLE_MIN_BODY_SCROLL_Y,
      Math.floor(available - headerHeight - paginationHeight)
    );
    const nextScrollX = Math.max(ITEMS_TABLE_MIN_SCROLL_X, Math.floor(container.clientWidth));

    setListTableScrollX((prev) => (prev === nextScrollX ? prev : nextScrollX));
    setListTableScrollY((prev) => (prev === nextScrollY ? prev : nextScrollY));
  }, []);

  useEffect(() => {
    if (!lockedView) {
      return;
    }
    setView(lockedView);
  }, [lockedView]);

  useEffect(() => {
    setPage(1);
  }, [normalizedFixedSourceIds]);

  useEffect(() => {
    setTranslatedByItemId({});
    translationRequestKeyRef.current = "";
  }, [
    rssTranslationConfig?.enabled,
    rssTranslationConfig?.provider,
    rssTranslationConfig?.targetLanguage
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

  const debouncedSearchInput = useDebounceValue(searchInput, ITEMS_SEARCH_DEBOUNCE_MS);
  const debouncedFilters = useDebounceValue(filters, ITEMS_FILTERS_URL_DEBOUNCE_MS);
  const debouncedFiltersFingerprint = useMemo(
    () => fingerprintFilters(debouncedFilters),
    [debouncedFilters]
  );

  useEffect(() => {
    const nextSearch = debouncedSearchInput.trim();
    if (nextSearch === search) {
      return;
    }
    setSearch(nextSearch);
    setPage(1);
  }, [debouncedSearchInput, search]);

  const filtersInput = useMemo(() => buildFiltersInput(effectiveFilters), [effectiveFilters]);
  const hasActiveFilters = filtersInput !== null;
  const isUnsearched =
    emptyStateVariant === "search" && search.length === 0 && !hasActiveFilters;
  const listTableScroll =
    typeof listTableScrollX === "number" && typeof listTableScrollY === "number"
      ? {
          x: listTableScrollX,
          y: listTableScrollY,
          scrollToFirstRowOnChange: true
        }
      : undefined;
  const listTableVirtualEnabled = Boolean(listTableScroll);
  const orderBy = useMemo<ItemsOrderBy>(
    () => (sortMode === "publishedDesc" ? "PUBLISHED_DESC" : "CREATED_DESC"),
    [sortMode]
  );

  const setQueryParams = useCallback(
    (updates: {
      q?: string | null;
      page?: number | null;
      pageSize?: number | null;
      filters?: FilterState | null;
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
      const nextQuery = next.toString();
      if (nextQuery === currentQuery) {
        return;
      }
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
    },
    [pathname, router]
  );

  useEffect(() => {
    const currentParams = new URLSearchParams(window.location.search);
    const currentSearch = (currentParams.get("q") ?? "").trim();
    const currentSearchParam = currentSearch.length > 0 ? currentSearch : null;
    const currentFiltersFingerprint = fingerprintFilters(
      parseFiltersFromSearchParams(
        currentParams as unknown as ReadonlyURLSearchParams,
        initialFilters
      )
    );

    const nextSearchParam = search.length > 0 ? search : null;

    const shouldUpdateSearch = nextSearchParam !== currentSearchParam;
    const shouldUpdateFilters = debouncedFiltersFingerprint !== currentFiltersFingerprint;

    if (!shouldUpdateSearch && !shouldUpdateFilters) {
      return;
    }

    setQueryParams({
      ...(shouldUpdateSearch ? { q: nextSearchParam } : {}),
      ...(shouldUpdateFilters ? { filters: debouncedFilters } : {}),
      page: 1
    });
  }, [
    debouncedFilters,
    debouncedFiltersFingerprint,
    initialFilters,
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

  const handleFilterChange = useCallback(
    (nextFilters: FilterState) => {
      const normalized = normalizeFiltersState(nextFilters);
      setFilters(normalized);
      setPage(1);
    },
    []
  );

  const {
    data,
    loading,
    error,
    refetch
  } = useQuery<ItemsQuery, ItemsQueryVariables>(ITEMS_QUERY, {
    skip: isUnsearched,
    variables: {
      first: pageSize,
      after: null,
      page,
      search: search || null,
      filters: filtersInput,
      orderBy
    },
    notifyOnNetworkStatusChange: true
  });

  const { data: facetsData } = useQuery<ItemFacetsQuery, ItemFacetsQueryVariables>(ITEM_FACETS_QUERY, {
    variables: {
      search: search || null,
      filters: filtersInput
    },
    fetchPolicy: "cache-and-network"
  });

  useEffect(() => {
    if (!loading) {
      setShowDelayHint(false);
      return;
    }
    const timeout = setTimeout(() => setShowDelayHint(true), 1200);
    return () => clearTimeout(timeout);
  }, [loading]);

  const resolvedData =
    isUnsearched
      ? undefined
      : data ??
        (filtersInput === null ? initialData ?? undefined : undefined);
  const edges = resolvedData?.items.edges ?? EMPTY_EDGES;
  const resolvedTotalCount = resolvedData?.items.totalCount;
  const totalCount = typeof resolvedTotalCount === "number" ? resolvedTotalCount : 0;
  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (filtersInput?.sourceIds?.length) {
      parts.push(
        `${t("pages.rss.sourceLabel", { defaultValue: "RSS Sources" })}: ${filtersInput.sourceIds.length.toLocaleString(locale)}`
      );
    }
    if (filtersInput?.regions?.length) {
      parts.push(
        `${t("items.filters.region", { defaultValue: "Region" })}: ${filtersInput.regions.length.toLocaleString(locale)}`
      );
    }
    if (filtersInput?.topics?.length) {
      parts.push(
        `${t("items.filters.topic", { defaultValue: "Topic" })}: ${filtersInput.topics.length.toLocaleString(locale)}`
      );
    }
    if (filtersInput?.sentiments?.length) {
      parts.push(
        `${t("items.filters.sentiment", { defaultValue: "Sentiment" })}: ${filtersInput.sentiments.length.toLocaleString(locale)}`
      );
    }
    if (filtersInput?.dateRange) {
      parts.push(`${t("items.filters.date", { defaultValue: "Date Range" })}: 1`);
    }
    return {
      parts,
      text: parts.join(" | ")
    };
  }, [filtersInput, locale, t]);

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
  }, [error, isUnsearched, loading, page, pageSize, resolvedTotalCount, setQueryParams]);

  const basePageData = useMemo<ParsedItem[]>(() => {
    return edges.map((edge) => {
      const processed = edge.node.processedPreview;
      const raw = edge.node.rawPreview;
      const summary = resolveDisplaySummary({
        processedSummary: processed?.summary,
        rawSummary: raw?.summary
      });
      const sentiment =
        toNonEmptyString(processed?.sentiment) ?? toNonEmptyString(raw?.sentiment) ?? undefined;
      const region = toNonEmptyString(raw?.region) ?? undefined;
      const location =
        toNonEmptyString(processed?.location) ?? toNonEmptyString(raw?.location) ?? undefined;
      const ticker = toNonEmptyString(raw?.ticker) ?? undefined;
      const price =
        typeof raw?.price === "number" && Number.isFinite(raw.price) ? raw.price : undefined;
      const change =
        typeof raw?.changePercent === "number" && Number.isFinite(raw.changePercent)
          ? raw.changePercent
          : undefined;
      const history = Array.isArray(raw?.history)
        ? raw.history
            .map((point) => {
              const timestamp = typeof point?.timestamp === "string" ? point.timestamp.trim() : "";
              const value =
                typeof point?.value === "number" && Number.isFinite(point.value)
                  ? point.value
                  : null;
              if (!timestamp || value === null) {
                return null;
              }
              return { timestamp, value };
            })
            .filter((point): point is { timestamp: string; value: number } => Boolean(point))
        : undefined;
      const url = safeHttpUrl(raw?.url) ?? undefined;
      const thumbnail = safeHttpUrl(raw?.thumbnail) ?? undefined;

      const publishedAt =
        toNonEmptyString(edge.node.publishedAt) ??
        toNonEmptyString(processed?.publishedAt) ??
        undefined;
      const ingestedAt = dayjs(edge.node.ingestedAt ?? edge.node.createdAt).toISOString();
      const topics = Array.from(
        new Set(
          (processed?.topics ?? [])
            .map((topic) => topic.trim())
            .filter((topic) => topic.length > 0)
        )
      );
      const entities = Array.from(
        new Set(
          (processed?.entities ?? [])
            .map((entity) => entity.trim())
            .filter((entity) => entity.length > 0)
        )
      );
      const source =
        toNonEmptyString(processed?.source) ?? toNonEmptyString(raw?.sourceName) ?? undefined;
      const displayTitle = resolveDisplayTitle({
        processedTitle: processed?.title,
        itemTitle: edge.node.title,
        source,
        originalUrl: raw?.url
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
        language: toNonEmptyString(processed?.language) ?? undefined,
        topics,
        entities,
        region,
        qualityScore: typeof processed?.qualityScore === "number" ? processed.qualityScore : undefined,
        duplicateSimilarity:
          typeof processed?.duplicateSimilarity === "number"
            ? processed.duplicateSimilarity
            : undefined,
        duplicateOf: processed?.duplicateOf ?? null,
        llm: processed?.llm ?? undefined,
        url: url ?? undefined,
        location,
        eventId: processed?.eventId ?? null
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

    const targetLanguage = rssTranslationConfig.targetLanguage?.trim() || "zh-CN";
    const provider = rssTranslationConfig.provider;
    const fields = normalizeRssTranslationFields(rssTranslationConfig.fields);
    const itemIds = basePageData.map((item) => item.id);

    const requestKey = JSON.stringify({ provider, targetLanguage, fields, itemIds });
    if (translationRequestKeyRef.current === requestKey) {
      return;
    }
    translationRequestKeyRef.current = requestKey;

    translateRssItems({
      variables: {
        input: {
          itemIds,
          provider,
          targetLanguage,
          fields
        }
      }
    })
      .then((response) => {
        onTranslationError?.(null);
        const translations = response.data?.translateRssItems.translations ?? [];
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
              ...(entry.cleanedMarkdown ? { cleanedMarkdown: entry.cleanedMarkdown } : {})
            };
          });
          return next;
        });
      })
      .catch((err) => {
        translationRequestKeyRef.current = "";
        const message = err instanceof Error ? err.message : "Translation failed";
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
    translateRssItems
  ]);

  const pageData = useMemo<ParsedItem[]>(() => {
    if (!rssTranslationConfig?.enabled) {
      return basePageData;
    }
    if (Object.keys(translatedByItemId).length === 0) {
      return basePageData;
    }
    return basePageData.map((item) => {
      const translated = translatedByItemId[item.id];
      if (!translated) {
        return item;
      }
      const title = toNonEmptyString(translated.title) ?? item.title;
      const summary = toNonEmptyString(translated.summary) ?? item.summary;
      return {
        ...item,
        title,
        name: title,
        summary
      };
    });
  }, [basePageData, rssTranslationConfig?.enabled, translatedByItemId]);

  useEffect(() => {
    if (view !== "list") {
      return;
    }
    updateListTableScroll();
  }, [error, hasActiveFilters, pageData.length, search, updateListTableScroll, view]);

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
      .flatMap((item) => [
        ...(item.topics ?? []),
      ])
      .filter((value): value is string => Boolean(value));
    return Array.from(new Set(fallback));
  }, [facetsData, pageData]);

  const availableSentiments = useMemo(() => {
    const sentiments = facetsData?.itemFacets?.sentiments;
    if (!sentiments || sentiments.length === 0) {
      return [];
    }
    const allowed = new Set(["positive", "neutral", "negative"]);
    const values = sentiments
      .map((sentiment) => sentiment.value.trim().toLowerCase())
      .filter((value) => value.length > 0 && allowed.has(value));
    return Array.from(new Set(values));
  }, [facetsData]);

  useEffect(() => {
    if (availableSentiments.length > 0) {
      return;
    }
    if (!filters.sentiments || filters.sentiments.length === 0) {
      return;
    }
    handleFilterChange({ ...filters, sentiments: undefined });
  }, [availableSentiments.length, filters, handleFilterChange]);

  const emptyStateConfig = useMemo(() => {
    if (emptyStateVariant === "today") {
      const action = canManageCrawl
        ? {
            label: t("items.empty.todayActionAdmin", { defaultValue: "Manage crawl tasks" }),
            href: "/admin/ops/crawl-tasks"
          }
        : {
            label: t("items.empty.todayActionSubscriber", {
              defaultValue: "Manage subscriptions"
            }),
            href: "/subscriptions"
          };
      return {
        title: t("items.empty.todayTitle", { defaultValue: "No news in this window" }),
        description: t("items.empty.todayDescription", {
          defaultValue: "Try adjusting filters or check back later."
        }),
        actionLabel: action.label,
        actionHref: action.href
      };
    }

    if (emptyStateVariant === "search") {
      if (isUnsearched) {
        return {
          title: t("items.empty.searchIdleTitle", { defaultValue: "Start searching" }),
          description: t("items.empty.searchIdleDescription", {
            defaultValue: "Enter keywords or adjust filters to search processed items."
          })
        };
      }
      return {
        title: t("items.empty.searchTitle", { defaultValue: "No results" }),
        description: t("items.empty.searchDescription", {
          defaultValue: "Try adjusting your keywords or filters."
        })
      };
    }

    return {
      title: t("items.empty.defaultTitle", { defaultValue: "No items found" }),
      description: t("items.empty.defaultDescription", {
        defaultValue: "Try adjusting filters or refresh."
      })
    };
  }, [canManageCrawl, emptyStateVariant, isUnsearched, t]);

  const handlePaginationChange = useCallback(
    (nextPage: number, nextPageSize?: number) => {
      const { page: normalizedPage, pageSize: normalizedPageSize } = normalizeItemsPaginationChange({
        nextPage,
        nextPageSize,
        currentPageSize: pageSize,
        totalCount: resolvedTotalCount
      });

      setPage(normalizedPage);
      setPageSize(normalizedPageSize);
      setQueryParams({
        page: normalizedPage,
        pageSize: normalizedPageSize
      });
    },
    [pageSize, resolvedTotalCount, setQueryParams]
  );

  const handleTableChange = (pager: TablePaginationConfig) => {
    handlePaginationChange(pager.current ?? 1, pager.pageSize);
  };

  const handleSearch = (value: string) => {
    const nextValue = value.trim();
    setSearchInput(nextValue);
    setSearch(nextValue);
    setPage(1);
    setQueryParams({
      q: nextValue || null,
      page: 1
    });
  };

  const columns = useMemo<ColumnsType<ParsedItem>>(
    () => [
      {
        title: t("items.columns.name", { defaultValue: "Title" }),
        dataIndex: "name",
        key: "name",
        ellipsis: true
      },
      {
        title: t("items.columns.source", { defaultValue: "Source" }),
        dataIndex: "source",
        key: "source",
        width: 120,
        render: (value: string | undefined) => value ?? t("common.notAvailable")
      },
      {
        title: t("items.columns.time", { defaultValue: "Time" }),
        dataIndex: "publishedAt",
        key: "publishedAt",
        width: 240,
        render: (_: string | undefined, record) => {
          const publishedLabel = t("items.time.published", { defaultValue: "Published" });
          const ingestedLabel = t("items.time.ingested", { defaultValue: "Ingested" });
          const ingestedAt = record.ingestedAt ?? record.createdAt;
          return (
            <Space direction="vertical" size={0}>
              <Typography.Text>
                {publishedLabel}:{" "}
                {record.publishedAt
                  ? formatDateTime(record.publishedAt, locale, {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone,
                      timeZoneName: "short"
                    })
                  : t("common.notAvailable")}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {ingestedLabel}:{" "}
                {formatDateTime(ingestedAt, locale, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone,
                  timeZoneName: "short"
                })}
              </Typography.Text>
            </Space>
          );
        }
      },
      {
        title: withMetricTooltip(
          t("items.columns.quality", { defaultValue: "Quality" }),
          t("items.metrics.quality.tooltip", {
            defaultValue: "Quality score from LLM cleaning stage (0–1, shown as %)."
          })
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
              <div>
                {t("items.metrics.quality.tooltip", {
                  defaultValue: "Quality score from LLM cleaning stage (0–1, shown as %)."
                })}
              </div>
              {record.llm?.model ? <div>Model: {record.llm.model}</div> : null}
              {record.llm?.promptVersion ? <div>Prompt: {record.llm.promptVersion}</div> : null}
            </div>
          );

          return (
            <Tooltip title={tooltip}>
              <Tag color="blue">{formatted}</Tag>
            </Tooltip>
          );
        }
      },
      {
        title: withMetricTooltip(
          t("items.columns.duplicate", { defaultValue: "Duplicate" }),
          t("items.metrics.duplicate.tooltip", {
            defaultValue: "Duplicate similarity from dedup stage (0–1, shown as %)."
          })
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
            ? t("items.duplicate.duplicate", { defaultValue: "Duplicate" })
            : t("items.duplicate.similarity", { defaultValue: "Similarity" });

          const tooltip = (
            <div className="text-xs">
              <div>
                {t("items.metrics.duplicate.tooltip", {
                  defaultValue: "Duplicate similarity from dedup stage (0–1, shown as %)."
                })}
              </div>
              {record.duplicateOf ? <div>Duplicate of: {record.duplicateOf}</div> : null}
            </div>
          );

          return (
            <Tooltip title={tooltip}>
              <Tag color="gold">
                {label} {formatted}
              </Tag>
            </Tooltip>
          );
        }
      },
      {
        title: t("items.columns.open", { defaultValue: "Open" }),
        key: "open",
        width: 100,
        render: (_: unknown, record) => (
          <Button
            type="link"
            size="small"
            onClick={() => router.push(`/items/${record.id}`)}
            className="px-0"
          >
            {t("items.detail.openItem", { defaultValue: "Open item" })}
          </Button>
        )
      }
    ],
    [locale, router, t, timeZone]
  );

  const renderContent = () => {
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
              title={t("common.loadingDelayedTitle", { defaultValue: "Still loading…" })}
              description={t("common.loadingDelayed", {
                defaultValue: "Data is taking longer than usual. Please hold on or refresh."
              })}
            />
          ) : null}
        </Space>
      );
    }

    if (error && pageData.length === 0) {
      const emptyState = buildRequestErrorEmptyState({ t, error, onRetry: () => refetch() });
      return (
        <ChartEmptyState
          className="h-auto"
          {...emptyState}
        />
      );
    }

    if (!loading && pageData.length === 0) {
      const isFiltered = Boolean(search.length > 0 || hasActiveFilters);
      const filteredDescription = isFiltered ? (
        <div className="flex flex-col items-center gap-1">
          <span>
            {t("items.empty.filteredDescription", {
              defaultValue: "No items match the current search or filters."
            })}
          </span>
          {search ? (
            <span className="font-mono text-[10px] opacity-80">
              {t("items.stats.query", { defaultValue: "Query" })}: {search}
            </span>
          ) : null}
          {filterSummary.text ? (
            <span className="font-mono text-[10px] opacity-80">{filterSummary.text}</span>
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
      <RequestErrorBanner
        error={error}
        onRetry={() => void refetch()}
        showCachedDataHint
      />
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
	              virtual={listTableVirtualEnabled}
	              scroll={listTableScroll}
	              pagination={{
	                current: page,
	                pageSize,
	                total: totalCount,
	                showSizeChanger: true,
	                pageSizeOptions: ITEMS_PAGE_SIZE_OPTIONS_STRINGS
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
              onShowSizeChange: handlePaginationChange
            }}
            renderItem={(item) => (
              <List.Item key={item.id}>
                {/* Naive heuristic to choose card type: if it has price/ticker, assume financial */}
                {item.price !== undefined || item.ticker ? (
                  <FinancialCard item={item} />
                ) : (
                  <NewsCard
                    item={{
                      ...item,
                      publishedAt: item.publishedAt,
                      ingestedAt: item.ingestedAt,
                      topics: item.topics,
                      entities: item.entities,
                      qualityScore: item.qualityScore,
                      duplicateSimilarity: item.duplicateSimilarity,
                      duplicateOf: item.duplicateOf,
                      llm: item.llm,
                      url: item.url
                    }}
                  />
                )}
              </List.Item>
            )}
          />
        </Space>
      );
    }

    if (view === "feed") {
      return (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {errorBanner}
          <List
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
              onShowSizeChange: handlePaginationChange
            }}
            renderItem={(item) => (
              <List.Item key={item.id}>
                <NewsCard
                  item={{
                    ...item,
                    publishedAt: item.publishedAt,
                    ingestedAt: item.ingestedAt,
                    topics: item.topics,
                    entities: item.entities,
                    qualityScore: item.qualityScore,
                    duplicateSimilarity: item.duplicateSimilarity,
                    duplicateOf: item.duplicateOf,
                    llm: item.llm,
                    url: item.url
                  }}
                />
              </List.Item>
            )}
          />
        </Space>
      );
    }
    
    return null;
  };

  return (
    <div className="content-card" style={{ padding: "24px" }}>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        
        {/* Header Controls */}
        <Row justify="space-between" align="middle" gutter={[16, 16]}>
           <Col flex="auto">
             <Space>
                <Space.Compact>
                  <Input
                    id="items-search"
                    name="itemsSearch"
                    placeholder={t("items.search.placeholder")}
                    allowClear
                    value={searchInput}
                    onChange={(event) => {
                      const value = event.target.value;
                      setSearchInput(value);
                      if (!value) {
                        setSearch("");
                        setPage(1);
                        setQueryParams({ q: null, page: 1 });
                      }
                    }}
                    onPressEnter={() => handleSearch(searchInput)}
                  />
                  <Button
                    icon={<SearchOutlined />}
                    aria-label={t("items.search.placeholder")}
                    onClick={() => handleSearch(searchInput)}
                  />
                </Space.Compact>
                {!screens.lg && (
                    <Button onClick={() => setShowFilters(true)}>
                        {t("items.filters.button", { defaultValue: "Filters" })}
                    </Button>
                )}
             </Space>
           </Col>
           <Col>
              <Space>
                {!lockedView ? <ViewSwitcher view={view} onChange={setView} /> : null}
                <Button onClick={() => refetch()} loading={loading} disabled={isUnsearched}>
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
                  {t("items.stats.query", { defaultValue: "Query" })}: {search}
                </Tag>
              </Tooltip>
            ) : null}
            {filterSummary.text ? (
              <Tooltip title={filterSummary.text}>
                <Tag className="text-xs" color="purple">
                  {t("items.stats.filters", { defaultValue: "Filters" })}: {filterSummary.text}
                </Tag>
              </Tooltip>
            ) : null}
            <Tag className="text-xs">
              {t("items.stats.matches", { defaultValue: "Matches" })}:{" "}
              {typeof resolvedTotalCount === "number"
                ? totalCount.toLocaleString(locale)
                : t("common.loading", { defaultValue: "Loading..." })}
            </Tag>
            {showingRange ? (
              <Tag className="text-xs">
                {t("items.stats.showing", {
                  from: showingRange.from,
                  to: showingRange.to,
                  total: totalCount,
                  defaultValue: "Showing {{from}}-{{to}} of {{total}}"
                })}
              </Tag>
            ) : null}
          </div>
        ) : null}

        {/* Main Layout */}
        <Row gutter={24}>
           {screens.lg && (
             <Col flex="280px">
                <FacetedSearch
                  filters={filters}
                  onFilterChange={handleFilterChange}
                  regions={availableRegions}
                  topics={availableTopics}
                  sentiments={availableSentiments}
                />
              </Col>
           )}
           <Col flex="auto">
              {renderContent()}
           </Col>
        </Row>

      </Space>

      <Drawer
        title={t("items.filters.title", { defaultValue: "Filters" })}
        placement="right"
        onClose={() => setShowFilters(false)}
        open={showFilters}
      >
         <FacetedSearch
           filters={filters}
           onFilterChange={handleFilterChange}
           regions={availableRegions}
           topics={availableTopics}
           sentiments={availableSentiments}
         />
      </Drawer>
    </div>
  );
}
