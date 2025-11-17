"use client";

import { Breadcrumb, Card } from "antd";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApolloClient } from "@apollo/client";
import { DashboardChart } from "@/components/echart";
import { useDashboardRangeStore } from "@/store/time-range";
import { EconomicDataDocument, TimeGranularity } from "@/graphql/generated";

const GRANS: TimeGranularity[] = [TimeGranularity.Year, TimeGranularity.Quarter, TimeGranularity.Month, TimeGranularity.Week, TimeGranularity.Day];

export function DrilldownChart({ category, title }: { category: string; title: string }) {
  const [level, setLevel] = useState<number>(2); // start at month
  const client = useApolloClient();
  const { start, end } = useDashboardRangeStore();

  const { data, isLoading } = useQuery({
    queryKey: ["economicData", category, level, start.toISOString(), end.toISOString()],
    queryFn: async () => {
      const res = await client.query({
        query: EconomicDataDocument,
        variables: {
          category,
          timeRange: { start: start.toISOString(), end: end.toISOString() },
          granularity: GRANS[level]
        },
        fetchPolicy: "network-only"
      });
      return res.data.getEconomicData;
    },
    staleTime: 60_000
  });

  const breadcrumbs = GRANS.slice(0, level + 1).map((g) => ({
    title: g
  }));

  const option = useMemo(() => {
    const seriesData =
      data?.map((point) => ({
        name: new Date(point.timestamp).toISOString(),
        value: [point.timestamp, point.value]
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
          data: seriesData
        }
      ]
    };
  }, [category, data, title]);

  return (
    <Card title={title} loading={isLoading} extra={<Breadcrumb items={breadcrumbs} />}>
      <DashboardChart
        group="linked-charts"
        option={option}
        onEvents={[
          {
            type: "click",
            handler: (_params) => {
              if (level < GRANS.length - 1) {
                setLevel((prev) => Math.min(GRANS.length - 1, prev + 1));
              }
            }
          }
        ]}
      />
    </Card>
  );
}
