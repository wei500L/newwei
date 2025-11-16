"use client";

import * as echarts from "echarts/core";
import { LineChart, BarChart, RadarChart, CandlestickChart, GaugeChart, HeatmapChart, TreemapChart } from "echarts/charts";
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent,
  ToolboxComponent,
  VisualMapComponent,
  TimelineComponent
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";

echarts.use([
  LineChart,
  BarChart,
  RadarChart,
  CandlestickChart,
  GaugeChart,
  HeatmapChart,
  TreemapChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent,
  ToolboxComponent,
  VisualMapComponent,
  TimelineComponent,
  CanvasRenderer
]);

export interface EchartProps {
  option: echarts.EChartsOption;
  height?: number | string;
  renderer?: "canvas" | "svg";
}

export function DashboardChart({ option, height = 360, renderer = "canvas" }: EchartProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    const chart = echarts.init(ref.current, undefined, { renderer });
    chart.setOption(option);
    const handleResize = () => chart.resize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.dispose();
    };
  }, [option, renderer]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}
