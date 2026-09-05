"use client";

/**
 * Crawl Task Detail 结果回填（FE-批5A：自 task-detail.tsx 拆出）。
 * 50×20 批次、每批 15s 超时、onlyMissing 游标迭代、稳定 message key、
 * 五种结果 notice 与空态；执行前 Modal confirm（空态不弹确认）。
 */

import type { FetchResult } from "@apollo/client";
import { Modal } from "antd";
import { useState } from "react";

import {
  useIngestCrawlTaskResultsToItemsMutation,
  type IngestCrawlTaskResultsToItemsMutation,
} from "@/graphql/generated";

import {
  BACKFILL_BATCH_TIMEOUT_MS,
  withTimeout,
} from "../task-detail-formatters";
import type {
  BackfillNotice,
  CrawlTaskDetailTask,
  TaskDetailMessageApi,
  TaskDetailTranslate,
} from "../task-detail-types";

export interface UseCrawlTaskBackfillOptions {
  task: CrawlTaskDetailTask | null;
  canCreateItem: boolean;
  refetch: () => Promise<unknown>;
  message: TaskDetailMessageApi;
  t: TaskDetailTranslate;
}

export interface CrawlBackfillController {
  /** 入口：无结果且无 lastResultAt 直接执行，否则弹确认框。 */
  run: () => void;
  running: boolean;
  unavailable: boolean;
  notice: BackfillNotice | null;
  dismissNotice: () => void;
}

export function useCrawlTaskBackfill({
  task,
  canCreateItem,
  refetch,
  message,
  t,
}: UseCrawlTaskBackfillOptions): CrawlBackfillController {
  const [ingestCrawlTaskResultsToItems] =
    useIngestCrawlTaskResultsToItemsMutation();
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillNotice, setBackfillNotice] = useState<BackfillNotice | null>(
    null,
  );

  const runBackfillToItems = async () => {
    if (!task || !canCreateItem) {
      return;
    }
    if ((task.results?.length ?? 0) === 0 && !task.lastResultAt) {
      const notice: BackfillNotice = {
        type: "info",
        message: t("crawl.detail.backfill.emptyTitle"),
        description: t("crawl.detail.backfill.emptyDescription"),
      };
      setBackfillNotice(notice);
      message.info(notice.message);
      return;
    }

    const messageKey = `crawl-backfill-${task.id}`;
    const batchLimit = 50;
    const maxBatches = 20;
    let after: string | null = null;
    let scannedTotal = 0;
    let ingestedTotal = 0;
    let skippedTotal = 0;
    let failedTotal = 0;

    setBackfillRunning(true);
    setBackfillNotice(null);
    message.loading({
      key: messageKey,
      duration: 0,
      content: t("crawl.detail.backfill.running"),
    });

    try {
      for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
        const response: FetchResult<IngestCrawlTaskResultsToItemsMutation> =
          await withTimeout(
            ingestCrawlTaskResultsToItems({
              variables: {
                taskId: task.id,
                after,
                limit: batchLimit,
                onlyMissing: true,
              },
            }),
            BACKFILL_BATCH_TIMEOUT_MS,
            t("crawl.detail.backfill.timeout"),
          );
        const summary:
          | IngestCrawlTaskResultsToItemsMutation["ingestCrawlTaskResultsToItems"]
          | null
          | undefined = response.data?.ingestCrawlTaskResultsToItems;
        if (!summary) {
          break;
        }

        scannedTotal += summary.scanned;
        ingestedTotal += summary.ingested;
        skippedTotal += summary.skippedExisting;
        failedTotal += summary.failed;

        message.loading({
          key: messageKey,
          duration: 0,
          content: t("crawl.detail.backfill.progress", {
            ingested: ingestedTotal,
            skipped: skippedTotal,
            failed: failedTotal,
          }),
        });

        after = summary.nextCursor ?? null;
        if (!summary.hasMore || !after) {
          break;
        }
      }

      const summaryDescription = t("crawl.detail.backfill.summary", {
        ingested: ingestedTotal,
        skipped: skippedTotal,
        failed: failedTotal,
        scanned: scannedTotal,
      });
      let notice: BackfillNotice;
      if (scannedTotal === 0) {
        notice = {
          type: "info",
          message: t("crawl.detail.backfill.emptyTitle"),
          description: t("crawl.detail.backfill.emptyDescription"),
        };
        message.info({
          key: messageKey,
          content: notice.message,
        });
      } else if (ingestedTotal === 0 && failedTotal === 0) {
        notice = {
          type: "info",
          message: t("crawl.detail.backfill.noMissingTitle"),
          description: summaryDescription,
        };
        message.info({
          key: messageKey,
          content: notice.message,
        });
      } else if (failedTotal > 0) {
        notice = {
          type: ingestedTotal > 0 ? "warning" : "error",
          message: t("crawl.detail.backfill.partialTitle"),
          description: summaryDescription,
        };
        if (notice.type === "error") {
          message.error({
            key: messageKey,
            content: notice.message,
          });
        } else {
          message.warning({
            key: messageKey,
            content: notice.message,
          });
        }
      } else {
        notice = {
          type: "success",
          message: t("crawl.detail.backfill.done"),
          description: summaryDescription,
        };
        message.success({
          key: messageKey,
          content: notice.message,
        });
      }
      setBackfillNotice(notice);
      await refetch();
    } catch (error) {
      const description =
        error instanceof Error
          ? error.message
          : t("common.operationFailed");
      setBackfillNotice({
        type: "error",
        message: t("crawl.detail.backfill.failedTitle"),
        description,
      });
      message.error({
        key: messageKey,
        content: description,
      });
    } finally {
      setBackfillRunning(false);
    }
  };

  const run = () => {
    if (!task || !canCreateItem) {
      return;
    }
    if ((task.results?.length ?? 0) === 0 && !task.lastResultAt) {
      void runBackfillToItems();
      return;
    }

    Modal.confirm({
      title: t("crawl.detail.backfill.confirmTitle"),
      content: t("crawl.detail.backfill.confirmDescription"),
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      onOk: runBackfillToItems,
    });
  };

  return {
    run,
    running: backfillRunning,
    unavailable:
      (task?.results?.length ?? 0) === 0 && !task?.lastResultAt,
    notice: backfillNotice,
    dismissNotice: () => setBackfillNotice(null),
  };
}
