"use client";

import dynamic from "next/dynamic";

import { ChartSkeleton } from "@/components/chart-skeleton";

import type { EchartProps } from "./echart.client";

const DashboardChartInner = dynamic<EchartProps>(
  () => import("./echart.client").then((mod) => mod.DashboardChart),
  {
    ssr: false,
    loading: () => <ChartSkeleton height={360} />,
  },
);

export function DashboardChart(props: EchartProps) {
  return <DashboardChartInner {...props} />;
}

export type { EchartProps };
