"use client";

import type { WarMapTransportDetailResponse } from "@modular/utils";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { createApiClient } from "@/lib/api-client";

import type { SelectedInspector } from "./war-map-overlay-model";

export interface UseWarMapTransportDetailOptions {
  apiClient: ReturnType<typeof createApiClient>;
  selectedInspector: SelectedInspector | null;
  effectiveRange: { start: Date; end: Date };
}

/** 运输对象详情查询（选中 flight/vessel 时启用）。 */
export function useWarMapTransportDetail(
  options: UseWarMapTransportDetailOptions,
) {
  const { apiClient, selectedInspector, effectiveRange } = options;

  const selectedTransport = useMemo(() => {
    if (
      !selectedInspector ||
      (selectedInspector.kind !== "flight" &&
        selectedInspector.kind !== "vessel")
    ) {
      return null;
    }
    return {
      kind:
        selectedInspector.kind === "flight"
          ? ("aircraft" as const)
          : ("vessel" as const),
      objectKey: selectedInspector.item.objectKey,
    };
  }, [selectedInspector]);

  return useQuery({
    queryKey: [
      "dashboard",
      "war-map",
      "transport-detail",
      selectedTransport?.kind ?? null,
      selectedTransport?.objectKey ?? null,
      effectiveRange.start.toISOString(),
      effectiveRange.end.toISOString(),
    ],
    queryFn: async () => {
      if (!selectedTransport) {
        return { detail: null } satisfies WarMapTransportDetailResponse;
      }
      const response = await apiClient.get<WarMapTransportDetailResponse>(
        "dashboard/war-map/transport-detail",
        {
          params: {
            kind: selectedTransport.kind,
            objectKey: selectedTransport.objectKey,
            start: effectiveRange.start.toISOString(),
            end: effectiveRange.end.toISOString(),
            limit: "20",
          },
        },
      );
      return response.data;
    },
    enabled: Boolean(selectedTransport),
    staleTime: 15_000,
  });
}
