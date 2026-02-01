"use client";

import { gql, useQuery } from "@apollo/client";
import { Alert, Button, Skeleton, Space, Tag, Typography } from "antd";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import type { TimeGranularity } from "@/graphql/generated";
import { formatDashboardWindowLabel } from "@/lib/dashboard-time";
import dayjs from "@/lib/dayjs";
import { resolveEconomicUnit } from "@/lib/economic-units";
import {
  compareGranularity,
  formatGranularityLabel,
  pickCoarsestGranularity,
  resolveDefaultGranularityForRangePreset,
  timeGranularityToUiGranularity,
  UiTimeGranularity,
  uiGranularityToInterval,
} from "@/lib/time-granularity";
import { useDashboardRangeStore } from "@/store/time-range";

const ECONOMIC_WIDGET_QUERY = gql`
  query EconomicWidgetData(
    $category: String!
    $timeRange: DateRangeInput!
    $granularity: TimeGranularity
  ) {
    getEconomicData(
      category: $category
      timeRange: $timeRange
      granularity: $granularity
    ) {
      timestamp
      effectiveGranularity
      value
      unit
      dataType
      item {
        defaultUnit
      }
    }
  }
`;

const parseDataSource = (dataSource: string) => {
  if (dataSource.startsWith("economic:")) {
    return {
      kind: "economic" as const,
      category: dataSource.replace("economic:", ""),
    };
  }
  return { kind: "unknown" as const };
};

const chooseGranularity = (
  start: Date,
  end: Date,
  explicit?: TimeGranularity,
) => {
  if (explicit) return explicit;
  const diffDays = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)),
  );
  if (diffDays > 1095) return "year";
  if (diffDays > 365) return "quarter";
  if (diffDays > 120) return "month";
  if (diffDays > 45) return "week";
  return "day";
};

export interface WidgetRenderProps {
  type: string;
  title?: string;
  dataSource: string;
  color?: string;
  data?: {
    timestamp: string | number;
    effectiveGranularity?: string | null;
    value: number;
    unit?: string | null;
    dataType?: string | null;
    item?: { defaultUnit?: string | null } | null;
  }[];
}

type ResolvedDataPoint = {
  timestamp: string | number;
  effectiveGranularity?: string | null;
  value: number;
  unit?: string | null;
  dataType?: string | null;
  item?: { defaultUnit?: string | null } | null;
};

