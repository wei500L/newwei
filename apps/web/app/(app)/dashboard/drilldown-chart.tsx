"use client";

import { useApolloClient } from "@apollo/client";
import { useQuery } from "@tanstack/react-query";
import { Alert, Breadcrumb, Button, Card } from "antd";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { EconomicDataDocument } from "@/graphql/generated";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { useDashboardRangeStore } from "@/store/time-range";

const GRANS = ["year", "quarter", "month", "week", "day"] as const;

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
  const client = useApolloClient();
  const { start, end, setCustomRange } = useDashboardRangeStore();

  const { data, isLoading, isError, refetch, error } = useQuery({
    queryKey: [
      "economicData",
      category,
      level,
      start.toISOString(),
      end.toISOString(),
    ],
    queryFn: async () => {
      const res = await client.query({
        query: EconomicDataDocument,
        variables: {
          category,
          timeRange: { start: start.toISOString(), end: end.toISOString() },
          granularity: GRANS[level],
        },
        fetchPolicy: "network-only",
      });
      return res.data.getEconomicData;
    },
    staleTime: 60_000,
  });

  const breadcrumbs = GRANS.slice(0, level + 1).map((g, idx) => ({
    title: t(`dashboard.granularity.${g}`),
    onClick: () => setLevel(idx),
  }));

  const option = useMemo(() => {
    const seriesData =
      data?.map((point: { timestamp: string; value: number }) => ({
        name: new Date(point.timestamp).toISOString(),
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
  }, [category, data, title, colors]);

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
          message={t("dashboard.drilldown.loadFailed")}
          description={error instanceof Error ? error.message : undefined}
          action={
            <Button size="small" onClick={() => refetch()}>
              {t("common.retry")}
            </Button>
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {!isLoading && (!data || data.length === 0) ? (
        <Alert
          type="info"
          message={t("common.empty")}
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
                const startDate = new Date(startVal);
                const endDate = new Date(endVal);
                if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
                  setCustomRange(startDate, endDate);
                }
              }
            },
          },
        ]}
      />
    </Card>
  );
}
