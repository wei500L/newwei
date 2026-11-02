"use client";

import { Card, theme } from "antd";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import type { EconomicSeriesGroup } from "@/hooks/useEconomicData";
import { resolveLocale } from "@/lib/i18n";

import { buildCandlestickChartOption } from "../utils/candlestick-chart";
import { getCandlestickSeries } from "../utils/series";

export interface CandlestickCardProps {
  title: string;
  group?: EconomicSeriesGroup;
  height?: number;
  meta?: ReactNode;
  chartLazy?: boolean;
  /** FE-UI 批9B：为 true 时只渲染内容，不渲染 Card 外壳（避免卡中卡）。 */
  bare?: boolean;
}

export function CandlestickCard({
  title,
  group,
  height = 336,
  meta,
  chartLazy = true,
  bare = false,
}: CandlestickCardProps) {
  const { t, i18n } = useTranslation();
  const { token } = theme.useToken();
  const chartTheme = useChartTheme();
  const locale = resolveLocale(i18n.language);
  const candlestick = useMemo(() => getCandlestickSeries(group), [group]);
  const option = useMemo(
    () =>
      buildCandlestickChartOption({
        title,
        points: candlestick,
        unit: group?.unit,
        locale,
        theme: chartTheme,
      }),
    [candlestick, chartTheme, group?.unit, locale, title],
  );

  const content =
    candlestick.length > 0 ? (
      <DashboardChart
        option={option}
        height={height}
        lazy={chartLazy}
        theme={chartTheme.echartsTheme}
      />
    ) : (
      <ChartEmptyState
        className="min-h-viz-sm"
        description={t("dashboard.charts.noCandlestick")}
      />
    );

  if (bare) {
    return <div className="w-full">{content}</div>;
  }

  return (
    <Card
      className="content-card"
      title={title}
      extra={meta ? <div className="text-right">{meta}</div> : undefined}
      styles={{
        header: {
          paddingBlock: 16,
          paddingInline: 20,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        },
        body: {
          paddingTop: 8,
          paddingInline: 8,
          paddingBottom: 8,
        },
      }}
    >
      {content}
    </Card>
  );
}
