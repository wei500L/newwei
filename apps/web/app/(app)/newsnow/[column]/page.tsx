"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { NewsnowHeader } from "../components/newsnow-header";
import { NewsnowColumn } from "../components/newsnow-column";
import { useNewsMetadata, useBatchPrefetch } from "../hooks/use-news-sources";
import { useNewsnowStore } from "../store/newsnow-store";
import { Skeleton, Empty, Button, Result } from "antd";
import { StarOutlined } from "@ant-design/icons";

function NewsnowAttribution() {
  return (
    <footer className="mx-auto w-full max-w-[1880px] px-3 pb-5 pt-2 text-center text-xs text-zinc-500 md:px-4">
      <p className="leading-6">
        本页面基于{" "}
        <a
          href="https://github.com/ourongxing/newsnow"
          target="_blank"
          rel="noreferrer noopener"
          className="text-zinc-300 underline-offset-2 hover:text-zinc-100 hover:underline"
        >
          ourongxing/newsnow
        </a>{" "}
        开源项目改造，Copyright (c) ourongxing，采用{" "}
        <a
          href="/licenses/newsnow-mit.txt"
          target="_blank"
          rel="noreferrer noopener"
          className="text-zinc-300 underline-offset-2 hover:text-zinc-100 hover:underline"
        >
          MIT License
        </a>
        。
      </p>
    </footer>
  );
}

export default function NewsnowColumnPage() {
  const params = useParams<{ column?: string | string[] }>();
  const columnParam = params.column;
  const columnKey = Array.isArray(columnParam)
    ? (columnParam[0] ?? "hottest")
    : (columnParam ?? "hottest");
  const normalizedColumnKey = columnKey.toLowerCase();
  const { data: metadata, isLoading, isError, refetch } = useNewsMetadata();
  const { focusSources } = useNewsnowStore();
  const batchPrefetch = useBatchPrefetch();
  const resolvedColumnKey = metadata?.columns[normalizedColumnKey]
    ? normalizedColumnKey
    : "hottest";

  const sourceIds =
    resolvedColumnKey === "focus"
      ? focusSources
      : metadata?.columns[resolvedColumnKey]?.sources || [];

  useEffect(() => {
    if (sourceIds.length > 0) {
      batchPrefetch(sourceIds);
    }
  }, [sourceIds, batchPrefetch]);

  const frameClass = "min-h-full";
  const frameStyle = {
    backgroundColor: "#04060b",
    backgroundImage:
      "radial-gradient(1100px 420px at 8% -12%, rgba(59,130,246,0.15), transparent 62%), radial-gradient(960px 360px at 96% -14%, rgba(20,184,166,0.11), transparent 62%), linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0) 30%), linear-gradient(180deg, #04060b 0%, #03050a 62%, #020409 100%)",
  } as const;

  if (isLoading) {
    return (
      <div className={frameClass} style={frameStyle}>
        <NewsnowHeader />
        <div className="mx-auto w-full max-w-[1880px] px-3 py-4 md:px-4 md:py-5">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4 md:gap-5">
            {[...Array(10)].map((_, i) => (
              <div
                key={i}
                className="h-[500px] rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4"
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
            image={<StarOutlined className="text-6xl text-zinc-500" />}
            description={
              <div className="space-y-1">
                <p className="text-lg font-medium text-zinc-100">
                  还没有关注的源
                </p>
                <p className="text-zinc-400">
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
