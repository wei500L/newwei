"use client";

import { useApolloClient } from "@apollo/client";
import { useEffect, useMemo, useState } from "react";

import { AlertEventsStreamDocument, useAlertEventsQuery } from "@/graphql/generated";
import { createCoalescedRefetchScheduler } from "@/lib/coalesced-refetch";

import type { AlertEventItem } from "../alert-center.utils";

/**
 * Alert Center 事件数据 feed（FE-批3B 从 alert-center.tsx 提取）。
 *
 * 数据域职责（不含展示/分页 JSX/URL codec）：
 * - AlertEvents query：eventsLimit 300→500，`alerts.read` fail-closed skip；
 * - AlertEventsStream 订阅 → 800ms coalesced refetch（清理 unsubscribe/cancel）；
 * - 事件按 triggeredAt 倒序；
 * - sampled/load-more 状态（MAX_EVENTS_LIMIT=500，每次 +200）；
 * - refetch 接口（页面刷新 / 批量成功后 / 深链扩充共用）；
 * - 深链 eventId 不在当前数据集时：扩充 limit 至 500 并 refetch（一次性）。
 *
 * 会话/权限派生（resolveAlertCenterAccess）留在编排层：DataStateBoundary
 * 分派同样消费 authenticated/canReadAlerts/shouldQueryEvents，此处只接收
 * fail-closed 的查询门禁布尔值。消息提示 messageApi 同理由编排层传入
 * （未渲染 context 元素的 useMessage 实例不会真正展示消息）。
 */

export interface AlertMessageApi {
  success: (content: string) => void;
  error: (content: string) => void;
  warning: (content: string) => void;
}

const MAX_EVENTS_LIMIT = 500;

export interface UseAlertEventsFeedOptions {
  /** fail-closed 查询门禁（alerts.read），由编排层派生。 */
  shouldQueryEvents: boolean;
  messageApi: AlertMessageApi;
  /** 深链事件不在数据集时 refetch 失败的提示文案。 */
  errorMessage: (error: unknown) => string;
}

export interface UseAlertEventsFeedResult {
  eventsData: ReturnType<typeof useAlertEventsQuery>["data"];
  eventsError: ReturnType<typeof useAlertEventsQuery>["error"];
  eventsLoading: ReturnType<typeof useAlertEventsQuery>["loading"];
  refetchEvents: ReturnType<typeof useAlertEventsQuery>["refetch"];
  sortedEvents: AlertEventItem[];
  isLikelySampled: boolean;
  canLoadMoreHistory: boolean;
  eventsLimit: number;
  loadMoreEvents: () => Promise<void>;
  /** 选中事件不在已加载数据集时：扩充 limit 并 refetch（深链定位用）。 */
  ensureEventLoaded: (eventId: string) => Promise<void>;
}

export function useAlertEventsFeed({
  shouldQueryEvents,
  messageApi,
  errorMessage,
}: UseAlertEventsFeedOptions): UseAlertEventsFeedResult {
  const client = useApolloClient();

  const [eventsLimit, setEventsLimit] = useState(300);

  const {
    data: eventsData,
    error: eventsError,
    loading: eventsLoading,
    refetch: refetchEvents,
  } = useAlertEventsQuery({
    variables: { limit: eventsLimit },
    skip: !shouldQueryEvents,
  });

  useEffect(() => {
    if (!shouldQueryEvents) {
      return;
    }
    const refetchScheduler = createCoalescedRefetchScheduler(() =>
      refetchEvents(),
    );
    const sub = client
      .subscribe({
        query: AlertEventsStreamDocument,
      })
      .subscribe({
        next: () => {
          refetchScheduler.schedule();
        },
      });

    return () => {
      sub.unsubscribe();
      refetchScheduler.cancel();
    };
  }, [client, refetchEvents, shouldQueryEvents]);

  const sortedEvents = useMemo(() => {
    const events = eventsData?.alertEvents ?? [];
    return [...events].sort((a, b) => {
      const aTime = new Date(a.triggeredAt).getTime();
      const bTime = new Date(b.triggeredAt).getTime();
      return bTime - aTime;
    });
  }, [eventsData?.alertEvents]);

  const isLikelySampled = sortedEvents.length >= eventsLimit;
  const canLoadMoreHistory = eventsLimit < MAX_EVENTS_LIMIT;

  const loadMoreEvents = async () => {
    if (!canLoadMoreHistory) {
      return;
    }
    const nextLimit = Math.min(eventsLimit + 200, MAX_EVENTS_LIMIT);
    setEventsLimit(nextLimit);
    await refetchEvents({ limit: nextLimit });
  };

  const ensureEventLoaded = async (eventId: string) => {
    if (!eventId) {
      return;
    }
    const exists = sortedEvents.some((event) => event.id === eventId);
    if (!exists) {
      const nextLimit = Math.max(eventsLimit, MAX_EVENTS_LIMIT);
      setEventsLimit(nextLimit);
      try {
        await refetchEvents({ limit: nextLimit });
      } catch (error) {
        messageApi.error(
          error instanceof Error ? error.message : errorMessage(error),
        );
      }
    }
  };

  return {
    eventsData,
    eventsError,
    eventsLoading,
    refetchEvents,
    sortedEvents,
    isLikelySampled,
    canLoadMoreHistory,
    eventsLimit,
    loadMoreEvents,
    ensureEventLoaded,
  };
}