export function WidgetRenderer({
  type,
  title,
  data,
  dataSource,
  color,
}: WidgetRenderProps) {
  const { t } = useTranslation();
  const { range, start, end } = useDashboardRangeStore();
  const sourceInfo = parseDataSource(dataSource);
  const chosenGranularity = useMemo(
    () => chooseGranularity(start, end),
    [end, start],
  );
  const defaultGranularity = resolveDefaultGranularityForRangePreset(range, start, end);
  const chosenUiGranularity = timeGranularityToUiGranularity(chosenGranularity);
  const windowLabel = formatDashboardWindowLabel(start, end);
  const {
    data: apiData,
    loading,
    error,
    refetch,
  } = useQuery(ECONOMIC_WIDGET_QUERY, {
    skip: sourceInfo.kind !== "economic",
    variables:
      sourceInfo.kind !== "economic"
        ? undefined
        : {
            category: sourceInfo.category,
            timeRange: { start: start.toISOString(), end: end.toISOString() },
            granularity: chosenGranularity,
          },
    fetchPolicy: "cache-first",
  });

  const resolvedData: ResolvedDataPoint[] | undefined =
    data ??
    apiData?.getEconomicData?.map(
      (p: {
        timestamp: string;
        effectiveGranularity?: string | null;
        value: number;
        unit?: string | null;
        dataType?: string | null;
        item?: { defaultUnit?: string | null } | null;
      }) => ({
        timestamp: p.timestamp,
        effectiveGranularity: p.effectiveGranularity ?? null,
        value: p.value,
        unit: p.unit ?? null,
        dataType: p.dataType ?? null,
        item: p.item ?? null,
      }),
    );

  const activeUiGranularity = useMemo(() => {
    const backend = pickCoarsestGranularity(
      (resolvedData ?? []).map((point) => timeGranularityToUiGranularity(point.effectiveGranularity)),
    );
    return backend === UiTimeGranularity.Unknown ? chosenUiGranularity : backend;
  }, [chosenUiGranularity, resolvedData]);

  const chosenGranularityLabel = formatGranularityLabel(chosenUiGranularity);
  const activeGranularityLabel = formatGranularityLabel(activeUiGranularity);
  const defaultGranularityLabel = formatGranularityLabel(defaultGranularity);
  const granularityCompare = compareGranularity(activeUiGranularity, defaultGranularity);
  const granularityColor =
    granularityCompare === "match"
      ? "geekblue"
      : granularityCompare === "coarser"
        ? "orange"
        : granularityCompare === "finer"
          ? "cyan"
          : "default";

  const seriesUnit = useMemo(() => {
    const series = resolvedData ?? [];
    for (let i = series.length - 1; i >= 0; i -= 1) {
      const point = series[i];
      if (!point) continue;
      const unit = resolveEconomicUnit({
        unit: point.unit ?? null,
        defaultUnit: point.item?.defaultUnit ?? null,
        dataType: point.dataType ?? null,
      });
      if (unit) return unit;
    }
    return null;
  }, [resolvedData]);

  const option = useMemo(() => {
    const seriesData = resolvedData?.map((p) => [p.timestamp, p.value]) ?? [];
    const interval = uiGranularityToInterval(activeUiGranularity);
    const common = {
      title: { text: title ?? dataSource },
      tooltip:
        type === "pie"
          ? { trigger: "item" as const }
          : {
              trigger: "axis" as const,
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
                const endIso = startIso && interval
                  ? dayjs(startIso).add(interval.count, interval.unit).toISOString()
                  : null;
                const labelStart = startIso ? dayjs(startIso).format("YYYY-MM-DD") : "";
                const labelEnd = endIso ? dayjs(endIso).format("YYYY-MM-DD") : "";
                const rangeLabel = labelEnd ? `${labelStart} - ${labelEnd}` : labelStart;
                const valueNumber =
                  typeof value === "number"
                    ? value
                    : typeof value === "string"
                      ? Number(value)
                      : typeof payload?.data === "number"
                        ? payload.data
                        : Number.NaN;

                return [
                  `<div style="font-weight:600;margin-bottom:6px;">${rangeLabel}</div>`,
                  `<div>${Number.isFinite(valueNumber) ? valueNumber.toFixed(2) : String(value ?? "")}${seriesUnit ? ` ${seriesUnit}` : ""}</div>`,
                  `<div style="color:#64748b;margin-top:6px;">Bucket: ${activeGranularityLabel}</div>`,
                ].join("");
              }
            },
      dataZoom: [{ type: "inside" }, { type: "slider" }],
      xAxis: type === "bar" ? { type: "category" } : { type: "time" },
      yAxis: { type: "value" },
      color: color ? [color] : undefined,
    };

    switch (type) {
      case "bar":
        return {
          ...common,
          series: [
            {
              type: "bar",
              data: seriesData.map(([, v]) => v),
              barWidth: "60%",
            },
          ],
          xAxis: {
            type: "category",
            data: resolvedData?.map((p) => p.timestamp),
          },
        };
      case "pie":
        return {
          ...common,
          series: [
            {
              type: "pie",
              radius: "60%",
              data:
                resolvedData?.map((p) => ({
                  name: p.timestamp,
                  value: p.value,
                })) ?? [],
            },
          ],
        };
      case "scatter":
        return {
          ...common,
          series: [{ type: "scatter", data: seriesData }],
        };
      case "kline":
        return {
          ...common,
          series: [{ type: "candlestick", data: [] }],
        };
      case "radar":
        return {
          radar: {
            indicator: resolvedData?.map((p) => ({
              name: String(p.timestamp),
              max: Math.max(...(resolvedData?.map((d) => d.value) ?? [1])),
            })),
          },
          series: [
            {
              type: "radar",
              data: [
                {
                  value: resolvedData?.map((p) => p.value) ?? [],
                  name: title ?? dataSource,
                },
              ],
            },
          ],
        };
      default:
        return {
          ...common,
          series: [
            { type: "line", smooth: true, showSymbol: false, data: seriesData },
          ],
        };
    }
  }, [activeGranularityLabel, activeUiGranularity, color, dataSource, resolvedData, seriesUnit, title, type]);

  const theme = useMemo(
    () =>
      color
        ? {
            color: [color],
            textStyle: { color: "#333" },
            title: { textStyle: { color } },
          }
        : undefined,
    [color],
  );

  if (sourceInfo.kind === "unknown") {
    return (
      <Typography.Text type="secondary">
        {t("dashboard.widgets.unsupportedSource", { source: dataSource })}
      </Typography.Text>
    );
  }

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
        description={error.message}
        action={
          <Button size="small" onClick={() => refetch()}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  }

  if (loading) {
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }

  if (!resolvedData || resolvedData.length === 0) {
    return (
      <Typography.Text type="secondary">
        {t("dashboard.dataEmpty", { defaultValue: "No data" })}
      </Typography.Text>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Space size={6} wrap>
        <Tag color="default" className="text-xs">
          Range: {range}
        </Tag>
        <Tag color="default" className="text-xs">
          Window: {windowLabel}
        </Tag>
        {seriesUnit ? (
          <Tag color="default" className="text-xs">
            Unit: {seriesUnit}
          </Tag>
        ) : null}
        <Tag color={granularityColor} className="text-xs">
          Aggregation:{" "}
          {granularityCompare === "match" || defaultGranularity === activeUiGranularity
            ? activeGranularityLabel
            : `${activeGranularityLabel} (default ${defaultGranularityLabel})`}
          {activeUiGranularity !== chosenUiGranularity
            ? ` (requested ${chosenGranularityLabel})`
            : ""}
        </Tag>
      </Space>
      <DashboardChart
        option={option}
        height={300}
        group="linked-charts"
        theme={theme}
      />
    </div>
  );
}
