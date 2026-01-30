"use client";

import { FileTextOutlined, LoadingOutlined, SearchOutlined } from "@ant-design/icons";
import { gql, useQuery } from "@apollo/client";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDebounceValue } from "@/lib/use-debounce-value";

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

export function CommandBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const { status } = useSession();
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  
  const debouncedQuery = useDebounceValue(query, 500);
  const emptyLabel = t("nav.commandEmpty", { defaultValue: "No results found." });

  const { data, loading } = useQuery<SearchItemsQueryData, SearchItemsQueryVariables>(
    SEARCH_ITEMS_QUERY,
    {
      variables: { search: debouncedQuery },
      skip: status !== "authenticated" || !focused || debouncedQuery.length < 2,
      fetchPolicy: "no-cache",
    }
  );

  const edges = data?.items.edges ?? [];

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

  return (
    <div className={`relative transition-all duration-300 ease-out z-50 ${focused ? "w-[600px]" : "w-[420px]"}`}>
      <div
        className={`
        flex items-center h-10 px-4 rounded-lg
        bg-white/90 backdrop-blur-md
        border transition-all duration-300
        ${focused 
          ? "border-[var(--primary)] shadow-[0_12px_24px_rgba(15,23,42,0.12)]" 
          : "border-[var(--border)] hover:border-slate-300"
        }
      `}
      >
        {loading ? (
           <LoadingOutlined className="text-lg mr-3 text-[var(--primary)]" />
        ) : (
           <SearchOutlined className={`text-lg mr-3 ${focused ? "text-[var(--primary)]" : "text-slate-500"}`} />
        )}

        <input
          ref={inputRef}
          type="text"
          id="command-bar-query"
          name="commandBarQuery"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("nav.commandPlaceholder", {
            defaultValue: "Search titles, summaries, topics, entities... (Cmd+K)"
          })}
          className="bg-transparent border-none outline-none text-[var(--foreground)] placeholder-slate-400 w-full text-sm"
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
        />
        <div className="flex gap-1 ml-2">
           {!focused && (
             <kbd className="hidden md:inline-flex h-5 items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 text-[10px] font-medium text-slate-500 opacity-100">
               <span className="text-xs">⌘</span>K
             </kbd>
           )}
        </div>
      </div>

      {/* Results Dropdown */}
      {focused && query.length >= 2 && (
        <div className="absolute top-full left-0 right-0 mt-2 glass-card border border-[var(--border)] max-h-[300px] overflow-auto animate-in fade-in slide-in-from-top-2">
          {edges.length === 0 && !loading && (
            <div className="p-4 text-center text-slate-500 text-xs">
              {emptyLabel}
            </div>
          )}
          
          {edges.map((edge) => {
            const statusText = edge.node.status ?? "";
            const statusLabel = t(`items.status.${statusText}`, { defaultValue: statusText });
            const externalIdLabel = t("items.detail.fields.externalId", { defaultValue: "External ID" });
            return (
            <div 
              key={edge.node.id}
              onClick={() => handleSelect(edge.node.id)}
              className="px-4 py-3 hover:bg-slate-50 cursor-pointer border-b border-[var(--border)]/60 last:border-0 flex items-center justify-between group"
            >
              <div className="flex items-center gap-3">
                 <FileTextOutlined className="text-slate-400 group-hover:text-[var(--primary)]" />
                 <div className="flex flex-col">
                   <span className="text-sm text-slate-800 group-hover:text-[var(--primary)]">
                     {edge.node.title}
                   </span>
                   <span className="text-[10px] text-slate-500">
                     {externalIdLabel}: {edge.node.meta?.externalId ?? "-"}
                   </span>
                 </div>
              </div>
              <span className="text-[10px] text-[var(--accent)] border border-[var(--accent)]/30 px-1.5 py-0.5 rounded-sm">
                 {statusLabel}
              </span>
            </div>
          );
          })}
        </div>
      )}
    </div>
  );
}
