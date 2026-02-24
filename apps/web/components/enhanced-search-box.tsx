"use client";

import { gql, useLazyQuery } from "@apollo/client";
import {
  GlobalOutlined,
  HistoryOutlined,
  QuestionCircleOutlined,
  ReadOutlined,
  SearchOutlined,
  SmileOutlined,
  TagsOutlined
} from "@ant-design/icons";
import { AutoComplete, Button, Input, Popover, Spin, Tag } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SearchSuggestionType } from "@/graphql/generated";
import {
  MAX_SEARCH_HISTORY_ITEMS,
  parseSearchHistory,
  SEARCH_HISTORY_KEY,
} from "@/lib/search-history";
import { parseSearchSyntax } from "@/lib/search-syntax-parser";
import { resolveSuggestionRequestPlan, type SearchField } from "./enhanced-search-box-utils";

const DEBOUNCE_MS = 300;
const SUGGESTIONS_LIMIT = 8;
const HEADER_OPTION_PREFIX = "__header__";

type SuggestionOption = {
  label: ReactNode;
  value: string;
  disabled?: boolean;
};

type SearchSuggestionOrigin = "LEXICAL" | "SEMANTIC" | "HYBRID";

interface SearchSuggestionRecord {
  type: SearchSuggestionType;
  value: string;
  origin: SearchSuggestionOrigin;
}

interface SearchSuggestionsQueryData {
  searchSuggestions: SearchSuggestionRecord[];
}

interface SearchSuggestionsQueryVariables {
  prefix: string;
  limit?: number;
}

export interface SearchSuggestionStatus {
  loading: boolean;
  prefix: string;
  total: number;
  lexicalCount: number;
  semanticCount: number;
  hybridCount: number;
}

const SEARCH_SUGGESTIONS_QUERY = gql`
  query SearchSuggestionsEnhanced($prefix: String!, $limit: Float) {
    searchSuggestions(prefix: $prefix, limit: $limit) {
      type
      value
      origin
    }
  }
`;

interface EnhancedSearchBoxProps {
  onSearch?: (query: string, parsed: ReturnType<typeof parseSearchSyntax>) => void;
  placeholder?: string;
  className?: string;
  value?: string;
  onChange?: (value: string) => void;
  navigateOnSearch?: boolean;
  onSuggestionStatusChange?: (status: SearchSuggestionStatus) => void;
}

