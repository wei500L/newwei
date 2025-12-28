"use client";

import { SearchOutlined, LoadingOutlined, FileTextOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { createApiClient } from "@/lib/api-client";
import { useDebounce } from "@/hooks/use-debounce"; // Assuming this exists or I'll implement simple debounce

// Simple debounce hook implementation if missing
function useDebounceValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);
  return debouncedValue;
}

export function CommandBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const { data: session } = useSession();
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  
  const debouncedQuery = useDebounceValue(query, 500);

  const apiClient = createApiClient({ accessToken: session?.accessToken });

  const { data, isLoading } = useQuery({
    queryKey: ["command-bar", "search", debouncedQuery],
    queryFn: async () => {
      if (!debouncedQuery || debouncedQuery.length < 2) return [];
      const response = await apiClient.post("graphql", {
        query: `
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
        `,
        variables: { search: debouncedQuery }
      });
      return response.data?.data?.items?.edges ?? [];
    },
    enabled: Boolean(debouncedQuery.length >= 2),
  });

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
    <div className={`relative transition-all duration-300 ease-out z-50 ${focused ? "w-[600px]" : "w-[400px]"}`}>
      <div className={`
        flex items-center h-10 px-4 rounded-none
        bg-[#0b1221]/80 backdrop-blur-md
        border transition-all duration-300
        ${focused 
          ? "border-[var(--primary)] shadow-[0_0_15px_rgba(0,240,255,0.2)]" 
          : "border-white/10 hover:border-white/20"
        }
      `}>
        {isLoading ? (
           <LoadingOutlined className="text-lg mr-3 text-[var(--primary)]" />
        ) : (
           <SearchOutlined className={`text-lg mr-3 ${focused ? "text-[var(--primary)]" : "text-gray-500"}`} />
        )}
        
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("nav.commandPlaceholder", { defaultValue: "Ask global intelligence... (Cmd+K)" })}
          className="bg-transparent border-none outline-none text-white placeholder-gray-600 w-full font-mono text-sm"
          onFocus={() => setFocused(true)}
          // Delay blur to allow clicking results
          onBlur={() => setTimeout(() => setFocused(false), 200)} 
        />
        <div className="flex gap-1 ml-2">
           {!focused && <kbd className="hidden md:inline-flex h-5 items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 font-mono text-[10px] font-medium text-gray-400 opacity-100">
             <span className="text-xs">⌘</span>K
           </kbd>}
        </div>
      </div>
      
      {/* Decorative corners for HUD feel */}
      {focused && (
        <>
          <div className="absolute -top-px -left-px w-2 h-2 border-l border-t border-[var(--primary)]" />
          <div className="absolute -top-px -right-px w-2 h-2 border-r border-t border-[var(--primary)]" />
          <div className="absolute -bottom-px -left-px w-2 h-2 border-l border-b border-[var(--primary)]" />
          <div className="absolute -bottom-px -right-px w-2 h-2 border-r border-b border-[var(--primary)]" />
        </>
      )}

      {/* Results Dropdown */}
      {focused && query.length >= 2 && (
        <div className="absolute top-full left-0 right-0 mt-2 glass-card border border-[var(--border)] max-h-[300px] overflow-auto animate-in fade-in slide-in-from-top-2">
          {data?.length === 0 && !isLoading && (
            <div className="p-4 text-center text-gray-500 font-mono text-xs">
              &gt; NO INTELLIGENCE FOUND.
            </div>
          )}
          
          {data?.map((edge: any) => (
            <div 
              key={edge.node.id}
              onClick={() => handleSelect(edge.node.id)}
              className="px-4 py-3 hover:bg-[var(--primary)]/10 cursor-pointer border-b border-white/5 last:border-0 flex items-center justify-between group"
            >
              <div className="flex items-center gap-3">
                 <FileTextOutlined className="text-gray-500 group-hover:text-[var(--primary)]" />
                 <div className="flex flex-col">
                   <span className="text-sm text-gray-200 font-mono group-hover:text-white group-hover:text-glow">
                     {edge.node.title}
                   </span>
                   <span className="text-[10px] text-gray-600 font-mono">
                     ID: {edge.node.meta.externalId}
                   </span>
                 </div>
              </div>
              <span className="text-[10px] uppercase text-[var(--accent)] border border-[var(--accent)]/30 px-1.5 py-0.5 rounded-sm">
                 {edge.node.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
