"use client";

import { useDashboardRangeUrlSync } from "@/hooks/use-dashboard-range-url-sync";
import { useDashboardSectorUrlSync } from "@/hooks/use-dashboard-sector-url-sync";

export function UrlStateSync() {
  useDashboardRangeUrlSync();
  useDashboardSectorUrlSync();
  return null;
}

