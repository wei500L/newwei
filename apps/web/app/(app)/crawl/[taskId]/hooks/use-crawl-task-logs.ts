"use client";

/**
 * Crawl Task Detail 任务日志域（FE-批5A：自 task-detail.tsx 拆出）。
 * REST admin/quality/task-logs（queue=crawl4ai、jobId=taskId、limit=100）
 * 为唯一数据源：仅 settings.manage 且 authenticated 时初次加载 + 手动
 * 刷新，单飞（in-flight 去重）、非 silent 请求展示 loading/error；
 * 不由 Socket 或 fallback polling 触发。taskId 变化清空展开行，
 * logs 更新时清理已不存在的 expanded keys。
 */

import { useCallback, useEffect, useRef, useState, type Key } from "react";

import type { createApiClient } from "@/lib/api-client";

import type {
  TaskDetailMessageApi,
  TaskLogRecord,
} from "../task-detail-types";

type CrawlApiClient = ReturnType<typeof createApiClient>;

interface UseCrawlTaskLogsOptions {
  apiClient: CrawlApiClient;
  canView: boolean;
  canViewTaskLogs: boolean;
  authenticated: boolean;
  taskId: string;
  message: TaskDetailMessageApi;
}

interface CrawlTaskLogsModel {
  logs: TaskLogRecord[];
  loading: boolean;
  error: string | null;
  expandedKeys: string[];
  reload: () => Promise<void>;
  onExpandedRowsChange: (expandedRows: readonly Key[]) => void;
}

export function useCrawlTaskLogs({
  apiClient,
  canView,
  canViewTaskLogs,
  authenticated,
  taskId,
  message,
}: UseCrawlTaskLogsOptions): CrawlTaskLogsModel {
  const taskLogsLoadingRef = useRef(false);
  const [taskLogs, setTaskLogs] = useState<TaskLogRecord[]>([]);
  const [expandedTaskLogKeys, setExpandedTaskLogKeys] = useState<string[]>([]);
  const [taskLogsLoading, setTaskLogsLoading] = useState(false);
  const [taskLogsError, setTaskLogsError] = useState<string | null>(null);

  const loadTaskLogs = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!canViewTaskLogs) {
        return;
      }
      if (taskLogsLoadingRef.current) {
        return;
      }
      const silent = options?.silent === true;
      taskLogsLoadingRef.current = true;
      if (!silent) {
        setTaskLogsLoading(true);
        setTaskLogsError(null);
      }
      try {
        const res = await apiClient.get<TaskLogRecord[]>(
          "admin/quality/task-logs",
          {
            params: {
              queue: "crawl4ai",
              jobId: taskId,
              limit: 100,
            },
          },
        );
        setTaskLogs(Array.isArray(res.data) ? res.data : []);
        setTaskLogsError(null);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!silent) {
          setTaskLogsError(reason);
          message.error(reason);
        }
      } finally {
        if (!silent) {
          setTaskLogsLoading(false);
        }
        taskLogsLoadingRef.current = false;
      }
    },
    [apiClient, canViewTaskLogs, message, taskId],
  );

  useEffect(() => {
    if (!canViewTaskLogs || !canView || !authenticated) {
      return;
    }
    void loadTaskLogs();
  }, [authenticated, canView, canViewTaskLogs, loadTaskLogs]);

  useEffect(() => {
    setExpandedTaskLogKeys((current) => {
      const next = current.filter((key) =>
        taskLogs.some((log) => log.id === key),
      );
      return next.length === current.length ? current : next;
    });
  }, [taskLogs]);

  useEffect(() => {
    setExpandedTaskLogKeys([]);
  }, [taskId]);

  return {
    logs: taskLogs,
    loading: taskLogsLoading,
    error: taskLogsError,
    expandedKeys: expandedTaskLogKeys,
    reload: () => loadTaskLogs(),
    onExpandedRowsChange: (expandedRows) =>
      setExpandedTaskLogKeys(expandedRows.map((key) => String(key))),
  };
}
