"use client";

import { FileTextOutlined, LoadingOutlined, SearchOutlined, WarningOutlined } from "@ant-design/icons";
import { gql, useQuery } from "@apollo/client";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { getSearchRemainingChars, resolveSearchFeedbackState } from "@/lib/search-feedback-state";
import { useDebounceValue } from "@/lib/use-debounce-value";

import { buildCommandBarSearchHref } from "./command-bar-search";

interface SearchItemsQueryData {
  items: {
    edges: {
      node: {
        id: string;
        title: string;
        status: string;
        meta?: { externalId?: string | null } | null;
      };
    }[];
  };
}

interface SearchItemsQueryVariables {
  search?: string | null;
}

const SEARCH_ITEMS_QUERY = gql`
  query SearchItems($search: String) {
    items(search: $search, first: 5) {
      edges {
        node {
          id
          title
          status
          meta {
            externalId
          }
        }
      }
    }
  }
`;

const COMMAND_SEARCH_DEBOUNCE_MS = 300;
const COMMAND_SEARCH_MIN_CHARS = 2;

export function CommandBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const { status } = useSession();
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const debouncedQuery = useDebounceValue(query, COMMAND_SEARCH_DEBOUNCE_MS);
  const emptyLabel = t("nav.commandEmpty");
  const runSearchLabel = t("nav.commandRunSearch");
  const normalizedQuery = query.trim();
  const normalizedDebouncedQuery = debouncedQuery.trim();

  const { data, loading, error } = useQuery<SearchItemsQueryData, SearchItemsQueryVariables>(
    SEARCH_ITEMS_QUERY,
    {
      variables: { search: debouncedQuery },
      skip:
        status !== "authenticated" ||
        !focused ||
        normalizedDebouncedQuery.length < COMMAND_SEARCH_MIN_CHARS,
      fetchPolicy: "no-cache",
    }
  );

  const edges = data?.items.edges ?? [];
  const hasQuery = normalizedQuery.length > 0;
  const isActive = focused || hasQuery;
  const remainingChars = getSearchRemainingChars(normalizedQuery, COMMAND_SEARCH_MIN_CHARS);
  const feedbackState = resolveSearchFeedbackState({
    query: normalizedQuery,
    debouncedQuery: normalizedDebouncedQuery,
    loading,
    hasResults: edges.length > 0,
    hasError: Boolean(error) && normalizedQuery === normalizedDebouncedQuery,
    minChars: COMMAND_SEARCH_MIN_CHARS,
  });
  const feedbackMessage = useMemo(() => {
    switch (feedbackState) {
      case "minChars":
        return t("search.feedback.minChars", {
          remaining: remainingChars,
        });
      case "debouncing":
        return t("search.feedback.debouncing");
      case "loading":
        return t("search.feedback.loading");
      case "error":
        return t("search.feedback.error");
      case "empty":
        return emptyLabel;
      default:
        return null;
    }
  }, [emptyLabel, feedbackState, remainingChars, t]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") {
        inputRef.current?.blur();
        setFocused(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSelect = (id: string) => {
    router.push(`/items/${id}`);
    setFocused(false);
    setQuery("");
  };

  const executeSearch = useCallback(
    (rawQuery?: string) => {
      const href = buildCommandBarSearchHref(rawQuery ?? query);
      if (!href) {
        return;
      }
      router.push(href);
      setFocused(false);
      setQuery("");
    },
    [query, router]
  );

  return (
    <div
      className={`relative z-50 w-full min-w-0 max-w-[440px] transition-[max-width,filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] lg:max-w-[560px] 2xl:max-w-[640px] ${
        focused ? "2xl:max-w-[700px]" : ""
      }`}
    >
      <div
        className={`command-bar-shell ${isActive ? "command-bar-shell--active" : ""}`}
      >
        <div
          className={`
            relative flex h-11 items-center rounded-[inherit] px-3.5 backdrop-blur-xl
            transition-[background-color,border-color,box-shadow] duration-300
            ${
              isActive
                ? "border border-[var(--command-bar-border-active)] bg-[var(--command-bar-surface-active)] shadow-[0_14px_36px_-22px_rgba(15,23,42,0.65)] dark:shadow-[0_16px_38px_-20px_rgba(2,6,23,0.9)]"
                : "border border-[var(--command-bar-border)] bg-[var(--command-bar-surface)] shadow-[0_12px_30px_-25px_rgba(15,23,42,0.65)] hover:border-[var(--command-bar-border-hover)]"
            }
          `}
        >
          {loading ? (
            <LoadingOutlined className="mr-2.5 animate-spin text-base text-[var(--primary)]" />
          ) : (
            <button
              type="button"
              onClick={() => executeSearch()}
              className={`mr-2.5 inline-flex h-7 w-7 items-center justify-center rounded-full text-base transition-[transform,color,background-color] duration-300 ${
                isActive
                  ? "scale-105 bg-[var(--primary)]/10 text-[var(--primary)] dark:bg-[var(--primary)]/20"
                  : "text-slate-500 hover:scale-105 hover:bg-slate-200/80 hover:text-[var(--primary)] dark:text-slate-300 dark:hover:bg-slate-700/80"
              }`}
              aria-label={runSearchLabel}
              title={runSearchLabel}
            >
              <SearchOutlined />
            </button>
          )}

          <input
            ref={inputRef}
            type="text"
            id="command-bar-query"
            name="commandBarQuery"
            autoComplete="off"
            aria-label={t("nav.searchAriaLabel")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("nav.commandPlaceholder")}
            className="w-full border-none bg-transparent text-[13px] font-medium text-[var(--command-bar-text)] caret-[var(--primary)] outline-none transition-[color,opacity] duration-300 placeholder:text-[var(--command-bar-placeholder)] sm:text-sm"
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 200)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) {
                return;
              }
              event.preventDefault();
              executeSearch(event.currentTarget.value);
            }}
          />
          <div className="ml-2 flex gap-1">
            <kbd
              className={`hidden h-5 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 text-[10px] font-medium text-slate-500 transition-[opacity,transform,background-color,border-color,color] duration-300 dark:border-slate-600/90 dark:bg-slate-800/80 dark:text-slate-300 md:inline-flex ${
                focused ? "pointer-events-none translate-x-1 scale-95 opacity-0" : "translate-x-0 scale-100 opacity-100"
              }`}
            >
              <span className="text-xs">⌘</span>K
            </kbd>
          </div>
        </div>
      </div>

      {/* Results Dropdown */}
      {focused && hasQuery && (
        <div className="command-bar-results absolute left-0 right-0 top-full mt-2 max-h-[340px] overflow-auto border border-[var(--border)] glass-card">
          {feedbackMessage ? (
            <div
              className={`search-feedback-strip search-feedback-strip--${feedbackState}`}
              role="status"
              aria-live="polite"
            >
              <span className="search-feedback-strip__icon" aria-hidden>
                {feedbackState === "loading" || feedbackState === "debouncing" ? (
                  <LoadingOutlined className="animate-spin" />
                ) : feedbackState === "error" ? (
                  <WarningOutlined />
                ) : (
                  <SearchOutlined />
                )}
              </span>
              <span>{feedbackMessage}</span>
            </div>
          ) : null}

          {feedbackState === "ready"
            ? edges.map((edge, index) => {
                const statusText = edge.node.status ?? "";
                const statusLabel = t(`items.status.${statusText}`, { defaultValue: statusText });
                const externalIdLabel = t("items.detail.fields.externalId");
                return (
                  <div
                    key={edge.node.id}
                    onClick={() => handleSelect(edge.node.id)}
                    className="command-bar-result-row group flex cursor-pointer items-center justify-between border-b border-[var(--border)]/60 px-4 py-3 last:border-0 hover:bg-slate-50/90 dark:hover:bg-slate-800/70"
                    style={{ animationDelay: `${80 + index * 30}ms` }}
                  >
                    <div className="flex items-center gap-3">
                      <FileTextOutlined className="text-slate-400 transition-colors duration-200 group-hover:text-[var(--primary)]" />
                      <div className="flex flex-col">
                        <span className="line-clamp-1 text-sm text-slate-800 transition-colors duration-200 group-hover:text-[var(--primary)] dark:text-slate-100">
                          {edge.node.title}
                        </span>
                        <span className="text-[10px] text-slate-500 dark:text-slate-400">
                          {externalIdLabel}: {edge.node.meta?.externalId ?? "-"}
                        </span>
                      </div>
                    </div>
                    <span className="rounded-sm border border-[var(--accent)]/30 px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                      {statusLabel}
                    </span>
                  </div>
                );
              })
            : null}
        </div>
      )}
    </div>
  );
}
