"use client";

/**
 * Crawl Task Detail 任务操作（FE-批5A：自 task-detail.tsx 拆出）。
 * retry（unsupported legacy proxy 阻断）与 ingest-to-items 开关
 * （canManage + items.write 门禁），成功后 refetch。
 */

import {
  useRetryCrawlTaskMutation,
  useUpdateCrawlTaskIngestToItemsMutation,
} from "@/graphql/generated";
import type { CrawlConfigPolicyIssue } from "@/lib/crawl-config-policy";

import { formatPolicyIssues } from "../task-detail-formatters";
import type {
  CrawlTaskDetailTask,
  TaskDetailMessageApi,
  TaskDetailTranslate,
} from "../task-detail-types";

interface UseCrawlTaskActionsOptions {
  task: CrawlTaskDetailTask | null;
  canManage: boolean;
  hasItemsWrite: boolean;
  hasUnsupportedLegacyProxy: boolean;
  proxyIssues: CrawlConfigPolicyIssue[];
  refetch: () => Promise<unknown>;
  message: TaskDetailMessageApi;
  t: TaskDetailTranslate;
}

export interface CrawlTaskActionController {
  retry: () => Promise<void>;
  retrying: boolean;
  toggleIngestToItems: (enabled: boolean) => Promise<void>;
  updatingIngest: boolean;
}

export function useCrawlTaskActions({
  task,
  canManage,
  hasItemsWrite,
  hasUnsupportedLegacyProxy,
  proxyIssues,
  refetch,
  message,
  t,
}: UseCrawlTaskActionsOptions): CrawlTaskActionController {
  const [retryTask, { loading: retrying }] = useRetryCrawlTaskMutation();
  const [updateIngestToItems, { loading: updatingIngest }] =
    useUpdateCrawlTaskIngestToItemsMutation();

  const retry = async () => {
    if (!task) return;
    if (hasUnsupportedLegacyProxy) {
      message.error(formatPolicyIssues(proxyIssues, t));
      return;
    }
    try {
      await retryTask({ variables: { id: task.id } });
      message.success(t("crawl.detail.retryQueued"));
      await refetch();
    } catch (error: unknown) {
      message.error((error as Error).message ?? t("crawl.detail.retryFailed"));
    }
  };

  const toggleIngestToItems = async (enabled: boolean) => {
    if (!task || !canManage) {
      return;
    }
    if (enabled && !hasItemsWrite) {
      message.error(t("crawl.settings.ingestToItemsNoPermission"));
      return;
    }

    try {
      await updateIngestToItems({
        variables: {
          id: task.id,
          enabled,
        },
      });
      message.success(t("common.updated"));
      await refetch();
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("common.operationFailed"),
      );
    }
  };

  return { retry, retrying, toggleIngestToItems, updatingIngest };
}
