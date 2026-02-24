"use client";

import { BulbOutlined } from "@ant-design/icons";
import { Alert, Button, Skeleton, Space, Tag, Tooltip, Typography } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { ItemsView } from "@/app/(app)/items/items-view";
import type { SearchSuggestionStatus } from "@/components/enhanced-search-box";
import { useItemFacetsQuery } from "@/graphql/generated";
import { parseSearchHistory, SEARCH_HISTORY_KEY } from "@/lib/search-history";
import { buildHotTopicQueryString } from "./search-hot-topic-query";

const SEARCH_GUIDANCE_HISTORY_LIMIT = 8;
const QUERY_TAG_MAX_LENGTH = 28;

export function SearchContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [suggestionStatus, setSuggestionStatus] = useState<SearchSuggestionStatus | null>(null);

  const query = (searchParams.get("q") ?? "").trim();
  const shouldShowHotTopics = query.length === 0;
  const rankingParam = (searchParams.get("ranking") ?? "").trim().toLowerCase();
  const activeRankingMode =
    query.length > 0 ? (rankingParam === "recency" ? "recency" : "relevance") : null;
  const queryPreview =
    query.length > QUERY_TAG_MAX_LENGTH ? `${query.slice(0, QUERY_TAG_MAX_LENGTH - 1)}…` : query;
  const hasSemanticSuggestions =
    (suggestionStatus?.semanticCount ?? 0) + (suggestionStatus?.hybridCount ?? 0) > 0;
  const hasSuggestionPrefix = (suggestionStatus?.prefix ?? "").length > 0;

  const { data: facetsData, loading: hotTopicsLoading, error: hotTopicsError } = useItemFacetsQuery({
    variables: {
      search: null,
      filters: null
    },
    fetchPolicy: "cache-and-network",
    skip: !shouldShowHotTopics
  });

  const hotTopics = useMemo(
    () => (facetsData?.itemFacets?.topics ?? []).slice(0, 8),
    [facetsData]
  );

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SEARCH_HISTORY_KEY);
      setRecentSearches(parseSearchHistory(saved, SEARCH_GUIDANCE_HISTORY_LIMIT));
    } catch {
      setRecentSearches([]);
    }
  }, [shouldShowHotTopics]);

  const executeGuidedSearch = useCallback((keyword: string) => {
    const nextQuery = buildHotTopicQueryString(new URLSearchParams(searchParams.toString()), keyword);
    router.push(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }, [pathname, router, searchParams]);

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

  const handleTagKeyDown = (event: KeyboardEvent<HTMLElement>, value: string) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    executeGuidedSearch(value);
  };

  return (
    <div className="flex flex-col gap-4">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.search.title", { defaultValue: "Search" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.search.subtitle", { defaultValue: "Search across processed items." })}
        </Typography.Text>
      </Space>
      <Alert
        type="info"
        showIcon
        message={t("pages.search.noticeTitle", { defaultValue: "Search scope" })}
        description={t("pages.search.noticeDescription", {
          defaultValue: "Searches titles, summaries, topics, entities, locations, and external IDs."
        })}
      />
      <Alert
        type="success"
        showIcon
        icon={<BulbOutlined />}
        message={t("pages.search.featuresTitle", { defaultValue: "Active search capabilities" })}
        description={
          <Space direction="vertical" size={6}>
            <Space wrap size={[8, 8]}>
              <Tag color="processing">
                {t("pages.search.featureServerSuggestions", {
                  defaultValue: "Server suggestions"
                })}
                {suggestionStatus ? ` (${suggestionStatus.total})` : ""}
              </Tag>
              <Tag color="geekblue">
                {t("pages.search.featureSemanticSuggestions", {
                  defaultValue: "Semantic suggestions (Embeddings + Vector recall)"
                })}
              </Tag>
              {suggestionStatus?.loading ? (
                <Tag color="blue">
                  {t("pages.search.featureSuggestionsLoading", {
                    defaultValue: "Suggestions loading..."
                  })}
                </Tag>
              ) : null}
              <Tag color="cyan">
                {t("pages.search.featureLocalHistory", {
                  defaultValue: "Local history guidance"
                })}
              </Tag>
              {shouldShowHotTopics ? (
                <Tag color="gold">
                  {t("pages.search.featureHotTopics", {
                    defaultValue: "Hot topics quick start"
                  })}
                </Tag>
              ) : null}
              {hasSemanticSuggestions ? (
                <Tag color="green">
                  {t("pages.search.featureSemanticReady", {
                    defaultValue: "Semantic suggestions active"
                  })}
                </Tag>
              ) : hasSuggestionPrefix ? (
                <Tag>
                  {t("pages.search.featureSemanticPending", {
                    defaultValue: "Keep typing to trigger semantic suggestions"
                  })}
                </Tag>
              ) : null}
              {!suggestionStatus?.loading && hasSuggestionPrefix && suggestionStatus?.total === 0 ? (
                <Tag>
                  {t("pages.search.featureSuggestionsEmpty", {
                    defaultValue: "No server suggestions for current prefix"
                  })}
                </Tag>
              ) : null}
              {hasSemanticSuggestions ? (
                <Tag color="volcano">
                  {t("pages.search.featureSemanticBreakdown", {
                    defaultValue: "Semantic {{semantic}} + Hybrid {{hybrid}}",
                    semantic: suggestionStatus?.semanticCount ?? 0,
                    hybrid: suggestionStatus?.hybridCount ?? 0
                  })}
                </Tag>
              ) : null}
              {activeRankingMode === "relevance" ? (
                <Tag color="purple">
                  {t("pages.search.featureRankingRelevance", {
                    defaultValue: "Result ranking: Relevance (rerank if available)"
                  })}
                </Tag>
              ) : null}
              {activeRankingMode === "recency" ? (
                <Tag color="orange">
                  {t("pages.search.featureRankingRecency", {
                    defaultValue: "Result ranking: Recency"
                  })}
                </Tag>
              ) : null}
              {query ? (
                <Tooltip title={query}>
                  <Tag color="blue">
                    {t("pages.search.featureCurrentQuery", {
                      defaultValue: "Current query"
                    })}
                    : {queryPreview}
                  </Tag>
                </Tooltip>
              ) : null}
            </Space>
            <Typography.Text>
              {shouldShowHotTopics
                ? t("pages.search.modeIdleHint", {
                    defaultValue: "No query detected. Use hot topics or recent searches to start quickly."
                  })
                : t("pages.search.modeActiveHint", {
                    defaultValue:
                      "Semantic and lexical suggestions are being used to guide your next query refinement."
                  })}
            </Typography.Text>
          </Space>
        }
      />
      {!shouldShowHotTopics && recentSearches.length > 0 ? (
        <Alert
          type="info"
          showIcon
          message={t("pages.search.recentSearches", { defaultValue: "Recent searches" })}
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
              defaultValue: "Click a topic to fill the query and start searching immediately."
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
                    defaultValue: "Failed to load hot topics."
                  })
                : t("pages.search.hotTopicsEmpty", {
                    defaultValue: "No hot topics available yet."
                  })}
            </Typography.Text>
          )}

          {recentSearches.length > 0 ? (
            <Space direction="vertical" size={8}>
              <Space align="center" size={8}>
                <Typography.Text type="secondary">
                  {t("pages.search.recentSearches", { defaultValue: "Recent searches" })}
                </Typography.Text>
                <Button
                  size="small"
                  type="link"
                  onClick={handleRecentSearchClear}
                  style={{ paddingInline: 0 }}
                >
                  {t("pages.search.clearHistory", { defaultValue: "Clear history" })}
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
      <ItemsView
        initialView="feed"
        emptyStateVariant="search"
        filterBehavior="layered"
        onSearchSuggestionStatusChange={setSuggestionStatus}
      />
    </div>
  );
}
