"use client";

import { useEffect, useMemo, useState } from "react";

import type { AlertEventItem } from "../alert-center.utils";

/**
 * Alert Center 批量选择域（FE-批3B 从 alert-center.tsx 提取）。
 *
 * - 行勾选/全选（当前页）、事件集变化时清理失效 id；
 * - selectedInFilter/selectedVisible/hiddenSelected 派生（筛选外隐藏
 *   选中数与一键清理，行为保持）；
 * - 导出 scope 派生（selected/page 两档）。
 */

export interface UseAlertEventBatchOptions {
  sortedEvents: AlertEventItem[];
  filteredEvents: AlertEventItem[];
  currentPageEvents: AlertEventItem[];
}

export interface UseAlertEventBatchResult {
  selectedEventIds: string[];
  selectedEventIdSet: Set<string>;
  selectedVisibleCount: number;
  hiddenSelectedCount: number;
  allVisibleSelected: boolean;
  clearHiddenSelection: () => void;
  toggleSelectAllVisible: (checked: boolean) => void;
  toggleEventSelection: (eventId: string, checked: boolean) => void;
  /** 批量成功后清空选择（调用方在 executeStatusUpdate 返回 >0 时调用）。 */
  clearSelection: () => void;
}

export function useAlertEventBatch({
  sortedEvents,
  filteredEvents,
  currentPageEvents,
}: UseAlertEventBatchOptions): UseAlertEventBatchResult {
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);

  // 事件集变化时清理失效 id（refetch 后事件消失的既有行为）
  useEffect(() => {
    const existingIds = new Set(sortedEvents.map((event) => event.id));
    setSelectedEventIds((prev) => prev.filter((id) => existingIds.has(id)));
  }, [sortedEvents]);

  const selectedEventIdSet = useMemo(
    () => new Set(selectedEventIds),
    [selectedEventIds],
  );

  const filteredEventIdSet = useMemo(
    () => new Set(filteredEvents.map((event) => event.id)),
    [filteredEvents],
  );

  const selectedInFilterCount = useMemo(
    () =>
      selectedEventIds.reduce(
        (count, eventId) =>
          filteredEventIdSet.has(eventId) ? count + 1 : count,
        0,
      ),
    [filteredEventIdSet, selectedEventIds],
  );
  const selectedVisibleCount = useMemo(
    () =>
      currentPageEvents.reduce(
        (count, event) =>
          selectedEventIdSet.has(event.id) ? count + 1 : count,
        0,
      ),
    [currentPageEvents, selectedEventIdSet],
  );
  const hiddenSelectedCount = Math.max(
    selectedEventIds.length - selectedInFilterCount,
    0,
  );
  const allVisibleSelected =
    currentPageEvents.length > 0 &&
    selectedVisibleCount === currentPageEvents.length;

  const clearHiddenSelection = () => {
    setSelectedEventIds((prev) =>
      prev.filter((id) => filteredEventIdSet.has(id)),
    );
  };

  const toggleSelectAllVisible = (checked: boolean) => {
    const visibleIds = currentPageEvents.map((event) => event.id);
    if (checked) {
      setSelectedEventIds((prev) => [...new Set([...prev, ...visibleIds])]);
      return;
    }
    const visibleSet = new Set(visibleIds);
    setSelectedEventIds((prev) => prev.filter((id) => !visibleSet.has(id)));
  };

  const toggleEventSelection = (eventId: string, checked: boolean) => {
    setSelectedEventIds((prev) => {
      if (checked) {
        return [...new Set([...prev, eventId])];
      }
      return prev.filter((id) => id !== eventId);
    });
  };

  const clearSelection = () => {
    setSelectedEventIds([]);
  };

  return {
    selectedEventIds,
    selectedEventIdSet,
    selectedVisibleCount,
    hiddenSelectedCount,
    allVisibleSelected,
    clearHiddenSelection,
    toggleSelectAllVisible,
    toggleEventSelection,
    clearSelection,
  };
}
