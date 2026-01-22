"use client";

import { Alert, Breadcrumb, Button, Card, Space, Tag } from "antd";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { TimeGranularity, useEconomicDataQuery } from "@/graphql/generated";
import { useChartTheme } from "@/hooks/use-chart-theme";
import dayjs from "@/lib/dayjs";
import {
  compareGranularity,
  formatGranularityLabel,
  resolveDefaultGranularityForRangePreset,
  timeGranularityToUiGranularity,
  uiGranularityToInterval,
} from "@/lib/time-granularity";
import { useDashboardRangeStore } from "@/store/time-range";

const GRANS = [
  TimeGranularity.Year,
  TimeGranularity.Quarter,
  TimeGranularity.Month,
  TimeGranularity.Week,
  TimeGranularity.Day,
] as const;

interface DataZoomEvent {
  batch?: {
    startValue?: string | number;
    endValue?: string | number;
    start?: string | number;
    end?: string | number;
  }[];
}

export function DrilldownChart({
  category,
  title,
}: {
  category: string;
  title: string;
}) {
  const { t } = useTranslation();
  const { echartsTheme, colors } = useChartTheme();
  const [level, setLevel] = useState<number>(2); // start at month
  const { range, start, end, setCustomRange } = useDashboardRangeStore();
  const selectedGranularity = GRANS[level];
  const selectedUiGranularity = timeGranularityToUiGranularity(selectedGranularity);
  const defaultGranularity = resolveDefaultGranularityForRangePreset(range, start, end);
  const granularityCompare = compareGranularity(selectedUiGranularity, defaultGranularity);
  const granularityColor =
    granularityCompare === "match"
      ? "geekblue"
      : granularityCompare === "coarser"
        ? "orange"
        : granularityCompare === "finer"
          ? "cyan"
          : "default";
  const selectedGranularityLabel = formatGranularityLabel(selectedUiGranularity);
  const defaultGranularityLabel = formatGranularityLabel(defaultGranularity);
  const windowLabel = `${dayjs(start).format("YYYY-MM-DD")} - ${dayjs(end).format("YYYY-MM-DD")}`;

  const {
    data,
    loading: isLoading,
    error,
    refetch,
  } = useEconomicDataQuery({
    variables: {
      category,
      timeRange: { start: start.toISOString(), end: end.toISOString() },
      granularity: selectedGranularity,
    },
    fetchPolicy: "network-only",
    notifyOnNetworkStatusChange: true,
  });
  const isError = Boolean(error);
  const points = data?.getEconomicData ?? [];

  const breadcrumbs = GRANS.slice(0, level + 1).map((g, idx) => ({
    title: t(`dashboard.granularity.${g}`),
    onClick: () => setLevel(idx),
  }));

  const option = useMemo(() => {
    const seriesData =
      points.map((point: { timestamp: string; value: number }) => ({
        name: dayjs(point.timestamp).toISOString(),
        value: [point.timestamp, point.value],
      })) ?? [];
    const interval = uiGranularityToInterval(selectedUiGranularity);
    return {
      title: { text: title },
      tooltip: {
        trigger: "axis",
        formatter: (params: any) => {
          const payload = Array.isArray(params) ? params[0] : params;
          const axisValue = payload?.axisValue as string | number | undefined;
          const rawValue = payload?.value as unknown;
          const startTs = Array.isArray(rawValue) ? rawValue[0] : axisValue;
          const value = Array.isArray(rawValue) ? rawValue[1] : rawValue;
          const startIso =
            typeof startTs === "string"
              ? startTs
              : typeof startTs === "number"
                ? new Date(startTs).toISOString()
                : "";
          const endIso =
            startIso && interval
              ? dayjs(startIso).add(interval.count, interval.unit).toISOString()
              : null;
          const labelStart = startIso ? dayjs(startIso).format("YYYY-MM-DD") : "";
          const labelEnd = endIso ? dayjs(endIso).format("YYYY-MM-DD") : "";
          const bucketLabel = labelEnd ? `${labelStart} - ${labelEnd}` : labelStart;
          const valueNumber =
            typeof value === "number"
              ? value
              : typeof value === "string"
                ? Number(value)
                : Number.NaN;
          return [
            `<div style="font-weight:600;margin-bottom:6px;">${bucketLabel}</div>`,
            `<div>${Number.isFinite(valueNumber) ? valueNumber : String(value ?? "")}</div>`,
            `<div style="color:#64748b;margin-top:6px;">Bucket: ${selectedGranularityLabel}</div>`,
          ].join("");
        }
      },
      xAxis: { type: "time" },
      yAxis: { type: "value" },
      dataZoom: [{ type: "inside" }, { type: "slider" }],
      grid: {
        left: 20,
        right: 20,
        bottom: 40,
        containLabel: true,
      },
      series: [
        {
          name: category,
          type: "line",
          smooth: true,
          showSymbol: false,
          data: seriesData,
          itemStyle: {
            color: colors?.primary,
          },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                {
                  offset: 0,
                  color: colors?.primary ?? "#1677ff", // color at 0%
                },
                {
                  offset: 1,
                  color: "transparent", // color at 100%
                },
              ],
            },
            opacity: 0.1,
          },
        },
      ],
    };
  }, [category, colors, points, selectedGranularityLabel, selectedUiGranularity, title]);

  return (
    <Card
      title={title}
      loading={isLoading}
      extra={<Breadcrumb items={breadcrumbs} />}
    >
      <Space size={6} wrap style={{ marginBottom: 12 }}>
        <Tag color="default" className="text-xs">
          Range: {range}
        </Tag>
        <Tag color="default" className="text-xs">
          Window: {windowLabel}
        </Tag>
        <Tag color={granularityColor} className="text-xs">
          Aggregation:{" "}
          {granularityCompare === "match" || defaultGranularity === selectedUiGranularity
            ? selectedGranularityLabel
            : `${selectedGranularityLabel} (default ${defaultGranularityLabel})`}
        </Tag>
      </Space>
      {isError ? (
        <Alert
          type="error"
          showIcon
          message={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={error?.message}
          action={
            <Button size="small" onClick={() => refetch()}>
              {t("common.retry")}
            </Button>
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {!isLoading && points.length === 0 ? (
        <Alert
          type="info"
          message={t("dashboard.dataEmpty", { defaultValue: "No data" })}
          showIcon
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <DashboardChart
        group="dashboard-charts"
        option={option}
        theme={echartsTheme}
        onEvents={[
          {
            type: "click",
            handler: () => {
              if (level < GRANS.length - 1) {
                setLevel((prev) => Math.min(GRANS.length - 1, prev + 1));
              }
            },
          },
          {
            type: "dataZoom",
            handler: (params: unknown) => {
              const p = params as DataZoomEvent;
              const startVal =
                p.batch?.[0]?.startValue ??
                p.batch?.[0]?.start ??
                undefined;
              const endVal =
                p.batch?.[0]?.endValue ??
                p.batch?.[0]?.end ??
                undefined;
              if (startVal && endVal) {
                const startDate = dayjs(startVal);
                const endDate = dayjs(endVal);
                if (startDate.isValid() && endDate.isValid()) {
                  setCustomRange(startDate.toDate(), endDate.toDate());
                }
              }
            },
          },
        ]}
      />
    </Card>
  );
}
