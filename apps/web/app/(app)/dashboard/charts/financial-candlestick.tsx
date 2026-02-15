"use client";

import { useQuery } from "@tanstack/react-query";
import { Button, Skeleton, Space, Tag } from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { DashboardChart } from "@/components/echart";
import { useCsvExport } from "@/hooks/use-csv-export";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { createApiClient } from "@/lib/api-client";
import {
  buildExportBaseName,
  buildExportFilename,
  formatDateForFilename
} from "@/lib/data-export";
import dayjs from "@/lib/dayjs";
import { formatDateTime, formatUpdatedAt, resolveLocale } from "@/lib/i18n";
import { buildRequestErrorEmptyState } from "@/lib/request-error-empty-state";
import {
  addInterval,
  formatGranularityLabel,
  intervalToGranularity,
  parseInterval,
  UiTimeGranularity,
} from "@/lib/time-granularity";
import { useDashboardRangeStore } from "@/store/time-range";

interface FinancialCandlePoint {
  timestamp: string;
  open: number;
  close: number;
  low: number;
  high: number;
  volume?: number;
}

interface FinancialCandlestickResponse {
  symbol: string;
  interval: string;
  points: FinancialCandlePoint[];
  unit?: string | null;
  sourceFields?: Record<string, string>;
  updatedAt?: string;
}

