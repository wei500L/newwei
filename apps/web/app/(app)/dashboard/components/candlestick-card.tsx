"use client";

import { Card, Empty, Typography, theme } from "antd";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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
}

export function CandlestickCard({
  title,
  group,
  height = 336,
  meta,
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

  return (
    <Card
      className="content-card"
      title={
        <Typography.Text
          strong
          style={{
            color: token.colorTextHeading,
            fontSize: 17,
            fontWeight: 800,
            lineHeight: 1.2,
            letterSpacing: "0.01em",
          }}
        >
          {title}
        </Typography.Text>
      }
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
      {candlestick.length > 0 ? (
        <DashboardChart
          option={option}
          height={height}
          theme={chartTheme.echartsTheme}
        />
      ) : (
        <Empty description={t("dashboard.charts.noCandlestick")} />
      )}
    </Card>
  );
}
