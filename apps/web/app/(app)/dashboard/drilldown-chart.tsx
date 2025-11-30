"use client";

import { Breadcrumb, Card } from "antd";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApolloClient } from "@apollo/client";
import { DashboardChart } from "@/components/echart";
import { useDashboardRangeStore } from "@/store/time-range";
import { EconomicDataDocument } from "@/graphql/generated";

const GRANS = ["year", "quarter", "month", "week", "day"] as const;

export function DrilldownChart({
  category,
  title,
}: {
  category: string;
  title: string;
}) {
  const [level, setLevel] = useState<number>(2); // start at month
  const client = useApolloClient();
  const { start, end, setCustomRange } = useDashboardRangeStore();

  const { data, isLoading } = useQuery({
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
    title: g,
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
      series: [
        {
          name: category,
          type: "line",
          smooth: true,
          showSymbol: false,
          data: seriesData,
        },
      ],
    };
  }, [category, data, title]);

  return (
    <Card
      title={title}
      loading={isLoading}
      extra={<Breadcrumb items={breadcrumbs} />}
    >
      <DashboardChart
        group="linked-charts"
        option={option}
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
            handler: (params: any) => {
              const startVal =
                params.batch?.[0]?.startValue ??
                params.batch?.[0]?.start ??
                undefined;
              const endVal =
                params.batch?.[0]?.endValue ??
                params.batch?.[0]?.end ??
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
