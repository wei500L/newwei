"use client";

import { StarOutlined } from "@ant-design/icons";
import { Skeleton, Empty, Button, Result, Alert, Space } from "antd";
import { useParams } from "next/navigation";
import { useEffect, useMemo } from "react";

import { useTheme } from "@/hooks/use-theme";

import { NewsnowColumn } from "../components/newsnow-column";
import { NewsnowHeader } from "../components/newsnow-header";
import { useNewsMetadata, useBatchPrefetch } from "../hooks/use-news-sources";
import { useNewsnowStream } from "../hooks/use-newsnow-stream";
import { useNewsnowUiSync } from "../hooks/use-newsnow-ui-sync";
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
    liveUnreadBySource,
    realtimeHighlights,
    realtimeConnected,
    realtimeConnectionError,
    clearLiveUnread,
    clearAllLiveUnread,
  } = useNewsnowStore();
  const batchPrefetch = useBatchPrefetch();
  const resolvedColumnKey = metadata?.columns[normalizedColumnKey]
    ? normalizedColumnKey
    : "hottest";

  const sourceIds = useMemo(
    () =>
      resolvedColumnKey === "focus"
        ? focusSources
        : metadata?.columns[resolvedColumnKey]?.sources || [],
    [focusSources, metadata?.columns, resolvedColumnKey],
  );

  useEffect(() => {
    if (sourceIds.length > 0) {
      batchPrefetch(sourceIds);
    }
  }, [sourceIds, batchPrefetch]);

  const visibleRealtimeUnread = sourceIds.reduce(
    (total, sourceId) => total + (liveUnreadBySource[sourceId] ?? 0),
    0,
  );
  const visibleRealtimeHighlights = realtimeHighlights
    .filter((entry) => sourceIds.includes(entry.sourceId))
    .slice(0, 3);

  const frameClass = "min-h-full";
  const frameStyle = isDark
    ? {
        backgroundColor: "#04060b",
        backgroundImage:
          "radial-gradient(1100px 420px at 8% -12%, rgba(59,130,246,0.15), transparent 62%), radial-gradient(960px 360px at 96% -14%, rgba(20,184,166,0.11), transparent 62%), linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0) 30%), linear-gradient(180deg, #04060b 0%, #03050a 62%, #020409 100%)",
      }
    : {
        backgroundColor: "#f5f8ff",
        backgroundImage:
          "radial-gradient(960px 380px at 8% -12%, rgba(59,130,246,0.16), transparent 62%), radial-gradient(900px 360px at 96% -14%, rgba(14,165,233,0.14), transparent 62%), linear-gradient(180deg, rgba(255,255,255,0.94), rgba(241,245,249,0.96) 40%, rgba(236,243,252,0.98) 100%)",
      };

  if (isLoading) {
    return (
      <div className={frameClass} style={frameStyle}>
        <NewsnowHeader />
        <div className="mx-auto w-full max-w-[1760px] px-4 py-6 md:px-6 md:py-7 xl:px-8">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] md:gap-6 xl:gap-7">
            {[...Array(10)].map((_, i) => (
              <div
                key={i}
                className={`h-[430px] rounded-3xl border p-5 sm:h-[470px] lg:h-[500px] ${
                  isDark
                    ? "border-zinc-800 bg-zinc-900/80"
                    : "border-slate-200 bg-white/85"
                }`}
              >
                <Skeleton active paragraph={{ rows: 10 }} />
              </div>
            ))}
          </div>
        </div>
        <NewsnowAttribution />
      </div>
    );
  }

  if (isError) {
    return (
      <div className={frameClass} style={frameStyle}>
        <NewsnowHeader />
        <div className="flex min-h-[65vh] items-center justify-center p-8">
          <Result
            status="error"
            title="加载失败"
            subTitle="无法获取新闻源数据，请稍后重试"
            extra={
              <Button type="primary" onClick={() => refetch()}>
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
        <div className="flex min-h-[65vh] items-center justify-center p-8 text-center">
          <Empty
            image={
              <StarOutlined
                className={`text-6xl ${isDark ? "text-zinc-500" : "text-slate-400"}`}
              />
            }
            description={
              <div className="space-y-1">
                <p
                  className={`text-lg font-medium ${isDark ? "text-zinc-100" : "text-slate-900"}`}
                >
                  还没有关注的源
                </p>
                <p className={isDark ? "text-zinc-400" : "text-slate-600"}>
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
      <NewsnowHeader />
      {visibleRealtimeUnread > 0 ? (
        <div className="mx-auto w-full max-w-[1760px] px-4 pt-4 md:px-6 xl:px-8">
          <Alert
            showIcon
            type="info"
            message={`实时推送到达 ${visibleRealtimeUnread} 条新内容`}
            description={
              <div className="space-y-1">
                <p>已检测到数据源更新。你可以立即刷新当前栏目并清空未读计数。</p>
                {visibleRealtimeHighlights.length > 0 ? (
                  <ul className="list-disc pl-5">
                    {visibleRealtimeHighlights.map((entry) => {
                      const sourceName =
                        metadata?.sources[entry.sourceId]?.name ?? entry.sourceId;
                      const firstTitle = entry.topTitles[0];
                      return (
                        <li key={`${entry.sourceId}:${entry.timestamp}`}>
                          <span className="font-medium">{sourceName}</span>
                          <span>{` +${entry.count}`}</span>
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
                  onClick={() => {
                    void batchPrefetch(sourceIds);
                    sourceIds.forEach((sourceId) => clearLiveUnread(sourceId));
                  }}
                >
                  立即刷新
                </Button>
                <Button size="small" type="text" onClick={() => clearAllLiveUnread()}>
                  标记已读
                </Button>
              </Space>
            }
          />
        </div>
      ) : null}
      {!realtimeConnected && realtimeConnectionError ? (
        <div className="mx-auto w-full max-w-[1760px] px-4 pt-4 md:px-6 xl:px-8">
          <Alert
            showIcon
            type="warning"
            message="实时连接不可用"
            description={realtimeConnectionError}
          />
        </div>
      ) : null}
      <main>
        <NewsnowColumn
          columnKey={resolvedColumnKey}
          sourceIds={sourceIds}
          sources={metadata?.sources || {}}
        />
      </main>
      <NewsnowAttribution />
    </div>
  );
}
