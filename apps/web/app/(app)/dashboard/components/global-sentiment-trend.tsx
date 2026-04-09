"use client";

import { Card, Space, Tag } from "antd";
import type { EChartsOption } from "echarts";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { formatDashboardWindowLabel } from "@/lib/dashboard-time";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import {
  formatGranularityLabel,
  pickCoarsestGranularity,
  timeGranularityToUiGranularity,
  UiTimeGranularity,
} from "@/lib/time-granularity";
import { useDashboardRangeStore } from "@/store/time-range";

import {
  type GlobalSentimentTrendDataPoint,
  prepareGlobalSentimentTrendSeries,
} from "./global-sentiment-trend-utils";

interface GlobalSentimentTrendProps {
  data?: GlobalSentimentTrendDataPoint[];
  loading?: boolean;
}

const resolveTooltipSeriesValue = (payload: any): number => {
  const value = payload?.value;
  if (Array.isArray(value)) {
    const seriesValue = Number(value[1] ?? Number.NaN);
    return Number.isFinite(seriesValue) ? seriesValue : 0;
  }
  const rawValue =
    typeof value === "number" || typeof value === "string" ? value : payload?.data;
  const numeric = Number(rawValue ?? Number.NaN);
  return Number.isFinite(numeric) ? numeric : 0;
};

