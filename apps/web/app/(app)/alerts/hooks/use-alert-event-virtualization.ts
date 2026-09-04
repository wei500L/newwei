"use client";

import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";

import type { AlertEventItem } from "../alert-center.utils";
import {
  ALERT_EVENT_ROW_ESTIMATE_PX,
  shouldUpdateAlertEventsMetric,
  shouldVirtualizeAlertEvents,
} from "../alert-events-virtualization";

/**
 * Alert Center 事件列表虚拟化（FE-批3B 从 alert-center.tsx 提取）。
 *
 * - 25 条阈值启用窗口虚拟化（alert-events-virtualization 单一事实源）；
 * - scrollMargin 测量：RAF 调度 + ResizeObserver + resize/scroll 监听，
 *   卸载时全部清理（由行为测试锁定）；
 * - spacer（top/bottom）与行集合派生（virtual 行 → 当前页事件映射）。
 */

export interface AlertEventListEntry {
  event: AlertEventItem;
  key: string;
  virtualIndex: number;
}

export interface UseAlertEventVirtualizationResult {
  eventsListRef: React.RefObject<HTMLDivElement | null>;
  shouldVirtualize: boolean;
  topSpacer: number;
  bottomSpacer: number;
  entries: AlertEventListEntry[];
}

export function useAlertEventVirtualization(
  currentPageEvents: AlertEventItem[],
): UseAlertEventVirtualizationResult {
  const eventsListRef = useRef<HTMLDivElement | null>(null);
  const [eventsListScrollMargin, setEventsListScrollMargin] = useState(0);

  const shouldVirtualizeCurrentEvents = shouldVirtualizeAlertEvents(
    currentPageEvents.length,
  );
  const eventVirtualizer = useWindowVirtualizer({
    count: currentPageEvents.length,
    estimateSize: () => ALERT_EVENT_ROW_ESTIMATE_PX,
    overscan: 5,
    enabled: shouldVirtualizeCurrentEvents,
    scrollMargin: eventsListScrollMargin,
  });
  const virtualEventRows = shouldVirtualizeCurrentEvents
    ? eventVirtualizer.getVirtualItems()
    : [];
  const eventListTopSpacer =
    virtualEventRows.length > 0
      ? Math.max(0, virtualEventRows[0]!.start - eventsListScrollMargin)
      : 0;
  const eventListBottomSpacer =
    virtualEventRows.length > 0
      ? Math.max(
          0,
          eventVirtualizer.getTotalSize() -
            virtualEventRows[virtualEventRows.length - 1]!.end,
        )
      : 0;
  const entries = shouldVirtualizeCurrentEvents
    ? virtualEventRows
        .map((row) => {
          const event = currentPageEvents[row.index];
          return event ? { event, key: event.id, virtualIndex: row.index } : null;
        })
        .filter(
          (entry): entry is AlertEventListEntry =>
            entry !== null,
        )
    : currentPageEvents.map((event, index) => ({
        event,
        key: event.id,
        virtualIndex: index,
      }));

  useEffect(() => {
    if (!shouldVirtualizeCurrentEvents) {
      setEventsListScrollMargin(0);
      return;
    }

    let frameId: number | null = null;
    const scheduleUpdate = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        const node = eventsListRef.current;
        if (!node) {
          return;
        }
        const nextScrollMargin = node.getBoundingClientRect().top + window.scrollY;
        setEventsListScrollMargin((previous) =>
          shouldUpdateAlertEventsMetric(previous, nextScrollMargin)
            ? nextScrollMargin
            : previous,
        );
      });
    };

    scheduleUpdate();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => scheduleUpdate());
    if (eventsListRef.current) {
      resizeObserver?.observe(eventsListRef.current);
    }
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, { passive: true });

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate);
    };
  }, [currentPageEvents.length, shouldVirtualizeCurrentEvents]);

  useEffect(() => {
    if (shouldVirtualizeCurrentEvents) {
      eventVirtualizer.measure();
    }
  }, [currentPageEvents.length, eventVirtualizer, shouldVirtualizeCurrentEvents]);

  return {
    eventsListRef,
    shouldVirtualize: shouldVirtualizeCurrentEvents,
    topSpacer: eventListTopSpacer,
    bottomSpacer: eventListBottomSpacer,
    entries,
  };
}
