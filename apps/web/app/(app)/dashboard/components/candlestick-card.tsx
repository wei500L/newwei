"use client";

import { Card, Empty } from "antd";
import type { EChartsOption } from "echarts";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import type { EconomicSeriesGroup } from "@/hooks/useEconomicData";

import { getCandlestickSeries } from "../utils/series";

export interface CandlestickCardProps {
  title: string;
  group?: EconomicSeriesGroup;
  height?: number;
  meta?: ReactNode;
}

export function CandlestickCard({
  title,
  group,
  height = 320,
  meta,
}: CandlestickCardProps) {
  const { t } = useTranslation();
  const candlestick = getCandlestickSeries(group);
  const unitSuffix = group?.unit ? ` ${group.unit}` : "";
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
      axisLabel: {
        formatter: (value: unknown) => `${value}${unitSuffix}`,
      },
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
      {meta ? <div className="mb-2 flex justify-end">{meta}</div> : null}
      {candlestick.length > 0 ? (
        <DashboardChart option={option} height={height} />
      ) : (
        <Empty description={t("dashboard.charts.noCandlestick")} />
      )}
    </Card>
  );
}
