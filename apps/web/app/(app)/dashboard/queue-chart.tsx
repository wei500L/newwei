"use client";

import * as echarts from "echarts";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface QueueChartProps {
  data: Record<string, number>;
}

export function QueueChart({ data }: QueueChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }

    const keys = Object.keys(data);
    const labels = keys.map((key) => t(`dashboard.queue.states.${key}`, { defaultValue: key }));
    const chart = echarts.init(chartRef.current);
    const option = {
      tooltip: {
        trigger: "axis",
      },
      xAxis: {
        type: "category",
        data: labels,
      },
      yAxis: {
        type: "value",
      },
      series: [
        {
          data: keys.map((key) => data[key] ?? 0),
          type: "bar",
          itemStyle: {
            color: "#1677ff",
          },
        },
      ],
    };

    chart.setOption(option);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [data, t]);

  return <div ref={chartRef} style={{ width: "100%", height: 260 }} />;
}
