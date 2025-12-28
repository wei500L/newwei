"use client";

import { LoadingOutlined, ThunderboltFilled } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Tag } from "antd";
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

export function BreakingNewsStream() {
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
    <div className="flex flex-col h-full glass-panel overflow-hidden relative font-mono text-sm">
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[#030712]/50">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--primary)] opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--primary)]"></span>
          </span>
          <span className="font-bold text-[var(--primary)] tracking-widest uppercase text-xs text-glow">
            NEURAL_STREAM // V.2.0
          </span>
        </div>
        <div className="flex items-center gap-2">
           {isLoading && <LoadingOutlined className="text-[var(--primary)]" />}
           <span className="text-[10px] text-gray-500">
             {data?.length ?? 0} NODES ACTIVE
           </span>
        </div>
      </div>

      {/* Terminal Feed */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-[var(--primary)]/20 scrollbar-track-transparent p-4 space-y-4">
        {isLoading && !data && (
          <div className="text-[var(--primary)] animate-pulse">
            &gt; INITIALIZING NEURAL LINK...
            <br />
            &gt; ESTABLISHING SECURE CONNECTION...
          </div>
        )}

        {error && (
           <div className="text-[var(--destructive)]">
             &gt; ERROR: CONNECTION SEVERED.
             <br />
             &gt; {error instanceof Error ? error.message : "UNKNOWN_ERROR"}
           </div>
        )}

        {!isLoading && data?.length === 0 && (
          <div className="text-gray-500">
            &gt; NO ACTIVE INTELLIGENCE FOUND.
            <br />
            &gt; WAITING FOR INPUT...
          </div>
        )}

        {data?.map((item) => (
          <div 
            key={item.id}
            className="group relative pl-4 border-l border-white/10 hover:border-[var(--primary)] transition-colors duration-200"
          >
            {/* Timestamp & Type Line */}
            <div className="flex items-center gap-2 mb-1 opacity-60 text-[10px]">
              <span className="text-[var(--primary)]">
                [{dayjs(item.createdAt).format("HH:mm:ss")}]
              </span>
              <span className={`uppercase ${item.type === AnalysisType.Anomaly ? "text-[var(--bearish)]" : "text-[var(--bullish)]"}`}>
                {item.type}
              </span>
              <span>:: {item.status}</span>
            </div>
            
            {/* Content Line */}
            <div className="text-gray-300 text-xs leading-relaxed group-hover:text-white group-hover:text-glow transition-all">
              <span className="text-[var(--primary)] mr-2">&gt;&gt;</span>
              {item.summary || "RAW_DATA_PROCESSED"}
            </div>

            {/* Decorator */}
            <div className="absolute left-[-1px] top-0 bottom-0 w-[1px] bg-gradient-to-b from-[var(--primary)] to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        ))}
        
        <div className="h-4" /> {/* Spacer */}
      </div>

      {/* Scanline Effect Overlay */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] z-20 bg-[length:100%_2px,3px_100%] opacity-20" />
    </div>
  );
}
