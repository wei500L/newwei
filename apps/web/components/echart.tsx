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
  group?: string;
  onEvents?: { type: string; handler: (params: unknown, chart: echarts.ECharts) => void }[];
}

export function DashboardChart({ option, height = 360, renderer = "canvas", group, onEvents }: EchartProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    const chart = echarts.init(ref.current, undefined, { renderer });
    if (group) {
      chart.group = group;
      echarts.connect(group);
    }
    chart.setOption(option);
    onEvents?.forEach((evt) => chart.on(evt.type, (params) => evt.handler(params, chart)));
    const handleResize = () => chart.resize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      onEvents?.forEach((evt) => chart.off(evt.type));
      chart.dispose();
    };
  }, [option, renderer, group, onEvents]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}
