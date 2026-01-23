"use client";

import { Card, Space, Tag } from "antd";
import type { EChartsOption } from "echarts";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import dayjs from "@/lib/dayjs";
import { formatDateTime, resolveLocale } from "@/lib/i18n";
import {
  compareGranularity,
  formatGranularityLabel,
  inferGranularityFromTimestampsMs,
  resolveDefaultGranularityForRangePreset,
  UiTimeGranularity,
} from "@/lib/time-granularity";
import { useDashboardRangeStore } from "@/store/time-range";

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
  const { range, start, end } = useDashboardRangeStore();
  const windowLabel = `${dayjs(start).format("YYYY-MM-DD")} - ${dayjs(end).format("YYYY-MM-DD")}`;

  const option = useMemo<EChartsOption>(() => {
    if (!data || data.length === 0) return {};

    const timestamps = data.map((d) => d.timestamp);
    const values = data.map((d) => d.value);
    const timestampsMs = data
      .map((d) => dayjs(d.timestamp).valueOf())
      .filter((value) => Number.isFinite(value));
    const actualGranularity = inferGranularityFromTimestampsMs(timestampsMs);
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
          const payload = Array.isArray(params) ? params[0] : params;
          const axisValue = payload?.axisValue as string | number | undefined;
          const value = payload?.value;
          const ts = Array.isArray(value) ? value[0] : axisValue;
          const v = Array.isArray(value) ? value[1] : typeof value === "number" ? value : payload?.data;

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

          const valueText = typeof v === "number" ? v.toFixed(2) : String(v ?? "");
          return [
            `<div style="font-weight:600;margin-bottom:6px;">${bucketText}</div>`,
            `<div>${t("dashboard.sentiment.label", { defaultValue: "Sentiment" })}: ${valueText}</div>`,
            `<div style="color:#64748b;margin-top:6px;">Bucket: ${actualGranularityLabel}</div>`
          ].join("");
        },
      },
      grid: {
        left: "3%",
        right: "4%",
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
        {
          name: t("dashboard.sentiment.label", { defaultValue: "Sentiment" }),
          type: "line",
          smooth: true,
          showSymbol: false,
          areaStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(217, 119, 6, 0.45)" },
                { offset: 1, color: "rgba(217, 119, 6, 0)" }
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

  const defaultGranularity = resolveDefaultGranularityForRangePreset(range, start, end);
  const timestampsMs = useMemo(
    () => (data ?? []).map((d) => dayjs(d.timestamp).valueOf()).filter((v) => Number.isFinite(v)),
    [data]
  );
  const actualGranularity = inferGranularityFromTimestampsMs(timestampsMs);
  const actualGranularityLabel = formatGranularityLabel(actualGranularity);
  const defaultGranularityLabel = formatGranularityLabel(defaultGranularity);
  const granularityCompare = compareGranularity(actualGranularity, defaultGranularity);
  const granularityColor =
    granularityCompare === "match"
      ? "geekblue"
      : granularityCompare === "coarser"
        ? "orange"
        : granularityCompare === "finer"
          ? "cyan"
          : "default";
  const granularityTagText =
    granularityCompare === "match" || defaultGranularity === UiTimeGranularity.Unknown
      ? `Aggregation: ${actualGranularityLabel}`
      : `Aggregation: ${actualGranularityLabel} (default ${defaultGranularityLabel})`;

  return (
    <Card 
      title={t("dashboard.sentiment.title", "Global Sentiment Trend")} 
      loading={loading}
      className="h-full shadow-sm"
      variant="borderless"
      extra={
        <Space size={6} wrap>
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
