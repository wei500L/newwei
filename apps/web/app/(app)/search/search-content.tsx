"use client";

import {
  BulbOutlined,
  CalendarOutlined,
  HistoryOutlined,
} from "@ant-design/icons";
import { gql, useQuery } from "@apollo/client";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Segmented,
  Select,
  Skeleton,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { Dayjs } from "dayjs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { ItemsView } from "@/app/(app)/items/items-view";
import { AnnotationPanel } from "@/components/analysis/annotation-panel";
import { AnalysisToolbar } from "@/components/analysis/analysis-toolbar";
import {
  EnhancedSearchBox,
  type SearchSuggestionStatus,
} from "@/components/enhanced-search-box";
import { useItemFacetsQuery } from "@/graphql/generated";
import dayjs from "@/lib/dayjs";
import { parseSearchHistory, SEARCH_HISTORY_KEY } from "@/lib/search-history";
import { trackSearchTelemetry } from "@/lib/search-telemetry";

import {
  formatSelectedDateParam,
  parseDateParamUtc,
} from "../events-archive/events-archive-helpers";

import {
  buildGuidedSearchHref,
  shouldResetStaleSearchQuery,
} from "./search-hot-topic-query";

const SEARCH_GUIDANCE_HISTORY_LIMIT = 8;
const QUERY_TAG_MAX_LENGTH = 28;
const HEADLINES_PAGE_SIZE = 6;
const MIN_HEADLINES_QUERY_LENGTH = 2;

type SearchMode = "items" | "headlines";
type ArchiveRegion =
  | "APAC"
  | "MIDDLE_EAST"
  | "AMERICAS"
  | "EUROPE"
  | "AFRICA"
  | "OTHER";
type ArchiveVertical =
  | "EAST_SEA"
  | "SOUTH_SEA"
  | "WEST_FRONT"
  | "FOREIGN_AFFAIRS"
  | "DOMESTIC_AFFAIRS";
type ArchiveWeight = "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";
type ArchiveMatchOrigin = "LEXICAL" | "SEMANTIC" | "HYBRID";

interface ParsedSearchQuery {
  remainingText?: string;
  topic?: string;
  region?: string;
  sentiment?: string;
  from?: string;
  to?: string;
  source?: string;
}

interface ArchiveEventItem {
  processedArticleId: string;
  eventId?: string | null;
  title?: string | null;
  summary?: string | null;
  countryLabel?: string | null;
  region: ArchiveRegion;
  vertical: ArchiveVertical;
  weight: number;
  qualityScore?: number | null;
  publishedAt?: string | null;
  sortAt: string;
  sourceLabel?: string | null;
  sourceUrl?: string | null;
  entityTags: string[];
  keywordHighlights: string[];
  matchOrigin?: ArchiveMatchOrigin | null;
  relevanceScore?: number | null;
}

interface ArchiveVerticalGroup {
  vertical: ArchiveVertical;
  displayName: string;
  totalCount: number;
  items: ArchiveEventItem[];
  pageInfo: {
    hasMore: boolean;
    nextCursor?: string | null;
  };
}

interface ArchiveDigestData {
  anchorDate: string;
  region: ArchiveRegion;
  totalCount: number;
  groups: ArchiveVerticalGroup[];
}

const DEFAULT_MODE: SearchMode = "items";
const DEFAULT_ARCHIVE_REGION: ArchiveRegion = "APAC";
const DEFAULT_ARCHIVE_WEIGHTS = [5, 4, 3, 2, 1];
const ARCHIVE_REGION_OPTIONS: ArchiveRegion[] = [
  "APAC",
  "MIDDLE_EAST",
  "AMERICAS",
  "EUROPE",
  "AFRICA",
  "OTHER",
];
const MATCH_ORIGIN_COLOR: Record<ArchiveMatchOrigin, string> = {
  LEXICAL: "blue",
  SEMANTIC: "purple",
  HYBRID: "geekblue",
};

const ARCHIVE_DIGEST_QUERY = gql`
  query SearchArchiveDigest($input: ArchiveQueryInput!) {
    archiveDigest(input: $input) {
      anchorDate
      region
      totalCount
      groups {
        vertical
        displayName
        totalCount
        pageInfo {
          hasMore
          nextCursor
        }
        items {
          processedArticleId
          eventId
          title
          summary
          countryLabel
          region
          vertical
          weight
          qualityScore
          publishedAt
          sortAt
          sourceLabel
          sourceUrl
          entityTags
          keywordHighlights
          matchOrigin
          relevanceScore
        }
      }
    }
  }
`;