export function FinancialCandlestick() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session, status: sessionStatus } = useSession();
  const { range, start, end } = useDashboardRangeStore();
  const theme = useChartTheme();
  const { exporting: exportingCsv, label: csvLabel, exportCsv } = useCsvExport();
  const emptyTitle = t("dashboard.dataEmpty", { defaultValue: "No data" });
  const emptyHint = t("dashboard.dataEmptyHint", {
    defaultValue: "No data for the selected range. Try expanding the range."
  });
  const startLabel = formatDateForFilename(start);
  const endLabel = formatDateForFilename(end);
  const windowLabel = `${startLabel} - ${endLabel}`;

  const apiClient = useMemo(
    () => createApiClient({ accessToken: session?.accessToken }),
    [session?.accessToken]
  );

  const {
    data,
    isLoading,
    isError,
    error,
    refetch
  } = useQuery({
    queryKey: [
      "dashboard",
      "financial-candlestick",
      start.toISOString(),
      end.toISOString()
    ],
    queryFn: async () => {
      const response = await apiClient.get<FinancialCandlestickResponse>(
        "dashboard/financial-candlestick",
        {
          params: {
            start: start.toISOString(),
            end: end.toISOString()
          }
        }
      );
      return response.data;
    },
    staleTime: 10_000,
    enabled: Boolean(session?.accessToken),
    placeholderData: (previous) => previous
  });

  const updatedAtLabel = useMemo(() => {
    const iso = data?.updatedAt;
    if (!iso) return null;
    const formatted = formatUpdatedAt(iso, locale);
    return formatted ? formatted : null;
  }, [data?.updatedAt, locale]);

  const normalizedPoints = useMemo(() => {
    if (!data) return [];
    return data.points.flatMap((point) => {
      const open = Number(point.open);
      const close = Number(point.close);
      const lowRaw = Number(point.low);
      const highRaw = Number(point.high);
      const volume = point.volume == null ? undefined : Number(point.volume);
      if (
        !dayjs(point.timestamp).isValid() ||
        !Number.isFinite(open) ||
        !Number.isFinite(close) ||
        !Number.isFinite(lowRaw) ||
        !Number.isFinite(highRaw)
      ) {
        return [];
      }
      const low = Math.min(lowRaw, highRaw, open, close);
      const high = Math.max(lowRaw, highRaw, open, close);
      return [
        {
          timestamp: point.timestamp,
          open,
          close,
          low,
          high,
          volume: Number.isFinite(volume) ? volume : undefined
        }
      ];
    });
  }, [data]);

  const option = useMemo<EChartsOption>(() => {
    if (!data || normalizedPoints.length === 0) return {};
    const parsedInterval = parseInterval(data.interval);
    const intervalGranularity = intervalToGranularity(parsedInterval);
    const intervalGranularityLabel = formatGranularityLabel(intervalGranularity);
    const intervalUnitSuffix = data.interval ? ` (${data.interval})` : "";
    const showTime =
      intervalGranularity === UiTimeGranularity.Minute ||
      intervalGranularity === UiTimeGranularity.Hour ||
      intervalGranularity === UiTimeGranularity.Realtime;
    const useCandlestick = normalizedPoints.length >= 5;
    const timestamps = normalizedPoints.map((point) => point.timestamp);
    const ohlc = normalizedPoints.map((point) => [
      point.open,
      point.close,
      point.low,
      point.high
    ]);
    const closeSeries = normalizedPoints.map((point) => point.close);
    const unitSuffix = data.unit ? ` ${data.unit}` : "";
    const lastClose = normalizedPoints.at(-1)?.close;

    return {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        axisPointer: {
          type: "cross",
          label: {
            backgroundColor: theme.colors.primary
          }
        },
        backgroundColor: theme.colors.tooltipBg,
        borderColor: theme.colors.primary,
        textStyle: { color: theme.colors.tooltipText, fontFamily: theme.fontFamily },
        borderWidth: 1,
        formatter: (params: any) => {
          const payload = Array.isArray(params) ? params[0] : params;
          const axisValue = payload?.axisValue as string | undefined;
          const values = payload?.data as number[] | number | undefined;
          const startIso = typeof axisValue === "string" ? axisValue : "";
          const endIso = startIso ? addInterval(startIso, parsedInterval) : null;
          const startLabel = startIso
            ? formatDateTime(startIso, locale, showTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" })
            : "";
          const endLabel =
            endIso && dayjs(endIso).isValid()
              ? formatDateTime(endIso, locale, showTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" })
              : "";
          const bucketLabel = endLabel ? `${startLabel} - ${endLabel}` : startLabel;
          const fmt = (value: number | undefined) =>
            typeof value === "number" ? `${value}${unitSuffix}` : "N/A";
          if (!useCandlestick) {
            const closeValue =
              typeof values === "number"
                ? values
                : typeof payload?.value === "number"
                  ? payload.value
                  : typeof payload?.data === "number"
                    ? payload.data
                    : undefined;
            return [
              `<div style="min-width:220px;">`,
              `<div style="font-weight:600;margin-bottom:6px;">${bucketLabel}</div>`,
              `<div style="display:flex;justify-content:space-between;"><span>Close</span><span>${fmt(closeValue)}</span></div>`,
              `<div style="margin-top:8px;color:#64748b;">Bucket: ${intervalGranularityLabel}${intervalUnitSuffix}</div>`,
              `</div>`
            ].join("");
          }
          const open = Array.isArray(values) ? values[0] : undefined;
          const close = Array.isArray(values) ? values[1] : undefined;
          const low = Array.isArray(values) ? values[2] : undefined;
          const high = Array.isArray(values) ? values[3] : undefined;

          return [
            `<div style="min-width:220px;">`,
            `<div style="font-weight:600;margin-bottom:6px;">${bucketLabel}</div>`,
            `<div style="display:flex;justify-content:space-between;"><span>Open</span><span>${fmt(open)}</span></div>`,
            `<div style="display:flex;justify-content:space-between;"><span>High</span><span>${fmt(high)}</span></div>`,
            `<div style="display:flex;justify-content:space-between;"><span>Low</span><span>${fmt(low)}</span></div>`,
            `<div style="display:flex;justify-content:space-between;"><span>Close</span><span>${fmt(close)}</span></div>`,
            `<div style="margin-top:8px;color:#64748b;">Bucket: ${intervalGranularityLabel}${intervalUnitSuffix}</div>`,
            `</div>`
          ].join("");
        },
      },
      grid: {
        left: "2%",
        right: "2%",
        bottom: "10%",
        top: "10%",
        containLabel: true
      },
      xAxis: {
        type: "category",
        data: timestamps,
        scale: true,
        boundaryGap: true, // Candles need gap usually
        axisLine: { onZero: false, lineStyle: { color: theme.colors.grid } },
        axisLabel: {
          color: theme.colors.foreground,
          fontFamily: theme.fontFamily,
          formatter: (value: unknown) => {
            if (typeof value !== "string") return "";
            return showTime
              ? dayjs(value).format("MM-DD HH:mm")
              : dayjs(value).format("MM-DD");
          }
        },
        splitLine: { show: false }, // No grid
        axisTick: { show: false }
      },
      yAxis: {
        scale: true,
        splitArea: { show: false },
        splitLine: { show: false }, // No grid
        axisLabel: {
          color: theme.colors.foreground,
          fontFamily: theme.fontFamily,
          formatter: (value: unknown) => `${value}${unitSuffix}`
        },
        axisLine: { show: false }
      },
      series: [
        useCandlestick
          ? {
              name: data.symbol ?? "Index",
              type: "candlestick",
              data: ohlc,
              itemStyle: {
                color: theme.colors.bullish,
                color0: theme.colors.bearish,
                borderColor: theme.colors.bullish,
                borderColor0: theme.colors.bearish,
                shadowBlur: 5,
                shadowColor: "inherit"
              },
              markLine:
                typeof lastClose === "number"
                  ? {
                      symbol: ["none", "none"],
                      data: [
                        {
                          yAxis: lastClose,
                          label: {
                            show: true,
                            position: "end",
                            backgroundColor: theme.colors.primary,
                            color: "#ffffff",
                            padding: [2, 4],
                            borderRadius: 2,
                            formatter: unitSuffix ? `{c}${unitSuffix}` : "{c}"
                          },
                          lineStyle: {
                            color: theme.colors.primary,
                            type: "dashed",
                            opacity: 0.5
                          }
                        }
                      ]
                    }
                  : undefined
            }
          : {
              name: data.symbol ?? "Index",
              type: "line",
              data: closeSeries,
              smooth: true,
              showSymbol: false,
              lineStyle: {
                color: theme.colors.primary,
                width: 2
              },
              areaStyle: {
                color: {
                  type: "linear",
                  x: 0,
                  y: 0,
                  x2: 0,
                  y2: 1,
                  colorStops: [
                    { offset: 0, color: "rgba(31, 59, 123, 0.28)" },
                    { offset: 1, color: "rgba(31, 59, 123, 0.02)" }
                  ]
                }
              }
            }
      ],
    };
  }, [theme, data, locale, normalizedPoints]);

  const parsedInterval = useMemo(() => parseInterval(data?.interval), [data?.interval]);
  const intervalGranularity = intervalToGranularity(parsedInterval);
  const intervalGranularityLabel = formatGranularityLabel(intervalGranularity);
  const intervalColor =
    intervalGranularity === UiTimeGranularity.Unknown ? "default" : "geekblue";
  const intervalDescriptor = data?.interval
    ? `${intervalGranularityLabel} (${data.interval})`
    : intervalGranularityLabel;
  const intervalTagText = `Interval: ${intervalDescriptor}`;

  const handleCsvExport = useCallback(async () => {
    if (!data || normalizedPoints.length === 0) return;
    const rows = [
      ["Timestamp", "Open", "High", "Low", "Close", "Volume"],
      ...normalizedPoints.map((point) => [
        point.timestamp,
        point.open,
        point.high,
        point.low,
        point.close,
        point.volume ?? ""
      ])
    ];
    const filename = buildExportFilename({
      base: "financial-candlestick",
      suffixes: [data.symbol],
      start: startLabel,
      end: endLabel,
      extension: "csv"
    });
    await exportCsv({ rows, filename });
  }, [data, endLabel, exportCsv, normalizedPoints, startLabel]);
  // csvLabel handled by useCsvExport

  const hasRenderableData = Boolean(data && normalizedPoints.length > 0);
  const showStaleErrorBanner = Boolean(isError && hasRenderableData);

  if (sessionStatus === "loading") {
    return (
      <div className="h-[350px] flex items-center transition-all duration-300">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="h-[350px] flex items-center transition-all duration-300">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (isError && !data) {
    const emptyState = buildRequestErrorEmptyState({ t, error, onRetry: () => refetch() });
    return (
      <div className="h-[350px] transition-all duration-300">
        <ChartEmptyState {...emptyState} />
      </div>
    );
  }

  if (!data || normalizedPoints.length === 0) {
    return (
      <div className="h-[350px] transition-all duration-300">
        <ChartEmptyState title={emptyTitle} description={emptyHint} />
      </div>
    );
  }

  return (
    <div className="relative h-[350px] transition-all duration-300">
      {showStaleErrorBanner ? (
        <div className="absolute left-2 right-2 top-2 z-20">
          <RequestErrorBanner
            error={error}
            onRetry={() => void refetch()}
            showCachedDataHint
          />
        </div>
      ) : null}
      <div className="absolute left-2 top-2 z-10 flex flex-wrap items-center gap-2">
        <Tag color="default" className="text-xs">
          Range: {range}
        </Tag>
        <Tag color="default" className="text-xs">
          Window: {windowLabel}
        </Tag>
        <Tag color={intervalColor} className="text-xs">
          {intervalTagText}
        </Tag>
        {updatedAtLabel ? (
          <Tag color="default" className="text-xs">
            {t("dashboard.updatedAt", {
              time: updatedAtLabel,
              defaultValue: "Updated: {{time}}"
            })}
          </Tag>
        ) : null}
      </div>
      <DashboardChart
        option={option}
        height="100%"
        exportFilename={buildExportBaseName({
          base: "financial-candlestick",
          suffixes: [data.symbol],
          start: startLabel,
          end: endLabel,
          fallback: "chart"
        })}
        showExportImage
        actions={
          <Space size={8}>
            <Button
              size="small"
              type="default"
              onClick={handleCsvExport}
              loading={exportingCsv}
              disabled={!data || normalizedPoints.length === 0}
            >
              {csvLabel}
            </Button>
          </Space>
        }
      />
      {isLoading ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Skeleton active paragraph={{ rows: 4 }} />
        </div>
      ) : null}
    </div>
  );
}
