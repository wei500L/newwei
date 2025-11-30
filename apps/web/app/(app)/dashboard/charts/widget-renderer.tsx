"use client";

import { DashboardChart } from "@/components/echart";
import { gql, useQuery } from "@apollo/client";
import { Skeleton, Typography } from "antd";
import { useMemo } from "react";
import { useDashboardRangeStore } from "@/store/time-range";
import { TimeGranularity } from "@/graphql/generated";
import * as echarts from "echarts/core";

const ECONOMIC_WIDGET_QUERY = gql`
  query EconomicWidgetData(
    $category: String!
    $timeRange: DateRangeInput!
    $granularity: TimeGranularity
  ) {
    getEconomicData(
      category: $category
      timeRange: $timeRange
      granularity: $granularity
    ) {
      timestamp
      value
    }
  }
`;

const parseDataSource = (dataSource: string) => {
  if (dataSource.startsWith("economic:")) {
    return {
      kind: "economic" as const,
      category: dataSource.replace("economic:", ""),
    };
  }
  return { kind: "unknown" as const };
};

const chooseGranularity = (
  start: Date,
  end: Date,
  explicit?: TimeGranularity,
) => {
  if (explicit) return explicit;
  const diffDays = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)),
  );
  if (diffDays > 1095) return "year";
  if (diffDays > 365) return "quarter";
  if (diffDays > 120) return "month";
  if (diffDays > 45) return "week";
  return "day";
};

export interface WidgetRenderProps {
  type: string;
  title?: string;
  dataSource: string;
  color?: string;
  data?: { timestamp: string | number; value: number }[];
}

export function WidgetRenderer({
  type,
  title,
  data,
  dataSource,
  color,
}: WidgetRenderProps) {
  const { start, end } = useDashboardRangeStore();
  const sourceInfo = parseDataSource(dataSource);
  const { data: apiData, loading } = useQuery(ECONOMIC_WIDGET_QUERY, {
    skip: sourceInfo.kind !== "economic",
    variables:
      sourceInfo.kind !== "economic"
        ? undefined
        : {
            category: sourceInfo.category,
            timeRange: { start: start.toISOString(), end: end.toISOString() },
            granularity: chooseGranularity(start, end),
          },
    fetchPolicy: "cache-first",
  });

  const resolvedData:
    | { timestamp: string | number; value: number }[]
    | undefined =
    data ??
    apiData?.getEconomicData?.map(
      (p: { timestamp: string; value: number }) => ({
        timestamp: p.timestamp,
        value: p.value,
      }),
    );

  const option = useMemo(() => {
    const seriesData = resolvedData?.map((p) => [p.timestamp, p.value]) ?? [];
    const common = {
      title: { text: title ?? dataSource },
      tooltip: { trigger: type === "pie" ? "item" : "axis" },
      dataZoom: [{ type: "inside" }, { type: "slider" }],
      xAxis: type === "bar" ? { type: "category" } : { type: "time" },
      yAxis: { type: "value" },
      color: color ? [color] : undefined,
    };

    switch (type) {
      case "bar":
        return {
          ...common,
          series: [
            {
              type: "bar",
              data: seriesData.map(([, v]) => v),
              barWidth: "60%",
            },
          ],
          xAxis: {
            type: "category",
            data: resolvedData?.map((p) => p.timestamp),
          },
        };
      case "pie":
        return {
          ...common,
          series: [
            {
              type: "pie",
              radius: "60%",
              data:
                resolvedData?.map((p) => ({
                  name: p.timestamp,
                  value: p.value,
                })) ?? [],
            },
          ],
        };
      case "scatter":
        return {
          ...common,
          series: [{ type: "scatter", data: seriesData }],
        };
      case "kline":
        return {
          ...common,
          series: [{ type: "candlestick", data: [] }],
        };
      case "radar":
        return {
          radar: {
            indicator: resolvedData?.map((p) => ({
              name: String(p.timestamp),
              max: Math.max(...(resolvedData?.map((d) => d.value) ?? [1])),
            })),
          },
          series: [
            {
              type: "radar",
              data: [
                {
                  value: resolvedData?.map((p) => p.value) ?? [],
                  name: title ?? dataSource,
                },
              ],
            },
          ],
        };
      default:
        return {
          ...common,
          series: [
            { type: "line", smooth: true, showSymbol: false, data: seriesData },
          ],
        };
    }
  }, [resolvedData, dataSource, title, type]);

  if (sourceInfo.kind === "unknown") {
    return (
      <Typography.Text type="secondary">
        Unsupported data source: {dataSource}
      </Typography.Text>
    );
  }

  if (loading) {
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }

  const theme = color
    ? {
        color: [color],
        textStyle: { color: "#333" },
        title: { textStyle: { color } },
      }
    : undefined;
  if (theme) {
    const themeName = `custom-${color}`;
    echarts.registerTheme(themeName, theme);
    return (
      <DashboardChart
        option={option}
        height={300}
        group="linked-charts"
        renderer="canvas"
      />
    );
  }

  return <DashboardChart option={option} height={300} group="linked-charts" />;
}
