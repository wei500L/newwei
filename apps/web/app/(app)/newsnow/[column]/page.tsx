"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { NewsnowHeader } from "../components/newsnow-header";
import { NewsnowColumn } from "../components/newsnow-column";
import { useNewsMetadata, useBatchPrefetch } from "../hooks/use-news-sources";
import { useNewsnowStore } from "../store/newsnow-store";
import { Skeleton, Empty, Button, Result } from "antd";
import { StarOutlined } from "@ant-design/icons";

export default function NewsnowColumnPage() {
  const params = useParams<{ column?: string | string[] }>();
  const columnParam = params.column;
  const columnKey = Array.isArray(columnParam) ? (columnParam[0] ?? "hottest") : (columnParam ?? "hottest");
  const { data: metadata, isLoading, isError, refetch } = useNewsMetadata();
  const { focusSources } = useNewsnowStore();
  const batchPrefetch = useBatchPrefetch();

  const sourceIds = columnKey === "focus" 
    ? focusSources 
    : metadata?.columns[columnKey]?.sources || [];

  useEffect(() => {
    if (sourceIds.length > 0) {
      batchPrefetch(sourceIds);
    }
  }, [sourceIds, batchPrefetch]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
        <NewsnowHeader />
        <div className="mx-auto max-w-7xl px-4 py-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {[...Array(10)].map((_, i) => (
              <div key={i} className="h-[500px] rounded-lg border bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <Skeleton active paragraph={{ rows: 10 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
        <NewsnowHeader />
        <div className="flex flex-1 items-center justify-center p-8">
          <Result
            status="error"
            title="加载失败"
            subTitle="无法获取新闻源数据，请稍后重试"
            extra={<Button type="primary" onClick={() => refetch()}>重试</Button>}
          />
        </div>
      </div>
    );
  }

  if (columnKey === "focus" && sourceIds.length === 0) {
    return (
      <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
        <NewsnowHeader />
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <Empty
            image={<StarOutlined className="text-6xl text-zinc-300 dark:text-zinc-700" />}
            description={
              <div className="space-y-1">
                <p className="text-lg font-medium text-zinc-800 dark:text-zinc-200">还没有关注的源</p>
                <p className="text-zinc-500">点击搜索按钮或在其他列中点击星标来关注新闻源</p>
              </div>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <NewsnowHeader />
      <main className="flex-1">
        <NewsnowColumn 
          columnKey={columnKey} 
          sourceIds={sourceIds} 
          sources={metadata?.sources || {}} 
        />
      </main>
    </div>
  );
}