const parseSearchMode = (value: string | null): SearchMode => {
  if (value === "headlines") {
    return "headlines";
  }
  return DEFAULT_MODE;
};

const parseArchiveRegion = (value: string | null): ArchiveRegion => {
  if (!value) {
    return DEFAULT_ARCHIVE_REGION;
  }
  const matched = ARCHIVE_REGION_OPTIONS.find((option) => option === value);
  return matched ?? DEFAULT_ARCHIVE_REGION;
};

const parseArchiveWeights = (value: string | null) => {
  if (!value) {
    return DEFAULT_ARCHIVE_WEIGHTS;
  }
  const parsed = value
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry) && entry >= 1 && entry <= 5);
  if (parsed.length === 0) {
    return DEFAULT_ARCHIVE_WEIGHTS;
  }
  return Array.from(new Set(parsed)).sort((a, b) => b - a);
};

const weightToEnum = (value: number): ArchiveWeight | null => {
  if (value === 1) return "ONE";
  if (value === 2) return "TWO";
  if (value === 3) return "THREE";
  if (value === 4) return "FOUR";
  if (value === 5) return "FIVE";
  return null;
};

const toArchiveAnchorIso = (date: string) => `${date}T00:00:00.000Z`;

const resolveMatchOriginLabel = (
  origin: ArchiveMatchOrigin,
  t: ReturnType<typeof useTranslation>["t"],
) => {
  if (origin === "HYBRID") {
    return t("pages.search.archive.originHybrid", {
      defaultValue: "混合",
    });
  }
  if (origin === "SEMANTIC") {
    return t("pages.search.archive.originSemantic", {
      defaultValue: "语义",
    });
  }
  return t("pages.search.archive.originLexical", {
    defaultValue: "词法",
  });
};

const stripSearchFilterParams = (params: URLSearchParams) => {
  params.delete("q");
  params.delete("topic");
  params.delete("region");
  params.delete("sentiment");
  params.delete("from");
  params.delete("to");
  params.delete("source");
  params.delete("page");
};

