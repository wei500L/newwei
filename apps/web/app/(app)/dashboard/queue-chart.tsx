"use client";

import * as echarts from "echarts";
import { useEffect, useRef } from "react";

interface QueueChartProps {
  data: Record<string, number>;
}

export function QueueChart({ data }: QueueChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }

    const chart = echarts.init(chartRef.current);
    const option = {
      tooltip: {
        trigger: "axis"
      },
      xAxis: {
        type: "category",
        data: Object.keys(data)
      },
      yAxis: {
        type: "value"
      },
      series: [
        {
          data: Object.values(data),
          type: "bar",
          itemStyle: {
            color: "#1677ff"
          }
        }
      ]
    };

    chart.setOption(option);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [data]);

  return <div ref={chartRef} style={{ width: "100%", height: 260 }} />;
}
