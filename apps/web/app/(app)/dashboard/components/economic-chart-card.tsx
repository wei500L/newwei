"use client";

import { Card, Empty, Typography } from "antd";
import type { EChartsOption, SeriesOption } from "echarts";
import { DashboardChart } from "@/components/echart";
import type { EconomicSeriesMap } from "@/hooks/useEconomicData";

export interface SeriesConfig {
  slug: string;
  label?: string;
  field?: string;
  type?: "line" | "bar" | "area" | "radar";
}

export interface EconomicChartCardProps {
  title: string;
  description?: string;
  seriesMap: EconomicSeriesMap;
  series: SeriesConfig[];
}

export function EconomicChartCard({ title, description, seriesMap, series }: EconomicChartCardProps) {
  const option = buildOption(seriesMap, series, title);

  return (
    <Card title={title} className="content-card" style={{ marginBottom: 16 }}>
      {description && <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>}
      {option.series && (option.series as any[]).length > 0 ? (
        <DashboardChart option={option} height={360} />
      ) : (
        <Empty description="暂无数据" />
      )}
    </Card>
  );
}

function buildOption(
  seriesMap: EconomicSeriesMap,
  configs: SeriesConfig[],
  title: string
): EChartsOption {
  const dataset = configs
    .map((config) => {
      const record = seriesMap.get(config.slug);
      if (!record || record.fields.size === 0) {
        return undefined;
      }
      const fieldKey = config.field ?? Array.from(record.fields.keys())[0];
      const fieldSeries = fieldKey ? record.fields.get(fieldKey) : undefined;
      if (!fieldSeries) {
        return undefined;
      }
      return {
        name: config.label ?? fieldSeries.label ?? record.name,
        type: config.type === "bar" ? "bar" : "line",
        smooth: true,
        showSymbol: false,
        areaStyle: config.type === "area" ? {} : undefined,
        data: fieldSeries.values
          .map((point) => [point.timestamp, point.value])
          .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      };
    })
    .filter(Boolean) as SeriesOption[];

  return {
    title: {
      text: title,
      left: "center",
      textStyle: { fontSize: 14, fontWeight: 400 }
    },
    tooltip: {
      trigger: "axis"
    },
    legend: {
      top: 24,
      data: dataset.map((d) => d.name as string)
    },
    grid: {
      left: "3%",
      right: "3%",
      bottom: 60,
      top: 60,
      containLabel: true
    },
    xAxis: {
      type: "time",
      boundaryGap: false
    },
    yAxis: {
      type: "value",
      scale: true
    },
    dataZoom: [
      {
        type: "inside"
      },
      {
        type: "slider"
      }
    ],
    series: dataset
  };
}