export function SearchContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [suggestionStatus, setSuggestionStatus] =
    useState<SearchSuggestionStatus | null>(null);
  const [loadingMoreByVertical, setLoadingMoreByVertical] = useState<
    Partial<Record<ArchiveVertical, boolean>>
  >({});
  const savedViewId = useMemo(() => {
    const value = searchParams.get("savedView")?.trim();
    return value ? value : null;
  }, [searchParams]);

  const query = (searchParams.get("q") ?? "").trim();
  const [searchInput, setSearchInput] = useState(query);

  const mode = useMemo(
    () => parseSearchMode(searchParams.get("mode")),
    [searchParams],
  );
  const archiveDate = useMemo(
    () => parseDateParamUtc(searchParams.get("archiveDate")),
    [searchParams],
  );
  const archiveRegion = useMemo(
    () => parseArchiveRegion(searchParams.get("archiveRegion")),
    [searchParams],
  );
  const archiveWeights = useMemo(
    () => parseArchiveWeights(searchParams.get("archiveWeights")),
    [searchParams],
  );
  const todayArchiveDate = useMemo(() => parseDateParamUtc(null), []);

  const shouldShowHotTopics = query.length === 0;
  const isHeadlinesQueryTooShort =
    mode === "headlines" &&
    query.length > 0 &&
    query.length < MIN_HEADLINES_QUERY_LENGTH;
  const archiveSearchQuery = isHeadlinesQueryTooShort ? "" : query;
  const rankingParam = (searchParams.get("ranking") ?? "").trim().toLowerCase();
  const activeRankingMode =
    query.length > 0
      ? rankingParam === "recency"
        ? "recency"
        : "relevance"
      : null;
  const queryPreview =
    query.length > QUERY_TAG_MAX_LENGTH
      ? `${query.slice(0, QUERY_TAG_MAX_LENGTH - 1)}…`
      : query;
  const hasSemanticSuggestions =
    (suggestionStatus?.semanticCount ?? 0) +
      (suggestionStatus?.hybridCount ?? 0) >
    0;
  const hasSuggestionPrefix = (suggestionStatus?.prefix ?? "").length > 0;

  const archiveWeightEnums = useMemo(
    () =>
      archiveWeights
        .map((value) => weightToEnum(value))
        .filter((value): value is ArchiveWeight => Boolean(value)),
    [archiveWeights],
  );

  const archiveDigestInput = useMemo(
    () => ({
      anchorDate: toArchiveAnchorIso(archiveDate),
      region: archiveRegion,
      ...(archiveSearchQuery ? { search: archiveSearchQuery } : {}),
      weights: archiveWeightEnums,
      pageSize: HEADLINES_PAGE_SIZE,
    }),
    [archiveDate, archiveRegion, archiveWeightEnums, archiveSearchQuery],
  );

  const {
    data: archiveDigestData,
    loading: archiveDigestLoading,
    error: archiveDigestError,
    refetch: refetchArchiveDigest,
    fetchMore: fetchMoreArchiveDigest,
  } = useQuery<{ archiveDigest: ArchiveDigestData }>(ARCHIVE_DIGEST_QUERY, {
    variables: { input: archiveDigestInput },
    skip: mode !== "headlines",
    fetchPolicy: "network-only",
  });

  const {
    data: facetsData,
    loading: hotTopicsLoading,
    error: hotTopicsError,
  } = useItemFacetsQuery({
    variables: {
      search: null,
      filters: null,
    },
    fetchPolicy: "cache-and-network",
    skip: !shouldShowHotTopics,
  });

  const hotTopics = useMemo(
    () => (facetsData?.itemFacets?.topics ?? []).slice(0, 8),
    [facetsData],
  );

  const regionOptions = useMemo(
    () =>
      ARCHIVE_REGION_OPTIONS.map((value) => ({
        value,
        label: t(`pages.eventsArchive.regions.${value}`, {
          defaultValue: value,
        }),
      })),
    [t],
  );
  const archiveWeightOptions = useMemo(
    () =>
      [5, 4, 3, 2, 1].map((value) => ({
        value,
        label: t(
          `pages.eventsArchive.weights.${weightToEnum(value) ?? "ONE"}`,
          {
            defaultValue: `${"★".repeat(value)} ${value}`,
          },
        ),
      })),
    [t],
  );
  const isDefaultArchiveWeights = useMemo(
    () =>
      archiveWeights.length === DEFAULT_ARCHIVE_WEIGHTS.length &&
      archiveWeights.every(
        (value, index) => value === DEFAULT_ARCHIVE_WEIGHTS[index],
      ),
    [archiveWeights],
  );

  const archiveDigest = archiveDigestData?.archiveDigest;
  const archiveTotalCount = archiveDigest?.totalCount ?? 0;

  const fullArchiveHref = useMemo(() => {
    const params = new URLSearchParams();
    params.set("date", archiveDate);
    if (archiveRegion !== DEFAULT_ARCHIVE_REGION) {
      params.set("region", archiveRegion);
    }
    if (!isDefaultArchiveWeights) {
      params.set("weights", archiveWeights.join(","));
    }
    if (query) {
      params.set("q", query);
    }
    const queryString = params.toString();
    return queryString ? `/events-archive?${queryString}` : "/events-archive";
  }, [
    archiveDate,
    archiveRegion,
    archiveWeights,
    isDefaultArchiveWeights,
    query,
  ]);

  useEffect(() => {
    setSearchInput(query);
  }, [query]);

  useEffect(() => {
    setLoadingMoreByVertical({});
  }, [archiveDate, archiveRegion, archiveWeights, archiveSearchQuery, mode]);

  useEffect(() => {
    if (mode !== "headlines" || query.length === 0) {
      return;
    }
    if (query.length < MIN_HEADLINES_QUERY_LENGTH) {
      void trackSearchTelemetry({
        eventType: "archive_query_too_short",
        surface: "search_page",
        queryLength: query.length,
      });
      return;
    }
    void trackSearchTelemetry({
      eventType: "archive_search_submit",
      surface: "search_page",
      queryLength: query.length,
    });
  }, [mode, query]);

  useEffect(() => {
    if (!shouldResetStaleSearchQuery(query, searchInput)) {
      return;
    }
    const next = new URLSearchParams(searchParams.toString());
    stripSearchFilterParams(next);
    const queryString = next.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname);
  }, [pathname, query, router, searchInput, searchParams]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SEARCH_HISTORY_KEY);
      setRecentSearches(
        parseSearchHistory(saved, SEARCH_GUIDANCE_HISTORY_LIMIT),
      );
    } catch {
      setRecentSearches([]);
    }
  }, [shouldShowHotTopics]);

  const pushWithParams = useCallback(
    (next: URLSearchParams) => {
      const queryString = next.toString();
      router.push(queryString ? `${pathname}?${queryString}` : pathname);
    },
    [pathname, router],
  );

  const executeGuidedSearch = useCallback(
    (keyword: string) => {
      const trimmedKeyword = keyword.trim();
      if (!trimmedKeyword) {
        return;
      }
      setSearchInput(trimmedKeyword);
      router.push(
        buildGuidedSearchHref(
          pathname,
          new URLSearchParams(searchParams.toString()),
          trimmedKeyword,
        ),
      );
    },
    [pathname, router, searchParams],
  );

  const updateMode = useCallback(
    (nextMode: SearchMode) => {
      const next = new URLSearchParams(searchParams.toString());
      if (nextMode === DEFAULT_MODE) {
        next.delete("mode");
      } else {
        next.set("mode", nextMode);
      }
      next.delete("page");
      pushWithParams(next);
    },
    [pushWithParams, searchParams],
  );

  const updateArchiveParams = useCallback(
    (updates: {
      date?: string;
      region?: ArchiveRegion;
      weights?: number[];
    }) => {
      const nextDate = updates.date ?? archiveDate;
      const nextRegion = updates.region ?? archiveRegion;
      const nextWeights = (updates.weights ?? archiveWeights)
        .filter((value) => Number.isFinite(value) && value >= 1 && value <= 5)
        .sort((a, b) => b - a);

      const next = new URLSearchParams(searchParams.toString());
      if (nextDate === todayArchiveDate) {
        next.delete("archiveDate");
      } else {
        next.set("archiveDate", nextDate);
      }

      if (nextRegion === DEFAULT_ARCHIVE_REGION) {
        next.delete("archiveRegion");
      } else {
        next.set("archiveRegion", nextRegion);
      }

      const normalizedWeights =
        nextWeights.length > 0 ? nextWeights : DEFAULT_ARCHIVE_WEIGHTS;
      const keepDefaultWeights =
        normalizedWeights.length === DEFAULT_ARCHIVE_WEIGHTS.length &&
        normalizedWeights.every(
          (value, index) => value === DEFAULT_ARCHIVE_WEIGHTS[index],
        );
      if (keepDefaultWeights) {
        next.delete("archiveWeights");
      } else {
        next.set("archiveWeights", normalizedWeights.join(","));
      }

      next.delete("page");
      pushWithParams(next);
    },
    [
      archiveDate,
      archiveRegion,
      archiveWeights,
      pushWithParams,
      searchParams,
      todayArchiveDate,
    ],
  );

  const handleSearchSubmit = useCallback(
    (submittedQuery: string, parsed: ParsedSearchQuery) => {
      const next = new URLSearchParams(searchParams.toString());
      stripSearchFilterParams(next);
      if (parsed.remainingText) {
        next.set("q", parsed.remainingText);
      }
      if (parsed.topic) {
        next.set("topic", parsed.topic);
      }
      if (parsed.region) {
        next.set("region", parsed.region);
      }
      if (parsed.sentiment) {
        next.set("sentiment", parsed.sentiment);
      }
      if (parsed.from) {
        next.set("from", parsed.from);
      }
      if (parsed.to) {
        next.set("to", parsed.to);
      }
      if (parsed.source) {
        next.set("source", parsed.source);
      }
      pushWithParams(next);
      setSearchInput(submittedQuery);
    },
    [pushWithParams, searchParams],
  );

  const handleTopicClick = (topic: string) => {
    executeGuidedSearch(topic);
  };

  const handleRecentSearchClear = () => {
    try {
      localStorage.removeItem(SEARCH_HISTORY_KEY);
    } catch {
      // Ignore localStorage errors.
    }
    setRecentSearches([]);
  };

  const handleTagKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    value: string,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    executeGuidedSearch(value);
  };

  const archiveSelectedDate = useMemo(
    () => dayjs.utc(`${archiveDate}T00:00:00.000Z`),
    [archiveDate],
  );

  const handleArchiveDateChange = (value: Dayjs | null) => {
    if (!value) {
      return;
    }
    const nextDate = parseDateParamUtc(formatSelectedDateParam(value));
    updateArchiveParams({ date: nextDate });
  };

  const mergeArchiveItems = useCallback(
    (current: ArchiveEventItem[], incoming: ArchiveEventItem[]) => {
      const seen = new Set(current.map((item) => item.processedArticleId));
      const merged = [...current];
      for (const item of incoming) {
        if (seen.has(item.processedArticleId)) {
          continue;
        }
        seen.add(item.processedArticleId);
        merged.push(item);
      }
      return merged;
    },
    [],
  );

  const handleHeadlinesLoadMore = useCallback(
    async (group: ArchiveVerticalGroup) => {
      if (!group.pageInfo.hasMore || !group.pageInfo.nextCursor) {
        return;
      }
      if (loadingMoreByVertical[group.vertical]) {
        return;
      }
      setLoadingMoreByVertical((current) => ({
        ...current,
        [group.vertical]: true,
      }));
      void trackSearchTelemetry({
        eventType: "archive_load_more_click",
        surface: "search_page",
        vertical: group.vertical,
      });
      try {
        await fetchMoreArchiveDigest({
          variables: {
            input: {
              ...archiveDigestInput,
              cursors: [
                {
                  vertical: group.vertical,
                  cursor: group.pageInfo.nextCursor,
                },
              ],
            },
          },
          updateQuery: (previous, { fetchMoreResult }) => {
            if (!fetchMoreResult?.archiveDigest) {
              return previous;
            }
            const incomingDigest = fetchMoreResult.archiveDigest;
            const incomingGroup = incomingDigest.groups.find(
              (entry) => entry.vertical === group.vertical,
            );
            if (!incomingGroup) {
              return previous;
            }
            return {
              archiveDigest: {
                ...incomingDigest,
                groups: previous.archiveDigest.groups.map((entry) => {
                  if (entry.vertical !== group.vertical) {
                    return entry;
                  }
                  return {
                    ...entry,
                    displayName: incomingGroup.displayName,
                    totalCount: incomingGroup.totalCount,
                    pageInfo: incomingGroup.pageInfo,
                    items: mergeArchiveItems(entry.items, incomingGroup.items),
                  };
                }),
              },
            };
          },
        });
      } finally {
        setLoadingMoreByVertical((current) => ({
          ...current,
          [group.vertical]: false,
        }));
      }
    },
    [
      archiveDigestInput,
      fetchMoreArchiveDigest,
      loadingMoreByVertical,
      mergeArchiveItems,
    ],
  );

  return (
    <div className="flex flex-col gap-4">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.search.title", { defaultValue: "Search" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.search.subtitle", {
            defaultValue:
              "Search across processed items and historical headlines.",
          })}
        </Typography.Text>
      </Space>

      <AnalysisToolbar
        surface="search"
        exportTarget="search"
        queryString={searchParams.toString()}
        savedViewId={savedViewId}
      />

      {savedViewId ? (
        <AnnotationPanel subjectType="saved_view" subjectId={savedViewId} />
      ) : null}

      <Card className="content-card">
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <EnhancedSearchBox
            value={searchInput}
            onChange={setSearchInput}
            onSearch={handleSearchSubmit}
            navigateOnSearch={false}
            onSuggestionStatusChange={setSuggestionStatus}
            placeholder={t("pages.search.searchPlaceholder", {
              defaultValue:
                "Search news, topics, entities, or historical headlines...",
            })}
          />

          <Space wrap size={[8, 8]}>
            <Segmented
              value={mode}
              options={[
                {
                  label: t("pages.search.mode.items", {
                    defaultValue: "Items",
                  }),
                  value: "items",
                },
                {
                  label: t("pages.search.mode.headlines", {
                    defaultValue: "History Headlines",
                  }),
                  value: "headlines",
                },
              ]}
              onChange={(value) => updateMode(value as SearchMode)}
            />
            {query ? (
              <Tooltip title={query}>
                <Tag color="blue">
                  {t("pages.search.featureCurrentQuery", {
                    defaultValue: "Current query",
                  })}
                  : {queryPreview}
                </Tag>
              </Tooltip>
            ) : null}
            {mode === "headlines" ? (
              <Tag color="gold">
                <HistoryOutlined />{" "}
                {t("pages.search.mode.headlinesHint", {
                  defaultValue: "Archive headlines mode",
                })}
              </Tag>
            ) : null}
          </Space>
        </Space>
      </Card>

      <Alert
        type="info"
        showIcon
        message={t("pages.search.noticeTitle", {
          defaultValue: "Search scope",
        })}
        description={t("pages.search.noticeDescription", {
          defaultValue:
            "Searches titles, summaries, topics, entities, locations, and external IDs.",
        })}
      />

      <Alert
        type="success"
        showIcon
        icon={<BulbOutlined />}
        message={t("pages.search.featuresTitle", {
          defaultValue: "Active search capabilities",
        })}
        description={
          <Space direction="vertical" size={6}>
            <Space wrap size={[8, 8]}>
              <Tag color="processing">
                {t("pages.search.featureServerSuggestions", {
                  defaultValue: "Server suggestions",
                })}
                {suggestionStatus ? ` (${suggestionStatus.total})` : ""}
              </Tag>
              <Tag color="geekblue">
                {t("pages.search.featureSemanticSuggestions", {
                  defaultValue:
                    "Semantic suggestions (Embeddings + Vector recall)",
                })}
              </Tag>
              {suggestionStatus?.loading ? (
                <Tag color="blue">
                  {t("pages.search.featureSuggestionsLoading", {
                    defaultValue: "Suggestions loading...",
                  })}
                </Tag>
              ) : null}
              <Tag color="cyan">
                {t("pages.search.featureLocalHistory", {
                  defaultValue: "Local history guidance",
                })}
              </Tag>
              {shouldShowHotTopics ? (
                <Tag color="gold">
                  {t("pages.search.featureHotTopics", {
                    defaultValue: "Hot topics quick start",
                  })}
                </Tag>
              ) : null}
              {hasSemanticSuggestions ? (
                <Tag color="green">
                  {t("pages.search.featureSemanticReady", {
                    defaultValue: "Semantic suggestions active",
                  })}
                </Tag>
              ) : hasSuggestionPrefix ? (
                <Tag>
                  {t("pages.search.featureSemanticPending", {
                    defaultValue: "Keep typing to trigger semantic suggestions",
                  })}
                </Tag>
              ) : null}
              {!suggestionStatus?.loading &&
              hasSuggestionPrefix &&
              suggestionStatus?.total === 0 ? (
                <Tag>
                  {t("pages.search.featureSuggestionsEmpty", {
                    defaultValue: "No server suggestions for current prefix",
                  })}
                </Tag>
              ) : null}
              {hasSemanticSuggestions ? (
                <Tag color="volcano">
                  {t("pages.search.featureSemanticBreakdown", {
                    defaultValue: "Semantic {{semantic}} + Hybrid {{hybrid}}",
                    semantic: suggestionStatus?.semanticCount ?? 0,
                    hybrid: suggestionStatus?.hybridCount ?? 0,
                  })}
                </Tag>
              ) : null}
              {activeRankingMode === "relevance" ? (
                <Tag color="purple">
                  {t("pages.search.featureRankingRelevance", {
                    defaultValue:
                      "Result ranking: Relevance (rerank if available)",
                  })}
                </Tag>
              ) : null}
              {activeRankingMode === "recency" ? (
                <Tag color="orange">
                  {t("pages.search.featureRankingRecency", {
                    defaultValue: "Result ranking: Recency",
                  })}
                </Tag>
              ) : null}
            </Space>
            <Typography.Text>
              {shouldShowHotTopics
                ? t("pages.search.modeIdleHint", {
                    defaultValue:
                      "No query detected. Use hot topics or recent searches to start quickly.",
                  })
                : t("pages.search.modeActiveHint", {
                    defaultValue:
                      "Semantic and lexical suggestions are being used to guide your next query refinement.",
                  })}
            </Typography.Text>
          </Space>
        }
      />

      {!shouldShowHotTopics && recentSearches.length > 0 ? (
        <Alert
          type="info"
          showIcon
          message={t("pages.search.recentSearches", {
            defaultValue: "Recent searches",
          })}
          description={
            <Space wrap size={[8, 8]}>
              {recentSearches.slice(0, 6).map((value) => (
                <Tag
                  key={value}
                  className="cursor-pointer"
                  role="button"
                  tabIndex={0}
                  onClick={() => executeGuidedSearch(value)}
                  onKeyDown={(event) => handleTagKeyDown(event, value)}
                >
                  {value}
                </Tag>
              ))}
            </Space>
          }
        />
      ) : null}

      {shouldShowHotTopics ? (
        <Space direction="vertical" size={8}>
          <Typography.Text type="secondary">
            {t("pages.search.hotTopics", { defaultValue: "Hot topics" })}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t("pages.search.hotTopicsHint", {
              defaultValue:
                "Click a topic to fill the query and start searching immediately.",
            })}
          </Typography.Text>
          {hotTopicsLoading && hotTopics.length === 0 ? (
            <Skeleton active paragraph={{ rows: 1 }} title={false} />
          ) : hotTopics.length > 0 ? (
            <Space wrap size={[8, 8]}>
              {hotTopics.map((topic) => (
                <Tag
                  key={topic.value}
                  color="blue"
                  className="cursor-pointer"
                  role="button"
                  tabIndex={0}
                  onClick={() => handleTopicClick(topic.value)}
                  onKeyDown={(event) => handleTagKeyDown(event, topic.value)}
                >
                  {topic.value} ({topic.count})
                </Tag>
              ))}
            </Space>
          ) : (
            <Typography.Text type="secondary">
              {hotTopicsError
                ? t("pages.search.hotTopicsLoadFailed", {
                    defaultValue: "Failed to load hot topics.",
                  })
                : t("pages.search.hotTopicsEmpty", {
                    defaultValue: "No hot topics available yet.",
                  })}
            </Typography.Text>
          )}

          {recentSearches.length > 0 ? (
            <Space direction="vertical" size={8}>
              <Space align="center" size={8}>
                <Typography.Text type="secondary">
                  {t("pages.search.recentSearches", {
                    defaultValue: "Recent searches",
                  })}
                </Typography.Text>
                <Button
                  size="small"
                  type="link"
                  onClick={handleRecentSearchClear}
                  style={{ paddingInline: 0 }}
                >
                  {t("pages.search.clearHistory", {
                    defaultValue: "Clear history",
                  })}
                </Button>
              </Space>
              <Space wrap size={[8, 8]}>
                {recentSearches.map((value) => (
                  <Tag
                    key={value}
                    className="cursor-pointer"
                    role="button"
                    tabIndex={0}
                    onClick={() => executeGuidedSearch(value)}
                    onKeyDown={(event) => handleTagKeyDown(event, value)}
                  >
                    {value}
                  </Tag>
                ))}
              </Space>
            </Space>
          ) : null}
        </Space>
      ) : null}

      {mode === "items" ? (
        <ItemsView
          initialView="feed"
          emptyStateVariant="search"
          filterBehavior="layered"
          hideSearchControl
        />
      ) : (
        <Card
          className="content-card"
          title={t("pages.search.archive.title", {
            defaultValue: "History Headlines",
          })}
        >
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Space wrap size={[8, 8]}>
              <DatePicker
                allowClear={false}
                value={archiveSelectedDate}
                format="YYYY/MM/DD"
                onChange={handleArchiveDateChange}
                disabledDate={(value) =>
                  value.utc().isAfter(dayjs.utc(), "day")
                }
                suffixIcon={<CalendarOutlined />}
              />
              <Select
                size="middle"
                value={archiveRegion}
                options={regionOptions}
                onChange={(value) =>
                  updateArchiveParams({ region: value as ArchiveRegion })
                }
                style={{ minWidth: 180 }}
              />
              <Select
                mode="multiple"
                size="middle"
                value={archiveWeights}
                options={archiveWeightOptions}
                onChange={(values) => updateArchiveParams({ weights: values })}
                style={{ minWidth: 220 }}
                maxTagCount="responsive"
                placeholder={t("pages.search.archive.weightsPlaceholder", {
                  defaultValue: "All weights",
                })}
              />
              <Button
                onClick={() => refetchArchiveDigest()}
                loading={archiveDigestLoading}
              >
                {t("common.refresh", { defaultValue: "Refresh" })}
              </Button>
              <Button onClick={() => router.push(fullArchiveHref)}>
                {t("pages.search.archive.openFull", {
                  defaultValue: "Open Full Archive",
                })}
              </Button>
            </Space>

            {archiveDigestError ? (
              <Alert
                type="error"
                showIcon
                message={t("pages.search.archive.loadFailedTitle", {
                  defaultValue: "Failed to load archive headlines",
                })}
                description={archiveDigestError.message}
              />
            ) : null}
            {isHeadlinesQueryTooShort ? (
              <Alert
                type="info"
                showIcon
                message={t("pages.search.archive.queryTooShortTitle", {
                  defaultValue: "Need more query text",
                })}
                description={t(
                  "pages.search.archive.queryTooShortDescription",
                  {
                    defaultValue:
                      "Enter at least {{min}} characters to enable semantic headline search. Showing latest archive headlines for current filters.",
                    min: MIN_HEADLINES_QUERY_LENGTH,
                  },
                )}
              />
            ) : null}

            {archiveDigestLoading && !archiveDigest ? (
              <div className="flex items-center justify-center py-12">
                <Spin />
              </div>
            ) : archiveTotalCount === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("pages.search.archive.empty", {
                  defaultValue:
                    "No historical headlines found for current filters.",
                })}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <Typography.Text type="secondary">
                  {t("pages.search.archive.count", {
                    defaultValue: "{{count}} headlines matched",
                    count: archiveTotalCount,
                  })}
                </Typography.Text>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {(archiveDigest?.groups ?? [])
                    .filter((group) => group.items.length > 0)
                    .map((group) => (
                      <Card
                        key={group.vertical}
                        size="small"
                        title={group.displayName}
                        extra={<Tag>{group.totalCount}</Tag>}
                      >
                        <div className="flex flex-col gap-3">
                          {group.items.map((item) => {
                            const summary =
                              item.summary?.trim() ||
                              item.title?.trim() ||
                              t("pages.search.archive.untitled", {
                                defaultValue: "Untitled headline",
                              });
                            const relevancePercent =
                              typeof item.relevanceScore === "number"
                                ? Math.round(item.relevanceScore * 100)
                                : null;
                            return (
                              <div
                                key={item.processedArticleId}
                                className="rounded-md border border-slate-200 p-2"
                              >
                                <Typography.Paragraph
                                  className="!mb-1 text-sm"
                                  ellipsis={{ rows: 2 }}
                                >
                                  <span className="font-semibold">
                                    {item.countryLabel || "-"}：
                                  </span>
                                  <span>{summary}</span>
                                </Typography.Paragraph>

                                <Space size={[6, 6]} wrap>
                                  <Tag color="gold">
                                    {"★".repeat(
                                      Math.max(1, Math.min(item.weight, 5)),
                                    )}
                                  </Tag>
                                  <Typography.Text
                                    type="secondary"
                                    className="text-xs"
                                  >
                                    {dayjs(
                                      item.publishedAt ?? item.sortAt,
                                    ).format("YYYY/MM/DD")}
                                  </Typography.Text>
                                  {item.matchOrigin ? (
                                    <Tag
                                      color={
                                        MATCH_ORIGIN_COLOR[item.matchOrigin]
                                      }
                                    >
                                      {resolveMatchOriginLabel(
                                        item.matchOrigin,
                                        t,
                                      )}
                                    </Tag>
                                  ) : null}
                                  {relevancePercent !== null ? (
                                    <Tag color="cyan">
                                      {t("pages.search.archive.relevance", {
                                        defaultValue: "Relevance {{percent}}%",
                                        percent: relevancePercent,
                                      })}
                                    </Tag>
                                  ) : null}
                                  {item.sourceLabel ? (
                                    <Tag>{item.sourceLabel}</Tag>
                                  ) : null}
                                </Space>

                                {item.keywordHighlights.length > 0 ? (
                                  <Space size={[4, 4]} wrap>
                                    {item.keywordHighlights
                                      .slice(0, 4)
                                      .map((keyword) => (
                                        <Tag
                                          key={`${item.processedArticleId}-${keyword}`}
                                          color="blue"
                                        >
                                          {keyword}
                                        </Tag>
                                      ))}
                                  </Space>
                                ) : null}
                              </div>
                            );
                          })}
                          {group.pageInfo.hasMore ? (
                            <Space size={[8, 8]} wrap>
                              <Button
                                type="link"
                                size="small"
                                style={{ paddingInline: 0 }}
                                loading={Boolean(
                                  loadingMoreByVertical[group.vertical],
                                )}
                                onClick={() => handleHeadlinesLoadMore(group)}
                              >
                                {t("pages.search.archive.loadMore", {
                                  defaultValue: "Load more",
                                })}
                              </Button>
                            </Space>
                          ) : null}
                        </div>
                      </Card>
                    ))}
                </div>
              </div>
            )}
          </Space>
        </Card>
      )}
    </div>
  );
}
