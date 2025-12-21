"use client";

import { Card, Empty } from "antd";
import type { EChartsOption } from "echarts";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import type { EconomicSeriesGroup } from "@/hooks/useEconomicData";

import { getCandlestickSeries } from "../utils/series";

export interface CandlestickCardProps {
  title: string;
  group?: EconomicSeriesGroup;
  height?: number;
}

export function CandlestickCard({
  title,
  group,
  height = 320,
}: CandlestickCardProps) {
  const { t } = useTranslation();
  const candlestick = getCandlestickSeries(group);
  const option: EChartsOption = {
    title: {
      text: title,
      left: "center",
      textStyle: { fontSize: 14, fontWeight: 500 },
    },
    tooltip: {
      trigger: "axis",
    },
    grid: { left: 40, right: 24, top: 50, bottom: 50 },
    dataZoom: [{ type: "inside" }, { type: "slider" }],
    xAxis: {
      type: "category",
      data: candlestick.map((entry) => entry.timestamp),
      boundaryGap: true,
    },
    yAxis: {
      scale: true,
    },
    series: [
      {
        name: title,
        type: "candlestick",
        data: candlestick.map((entry) => entry.values),
      },
    ],
  };

  return (
    <Card className="content-card">
      {candlestick.length > 0 ? (
        <DashboardChart option={option} height={height} />
      ) : (
        <Empty description={t("dashboard.charts.noCandlestick")} />
      )}
    </Card>
  );
}
