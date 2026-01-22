"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  QUEUE_STATUS_KEYS,
  type QueueStatusKey,
  useDashboardFiltersStore
} from "@/store/dashboard-filters";
import {
  type DashboardRangePreset,
  useDashboardRangeStore
} from "@/store/time-range";

const DEFAULT_RANGE: DashboardRangePreset = "1M";

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

  const { queueStatus, selectedSector, setQueueStatus, setSelectedSector } = useDashboardFiltersStore();
  const { range, setRange } = useDashboardRangeStore();
  const storeRef = useRef({ queueStatus });
  const skipWriteRef = useRef(false);

  const searchKey = searchParams.toString();

  useEffect(() => {
    storeRef.current = { queueStatus };
  }, [queueStatus]);

  useEffect(() => {
    const params = new URLSearchParams(searchKey);
    const nextStatus = normalizeStatus(params.get("status"));
    const snapshot = storeRef.current;

    // Hydrate only when the URL explicitly provides a valid queue status.
    // When links drop query params, we preserve the in-memory selection and
    // let the write effect serialize it back into the URL.
    if (nextStatus && nextStatus !== snapshot.queueStatus) {
      setQueueStatus(nextStatus);
      skipWriteRef.current = true;
    }

    if (!isReady) {
      setIsReady(true);
    }
  }, [
    isReady,
    searchKey,
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
    if (queueStatus) {
      next.set("status", queueStatus);
    } else {
      next.delete("status");
    }

    const nextQuery = next.toString();
    if (nextQuery === searchKey) return;
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }, [
    isReady,
    pathname,
    queueStatus,
    router,
    searchKey,
    selectedSector
  ]);

  const resetFilters = useCallback(() => {
    setQueueStatus(null);
    setSelectedSector(null);
    setRange(DEFAULT_RANGE);
  }, [setQueueStatus, setRange, setSelectedSector]);

  const hasActiveFilters = useMemo(
    () => Boolean(selectedSector || queueStatus || range !== DEFAULT_RANGE),
    [queueStatus, range, selectedSector]
  );

  return { resetFilters, hasActiveFilters };
}
