"use client";

import { Card } from "antd";
import type { EChartsOption } from "echarts";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

interface DataPoint {
  timestamp: string;
  value: number;
}

interface GlobalSentimentTrendProps {
  data?: DataPoint[];
  loading?: boolean;
}

export function GlobalSentimentTrend({ data, loading }: GlobalSentimentTrendProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const theme = useChartTheme();

  const option = useMemo<EChartsOption>(() => {
    if (!data || data.length === 0) return {};

    const dates = data.map((d) =>
      formatDateTime(d.timestamp, locale, { dateStyle: "medium" })
    );
    const values = data.map(d => d.value);

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'line'
        }
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: dates,
        axisLine: { lineStyle: { color: theme.colors.border } },
        axisLabel: { color: theme.colors.foreground, fontFamily: theme.fontFamily }
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { type: 'dashed', color: theme.colors.grid } },
        axisLabel: { color: theme.colors.foreground, fontFamily: theme.fontFamily }
      },
      series: [
        {
          name: t('dashboard.sentiment.label', 'Sentiment'),
          type: 'line',
          smooth: true,
          showSymbol: false,
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(217, 119, 6, 0.45)' },
                { offset: 1, color: 'rgba(217, 119, 6, 0)' }
              ]
            }
          },
          lineStyle: {
            color: theme.colors.accent,
            width: 3
          },
          data: values
        }
      ]
    };
  }, [data, locale, t, theme]);

  return (
    <Card 
      title={t("dashboard.sentiment.title", "Global Sentiment Trend")} 
      loading={loading}
      className="h-full shadow-sm"
      bordered={false}
    >
      <div className="h-[250px] w-full">
        <DashboardChart option={option} height="100%" theme={theme.echartsTheme} />
      </div>
    </Card>
  );
}
