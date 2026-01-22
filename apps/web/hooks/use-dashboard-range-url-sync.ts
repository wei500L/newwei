"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import dayjs from "@/lib/dayjs";
import { useDashboardRangeStore, type DashboardRangePreset } from "@/store/time-range";

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

/**
 * Keeps the dashboard time range store and the URL query params in sync.
 *
 * Important behavior: we only treat URL params as overrides when present.
 * If params are missing (e.g. internal navigation links that drop query),
 * we preserve the in-memory range and write it back to the URL so refresh/share works.
 */
export function useDashboardRangeUrlSync(): void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { range, start, end, setRange, setCustomRange } = useDashboardRangeStore();

  const storeRef = useRef({ range, start, end });
  const hydratedRef = useRef(false);
  const skipWriteRef = useRef(false);

  const searchKey = searchParams.toString();

  useEffect(() => {
    storeRef.current = { range, start, end };
  }, [end, range, start]);

  useEffect(() => {
    const params = new URLSearchParams(searchKey);
    const rangeParam = normalizeRange(params.get("range"));
    const startParam = parseDate(params.get("start"));
    const endParam = parseDate(params.get("end"));

    const snapshot = storeRef.current;
    const hasCustomDates = Boolean(startParam && endParam && startParam <= endParam);

    // Hydrate from URL when parameters are present; otherwise keep store as-is.
    if (hasCustomDates) {
      const startTime = startParam!.getTime();
      const endTime = endParam!.getTime();
      if (
        snapshot.range !== "custom" ||
        snapshot.start.getTime() !== startTime ||
        snapshot.end.getTime() !== endTime
      ) {
        setCustomRange(startParam!, endParam!);
        skipWriteRef.current = true;
      }
    } else if (rangeParam && rangeParam !== "custom") {
      if (rangeParam !== snapshot.range) {
        setRange(rangeParam);
        skipWriteRef.current = true;
      }
    }

    hydratedRef.current = true;
  }, [searchKey, setCustomRange, setRange]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (skipWriteRef.current) {
      skipWriteRef.current = false;
      return;
    }

    const next = new URLSearchParams(searchKey);
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
  }, [end, pathname, range, router, searchKey, start]);
}

