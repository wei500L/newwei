"use client";

import { Card, Empty } from "antd";
import type { EChartsCoreOption } from "echarts";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart, type EchartProps } from "@/components/echart";
import type { ChartDataState } from "@/lib/chart-data-state";

export interface DashboardChartCardProps {
  title: ReactNode;
  className?: string;
  extra?: ReactNode;
  option?: EChartsCoreOption | null;
  height?: EchartProps["height"];
  theme?: EchartProps["theme"];
  renderer?: EchartProps["renderer"];
  group?: EchartProps["group"];
  onEvents?: EchartProps["onEvents"];
  actions?: EchartProps["actions"];
  showExportImage?: boolean;
  exportFilename?: string;
  exportPixelRatio?: number;
  exportBackgroundColor?: string;
  state?: ChartDataState;
  emptyDescription?: ReactNode;
  errorDescription?: ReactNode;
  onRetry?: (() => void) | undefined;
}

const normalizeToArray = (value: unknown): unknown[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const hasSeries = (option: EChartsCoreOption) => {
  const series = normalizeToArray((option as { series?: unknown }).series);
  return series.length > 0;
};

export function DashboardChartCard({
  title,
  className,
  extra,
  option,
  height = 320,
  theme,
  renderer,
  group,
  onEvents,
  actions,
  showExportImage,
  exportFilename,
  exportPixelRatio,
  exportBackgroundColor,
  state,
  emptyDescription,
  errorDescription,
  onRetry
}: DashboardChartCardProps) {
  const { t } = useTranslation();
  const isRenderable = Boolean(option && hasSeries(option));

  return (
    <Card title={title} className={className} extra={extra}>
      {state === "error" ? (
        <ChartEmptyState
          variant="error"
          title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={
            errorDescription ??
            t("common.serviceUnavailable", {
              defaultValue: "Service is unavailable. Please try again."
            })
          }
          actionLabel={
            onRetry
              ? t("dashboard.actions.retryFetch", {
                  defaultValue: "Retry fetch"
                })
              : undefined
          }
          onAction={onRetry}
        />
      ) : isRenderable && option ? (
        <DashboardChart
          option={option}
          height={height}
          theme={theme}
          renderer={renderer}
          group={group}
          onEvents={onEvents}
          actions={actions}
          showExportImage={showExportImage}
          exportFilename={exportFilename}
          exportPixelRatio={exportPixelRatio}
          exportBackgroundColor={exportBackgroundColor}
        />
      ) : (
        <Empty
          description={
            emptyDescription ?? t("dashboard.dataEmpty", { defaultValue: "No data" })
          }
        />
      )}
    </Card>
  );
}
