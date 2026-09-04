import type { WarMapAisMode, WarMapFlightMode, WarMapTranslateTarget } from "@modular/utils";

import type { DashboardStreamState } from "../../use-dashboard-stream";

import type { WarMapLayoutVariant } from "./war-map-overlay-model";

/** WarMap 对外契约（三个消费入口共同依赖，FE-批4A 迁移自 war-map.tsx）。 */
export interface WarMapProps {
  className?: string;
  layoutVariant?: WarMapLayoutVariant;
  translateTarget?: WarMapTranslateTarget;
  streamState?: DashboardStreamState;
  onEffectiveRangeChange?: (range: { start: Date; end: Date }) => void;
  onRealtimeQueryChange?: (query: {
    start: Date;
    end: Date;
    bbox?: string;
    zoom?: number;
    translateTarget?: WarMapTranslateTarget;
    flightMode?: WarMapFlightMode;
    aisMode?: WarMapAisMode;
  }) => void;
}
