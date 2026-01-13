"use client";

import { Alert, Breadcrumb, Button, Card } from "antd";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { TimeGranularity, useEconomicDataQuery } from "@/graphql/generated";
import { useChartTheme } from "@/hooks/use-chart-theme";
import dayjs from "@/lib/dayjs";
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
  const { start, end, setCustomRange } = useDashboardRangeStore();

  const {
    data,
    loading: isLoading,
    error,
    refetch,
  } = useEconomicDataQuery({
    variables: {
      category,
      timeRange: { start: start.toISOString(), end: end.toISOString() },
      granularity: GRANS[level],
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
    return {
      title: { text: title },
      tooltip: { trigger: "axis" },
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
  }, [category, points, title, colors]);

  return (
    <Card
      title={title}
      loading={isLoading}
      extra={<Breadcrumb items={breadcrumbs} />}
    >
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
