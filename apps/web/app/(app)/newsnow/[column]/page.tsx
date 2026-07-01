"use client";

import { StarOutlined } from "@ant-design/icons";
import { Skeleton, Empty, Button, Result, Alert, Space } from "antd";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";

import { usePendingAction } from "@/hooks/use-pending-action";
import { useTheme } from "@/hooks/use-theme";

import { NewsnowColumn } from "../components/newsnow-column";
import { NewsnowHeader } from "../components/newsnow-header";
import { NewsnowHottestCandidates } from "../components/newsnow-hottest-candidates";
import { NewsnowRecommendedFeed } from "../components/newsnow-recommended-feed";
import {
  useDomesticOpinionIndex,
  useHottestAnalysis,
  useNewsMetadata,
  usePrimeNewsSources,
} from "../hooks/use-news-sources";
import { useNewsnowStream } from "../hooks/use-newsnow-stream";
import { useNewsnowUiSync } from "../hooks/use-newsnow-ui-sync";
import { shouldSyncDomesticOpinionWithHottestAnalysis } from "../lib/newsnow-domestic-opinion";
import { useNewsnowStore } from "../store/newsnow-store";

function NewsnowAttribution() {
  return (
    <footer className="mx-auto w-full max-w-[1760px] px-4 pb-7 pt-3 text-center text-xs text-slate-500 dark:text-zinc-500 md:px-6 xl:px-8">
      <p className="leading-6">
        本页面基于{" "}
        <a
          href="https://github.com/ourongxing/newsnow"
          target="_blank"
          rel="noreferrer noopener"
          className="text-slate-700 underline-offset-2 hover:text-slate-900 hover:underline dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          ourongxing/newsnow
        </a>{" "}
        开源项目改造，Copyright (c) ourongxing，采用{" "}
        <a
          href="/licenses/newsnow-mit.txt"
          target="_blank"
          rel="noreferrer noopener"
          className="text-slate-700 underline-offset-2 hover:text-slate-900 hover:underline dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          MIT License
        </a>
        。
      </p>
    </footer>
  );
}

function NewsnowSourcesSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1760px] px-4 py-6 md:px-6 md:py-7 xl:px-8 relative z-10">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] md:gap-6 xl:gap-7">
        {[...Array(10)].map((_, i) => (
          <div
            key={i}
            className="h-[430px] rounded-[24px] sm:h-[470px] md:h-viz-3xl glass-panel p-5"
          >
            <Skeleton active paragraph={{ rows: 10 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function NewsnowColumnPage() {
  const { isDark } = useTheme();
  useNewsnowUiSync();
  useNewsnowStream();
  const params = useParams<{ column?: string | string[] }>();
  const columnParam = params.column;
  const columnKey = Array.isArray(columnParam)
    ? (columnParam[0] ?? "hottest")
    : (columnParam ?? "hottest");
  const normalizedColumnKey = columnKey.toLowerCase();
  const { data: metadata, isLoading, isError, refetch } = useNewsMetadata();
  const {
    focusSources,
    visibleSourceIds,
    liveUnreadBySource,
    realtimeHighlights,
    realtimeConnected,
    realtimeConnectionError,
    clearLiveUnread,
    clearAllLiveUnread,
  } = useNewsnowStore();
  const resolvedColumnKey =
    normalizedColumnKey === "recommended"
      ? "recommended"
      : metadata?.columns[normalizedColumnKey]
        ? normalizedColumnKey
        : "hottest";

  const sourceIds = useMemo(
    () =>
      resolvedColumnKey === "focus"
        ? focusSources
        : resolvedColumnKey === "recommended"
          ? metadata?.columns.hottest?.sources || []
          : metadata?.columns[resolvedColumnKey]?.sources || [],
    [focusSources, metadata?.columns, resolvedColumnKey],
  );
  const visibleSourceIdsInColumn = useMemo(
    () => {
      if (visibleSourceIds.length === 0 || sourceIds.length === 0) {
        return [];
      }
      const visibleSet = new Set(visibleSourceIds);
      return sourceIds.filter((sourceId) => visibleSet.has(sourceId));
    },
    [sourceIds, visibleSourceIds],
  );
  const hottestAnalysis = useHottestAnalysis(
    resolvedColumnKey === "hottest",
  );
  const domesticOpinionIndex = useDomesticOpinionIndex(
    resolvedColumnKey === "hottest",
  );
  const { clearPrimeFeedback, primeFeedback, primeSources } =
    usePrimeNewsSources(visibleSourceIdsInColumn);
  const { pending: refreshingSources, run: runPrimeSources } = usePendingAction(
    async (ids: string[]) => {
      const refreshed = await primeSources(ids, { force: true });
      if (refreshed) {
        ids.forEach((sourceId) => clearLiveUnread(sourceId));
      }
      return refreshed;
    },
  );
  const hottestAnalysisGeneratedAt = hottestAnalysis.data?.generatedAt;
  const refetchDomesticOpinion = domesticOpinionIndex.refetch;
  const lastSyncedDomesticOpinionAnalysisRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !shouldSyncDomesticOpinionWithHottestAnalysis({
        columnKey: resolvedColumnKey,
        hottestAnalysisGeneratedAt,
        lastSyncedAnalysisGeneratedAt:
          lastSyncedDomesticOpinionAnalysisRef.current,
      })
    ) {
      return;
    }

    lastSyncedDomesticOpinionAnalysisRef.current =
      hottestAnalysisGeneratedAt ?? null;
    void refetchDomesticOpinion();
  }, [
    resolvedColumnKey,
    hottestAnalysisGeneratedAt,
    refetchDomesticOpinion,
  ]);

  const visibleRealtimeUnread = sourceIds.reduce(
    (total, sourceId) => total + (liveUnreadBySource[sourceId] ?? 0),
    0,
  );
  const visibleRealtimeHighlights = realtimeHighlights
    .filter((entry) => sourceIds.includes(entry.sourceId))
    .slice(0, 3);
  const primeFeedbackSummary = useMemo(() => {
    if (!primeFeedback || primeFeedback.failedSourceIds.length === 0) {
      return null;
    }

    const resolveSourceNames = (ids: string[]) =>
      ids
        .slice(0, 3)
        .map((sourceId) => metadata?.sources[sourceId]?.name ?? sourceId)
        .join("、");

    if (primeFeedback.requestFailed) {
      return {
        message: "当前栏目刷新失败",
        description:
          "新闻源刷新请求未完成，页面继续显示已有缓存内容。请稍后重试。",
      };
    }

    const details: string[] = [];
    if (primeFeedback.transientSourceIds.length > 0) {
      const names = resolveSourceNames(primeFeedback.transientSourceIds);
      details.push(
        `${primeFeedback.transientSourceIds.length} 个来源暂时刷新失败，当前继续显示缓存内容${
          names ? `：${names}` : ""
        }。`,
      );
    }
    if (primeFeedback.unsupportedSourceIds.length > 0) {
      const names = resolveSourceNames(primeFeedback.unsupportedSourceIds);
      details.push(
        `${primeFeedback.unsupportedSourceIds.length} 个来源不支持批量刷新，将在卡片加载时单独补取${
          names ? `：${names}` : ""
        }。`,
      );
    }

    return {
      message:
        primeFeedback.transientSourceIds.length > 0
          ? "部分来源未完成刷新"
          : "部分来源跳过批量刷新",
      description: details.join(" "),
    };
  }, [metadata?.sources, primeFeedback]);

  const frameClass = "min-h-full relative overflow-hidden";
  const frameStyle = isDark
    ? {
        backgroundColor: "var(--background)",
        backgroundImage:
          "radial-gradient(1100px 420px at 8% -12%, var(--aura-color-1), transparent 62%), radial-gradient(960px 360px at 96% -14%, var(--aura-color-2), transparent 62%)",
      }
    : {
        backgroundColor: "var(--background)",
        backgroundImage:
          "radial-gradient(960px 380px at 8% -12%, var(--aura-color-1), transparent 62%), radial-gradient(900px 360px at 96% -14%, var(--aura-color-2), transparent 62%)",
      };

  if (isLoading) {
    return (
      <div className={frameClass} style={frameStyle}>
        <NewsnowHeader />
        <NewsnowSourcesSkeleton />
        <NewsnowAttribution />
      </div>
    );
  }

  if (isError) {
    return (
      <div className={frameClass} style={frameStyle}>
        <NewsnowHeader />
        <div className="flex min-h-[65vh] items-center justify-center p-8 relative z-10">
          <Result
            status="error"
            title={<span className="text-[var(--foreground)] font-serif font-semibold">加载失败</span>}
            subTitle={<span className="text-[var(--secondary-foreground)]">无法获取新闻源数据，请稍后重试</span>}
            extra={
              <Button type="primary" onClick={() => refetch()} className="glass-panel border-none shadow-sm text-primary-foreground font-semibold">
                重试
              </Button>
            }
          />
        </div>
        <NewsnowAttribution />
      </div>
    );
  }

  if (resolvedColumnKey === "focus" && sourceIds.length === 0) {
    return (
      <div className={frameClass} style={frameStyle}>
        <NewsnowHeader />
        <div className="flex min-h-[65vh] items-center justify-center p-8 text-center relative z-10">
          <Empty
            image={
              <StarOutlined
                className="text-6xl text-[var(--secondary-foreground)] opacity-40"
              />
            }
            description={
              <div className="space-y-1">
                <p className="text-lg font-medium font-serif tracking-tight text-[var(--foreground)]">
                  还没有关注的源
                </p>
                <p className="text-[var(--secondary-foreground)] opacity-70">
                  点击搜索按钮或在其他列中点击星标来关注新闻源
                </p>
              </div>
            }
          />
        </div>
        <NewsnowAttribution />
      </div>
    );
  }

  return (
    <div className={frameClass} style={frameStyle}>
      <div className="relative z-10">
        <NewsnowHeader />
        {visibleRealtimeUnread > 0 ? (
          <div className="mx-auto w-full max-w-[1760px] px-4 pt-4 md:px-6 xl:px-8">
            <Alert
              showIcon
              type="info"
              className="glass-panel border-none shadow-sm"
              message={<span className="font-semibold text-[var(--foreground)]">实时推送到达 {visibleRealtimeUnread} 条新内容</span>}
              description={
                <div className="space-y-1 mt-1 text-[var(--secondary-foreground)]">
                  <p>已检测到数据源更新。你可以立即刷新当前栏目并清空未读计数。</p>
                  {visibleRealtimeHighlights.length > 0 ? (
                    <ul className="list-disc pl-5 opacity-90">
                      {visibleRealtimeHighlights.map((entry) => {
                        const sourceName =
                          metadata?.sources[entry.sourceId]?.name ?? entry.sourceId;
                        const firstTitle = entry.topTitles[0];
                        return (
                          <li key={`${entry.sourceId}:${entry.timestamp}`}>
                            <span className="font-medium text-[var(--foreground)]">{sourceName}</span>
                            <span className="text-[var(--bullish)]">{` +${entry.count}`}</span>
                            {firstTitle ? <span>{` · ${firstTitle}`}</span> : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              }
              action={
                <Space>
                  <Button
                    size="small"
                    loading={refreshingSources}
                    className="font-medium bg-[var(--primary)] text-white border-none shadow-md hover:brightness-110 active:scale-95 transition-all"
                    onClick={() => void runPrimeSources(sourceIds)}
                  >
                    立即刷新
                  </Button>
                  <Button size="small" type="text" className="font-medium text-[var(--secondary-foreground)] hover:text-[var(--foreground)]" onClick={() => clearAllLiveUnread()}>
                    标记已读
                  </Button>
                </Space>
              }
            />
          </div>
        ) : null}
        {primeFeedbackSummary ? (
          <div className="mx-auto w-full max-w-[1760px] px-4 pt-4 md:px-6 xl:px-8">
            <Alert
              showIcon
              closable
              type="warning"
              className="glass-panel border-none shadow-sm"
              message={
                <span className="font-semibold">{primeFeedbackSummary.message}</span>
              }
              description={
                <span className="opacity-80">{primeFeedbackSummary.description}</span>
              }
              onClose={clearPrimeFeedback}
              action={
                primeFeedback?.transientSourceIds.length ? (
                  <Button
                    size="small"
                    loading={refreshingSources}
                    onClick={() =>
                      void runPrimeSources(primeFeedback.transientSourceIds)
                    }
                  >
                    重试失败源
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : null}
        {!realtimeConnected && realtimeConnectionError ? (
          <div className="mx-auto w-full max-w-[1760px] px-4 pt-4 md:px-6 xl:px-8">
            <Alert
              showIcon
              type="warning"
              className="glass-panel border-none shadow-sm"
              message={<span className="font-semibold">实时连接不可用</span>}
              description={<span className="opacity-80">{realtimeConnectionError}</span>}
            />
          </div>
        ) : null}
        <main>
          {resolvedColumnKey === "hottest" ? (
            <NewsnowHottestCandidates
              analysis={hottestAnalysis.data}
              accessState={hottestAnalysis.accessState}
              isLoading={hottestAnalysis.isLoading}
              isError={hottestAnalysis.isError}
              error={hottestAnalysis.error}
              domesticOpinion={domesticOpinionIndex.data}
              isDomesticOpinionLoading={domesticOpinionIndex.isLoading}
              isDomesticOpinionError={domesticOpinionIndex.isError}
              domesticOpinionError={domesticOpinionIndex.error}
            />
          ) : null}
          {resolvedColumnKey === "recommended" ? (
            <NewsnowRecommendedFeed />
          ) : (
            <NewsnowColumn
              columnKey={resolvedColumnKey}
              sourceIds={sourceIds}
              sources={metadata?.sources || {}}
              analysisBySource={
                resolvedColumnKey === "hottest"
                  ? hottestAnalysis.data?.bySource
                  : undefined
              }
            />
          )}
        </main>
        <NewsnowAttribution />
      </div>
    </div>
  );
}
