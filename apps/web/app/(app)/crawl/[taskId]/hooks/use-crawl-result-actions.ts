"use client";

/**
 * Crawl Task Detail 单结果创建 Item（FE-批5A：自 task-detail.tsx 拆出）。
 * items.write 门禁、空 resultId 拒绝、行级 loading、成功跳转
 * /items/{createdId}、finally 清理。
 */

import { gql, useMutation } from "@apollo/client";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type {
  TaskDetailMessageApi,
  TaskDetailTranslate,
} from "../task-detail-types";

const CREATE_ITEM_FROM_CRAWL_RESULT_MUTATION = gql`
  mutation CreateItemFromCrawlResult($resultId: String!) {
    createItemFromCrawlResult(resultId: $resultId) {
      id
      title
      status
    }
  }
`;

export interface UseCrawlResultActionsOptions {
  canCreateItem: boolean;
  message: TaskDetailMessageApi;
  t: TaskDetailTranslate;
}

export interface CrawlResultActionController {
  createItem: (resultId: string) => Promise<void>;
  ingesting: boolean;
  ingestingResultId: string | null;
  openItem: (itemId: string) => void;
}

export function useCrawlResultActions({
  canCreateItem,
  message,
  t,
}: UseCrawlResultActionsOptions): CrawlResultActionController {
  const router = useRouter();
  const [ingestingResultId, setIngestingResultId] = useState<string | null>(
    null,
  );
  const [createItemFromCrawlResult, { loading: ingesting }] = useMutation<{
    createItemFromCrawlResult: { id: string; title: string; status: string };
  }>(CREATE_ITEM_FROM_CRAWL_RESULT_MUTATION);

  const createItem = async (resultId: string) => {
    if (!canCreateItem) {
      return;
    }

    const normalizedId = resultId.trim();
    if (!normalizedId) {
      message.error(t("common.invalidInput"));
      return;
    }

    setIngestingResultId(normalizedId);
    try {
      const response = await createItemFromCrawlResult({
        variables: { resultId: normalizedId },
      });
      const createdId = response.data?.createItemFromCrawlResult?.id;
      message.success(t("crawl.detail.ingestQueued"));
      if (createdId) {
        router.push(`/items/${createdId}`);
      }
    } catch (error) {
      message.error(
        error instanceof Error
          ? error.message
          : t("common.operationFailed"),
      );
    } finally {
      setIngestingResultId(null);
    }
  };

  return {
    createItem,
    ingesting,
    ingestingResultId,
    openItem: (itemId) => router.push(`/items/${itemId}`),
  };
}