export function GlobalSentimentTrend({ data, loading }: GlobalSentimentTrendProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const theme = useChartTheme();
  const { range, start, end } = useDashboardRangeStore();
  const windowLabel = formatDashboardWindowLabel(start, end);
  const positiveLabel = t("items.sentiment.positive", { defaultValue: "Positive" });
  const neutralLabel = t("items.sentiment.neutral", { defaultValue: "Neutral" });
  const negativeLabel = t("items.sentiment.negative", { defaultValue: "Negative" });
  const aggregateLabel = t("dashboard.sentiment.aggregateLabel", {
    defaultValue: "Sentiment (aggregate)",
  });
  const preparedSeries = useMemo(
    () => prepareGlobalSentimentTrendSeries(data ?? []),
    [data]
  );
  const isFallbackMode =
    preparedSeries.mode === "aggregate" && (data?.length ?? 0) > 0;

  const option = useMemo<EChartsOption>(() => {
    if (!data || data.length === 0 || preparedSeries.timestamps.length === 0) {
      return {};
    }

    const timestamps = preparedSeries.timestamps;
    const splitSeries = preparedSeries.mode === "split" ? preparedSeries : null;
    const aggregateSeries =
      preparedSeries.mode === "aggregate" ? preparedSeries : null;
    const splitMode = Boolean(splitSeries);
    const actualGranularity = pickCoarsestGranularity(
      data.map((point) => timeGranularityToUiGranularity(point.effectiveGranularity)),
    );
    const actualGranularityLabel = formatGranularityLabel(actualGranularity);
    const intervalUnit = (() => {
      switch (actualGranularity) {
        case UiTimeGranularity.Minute:
          return { count: 1, unit: "minute" as const };
        case UiTimeGranularity.Hour:
          return { count: 1, unit: "hour" as const };
        case UiTimeGranularity.Day:
          return { count: 1, unit: "day" as const };
        case UiTimeGranularity.Week:
          return { count: 1, unit: "week" as const };
        case UiTimeGranularity.Month:
          return { count: 1, unit: "month" as const };
        case UiTimeGranularity.Quarter:
          return { count: 3, unit: "month" as const };
        case UiTimeGranularity.Year:
          return { count: 1, unit: "year" as const };
        default:
          return null;
      }
    })();

    return {
      tooltip: {
        trigger: "axis",
        axisPointer: {
          type: "line"
        },
        formatter: (params: any) => {
          const payloads = Array.isArray(params) ? params : [params];
          const payload = payloads[0];
          const axisValue = payload?.axisValue as string | number | undefined;
          const value = payload?.value;
          const ts = Array.isArray(value) ? value[0] : axisValue;

          const startIso =
            typeof ts === "string"
              ? ts
              : typeof ts === "number"
                ? new Date(ts).toISOString()
                : "";
          const endIso =
            intervalUnit && startIso
              ? dayjs(startIso).add(intervalUnit.count, intervalUnit.unit).toISOString()
              : "";

          const bucketText =
            startIso && endIso
              ? `${formatDateTime(startIso, locale, { dateStyle: "medium" })} - ${formatDateTime(endIso, locale, {
                  dateStyle: "medium"
                })}`
              : startIso
                ? formatDateTime(startIso, locale, { dateStyle: "medium" })
                : "";
          const valueBySeries = new Map<string, number>();
          for (const seriesPayload of payloads) {
            if (!seriesPayload?.seriesName) {
              continue;
            }
            valueBySeries.set(
              String(seriesPayload.seriesName),
              resolveTooltipSeriesValue(seriesPayload)
            );
          }

          const positiveValue = valueBySeries.get(positiveLabel) ?? 0;
          const neutralValue = valueBySeries.get(neutralLabel) ?? 0;
          const negativeValue = valueBySeries.get(negativeLabel) ?? 0;
          const aggregateValue = valueBySeries.get(aggregateLabel) ?? 0;
          const formatValue = (v: number) => v.toFixed(2);
          const rows = splitMode
            ? [
                `<div>${positiveLabel}: ${formatValue(positiveValue)}</div>`,
                `<div>${neutralLabel}: ${formatValue(neutralValue)}</div>`,
                `<div>${negativeLabel}: ${formatValue(negativeValue)}</div>`,
              ]
            : [
                `<div>${aggregateLabel}: ${formatValue(aggregateValue)}</div>`,
              ];
          return [
            `<div style="font-weight:600;margin-bottom:6px;">${bucketText}</div>`,
            ...rows,
            `<div style="color:#64748b;margin-top:6px;">Bucket: ${actualGranularityLabel}</div>`
          ].join("");
        },
      },
      ...(splitMode
        ? {
            legend: {
              top: 0,
              right: 0,
              data: [positiveLabel, neutralLabel, negativeLabel],
              textStyle: {
                color: theme.colors.foreground,
                fontFamily: theme.fontFamily,
                fontSize: 12
              }
            }
          }
        : {}),
      grid: {
        left: "3%",
        right: "4%",
        top: splitMode ? "16%" : "8%",
        bottom: "3%",
        containLabel: true
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: timestamps,
        axisLine: { lineStyle: { color: theme.colors.border } },
        axisLabel: {
          color: theme.colors.foreground,
          fontFamily: theme.fontFamily,
          formatter: (value: unknown) =>
            typeof value === "string"
              ? formatDateTime(value, locale, { month: "2-digit", day: "2-digit" })
              : ""
        }
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { type: "dashed", color: theme.colors.grid } },
        axisLabel: { color: theme.colors.foreground, fontFamily: theme.fontFamily }
      },
      series: [
        ...(splitMode
          ? [
              {
                name: positiveLabel,
                type: "line" as const,
                smooth: true,
                showSymbol: false,
                lineStyle: {
                  color: theme.colors.bullish,
                  width: 2.5
                },
                itemStyle: {
                  color: theme.colors.bullish
                },
                data: splitSeries?.positiveValues ?? []
              },
              {
                name: neutralLabel,
                type: "line" as const,
                smooth: true,
                showSymbol: false,
                lineStyle: {
                  color: theme.colors.accent,
                  width: 2.5
                },
                itemStyle: {
                  color: theme.colors.accent
                },
                data: splitSeries?.neutralValues ?? []
              },
              {
                name: negativeLabel,
                type: "line" as const,
                smooth: true,
                showSymbol: false,
                lineStyle: {
                  color: theme.colors.bearish,
                  width: 2.5
                },
                itemStyle: {
                  color: theme.colors.bearish
                },
                data: splitSeries?.negativeValues ?? []
              }
            ]
          : [
              {
                name: aggregateLabel,
                type: "line" as const,
                smooth: true,
                showSymbol: false,
                lineStyle: {
                  color: theme.colors.accent,
                  width: 2.5
                },
                areaStyle: {
                  color: {
                    type: "linear",
                    x: 0,
                    y: 0,
                    x2: 0,
                    y2: 1,
                    colorStops: [
                      { offset: 0, color: "rgba(217, 119, 6, 0.35)" },
                      { offset: 1, color: "rgba(217, 119, 6, 0)" }
                    ]
                  }
                },
                data: aggregateSeries?.aggregateValues ?? []
              }
            ])
      ]
    };
  }, [
    aggregateLabel,
    data,
    locale,
    negativeLabel,
    neutralLabel,
    positiveLabel,
    preparedSeries,
    theme
  ]);

  const actualGranularity = useMemo(
    () =>
      pickCoarsestGranularity(
        (data ?? []).map((point) => timeGranularityToUiGranularity(point.effectiveGranularity)),
      ),
    [data],
  );
  const actualGranularityLabel = formatGranularityLabel(actualGranularity);
  const granularityColor =
    actualGranularity === UiTimeGranularity.Unknown ? "default" : "geekblue";
  const granularityTagText = `Aggregation: ${actualGranularityLabel}`;

  return (
    <Card 
      title={t("dashboard.sentiment.title", "Global Sentiment Trend")} 
      loading={loading}
      className="h-full shadow-sm"
      variant="borderless"
      extra={
        <Space size={6} wrap>
          {isFallbackMode ? (
            <Tag color="gold" className="text-xs">
              {t("dashboard.sentiment.fallbackSeries", {
                defaultValue: "Fallback: aggregated sentiment"
              })}
            </Tag>
          ) : null}
          <Tag color="default" className="text-xs">
            Range: {range}
          </Tag>
          <Tag color="default" className="text-xs">
            Window: {windowLabel}
          </Tag>
          <Tag color={granularityColor} className="text-xs">
            {granularityTagText}
          </Tag>
        </Space>
      }
    >
      <div className="h-[250px] w-full">
        <DashboardChart option={option} height="100%" theme={theme.echartsTheme} />
      </div>
    </Card>
  );
}
