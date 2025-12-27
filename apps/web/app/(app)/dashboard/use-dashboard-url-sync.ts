"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import dayjs from "@/lib/dayjs";
import {
  QUEUE_STATUS_KEYS,
  type QueueStatusKey,
  useDashboardFiltersStore
} from "@/store/dashboard-filters";
import {
  type DashboardRangePreset,
  useDashboardRangeStore
} from "@/store/time-range";

const RANGE_PRESETS: DashboardRangePreset[] = [
  "1D",
  "1W",
  "1M",
  "3M",
  "6M",
  "1Y",
  "3Y",
  "custom"
];

const RANGE_PRESET_SET = new Set<DashboardRangePreset>(RANGE_PRESETS);
const DEFAULT_RANGE: DashboardRangePreset = "1M";

const parseDate = (value: string | null): Date | null => {
  if (!value) return null;
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.toDate() : null;
};

const normalizeRange = (value: string | null): DashboardRangePreset | null => {
  if (!value) return null;
  return RANGE_PRESET_SET.has(value as DashboardRangePreset)
    ? (value as DashboardRangePreset)
    : null;
};

const normalizeStatus = (value: string | null): QueueStatusKey | null => {
  if (!value) return null;
  return QUEUE_STATUS_KEYS.includes(value as QueueStatusKey)
    ? (value as QueueStatusKey)
    : null;
};

interface DashboardUrlSyncResult {
  resetFilters: () => void;
  hasActiveFilters: boolean;
}

export function useDashboardUrlSync(): DashboardUrlSyncResult {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isReady, setIsReady] = useState(false);

  const { queueStatus, selectedSector, setQueueStatus, setSelectedSector } =
    useDashboardFiltersStore();
  const { range, start, end, setRange, setCustomRange } = useDashboardRangeStore();
  const storeRef = useRef({
    queueStatus,
    selectedSector,
    range,
    start,
    end
  });
  const skipWriteRef = useRef(false);

  const searchKey = searchParams.toString();

  useEffect(() => {
    storeRef.current = {
      queueStatus,
      selectedSector,
      range,
      start,
      end
    };
  }, [queueStatus, selectedSector, range, start, end]);

  useEffect(() => {
    const params = new URLSearchParams(searchKey);
    const nextSector = params.get("sector")?.trim() || null;
    const nextStatus = normalizeStatus(params.get("status"));
    const rangeParam = normalizeRange(params.get("range"));
    const startParam = parseDate(params.get("start"));
    const endParam = parseDate(params.get("end"));

    const snapshot = storeRef.current;
    if (nextSector !== snapshot.selectedSector) {
      setSelectedSector(nextSector);
    }
    if (nextStatus !== snapshot.queueStatus) {
      setQueueStatus(nextStatus);
    }

    const hasCustomDates = Boolean(startParam && endParam && startParam <= endParam);
    if (hasCustomDates) {
      const startTime = startParam!.getTime();
      const endTime = endParam!.getTime();
      if (
        snapshot.range !== "custom" ||
        snapshot.start.getTime() !== startTime ||
        snapshot.end.getTime() !== endTime
      ) {
        setCustomRange(startParam!, endParam!);
      }
    } else if (rangeParam && rangeParam !== "custom" && rangeParam !== snapshot.range) {
      setRange(rangeParam);
    } else if ((!rangeParam || rangeParam === "custom") && snapshot.range !== DEFAULT_RANGE) {
      setRange(DEFAULT_RANGE);
    }

    if (!isReady) {
      setIsReady(true);
    }
    skipWriteRef.current = true;
  }, [
    isReady,
    searchKey,
    setCustomRange,
    setQueueStatus,
    setRange,
    setSelectedSector
  ]);

  useEffect(() => {
    if (!isReady) return;
    if (skipWriteRef.current) {
      skipWriteRef.current = false;
      return;
    }
    const next = new URLSearchParams(searchKey);
    if (selectedSector) {
      next.set("sector", selectedSector);
    } else {
      next.delete("sector");
    }
    if (queueStatus) {
      next.set("status", queueStatus);
    } else {
      next.delete("status");
    }

    if (range === "custom") {
      next.set("range", "custom");
      next.set("start", start.toISOString());
      next.set("end", end.toISOString());
    } else {
      if (range !== DEFAULT_RANGE) {
        next.set("range", range);
      } else {
        next.delete("range");
      }
      next.delete("start");
      next.delete("end");
    }

    const nextQuery = next.toString();
    if (nextQuery === searchKey) return;
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }, [
    end,
    isReady,
    pathname,
    queueStatus,
    range,
    router,
    searchKey,
    selectedSector,
    start
  ]);

  const resetFilters = useCallback(() => {
    setQueueStatus(null);
    setSelectedSector(null);
    setRange(DEFAULT_RANGE);
    const next = new URLSearchParams(searchKey);
    next.delete("sector");
    next.delete("status");
    next.delete("range");
    next.delete("start");
    next.delete("end");
    const nextQuery = next.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }, [pathname, router, searchKey, setQueueStatus, setRange, setSelectedSector]);

  const hasActiveFilters = useMemo(
    () => Boolean(selectedSector || queueStatus || range !== DEFAULT_RANGE),
    [queueStatus, range, selectedSector]
  );

  return { resetFilters, hasActiveFilters };
}
