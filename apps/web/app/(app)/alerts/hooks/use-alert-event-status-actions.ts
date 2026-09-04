"use client";

import { gql, useMutation } from "@apollo/client";
import { useState } from "react";

import type { AlertMessageApi } from "./use-alert-events-feed";

/**
 * Alert Center 状态修改与批量操作（FE-批3B 从 alert-center.tsx 提取）。
 *
 * 行为保持（由 characterization tests 锁定）：
 * - UpdateAlertEventStatus mutation，20 条一批 + Promise.allSettled；
 * - 成功/失败计数、batch progress（done/total）、部分成功提示；
 * - 任一成功后 refetch 事件（+ tuning）；
 * - `alerts.manage` 双重门禁：无权限时 executeStatusUpdate 直接短路返回，
 *   mutation 路径不可达（即使按钮被绕过渲染）。
 *
 * 消息提示与文案由编排层传入（messageApi 必须来自已渲染 context 的
 * useMessage 实例；t 由编排层的 i18n 上下文提供）。
 */

const UPDATE_ALERT_EVENT_STATUS = gql`
  mutation UpdateAlertEventStatus($input: UpdateAlertEventStatusInput!) {
    updateAlertEventStatus(input: $input) {
      id
      status
    }
  }
`;

interface UpdateAlertEventStatusData {
  updateAlertEventStatus: { id: string; status: string };
}

interface UpdateAlertEventStatusVariables {
  input: {
    eventId: string;
    status: string;
    note?: string | null;
  };
}

const STATUS_BATCH_SIZE = 20;

export interface UseAlertEventStatusActionsOptions {
  canManageAlerts: boolean;
  messageApi: AlertMessageApi;
  /** 成功提示文案（count/status 已插值）。 */
  successMessage: (count: number, status: string) => string;
  /** 部分失败提示文案（count 已插值）。 */
  partialFailureMessage: (count: number) => string;
  refetchAfterSuccess: () => Promise<void>;
}

export interface UseAlertEventStatusActionsResult {
  updatingStatus: boolean;
  batchProgress: { done: number; total: number } | null;
  /** 批量/单项统一入口：返回成功条数（无权限或空集时 0，不触碰 mutation）。 */
  executeStatusUpdate: (
    eventIds: string[],
    status: "confirmed" | "ignored",
    note: string | null,
  ) => Promise<number>;
}

export function useAlertEventStatusActions({
  canManageAlerts,
  messageApi,
  successMessage,
  partialFailureMessage,
  refetchAfterSuccess,
}: UseAlertEventStatusActionsOptions): UseAlertEventStatusActionsResult {
  const [batchProgress, setBatchProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const [updateEventStatus, { loading: updatingStatus }] = useMutation<
    UpdateAlertEventStatusData,
    UpdateAlertEventStatusVariables
  >(UPDATE_ALERT_EVENT_STATUS);

  const executeStatusUpdate = async (
    eventIds: string[],
    status: "confirmed" | "ignored",
    note: string | null,
  ) => {
    if (!canManageAlerts || eventIds.length === 0) {
      return 0;
    }

    const uniqueIds = [...new Set(eventIds)];
    let successCount = 0;
    let failCount = 0;
    let processed = 0;
    setBatchProgress({ done: 0, total: uniqueIds.length });

    for (let index = 0; index < uniqueIds.length; index += STATUS_BATCH_SIZE) {
      const currentBatch = uniqueIds.slice(index, index + STATUS_BATCH_SIZE);
      const results = await Promise.allSettled(
        currentBatch.map((eventId) =>
          updateEventStatus({
            variables: {
              input: {
                eventId,
                status,
                note,
              },
            },
          }),
        ),
      );
      successCount += results.filter(
        (result) => result.status === "fulfilled",
      ).length;
      failCount += results.filter(
        (result) => result.status === "rejected",
      ).length;
      processed += currentBatch.length;
      setBatchProgress({ done: processed, total: uniqueIds.length });
    }

    setBatchProgress(null);

    if (successCount > 0) {
      messageApi.success(successMessage(successCount, status));
    }
    if (failCount > 0) {
      messageApi.warning(partialFailureMessage(failCount));
    }

    if (successCount > 0) {
      await refetchAfterSuccess();
    }

    return successCount;
  };

  return {
    updatingStatus,
    batchProgress,
    executeStatusUpdate,
  };
}
