"use client";

import type { WarMapLayerVisibility } from "@modular/utils";
import { useCallback } from "react";
import { toast } from "sonner";

import { captureClientError } from "@/lib/client-telemetry";
import { GeoTransportKind } from "@/graphql/generated";

import type { WarMapTranslateFn } from "./war-map-overlay-model";
import type { WarMapBbox } from "./query-viewport";

export interface UseWarMapAnalyzeOptions {
  t: WarMapTranslateFn;
  canRunAnalysis: boolean;
  layerVisibility: WarMapLayerVisibility;
  effectiveRange: { start: Date; end: Date };
  queryViewportBbox: WarMapBbox | undefined;
  requestGeoTransport: (options: {
    variables: {
      input: {
        transportKinds: GeoTransportKind[];
        startDate: string;
        endDate: string;
        bbox?: WarMapBbox;
      };
    };
  }) => Promise<unknown>;
}

/** 「分析当前视图」控制器：analysis.run 权限、运输图层门禁与提交。 */
export function useWarMapAnalyzeCurrentView(
  options: UseWarMapAnalyzeOptions,
): () => Promise<void> {
  const {
    t,
    canRunAnalysis,
    layerVisibility,
    effectiveRange,
    queryViewportBbox,
    requestGeoTransport,
  } = options;

  return useCallback(async () => {
    if (!canRunAnalysis) {
      toast.warning(t("analysis.runPermissionRequired"));
      return;
    }

    const transportKinds: GeoTransportKind[] = [
      ...(layerVisibility.flights ? [GeoTransportKind.Aircraft] : []),
      ...(layerVisibility.ais ? [GeoTransportKind.Vessel] : []),
    ];
    if (transportKinds.length === 0) {
      toast.warning(t("dashboard.charts.warMap.actions.enableTransportLayers"));
      return;
    }

    try {
      await requestGeoTransport({
        variables: {
          input: {
            transportKinds,
            startDate: effectiveRange.start.toISOString(),
            endDate: effectiveRange.end.toISOString(),
            ...(queryViewportBbox ? { bbox: queryViewportBbox } : {}),
          },
        },
      });
      toast.success(t("dashboard.charts.warMap.actions.analyzeCurrentViewSubmitted"));
    } catch (error) {
      toast.error(t("dashboard.charts.warMap.actions.analyzeCurrentViewFailed"));
      captureClientError("Failed to submit transport analysis.", error, {
        tags: {
          context: "war-map-geo-transport-analysis",
        },
      });
    }
  }, [
    canRunAnalysis,
    effectiveRange.end,
    effectiveRange.start,
    layerVisibility.ais,
    layerVisibility.flights,
    queryViewportBbox,
    requestGeoTransport,
    t,
  ]);
}