export function EnhancedSearchBox({
  onSearch,
  placeholder,
  className,
  value,
  onChange,
  navigateOnSearch = true,
  onSuggestionStatusChange,
}: EnhancedSearchBoxProps) {
  const { t } = useTranslation();
  const router = useRouter();

  const [internalValue, setInternalValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [remoteSuggestions, setRemoteSuggestions] = useState<SearchSuggestionRecord[]>([]);
  const requestSeqRef = useRef(0);

  const [loadSuggestions, { loading: suggestionsLoading }] = useLazyQuery<
    SearchSuggestionsQueryData,
    SearchSuggestionsQueryVariables
  >(SEARCH_SUGGESTIONS_QUERY, {
    fetchPolicy: "network-only",
  });

  const inputValue = value ?? internalValue;

  const setInputValue = useCallback(
    (nextValue: string) => {
      if (value === undefined) {
        setInternalValue(nextValue);
      }
      onChange?.(nextValue);
    },
    [onChange, value]
  );

  const fieldContext = useMemo(() => {
    const trimmed = inputValue.trim();
    const fieldMatch = trimmed.match(/^(\w+):"?([^"]*)$/);
    if (!fieldMatch) {
      return null;
    }

    const rawField = fieldMatch[1] ?? "";
    const rawTypedPrefix = fieldMatch[2] ?? "";
    if (!rawField) {
      return null;
    }

    const field = rawField.toLowerCase();
    const typedPrefix = rawTypedPrefix.trim();

    if (
      field === "topic" ||
      field === "region" ||
      field === "sentiment" ||
      field === "source"
    ) {
      return {
        field: field as SearchField,
        typedPrefix,
      };
    }

    return null;
  }, [inputValue]);

  const suggestionPrefix = useMemo(() => {
    if (fieldContext) {
      return fieldContext.typedPrefix;
    }
    return inputValue.trim();
  }, [fieldContext, inputValue]);

  const parsedQuery = useMemo(() => parseSearchSyntax(inputValue), [inputValue]);

  // Load search history from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SEARCH_HISTORY_KEY);
      setHistory(parseSearchHistory(saved, MAX_SEARCH_HISTORY_ITEMS));
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Save history helper
  const saveHistory = useCallback((newHistory: string[]) => {
    try {
      localStorage.setItem(
        SEARCH_HISTORY_KEY,
        JSON.stringify(newHistory.slice(0, MAX_SEARCH_HISTORY_ITEMS))
      );
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Add to history
  const addToHistory = useCallback(
    (query: string) => {
      if (!query.trim()) {
        return;
      }
      const trimmed = query.trim();
      setHistory((prev) => {
        const filtered = prev.filter((item) => item !== trimmed);
        const updated = [trimmed, ...filtered].slice(0, MAX_SEARCH_HISTORY_ITEMS);
        saveHistory(updated);
        return updated;
      });
    },
    [saveHistory]
  );

  useEffect(() => {
    const requestPlan = resolveSuggestionRequestPlan({
      currentSeq: requestSeqRef.current,
      prefix: suggestionPrefix,
      hasFieldContext: Boolean(fieldContext),
    });

    if (!requestPlan.shouldFetch) {
      requestSeqRef.current = requestPlan.nextSeq;
      setRemoteSuggestions([]);
      return;
    }

    const timer = window.setTimeout(() => {
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;

      void loadSuggestions({
        variables: {
          prefix: suggestionPrefix,
          limit: SUGGESTIONS_LIMIT,
        },
      })
        .then((result) => {
          if (requestSeqRef.current !== requestSeq) {
            return;
          }
          setRemoteSuggestions(result.data?.searchSuggestions ?? []);
        })
        .catch(() => {
          if (requestSeqRef.current !== requestSeq) {
            return;
          }
          setRemoteSuggestions([]);
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [fieldContext, loadSuggestions, suggestionPrefix]);

  const serverSuggestions = useMemo(() => {
    const fieldToSuggestionType: Record<SearchField, SearchSuggestionType> = {
      topic: SearchSuggestionType.Topic,
      region: SearchSuggestionType.Region,
      sentiment: SearchSuggestionType.Sentiment,
      source: SearchSuggestionType.Source,
    };

    const expectedType = fieldContext ? fieldToSuggestionType[fieldContext.field] : null;
    const filtered = expectedType
      ? remoteSuggestions.filter((suggestion) => suggestion.type === expectedType)
      : remoteSuggestions;

    const originPriority: Record<SearchSuggestionOrigin, number> = {
      LEXICAL: 1,
      SEMANTIC: 2,
      HYBRID: 3
    };
    const byKey = new Map<string, SearchSuggestionRecord>();
    for (const suggestion of filtered) {
      const key = `${suggestion.type}:${suggestion.value.toLowerCase()}`;
      const current = byKey.get(key);
      if (!current) {
        byKey.set(key, suggestion);
        continue;
      }
      if (originPriority[suggestion.origin] > originPriority[current.origin]) {
        byKey.set(key, suggestion);
      }
    }
    return Array.from(byKey.values());
  }, [fieldContext, remoteSuggestions]);

  const buildSuggestionValue = useCallback(
    (suggestion: SearchSuggestionRecord) => {
      if (!fieldContext) {
        return suggestion.value;
      }
      const escaped = suggestion.value.replace(/"/g, '\\"');
      return `${fieldContext.field}:"${escaped}"`;
    },
    [fieldContext]
  );

  const suggestionTypeLabel = useCallback(
    (type: SearchSuggestionType) => {
      switch (type) {
        case SearchSuggestionType.Topic:
          return t("search.suggestions.topics", { defaultValue: "Topics" });
        case SearchSuggestionType.Region:
          return t("search.suggestions.regions", { defaultValue: "Regions" });
        case SearchSuggestionType.Sentiment:
          return t("search.suggestions.sentiments", { defaultValue: "Sentiments" });
        case SearchSuggestionType.Source:
          return t("search.suggestions.sources", { defaultValue: "Sources" });
        default:
          return type;
      }
    },
    [t]
  );

  const suggestionTypeIcon = useCallback((type: SearchSuggestionType) => {
    switch (type) {
      case SearchSuggestionType.Topic:
        return <TagsOutlined className="text-[12px] text-blue-500" />;
      case SearchSuggestionType.Region:
        return <GlobalOutlined className="text-[12px] text-cyan-500" />;
      case SearchSuggestionType.Sentiment:
        return <SmileOutlined className="text-[12px] text-purple-500" />;
      case SearchSuggestionType.Source:
        return <ReadOutlined className="text-[12px] text-orange-500" />;
      default:
        return null;
    }
  }, []);

  const suggestionOriginLabel = useCallback(
    (origin: SearchSuggestionOrigin) => {
      if (origin === "HYBRID") {
        return t("search.suggestions.originHybrid", { defaultValue: "Hybrid" });
      }
      if (origin === "SEMANTIC") {
        return t("search.suggestions.originSemantic", { defaultValue: "Semantic" });
      }
      return t("search.suggestions.originLexical", { defaultValue: "Lexical" });
    },
    [t]
  );

  useEffect(() => {
    if (!onSuggestionStatusChange) {
      return;
    }
    const lexicalCount = serverSuggestions.filter((entry) => entry.origin === "LEXICAL").length;
    const semanticCount = serverSuggestions.filter((entry) => entry.origin === "SEMANTIC").length;
    const hybridCount = serverSuggestions.filter((entry) => entry.origin === "HYBRID").length;
    onSuggestionStatusChange({
      loading: suggestionsLoading,
      prefix: suggestionPrefix.trim(),
      total: serverSuggestions.length,
      lexicalCount,
      semanticCount,
      hybridCount
    });
  }, [onSuggestionStatusChange, serverSuggestions, suggestionPrefix, suggestionsLoading]);

  const options = useMemo(() => {
    const suggestions: SuggestionOption[] = [];
    const rawValue = inputValue;
    const trimmed = rawValue.trim();
    const normalized = trimmed.toLowerCase();

    if (!trimmed) {
      if (history.length > 0) {
        suggestions.push({
          label: (
            <div className="text-xs text-gray-400 px-2 py-1">
              {t("search.recent", { defaultValue: "Recent Searches" })}
            </div>
          ),
          value: `${HEADER_OPTION_PREFIX}_history`,
          disabled: true,
        });

        history.slice(0, 5).forEach((item) => {
          suggestions.push({
            label: (
              <div className="flex items-center gap-2 px-2 py-1">
                <HistoryOutlined className="text-gray-400" />
                <span>{item}</span>
              </div>
            ),
            value: item,
          });
        });
      }
      return suggestions;
    }

    const matchingHistory = history
      .filter((item) => item.toLowerCase().includes(normalized))
      .slice(0, 3);

    if (matchingHistory.length > 0) {
      suggestions.push({
        label: (
          <div className="text-xs text-gray-400 px-2 py-1">
            {t("search.recent", { defaultValue: "Recent Searches" })}
          </div>
        ),
        value: `${HEADER_OPTION_PREFIX}_history`,
        disabled: true,
      });

      matchingHistory.forEach((item) => {
        suggestions.push({
          label: (
            <div className="flex items-center gap-2 px-2 py-1">
              <HistoryOutlined className="text-gray-400" />
              <span>{item}</span>
            </div>
          ),
          value: item,
        });
      });
    }

    if (serverSuggestions.length > 0) {
      suggestions.push({
        label: (
          <div className="text-xs text-gray-400 px-2 py-1">
            {t("search.suggestions.server", { defaultValue: "Semantic Suggestions" })}
          </div>
        ),
        value: `${HEADER_OPTION_PREFIX}_server`,
        disabled: true,
      });

      serverSuggestions.forEach((suggestion) => {
        suggestions.push({
          label: (
            <div className="flex items-center justify-between gap-2 px-2 py-1">
              <span className="inline-flex items-center gap-2">
                {suggestionTypeIcon(suggestion.type)}
                <span>{suggestion.value}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <Tag className="text-[10px]" bordered={false}>
                  {suggestionTypeLabel(suggestion.type)}
                </Tag>
                <Tag className="text-[10px]" bordered={false} color="geekblue">
                  {suggestionOriginLabel(suggestion.origin)}
                </Tag>
              </span>
            </div>
          ),
          value: buildSuggestionValue(suggestion),
        });
      });
    }

    if (suggestionsLoading && trimmed.length >= 2) {
      suggestions.push({
        label: (
          <div className="px-2 py-1 text-xs text-gray-500 flex items-center gap-2">
            <Spin size="small" />
            <span>
              {t("search.suggestions.loading", { defaultValue: "Loading semantic suggestions..." })}
            </span>
          </div>
        ),
        value: `${HEADER_OPTION_PREFIX}_loading`,
        disabled: true,
      });
    }

    if (normalized.length >= 2) {
      const syntaxSuggestions = [
        { prefix: "topic:", example: "topic:AI" },
        { prefix: "region:", example: "region:US" },
        { prefix: "sentiment:", example: "sentiment:positive" },
        { prefix: "from:", example: "from:2024-01-01" },
        { prefix: "source:", example: "source:Reuters" },
      ];

      const matchingSyntax = syntaxSuggestions.filter(
        (entry) =>
          entry.prefix.startsWith(normalized) ||
          entry.example.toLowerCase().includes(normalized)
      );

      if (matchingSyntax.length > 0) {
        suggestions.push({
          label: (
            <div className="text-xs text-gray-400 px-2 py-1">
              {t("search.suggestions.syntax", { defaultValue: "Advanced Syntax" })}
            </div>
          ),
          value: `${HEADER_OPTION_PREFIX}_syntax`,
          disabled: true,
        });

        matchingSyntax.forEach((entry) => {
          suggestions.push({
            label: (
              <div className="px-2 py-1 text-sm">
                <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">
                  {entry.example}
                </code>
              </div>
            ),
            value: entry.example,
          });
        });
      }
    }

    suggestions.push({
      label: (
        <div className="flex items-center gap-2 px-2 py-1 text-blue-500">
          <SearchOutlined />
          <span>
            {t("search.searchFor", { defaultValue: "Search for" })} &quot;{rawValue}&quot;
          </span>
        </div>
      ),
      value: rawValue,
    });

    return suggestions;
  }, [
    buildSuggestionValue,
    history,
    inputValue,
    serverSuggestions,
    suggestionsLoading,
    suggestionTypeLabel,
    suggestionTypeIcon,
    suggestionOriginLabel,
    t,
  ]);

  // Handle search execution
  const handleSearch = useCallback(
    (searchValue: string) => {
      if (searchValue.startsWith(HEADER_OPTION_PREFIX)) {
        return;
      }

      const trimmed = searchValue.trim();
      if (!trimmed) {
        return;
      }

      addToHistory(trimmed);
      setInputValue(trimmed);

      const parsed = parseSearchSyntax(trimmed);

      if (navigateOnSearch) {
        const params = new URLSearchParams();
        if (parsed.remainingText) {
          params.set("q", parsed.remainingText);
        }
        if (parsed.topic) {
          params.set("topic", parsed.topic);
        }
        if (parsed.region) {
          params.set("region", parsed.region);
        }
        if (parsed.sentiment) {
          params.set("sentiment", parsed.sentiment);
        }
        if (parsed.from) {
          params.set("from", parsed.from);
        }
        if (parsed.to) {
          params.set("to", parsed.to);
        }
        if (parsed.source) {
          params.set("source", parsed.source);
        }

        const queryString = params.toString();
        router.push(`/search${queryString ? `?${queryString}` : ""}`);
      }

      onSearch?.(trimmed, parsed);
    },
    [addToHistory, navigateOnSearch, onSearch, router, setInputValue]
  );

  // Syntax help content
  const syntaxHelpContent = (
    <div className="max-w-xs">
      <p className="text-xs text-gray-500 mb-2">
        {t("search.syntax.description", {
          defaultValue: "Use these operators for advanced search:",
        })}
      </p>
      <ul className="text-xs space-y-1">
        <li>
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">topic:AI</code> -{" "}
          {t("search.syntax.topic", { defaultValue: "Filter by topic" })}
        </li>
        <li>
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">region:US</code> -{" "}
          {t("search.syntax.region", { defaultValue: "Filter by region" })}
        </li>
        <li>
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">sentiment:positive</code>{" "}
          - {t("search.syntax.sentiment", { defaultValue: "Filter by sentiment" })}
        </li>
        <li>
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">from:2024-01-01</code>{" "}
          - {t("search.syntax.from", { defaultValue: "Start date" })}
        </li>
        <li>
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">to:2024-12-31</code> -{" "}
          {t("search.syntax.to", { defaultValue: "End date" })}
        </li>
        <li>
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">source:Reuters</code>{" "}
          - {t("search.syntax.source", { defaultValue: "Filter by source" })}
        </li>
        <li>
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">
            &quot;exact phrase&quot;
          </code>{" "}
          - {t("search.syntax.phrase", { defaultValue: "Exact phrase match" })}
        </li>
      </ul>
    </div>
  );

  return (
    <div className={`relative w-full max-w-xl ${className ?? ""}`}>
      <div className="relative group">
        <div className="absolute inset-y-0 left-3 z-10 flex items-center pointer-events-none">
          <SearchOutlined className="text-gray-400 group-focus-within:text-blue-500 transition-colors" />
        </div>

        <AutoComplete
          className="w-full"
          options={options}
          onSearch={setInputValue}
          onSelect={handleSearch}
          value={inputValue}
          onChange={setInputValue}
          backfill={false}
        >
          <Input
            placeholder={
              placeholder ||
              t("search.placeholder", {
                defaultValue: "Search news, topics, or events...",
              })
            }
            allowClear
            className="pl-10 pr-20 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:border-gray-300 focus:border-blue-500 transition-all rounded-lg"
            size="large"
            onPressEnter={() => handleSearch(inputValue)}
            suffix={
              <div className="flex items-center gap-1">
                <Popover content={syntaxHelpContent} placement="bottomRight" trigger="click">
                  <Button
                    type="text"
                    size="small"
                    icon={<QuestionCircleOutlined />}
                    className="text-gray-400 hover:text-gray-600"
                  />
                </Popover>

                {(parsedQuery.topic || parsedQuery.region || parsedQuery.sentiment) && (
                  <div className="flex gap-1">
                    {parsedQuery.topic && (
                      <Tag color="blue" className="text-xs">
                        topic
                      </Tag>
                    )}
                    {parsedQuery.region && (
                      <Tag color="green" className="text-xs">
                        region
                      </Tag>
                    )}
                    {parsedQuery.sentiment && (
                      <Tag color="purple" className="text-xs">
                        sentiment
                      </Tag>
                    )}
                  </div>
                )}
              </div>
            }
          />
        </AutoComplete>

        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex gap-1 text-[10px] text-gray-400 pointer-events-none opacity-0 group-focus-within:opacity-100 transition-opacity">
          <kbd className="border rounded px-1 bg-gray-100 dark:bg-gray-800">Enter</kbd>
        </div>
      </div>
    </div>
  );
}
