"use client";

import {
  DashboardChart as DashboardChartInner,
  type EchartProps,
} from "./echart.client";

export function DashboardChart(props: EchartProps) {
  return <DashboardChartInner {...props} />;
}

export type { EchartProps };
