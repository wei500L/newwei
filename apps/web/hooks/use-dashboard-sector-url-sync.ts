"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { useDashboardFiltersStore } from "@/store/dashboard-filters";

/**
 * Keeps `selectedSector` in sync with the URL query parameter `sector`.
 *
 * We only hydrate the store when the param exists; missing `sector` won't clear
 * the in-memory selection (navigation links frequently drop query params).
 */
export function useDashboardSectorUrlSync(): void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { selectedSector, setSelectedSector } = useDashboardFiltersStore();

  const storeRef = useRef({ selectedSector });
  const hydratedRef = useRef(false);
  const skipWriteRef = useRef(false);

  const searchKey = searchParams.toString();

  useEffect(() => {
    storeRef.current = { selectedSector };
  }, [selectedSector]);

  useEffect(() => {
    const params = new URLSearchParams(searchKey);
    const nextSector = params.get("sector")?.trim();
    const snapshot = storeRef.current;

    if (nextSector) {
      if (nextSector !== snapshot.selectedSector) {
        setSelectedSector(nextSector);
        skipWriteRef.current = true;
      }
    }

    hydratedRef.current = true;
  }, [searchKey, setSelectedSector]);

  useEffect(() => {
    if (!hydratedRef.current) return;
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

    const nextQuery = next.toString();
    if (nextQuery === searchKey) return;
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }, [pathname, router, searchKey, selectedSector]);
}

