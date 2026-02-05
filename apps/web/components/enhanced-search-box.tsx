"use client";

import { HistoryOutlined, QuestionCircleOutlined, SearchOutlined } from "@ant-design/icons";
import { AutoComplete, Button, Input, Popover, Tag } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { parseSearchSyntax } from "@/lib/search-syntax-parser";

const SEARCH_HISTORY_KEY = "news_search_history";
const MAX_HISTORY_ITEMS = 10;
const DEBOUNCE_MS = 300;

interface EnhancedSearchBoxProps {
  facets?: {
    topics?: { value: string; count: number }[];
    regions?: { value: string; count: number }[];
    sentiments?: { value: string; count: number }[];
  };
  onSearch?: (query: string, parsed: ReturnType<typeof parseSearchSyntax>) => void;
  placeholder?: string;
  className?: string;
}

export function EnhancedSearchBox({
  facets,
  onSearch,
  placeholder,
  className
}: EnhancedSearchBoxProps) {
  const { t } = useTranslation();
  const router = useRouter();

  const [inputValue, setInputValue] = useState("");
  const [options, setOptions] = useState<{ label: React.ReactNode; value: string }[]>([]);
  const [history, setHistory] = useState<string[]>([]);

  // Load search history from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SEARCH_HISTORY_KEY);
      if (saved) {
        setHistory(JSON.parse(saved));
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Save history helper
  const saveHistory = useCallback((newHistory: string[]) => {
    try {
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(newHistory.slice(0, MAX_HISTORY_ITEMS)));
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Add to history
  const addToHistory = useCallback(
    (query: string) => {
      if (!query.trim()) return;
      const trimmed = query.trim();
      setHistory((prev) => {
        const filtered = prev.filter((h) => h !== trimmed);
        const updated = [trimmed, ...filtered].slice(0, MAX_HISTORY_ITEMS);
        saveHistory(updated);
        return updated;
      });
    },
    [saveHistory]
  );

  // Parse current input
  const parsedQuery = useMemo(() => parseSearchSyntax(inputValue), [inputValue]);

  // Generate suggestions based on input and facets
  const generateSuggestions = useCallback(
    (value: string) => {
      const suggestions: { label: React.ReactNode; value: string }[] = [];
      const trimmed = value.trim().toLowerCase();

      if (!trimmed) {
        // Show history when empty
        if (history.length > 0) {
          suggestions.push({
            label: (
              <div className="text-xs text-gray-400 px-2 py-1">
                {t("search.recent", { defaultValue: "Recent Searches" })}
              </div>
            ),
            value: "__header_history__"
          });
          history.slice(0, 5).forEach((h) => {
            suggestions.push({
              label: (
                <div className="flex items-center gap-2 px-2 py-1">
                  <HistoryOutlined className="text-gray-400" />
                  <span>{h}</span>
                </div>
              ),
              value: h
            });
          });
        }
        return suggestions;
      }

      // Check if user is typing a field
      const fieldMatch = trimmed.match(/^(\w+):$/);
      if (fieldMatch) {
        const field = fieldMatch[1];
        if (field === "topic" && facets?.topics) {
          suggestions.push({
            label: (
              <div className="text-xs text-gray-400 px-2 py-1">
                {t("search.suggestions.topics", { defaultValue: "Select Topic" })}
              </div>
            ),
            value: "__header_topics__"
          });
          facets.topics.slice(0, 5).forEach((t) => {
            suggestions.push({
              label: (
                <div className="flex items-center justify-between px-2 py-1">
                  <span>{t.value}</span>
                  <Tag className="text-xs">{t.count}</Tag>
                </div>
              ),
              value: `topic:"${t.value}"`
            });
          });
        }
        if (field === "region" && facets?.regions) {
          suggestions.push({
            label: (
              <div className="text-xs text-gray-400 px-2 py-1">
                {t("search.suggestions.regions", { defaultValue: "Select Region" })}
              </div>
            ),
            value: "__header_regions__"
          });
          facets.regions.slice(0, 5).forEach((r) => {
            suggestions.push({
              label: (
                <div className="flex items-center justify-between px-2 py-1">
                  <span>{r.value}</span>
                  <Tag className="text-xs">{r.count}</Tag>
                </div>
              ),
              value: `region:"${r.value}"`
            });
          });
        }
        return suggestions;
      }

      // Regular search suggestions
      // 1. Facet-based suggestions
      if (facets?.topics) {
        const matchingTopics = facets.topics
          .filter((t) => t.value.toLowerCase().includes(trimmed))
          .slice(0, 3);
        if (matchingTopics.length > 0) {
          suggestions.push({
            label: (
              <div className="text-xs text-gray-400 px-2 py-1">
                {t("search.suggestions.topics", { defaultValue: "Topics" })}
              </div>
            ),
            value: "__header_topics__"
          });
          matchingTopics.forEach((t) => {
            suggestions.push({
              label: (
                <div className="flex items-center justify-between px-2 py-1">
                  <span>
                    {t.value.slice(0, t.value.toLowerCase().indexOf(trimmed))}
                    <strong>{t.value.slice(t.value.toLowerCase().indexOf(trimmed), t.value.toLowerCase().indexOf(trimmed) + trimmed.length)}</strong>
                    {t.value.slice(t.value.toLowerCase().indexOf(trimmed) + trimmed.length)}
                  </span>
                  <Tag className="text-xs">{t.count}</Tag>
                </div>
              ),
              value: `topic:"${t.value}"`
            });
          });
        }
      }

      // 2. Syntax suggestions
      if (trimmed.length >= 2) {
        const syntaxSuggestions = [
          { prefix: "topic:", example: "topic:AI" },
          { prefix: "region:", example: "region:US" },
          { prefix: "sentiment:", example: "sentiment:positive" },
          { prefix: "from:", example: "from:2024-01-01" },
          { prefix: "source:", example: "source:Reuters" }
        ];

        const matchingSyntax = syntaxSuggestions.filter((s) =>
          s.prefix.startsWith(trimmed) || s.example.toLowerCase().includes(trimmed)
        );

        if (matchingSyntax.length > 0) {
          suggestions.push({
            label: (
              <div className="text-xs text-gray-400 px-2 py-1">
                {t("search.suggestions.syntax", { defaultValue: "Advanced Syntax" })}
              </div>
            ),
            value: "__header_syntax__"
          });
          matchingSyntax.forEach((s) => {
            suggestions.push({
              label: (
                <div className="px-2 py-1 text-sm">
                  <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">{s.example}</code>
                </div>
              ),
              value: s.example
            });
          });
        }
      }

      // 3. Direct search option
      suggestions.push({
        label: (
          <div className="flex items-center gap-2 px-2 py-1 text-blue-500">
            <SearchOutlined />
            <span>
              {t("search.searchFor", { defaultValue: "Search for" })} &quot;{value}&quot;
            </span>
          </div>
        ),
        value: value
      });

      return suggestions;
    },
    [facets, history, t]
  );

  // Debounced search handler
  useEffect(() => {
    const timer = setTimeout(() => {
      if (inputValue.length >= 2 || inputValue.length === 0) {
        setOptions(generateSuggestions(inputValue));
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [inputValue, generateSuggestions]);

  // Handle search execution
  const handleSearch = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      addToHistory(trimmed);

      const parsed = parseSearchSyntax(trimmed);

      // Build URL params
      const params = new URLSearchParams();
      if (parsed.remainingText) params.set("q", parsed.remainingText);
      if (parsed.topic) params.set("topic", parsed.topic);
      if (parsed.region) params.set("region", parsed.region);
      if (parsed.sentiment) params.set("sentiment", parsed.sentiment);
      if (parsed.from) params.set("from", parsed.from);
      if (parsed.to) params.set("to", parsed.to);
      if (parsed.source) params.set("source", parsed.source);

      const queryString = params.toString();
      router.push(`/search${queryString ? `?${queryString}` : ""}`);

      onSearch?.(trimmed, parsed);
    },
    [addToHistory, onSearch, router]
  );

  // Syntax help content
  const syntaxHelpContent = (
    <div className="max-w-xs"
    >
      <p className="text-xs text-gray-500 mb-2">
        {t("search.syntax.description", { defaultValue: "Use these operators for advanced search:" })}
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
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">sentiment:positive</code> -{" "}
          {t("search.syntax.sentiment", { defaultValue: "Filter by sentiment" })}
        </li>
        <li>
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">from:2024-01-01</code> -{" "}
          {t("search.syntax.from", { defaultValue: "Start date" })}
        </li>
        <li>
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">to:2024-12-31</code> -{" "}
          {t("search.syntax.to", { defaultValue: "End date" })}
        </li>
        <li>
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">source:Reuters</code> -{" "}
          {t("search.syntax.source", { defaultValue: "Filter by source" })}
        </li>
        <li>
          <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">&quot;exact phrase&quot;</code> -{" "}
          {t("search.syntax.phrase", { defaultValue: "Exact phrase match" })}
        </li>
      </ul>
    </div>
  );

  return (
    <div className={`relative w-full max-w-xl ${className}`}>
      <div className="relative group">
        {/* Search Icon */}
        <div className="absolute inset-y-0 left-3 z-10 flex items-center pointer-events-none"
        >
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
              placeholder || t("search.placeholder", { defaultValue: "Search news, topics, or events..." })
            }
            className="pl-10 pr-20 bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:border-gray-300 focus:border-blue-500 transition-all rounded-lg"
            size="large"
            onPressEnter={() => handleSearch(inputValue)}
            suffix={
              <div className="flex items-center gap-1"
              >
                {/* Syntax Help */}
                <Popover content={syntaxHelpContent} placement="bottomRight" trigger="click">
                  <Button
                    type="text"
                    size="small"
                    icon={<QuestionCircleOutlined />}
                    className="text-gray-400 hover:text-gray-600"
                  />
                </Popover>

                {/* Active Filters Indicator */}
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

        {/* Keyboard Shortcut Hint */}
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex gap-1 text-[10px] text-gray-400 pointer-events-none opacity-0 group-focus-within:opacity-100 transition-opacity"
        >
          <kbd className="border rounded px-1 bg-gray-100 dark:bg-gray-800">Enter</kbd>
        </div>
      </div>
    </div>
  );
}
