"use client";

import type { WarMapLayerVisibility } from "@modular/utils";
import { useMemo } from "react";

import type { SupportedLocale } from "@/lib/i18n";
import { formatDateTime } from "@/lib/i18n";

import type { WarMapLayersResponse } from "./war-map-data";

import type { WarMapTranslateFn } from "./war-map-overlay-model";
import {
  buildWarMapAisSummaryPresentation,
  buildWarMapChainStatuses,
  buildWarMapFlightsSummaryPresentation,
  buildWarMapStatusSummary,
  buildWarMapTransportLegendState,
  type WarMapAisSummaryPresentation,
  type WarMapFlightsSummaryPresentation,
  type WarMapStatusSummary,
} from "./war-map-status-model";
import type { WarMapTransportLegendState } from "./war-map-symbols";

interface WarMapPresentationQueryLike {
  isFetching: boolean;
  error: unknown;
  data?: { updatedAt?: string };
  dataUpdatedAt: number;
}

export interface UseWarMapStatusPresentationOptions {
  t: WarMapTranslateFn;
  locale: SupportedLocale;
  effectiveRange: { start: Date; end: Date };
  layerVisibility: WarMapLayerVisibility;
  aisMode: "all" | "military" | "density";
  effectiveAisMode: "all" | "military" | "density";
  aisHighlightCandidates: boolean;
  aisHighlightedCandidateCount: number | undefined;
  streamState: {
    status: string;
    lastMessageAt?: number;
    error?: string;
  };
  anyFetching: boolean;
  queries: {
    eventsQuery: WarMapPresentationQueryLike;
    newsQuery: WarMapPresentationQueryLike;
    layersQuery: WarMapPresentationQueryLike;
    monitorsQuery: {
      isFetching: boolean;
      error: unknown;
      data: unknown;
      dataUpdatedAt: number;
    };
    /** layers 查询数据（航班/AIS 摘要来源）。 */
    layersAisSummary: Parameters<typeof buildWarMapAisSummaryPresentation>[0]["aisSummary"];
    flightsSummary: Record<string, unknown> | undefined;
  };
}

export interface UseWarMapStatusPresentationResult {
  statusSummary: WarMapStatusSummary;
  flightsPresentation: WarMapFlightsSummaryPresentation;
  aisPresentation: WarMapAisSummaryPresentation;
  transportLegendState: WarMapTransportLegendState;
  windowLabel: string;
}

/**
 * War Map 状态展示域（FE-批4A）：查询/stream 输入 → 顶部状态摘要、
 * 航班/AIS 摘要与运输 legend 状态。纯派生组合，不含 DOM。
 */
export function useWarMapStatusPresentation(
  options: UseWarMapStatusPresentationOptions,
): UseWarMapStatusPresentationResult {
  const {
    t,
    locale,
    effectiveRange,
    layerVisibility,
    aisMode,
    effectiveAisMode,
    aisHighlightCandidates,
    aisHighlightedCandidateCount,
    streamState,
    anyFetching,
    queries,
  } = options;

  const nowMs = Date.now();
  const windowLabel = `${formatDateTime(effectiveRange.start, locale, {
    dateStyle: "medium",
  })} - ${formatDateTime(effectiveRange.end, locale, { dateStyle: "medium" })}`;

  const layersData = queries.layersQuery.data?.layers;
  const flightsSummary =
    layersData?.flights?.summary &&
    typeof layersData.flights.summary === "object" &&
    !Array.isArray(layersData.flights.summary)
      ? (layersData.flights.summary as Record<string, unknown>)
      : undefined;
  const layersAisSummary = layersData?.ais?.summary;

  const chainStatuses = buildWarMapChainStatuses({
    eventsQuery: queries.eventsQuery,
    newsQuery: queries.newsQuery,
    layersQuery: queries.layersQuery,
    monitorsQuery: queries.monitorsQuery,
    t,
  });

  const statusSummary = buildWarMapStatusSummary({
    chainStatuses,
    streamState,
    anyFetching,
    nowMs,
    locale,
    t,
  });

  const flightsPresentation = buildWarMapFlightsSummaryPresentation({
    flightsSummary,
    t,
  });

  const aisPresentation = buildWarMapAisSummaryPresentation({
    aisSummary: layersAisSummary,
    layerVisibility,
    aisMode,
    effectiveAisMode,
    aisHighlightCandidates,
    aisHighlightedCandidateCount,
    locale,
    nowMs,
    t,
  });

  const transportLegendState = useMemo(
    () =>
      buildWarMapTransportLegendState({
        layerVisibility,
        flightsReturnedCount: flightsPresentation.flightsReturnedCount,
        flightsFreshness: flightsPresentation.flightsFreshness,
        aisAllModeDegraded: aisPresentation.aisAllModeDegraded,
        aisAllModeDegradedLabel: aisPresentation.aisAllModeDegradedLabel,
        aisViewportEmptyStateActive: aisPresentation.aisViewportEmptyStateActive,
        aisViewportEmptyStateHint: aisPresentation.aisViewportEmptyStateHint,
        aisDisruptionsCount: aisPresentation.aisDisruptionsCount,
        aisPrimaryCountValue: aisPresentation.aisPrimaryCountValue,
        effectiveAisMode,
        t,
      }),
    [
      aisPresentation.aisAllModeDegraded,
      aisPresentation.aisAllModeDegradedLabel,
      aisPresentation.aisDisruptionsCount,
      aisPresentation.aisPrimaryCountValue,
      aisPresentation.aisViewportEmptyStateActive,
      aisPresentation.aisViewportEmptyStateHint,
      effectiveAisMode,
      flightsPresentation.flightsFreshness,
      flightsPresentation.flightsReturnedCount,
      layerVisibility.ais,
      layerVisibility.flights,
      t,
    ],
  );

  return {
    statusSummary,
    flightsPresentation,
    aisPresentation,
    transportLegendState,
    windowLabel,
  };
}
