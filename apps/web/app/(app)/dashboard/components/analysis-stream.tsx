"use client";

import { LoadingOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSession } from "next-auth/react";
import { useMemo } from "react";

import { createApiClient } from "@/lib/api-client";
import { AnalysisResultModel, AnalysisType } from "@/graphql/generated";
import dayjs from "@/lib/dayjs";

// Type definition for the query response
interface AnalysisResultsResponse {
  analysisResults: AnalysisResultModel[];
}

export function AnalysisStream() {
  const { t } = useTranslation();
  const { data: session } = useSession();

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard", "analysis-stream"],
    queryFn: async () => {
      const response = await apiClient.post<{ data: AnalysisResultsResponse }>(
        "graphql",
        {
          query: `
            query GetAnalysisStream {
              analysisResults(limit: 20) {
                id
                type
                summary
                createdAt
                status
              }
            }
          `,
        }
      );
      return response.data?.data?.analysisResults ?? [];
    },
    refetchInterval: 10000,
    enabled: Boolean(session?.accessToken),
  });

  return (
    <div className="flex flex-col h-full glass-panel overflow-hidden relative text-sm">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-white/70">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--primary)] opacity-40"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--primary)]"></span>
          </span>
          <span className="font-semibold text-slate-700 text-xs">
            Analysis Stream
          </span>
        </div>
        <div className="flex items-center gap-2">
           {isLoading && <LoadingOutlined className="text-[var(--primary)]" />}
           <span className="text-[10px] text-slate-500">
             {data?.length ?? 0} updates
           </span>
        </div>
      </div>

      {/* Terminal Feed */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-[var(--primary)]/20 scrollbar-track-transparent p-4 space-y-4">
        {isLoading && !data && (
          <div className="text-slate-500 animate-pulse">
            Preparing analysis stream...
          </div>
        )}

        {error && (
           <div className="text-[var(--destructive)]">
             {error instanceof Error ? error.message : "Unexpected error"}
           </div>
        )}

        {!isLoading && data?.length === 0 && (
          <div className="text-slate-500">
            No analysis updates yet.
          </div>
        )}

        {data?.map((item) => (
          <div 
            key={item.id}
            className="group relative pl-4 border-l border-slate-200 hover:border-[var(--primary)] transition-colors duration-200"
          >
            {/* Timestamp & Type Line */}
            <div className="flex items-center gap-2 mb-1 opacity-60 text-[10px]">
              <span className="text-slate-500">
                [{dayjs(item.createdAt).format("HH:mm:ss")}]
              </span>
              <span className={item.type === AnalysisType.Anomaly ? "text-[var(--bearish)]" : "text-[var(--bullish)]"}>
                {item.type}
              </span>
              <span>:: {item.status}</span>
            </div>
            
            {/* Content Line */}
            <div className="text-slate-700 text-xs leading-relaxed group-hover:text-slate-900 transition-all">
              {item.summary || "Summary unavailable"}
            </div>

            {/* Decorator */}
            <div className="absolute left-[-1px] top-0 bottom-0 w-[1px] bg-gradient-to-b from-[var(--primary)] to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        ))}
        
        <div className="h-4" /> {/* Spacer */}
      </div>

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-white/5 to-transparent opacity-40" />
    </div>
  );
}
