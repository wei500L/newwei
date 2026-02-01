"use client";

import { lazy, Suspense } from "react";

import { ChartSkeleton } from "@/components/chart-skeleton";

import type { EchartProps } from "./echart.client";

const DashboardChartInner = lazy(() =>
  import("./echart.client").then((m) => ({ default: m.DashboardChart }))
);

export function DashboardChart(props: EchartProps) {
  const height = props.height ?? 360;

  return (
    <Suspense fallback={<ChartSkeleton height={height} />}>
      <DashboardChartInner {...props} />
    </Suspense>
  );
}

export type { EchartProps };
