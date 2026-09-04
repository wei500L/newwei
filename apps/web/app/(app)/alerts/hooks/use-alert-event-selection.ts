"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  resolveSelectedEventId,
  type AlertEventItem,
} from "../alert-center.utils";

/**
 * Alert Center 选择与分页协调（FE-批3B 从 alert-center.tsx 提取）。
 *
 * FE-01 分页优先级契约（完整定义见 useAlertCenterUrlState 注释），
 * 由 alert-center 行为测试锁定：
 * 1. 外部/深链合法 eventId → 一次性定位到该事件所在页（自动写路径）；
 * 2. 手动 page/pageSize 不得被旧选择拉回（定位是一次性的）；
 * 3. 手动分页清除冲突 eventId（由 useAlertCenterUrlState setter 承载）；
 * 4. page 越界收敛仅在事件数据就绪后执行（加载期不改写 ?page=2）；
 * 5. 筛选重置 page=1（updateFilters 承载）；
 * 6. 未知 URL 参数保留（useUrlState 承载）。
 */

export interface UseAlertEventSelectionOptions {
  eventParam: string | null;
  sortedEvents: AlertEventItem[];
  filteredEvents: AlertEventItem[];
  listPage: number;
  listPageSize: number;
  listPageCount: number;
  isEventsDataReady: boolean;
  setEventId: (eventId: string | null) => void;
  setPagePreservingEventId: (page: number) => void;
}

export interface UseAlertEventSelectionResult {
  selectedEventId: string | null;
  selectedEvent: AlertEventItem | null;
  setSelectedEventId: React.Dispatch<React.SetStateAction<string | null>>;
  /** 行点击/深链选中：组件态 + URL eventId 写回。 */
  handleSelectEvent: (eventId: string) => void;
  /** filtered 中的序号（-1 = 被当前筛选排除）。 */
  selectedIndexInFiltered: number;
  /** filtered 中的前一/后一事件 id（无则为 null）。 */
  previousEventId: string | null;
  nextEventId: string | null;
}

export function useAlertEventSelection({
  eventParam,
  sortedEvents,
  filteredEvents,
  listPage,
  listPageSize,
  listPageCount,
  isEventsDataReady,
  setEventId,
  setPagePreservingEventId,
}: UseAlertEventSelectionOptions): UseAlertEventSelectionResult {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // 默认选中与 filtered-out 保留：合法 URL eventId 优先 → 仍存在的当前
  // 选中 → filtered 首项 → sorted 首项（被筛选排除的选中项保留，不强制切换）
  useEffect(() => {
    const nextSelectedEventId = resolveSelectedEventId({
      eventParam,
      selectedEventId,
      sortedEvents,
      filteredEvents,
    });
    if (nextSelectedEventId !== selectedEventId) {
      setSelectedEventId(nextSelectedEventId);
    }
  }, [eventParam, filteredEvents, selectedEventId, sortedEvents]);

  // page 越界收敛（优先级 6）：仅在事件查询完成后执行 —— 加载中/未授权
  // 时 filteredEvents 为空、listPageCount 恒为 1，此时收敛会把 URL ?page=2
  // 在数据到达前改写回 1，破坏纯 page 分享链接的恢复。走自动写路径保留
  // eventId：深链 ?eventId=X&page=99 收敛到最后一页后，下方的事件定位
  // （优先级 1）仍可执行，不因收敛丢失 eventId。
  useEffect(() => {
    if (isEventsDataReady && listPage > listPageCount) {
      setPagePreservingEventId(listPageCount);
    }
  }, [isEventsDataReady, listPage, listPageCount, setPagePreservingEventId]);

  // 外部 eventId（深链/分享链接/back-forward/行内点击）→ 一次性定位到该
  // 事件所在页（优先级 1/8）。eventParam 变化时把定位请求排入 ref，事件
  // 数据就绪后消费一次；此后不再监听 listPage —— 用户翻页 / 改 pageSize /
  // 筛选变化（优先级 2-4）不会被旧选中事件拉回。定位写入走自动路径
  // （保留 eventId），与用户分页的手动写入路径区分。
  const lastSeenEventParamRef = useRef<string | null>(eventParam);
  const pendingEventPositionRef = useRef<string | null>(eventParam);
  useEffect(() => {
    if (eventParam !== lastSeenEventParamRef.current) {
      lastSeenEventParamRef.current = eventParam;
      pendingEventPositionRef.current = eventParam;
    }
    const pending = pendingEventPositionRef.current;
    if (!pending) {
      return;
    }
    const index = filteredEvents.findIndex((event) => event.id === pending);
    if (index < 0) {
      // 事件不在当前筛选视图：已出现在数据集则放弃本次定位（与
      // resolveSelectedEventId 的「选中保留、页码不动」语义一致）；
      // 数据尚未加载（不在 sortedEvents）时保持等待。
      if (sortedEvents.some((event) => event.id === pending)) {
        pendingEventPositionRef.current = null;
      }
      return;
    }
    pendingEventPositionRef.current = null;
    const targetPage = Math.floor(index / listPageSize) + 1;
    if (targetPage !== listPage) {
      setPagePreservingEventId(targetPage);
    }
  }, [
    eventParam,
    filteredEvents,
    listPage,
    listPageSize,
    setPagePreservingEventId,
    sortedEvents,
  ]);

  const selectedEvent = useMemo(
    () => sortedEvents.find((event) => event.id === selectedEventId) ?? null,
    [selectedEventId, sortedEvents],
  );

  const handleSelectEvent = (eventId: string) => {
    setSelectedEventId(eventId);
    setEventId(eventId);
  };

  const selectedIndexInFiltered = filteredEvents.findIndex(
    (event) => event.id === selectedEventId,
  );
  const previousEventId =
    selectedIndexInFiltered > 0
      ? (filteredEvents[selectedIndexInFiltered - 1]?.id ?? null)
      : null;
  const nextEventId =
    selectedIndexInFiltered >= 0 &&
    selectedIndexInFiltered < filteredEvents.length - 1
      ? (filteredEvents[selectedIndexInFiltered + 1]?.id ?? null)
      : null;

  return {
    selectedEventId,
    selectedEvent,
    setSelectedEventId,
    handleSelectEvent,
    selectedIndexInFiltered,
    previousEventId,
    nextEventId,
  };
}
