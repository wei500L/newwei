"use client";

/**
 * Crawl Task Detail 查询与结果过滤状态（FE-批5A：自 task-detail.tsx 拆出）。
 * 单一所有者：resultLimit / resultSearch / resultSearchInput 与
 * useCrawlTaskQuery 调用全部收敛在本 hook，fetchPolicy 语义原样保持
 * （cache-and-network + nextFetchPolicy cache-first + !canView skip）。
 */

import { useState } from "react";

import { useCrawlTaskQuery } from "@/graphql/generated";

import type { CrawlTaskDetailTask } from "../task-detail-types";

interface CrawlTaskDetailQueryOptions {
  taskId: string;
  canView: boolean;
}

interface CrawlTaskDetailQueryController {
  task: CrawlTaskDetailTask | null;
  loading: boolean;
  refetch: ReturnType<typeof useCrawlTaskQuery>["refetch"];
  startPolling: ReturnType<typeof useCrawlTaskQuery>["startPolling"];
  stopPolling: ReturnType<typeof useCrawlTaskQuery>["stopPolling"];
  limit: number;
  searchInput: string;
  setLimit: (limit: number) => void;
  /** 输入框 onChange：更新输入值；清空时立即复位已提交搜索。 */
  changeSearchInput: (value: string) => void;
  /** Enter / 搜索按钮：提交 trim 后的搜索词并回写输入框。 */
  submitSearchInput: () => void;
}

export function useCrawlTaskDetailQuery({
  taskId,
  canView,
}: CrawlTaskDetailQueryOptions): CrawlTaskDetailQueryController {
  const [resultLimit, setResultLimit] = useState(20);
  const [resultSearch, setResultSearch] = useState<string>();
  const [resultSearchInput, setResultSearchInput] = useState("");

  const { data, loading, refetch, startPolling, stopPolling } =
    useCrawlTaskQuery({
      variables: {
        id: taskId,
        resultLimit,
        resultSearch: resultSearch ?? null,
      },
      fetchPolicy: "cache-and-network",
      nextFetchPolicy: "cache-first",
      skip: !canView,
    });

  return {
    task: data?.crawlTask ?? null,
    loading,
    refetch,
    startPolling,
    stopPolling,
    limit: resultLimit,
    searchInput: resultSearchInput,
    setLimit: setResultLimit,
    changeSearchInput: (value: string) => {
      setResultSearchInput(value);
      if (!value) {
        setResultSearch(undefined);
      }
    },
    submitSearchInput: () => {
      const nextValue = resultSearchInput.trim();
      setResultSearch(nextValue || undefined);
      setResultSearchInput(nextValue);
    },
  };
}
