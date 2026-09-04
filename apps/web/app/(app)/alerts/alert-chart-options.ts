import type { EChartsOption } from "echarts";

import dayjs from "@/lib/dayjs";

import { ALERT_LINE_COLORS } from "@/lib/status-tokens";

import type { AlertEventItem, AlertRuleTrendAnalysis, AlertTrendPoint } from "./alert-center.utils";
import type { TranslateFn } from "./evidence-utils";

/**
 * Alert Center 图表 option 构建器（FE-批3 从 alert-center.tsx 原样迁出）。
 * 纯函数：输入数据 + 主题色 + t，输出 EChartsOption；行为保持不变。
 */

export interface ChartThemeInputs {
  primary: string;
  accent: string;
  fontFamily: string;
}

export interface ReplayChartInput {
  replay: unknown;
  replayPoints: Array<{ timestamp: unknown; value: number }> | null | undefined;
  replayUnit: string | null | undefined;
  selectedEvent: AlertEventItem | null;
}

export function buildReplayOption(
  input: ReplayChartInput,
  theme: ChartThemeInputs,
): EChartsOption {
  const { replay, replayPoints, replayUnit, selectedEvent } = input;
  if (!replay || !replayPoints || replayPoints.length === 0) {
    return {};
  }

  const operator = selectedEvent?.operator ?? null;
  const thresholdValue =
    typeof selectedEvent?.thresholdValue === "number" &&
    Number.isFinite(selectedEvent.thresholdValue)
      ? selectedEvent.thresholdValue
      : null;
  const thresholdLower =
    typeof selectedEvent?.thresholdLower === "number" &&
    Number.isFinite(selectedEvent.thresholdLower)
      ? selectedEvent.thresholdLower
      : null;
  const thresholdUpper =
    typeof selectedEvent?.thresholdUpper === "number" &&
    Number.isFinite(selectedEvent.thresholdUpper)
      ? selectedEvent.thresholdUpper
      : null;

  const markLineData: {
    yAxis: number;
    lineStyle?: { type?: "dashed"; color?: string };
    label?: { formatter?: string };
  }[] = [];
  if (
    operator &&
    ["gt", "gte", "lt", "lte", "eq"].includes(operator) &&
    thresholdValue !== null
  ) {
    markLineData.push({
      yAxis: thresholdValue,
      lineStyle: { type: "dashed", color: theme.accent },
      label: { formatter: `threshold ${thresholdValue}` },
    });
  }
  if (
    operator &&
    ["outside_range", "within_range"].includes(operator) &&
    thresholdLower !== null &&
    thresholdUpper !== null
  ) {
    markLineData.push(
      {
        yAxis: thresholdLower,
        lineStyle: { type: "dashed", color: theme.accent },
        label: { formatter: `lower ${thresholdLower}` },
      },
      {
        yAxis: thresholdUpper,
        lineStyle: { type: "dashed", color: theme.accent },
        label: { formatter: `upper ${thresholdUpper}` },
      },
    );
  }

  return {
    tooltip: { trigger: "axis" },
    grid: { top: 20, left: 40, right: 20, bottom: 30, containLabel: true },
    xAxis: { type: "time" },
    yAxis: { type: "value", name: replayUnit ?? undefined },
    series: [
      {
        type: "line",
        smooth: true,
        showSymbol: false,
        data: replayPoints.map((point) => [point.timestamp, point.value]),
        lineStyle: { width: 2, color: theme.primary },
        areaStyle: { opacity: 0.06, color: theme.primary },
        ...(markLineData.length > 0
          ? {
              markLine: {
                symbol: "none",
                data: markLineData,
              },
            }
          : {}),
      },
    ],
    textStyle: { fontFamily: theme.fontFamily },
  };
}

export function buildTrendOption(
  trendPoints: AlertTrendPoint[],
  theme: ChartThemeInputs,
  t: TranslateFn,
): EChartsOption {
  if (trendPoints.length === 0) {
    return {};
  }

  return {
    tooltip: { trigger: "axis" },
    legend: {
      data: [
        t("alerts.center.filters.severity.low"),
        t("alerts.center.filters.severity.medium"),
        t("alerts.center.filters.severity.high"),
      ],
    },
    grid: { top: 36, left: 26, right: 14, bottom: 30, containLabel: true },
    xAxis: {
      type: "category",
      data: trendPoints.map((point) => dayjs(point.date).format("MM-DD")),
    },
    yAxis: { type: "value", minInterval: 1 },
    series: [
      {
        name: t("alerts.center.filters.severity.low"),
        type: "line",
        smooth: true,
        data: trendPoints.map((point) => point.low),
        lineStyle: { color: ALERT_LINE_COLORS.low },
      },
      {
        name: t("alerts.center.filters.severity.medium"),
        type: "line",
        smooth: true,
        data: trendPoints.map((point) => point.medium),
        lineStyle: { color: ALERT_LINE_COLORS.medium },
      },
      {
        name: t("alerts.center.filters.severity.high"),
        type: "line",
        smooth: true,
        data: trendPoints.map((point) => point.high),
        lineStyle: { color: ALERT_LINE_COLORS.high },
      },
    ],
    textStyle: { fontFamily: theme.fontFamily },
  };
}

export function buildRuleTrendOption(
  analysis: AlertRuleTrendAnalysis,
  theme: ChartThemeInputs,
  t: TranslateFn,
): EChartsOption {
  if (analysis.points.length === 0) {
    return {};
  }

  return {
    tooltip: { trigger: "axis" },
    grid: { top: 30, left: 26, right: 20, bottom: 30, containLabel: true },
    legend: {
      data: [
        t("alerts.center.analysis.triggerFrequency"),
        t("alerts.center.analysis.falsePositiveTrend"),
      ],
    },
    xAxis: {
      type: "category",
      data: analysis.points.map((point) => dayjs(point.date).format("MM-DD")),
    },
    yAxis: [
      { type: "value", minInterval: 1 },
      {
        type: "value",
        min: 0,
        max: 100,
        axisLabel: { formatter: "{value}%" },
      },
    ],
    series: [
      {
        name: t("alerts.center.analysis.triggerFrequency"),
        type: "bar",
        barMaxWidth: 24,
        data: analysis.points.map((point) => point.triggers),
        itemStyle: { color: theme.primary },
      },
      {
        name: t("alerts.center.analysis.falsePositiveTrend"),
        type: "line",
        yAxisIndex: 1,
        smooth: true,
        data: analysis.points.map((point) =>
          typeof point.falsePositiveRate === "number"
            ? Number((point.falsePositiveRate * 100).toFixed(2))
            : null,
        ),
        lineStyle: { color: theme.accent },
      },
    ],
    textStyle: { fontFamily: theme.fontFamily },
  };
}
