"use client";

import dynamic from "next/dynamic";
import type { EchartProps } from "./echart.client";

export const DashboardChart = dynamic<EchartProps>(
  () => import("./echart.client").then((m) => m.DashboardChart),
  {
    ssr: false,
    loading: () => <div style={{ width: "100%", height: 360 }} />,
  },
);

export type { EchartProps };
