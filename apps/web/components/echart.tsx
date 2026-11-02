"use client";

import dynamic from "next/dynamic";

import type { EchartProps } from "./echart.client";

const DashboardChartInner = dynamic<EchartProps>(
  () => import("./echart.client").then((mod) => mod.DashboardChart),
  {
    ssr: false,
    loading: () => null,
  },
);

export function DashboardChart(props: EchartProps) {
  return (
    <div className="relative" style={{ minHeight: props.height ?? 360 }}>
      <DashboardChartInner {...props} />
    </div>
  );
}

export type { EchartProps };
