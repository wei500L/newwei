"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import type { QueueStatusKey } from "@/store/dashboard-filters";
import { QUEUE_STATUS_KEYS } from "@/store/dashboard-filters";

interface QueueChartProps {
  data: Record<QueueStatusKey, number>;
  activeStatus?: QueueStatusKey | null;
  onFilterChange?: (status: QueueStatusKey | null) => void;
}

interface QueueChartClickParams {
  dataIndex?: number;
}

export function QueueChart({
  data,
  activeStatus,
  onFilterChange
}: QueueChartProps) {
  const { t } = useTranslation();
  const { echartsTheme, colors } = useChartTheme();

  const option = useMemo(() => {
    const labels = QUEUE_STATUS_KEYS.map((key) =>
      t(`dashboard.queue.states.${key}`, { defaultValue: key })
    );

    return {
      tooltip: {
        trigger: "axis",
      },
      grid: {
        top: 30,
        bottom: 30,
        left: 20,
        right: 20,
        containLabel: true,
      },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: {
          color: colors?.foreground,
        },
      },
      yAxis: {
        type: "value",
        splitLine: {
          lineStyle: {
            color: colors?.border,
            type: "dashed",
          },
        },
      },
      series: [
        {
          data: QUEUE_STATUS_KEYS.map((key) => ({
            value: data[key] ?? 0,
            itemStyle: {
              opacity:
                activeStatus && activeStatus !== key
                  ? 0.35
                  : 1,
              color:
                key === "failed"
                  ? colors?.destructive
                  : key === "completed"
                    ? colors?.bullish
                    : colors?.primary,
            },
          })),
          type: "bar",
          barMaxWidth: 60,
          itemStyle: {
            borderRadius: [4, 4, 0, 0],
          },
        },
      ],
    };
  }, [activeStatus, data, t, colors]);

  return (
    <DashboardChart
      group="dashboard-charts"
      option={option}
      theme={echartsTheme}
      height={260}
      onEvents={[
        {
          type: "click",
          handler: (params: unknown) => {
            if (!onFilterChange) return;
            const payload = params as QueueChartClickParams;
            const index = payload.dataIndex ?? -1;
            if (index < 0 || index >= QUEUE_STATUS_KEYS.length) return;
            const nextStatus = QUEUE_STATUS_KEYS[index] ?? null;
            onFilterChange(nextStatus === activeStatus ? null : nextStatus);
          },
        },
      ]}
    />
  );
}
