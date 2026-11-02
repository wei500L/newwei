"use client";

import { Skeleton, Button, Alert, Space } from "antd";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DataStateBoundary } from "@/components/data-state-boundary";
import { usePendingAction } from "@/hooks/use-pending-action";

import { NewsnowBoardContainer } from "../components/newsnow-board-container";
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
    <NewsnowBoardContainer spacing="footer" className="text-center text-xs text-[var(--muted-foreground)]">
      <p className="leading-6">
        本页面基于{" "}
        <a
          href="https://github.com/ourongxing/newsnow"
          target="_blank"
          rel="noreferrer noopener"
          className="text-[var(--secondary-foreground)] underline-offset-2 hover:text-[var(--foreground)] hover:underline"
        >
          ourongxing/newsnow
        </a>{" "}
        开源项目改造，Copyright (c) ourongxing，采用{" "}
        <a
          href="/licenses/newsnow-mit.txt"
          target="_blank"
          rel="noreferrer noopener"
          className="text-[var(--secondary-foreground)] underline-offset-2 hover:text-[var(--foreground)] hover:underline"
        >
          MIT License
        </a>
        。
      </p>
    </NewsnowBoardContainer>
  );
}

function NewsnowSourcesSkeleton() {
  return (
    <NewsnowBoardContainer spacing="content" className="py-6 md:py-7 relative z-10">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] md:gap-6 xl:gap-7">
        {[...Array(10)].map((_, i) => (
          <div
            key={i}
            className="h-[430px] content-card sm:h-[470px] md:h-viz-3xl p-5"
          >
            <Skeleton active paragraph={{ rows: 10 }} />
          </div>
        ))}
      </div>
    </NewsnowBoardContainer>
  );
}

export default function NewsnowColumnPage() {
  const { t } = useTranslation();
  useNewsnowUiSync();
  useNewsnowStream();
  const params = useParams<{ column?: string | string[] }>();
  const columnParam = params.column;
  const columnKey = Array.isArray(columnParam)
    ? (columnParam[0] ?? "hottest")
    : (columnParam ?? "hottest");
  const normalizedColumnKey = columnKey.toLowerCase();
  const {
    data: metadata,
    isLoading,
    isError,
    error: metadataError,
    refetch,
  } = useNewsMetadata();
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
        message: t("newsnow.column.primeRequestFailedTitle"),
        description: t("newsnow.column.primeRequestFailedDescription"),
      };
    }

    const details: string[] = [];
    if (primeFeedback.transientSourceIds.length > 0) {
      const names = resolveSourceNames(primeFeedback.transientSourceIds);
      details.push(
        t("newsnow.column.primeTransientFail", {
          count: primeFeedback.transientSourceIds.length,
          names: names ? `：${names}` : "",
        }),
      );
    }
    if (primeFeedback.unsupportedSourceIds.length > 0) {
      const names = resolveSourceNames(primeFeedback.unsupportedSourceIds);
      details.push(
        t("newsnow.column.primeUnsupportedFail", {
          count: primeFeedback.unsupportedSourceIds.length,
          names: names ? `：${names}` : "",
        }),
      );
    }

    return {
      message:
        primeFeedback.transientSourceIds.length > 0
          ? t("newsnow.column.primePartialTitle")
          : t("newsnow.column.primeSkippedTitle"),
      description: details.join(" "),
    };
  }, [metadata?.sources, primeFeedback, t]);

  const frameClass = "min-h-full relative overflow-hidden";

  if (isLoading) {
    return (
      <div className={frameClass}>
        <NewsnowHeader />
        <NewsnowSourcesSkeleton />
        <NewsnowAttribution />
      </div>
    );
  }

  if (isError) {
    return (
      <div className={frameClass}>
        <NewsnowHeader />
        <div className="flex min-h-[65vh] w-full items-center justify-center p-8 relative z-10">
          <DataStateBoundary
            className="w-full"
            state={{ kind: "blockingError", error: metadataError }}
            onRetry={() => refetch()}
          />
        </div>
        <NewsnowAttribution />
      </div>
    );
  }

  if (resolvedColumnKey === "focus" && sourceIds.length === 0) {
    return (
      <div className={frameClass}>
        <NewsnowHeader />
        <div className="flex min-h-[65vh] items-center justify-center p-8 text-center relative z-10">
          <ChartEmptyState
            variant="empty"
            title={t("newsnow.column.noFocusTitle")}
            description={t("newsnow.column.noFocusDescription")}
            className="min-h-[40vh]"
          />
        </div>
        <NewsnowAttribution />
      </div>
    );
  }

  return (
    <div className={frameClass}>
      <div className="relative z-10">
        <NewsnowHeader />
        {visibleRealtimeUnread > 0 ? (
          <NewsnowBoardContainer spacing="section">
            <Alert
              showIcon
              type="info"
              className="border-none"
              message={<span className="font-semibold text-[var(--foreground)]">{t("newsnow.column.realtimeReached", { count: visibleRealtimeUnread })}</span>}
              description={
                <div className="space-y-1 mt-1 text-[var(--secondary-foreground)]">
                  <p>{t("newsnow.column.realtimeDescription")}</p>
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
                    type="primary"
                    size="small"
                    loading={refreshingSources}
                    onClick={() => void runPrimeSources(sourceIds)}
                  >
                    {t("newsnow.column.refreshNow")}
                  </Button>
                  <Button size="small" type="text" className="font-medium text-[var(--secondary-foreground)] hover:text-[var(--foreground)]" onClick={() => clearAllLiveUnread()}>
                    {t("newsnow.column.markRead")}
                  </Button>
                </Space>
              }
            />
          </NewsnowBoardContainer>
        ) : null}
        {primeFeedbackSummary ? (
          <NewsnowBoardContainer spacing="section">
            <Alert
              showIcon
              closable
              type="warning"
              className="border-none"
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
                    {t("newsnow.column.retryFailedSources")}
                  </Button>
                ) : undefined
              }
            />
          </NewsnowBoardContainer>
        ) : null}
        {!realtimeConnected && realtimeConnectionError ? (
          <NewsnowBoardContainer spacing="section">
            <Alert
              showIcon
              type="warning"
              className="border-none"
              message={<span className="font-semibold">{t("newsnow.column.realtimeUnavailable")}</span>}
              description={<span className="opacity-80">{realtimeConnectionError}</span>}
            />
          </NewsnowBoardContainer>
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
