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
  option: echarts.EChartsCoreOption;
  height?: number | string;
  renderer?: "canvas" | "svg";
  group?: string;
  onEvents?: { type: string; handler: (params: unknown, chart: echarts.ECharts) => void }[];
}

export function DashboardChart({ option, height = 360, renderer = "canvas", group, onEvents }: EchartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.EChartsType>();

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    const chart = echarts.init(ref.current, undefined, { renderer });
    chartRef.current = chart;
    if (group) {
      chart.group = group;
      echarts.connect(group);
    }
    const handleResize = () => chart.resize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      chart.dispose();
      chartRef.current = undefined;
    };
  }, [renderer, group]);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }
    chartRef.current.setOption(option);
  }, [option, renderer, group]);

  useEffect(() => {
    if (!chartRef.current || !onEvents?.length) {
      return;
    }
    const chart = chartRef.current;
    const handlers = onEvents.map((evt) => {
      const wrapped = (params: unknown) => evt.handler(params, chart);
      chart.on(evt.type, wrapped);
      return { type: evt.type, wrapped };
    });
    return () => handlers.forEach(({ type, wrapped }) => chart.off(type, wrapped));
  }, [onEvents, renderer, group]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}
