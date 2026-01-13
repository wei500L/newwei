"use client";

import { useQuery } from "@tanstack/react-query";
import { Button, Skeleton } from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { createApiClient } from "@/lib/api-client";
import dayjs from "@/lib/dayjs";
import { resolveLocale } from "@/lib/i18n";
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

const escapeCsvValue = (value: string | number | null | undefined) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
};

const yieldToMain = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });

const buildCsv = async (rows: (string | number | null | undefined)[][]) => {
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) {
      continue;
    }
    lines.push(row.map(escapeCsvValue).join(","));
    if (i > 0 && i % 500 === 0) {
      await yieldToMain();
    }
  }
  return lines.join("\n");
};

const downloadCsvFile = (csv: string, filename: string) => {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const sanitizeFilename = (value: string) => {
  const normalized = value.trim().replace(/[^a-zA-Z0-9-_]+/g, "-");
  const trimmed = normalized.replace(/^-+|-+$/g, "");
  return trimmed || "export";
};

const formatDateForFilename = (date: Date) => {
  return dayjs.utc(date).format("YYYY-MM-DD");
};

export function FinancialCandlestick() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session } = useSession();
  const { start, end } = useDashboardRangeStore();
  const theme = useChartTheme();
  const [exportingCsv, setExportingCsv] = useState(false);
  const emptyMessage = t("dashboard.dataEmpty", { defaultValue: "No data" });

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

  const option = useMemo<EChartsOption>(() => {
    if (!data || data.points.length === 0) return {};
    const timestamps = data.points.map((point) => point.timestamp);
    const ohlc = data.points.map((point) => [
      point.open,
      point.close,
      point.low,
      point.high
    ]);
    const unitSuffix = data.unit ? ` ${data.unit}` : "";
    const lastClose = data.points.at(-1)?.close;

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
        axisLabel: { color: theme.colors.foreground, fontFamily: theme.fontFamily },
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
      dataZoom: [
        {
          type: "inside",
          start: 50,
          end: 100,
        },
      ],
      series: [
        {
          name: data.symbol ?? "Index",
          type: "candlestick",
          data: ohlc,
          itemStyle: {
            color: theme.colors.bullish,
            color0: theme.colors.bearish,
            borderColor: theme.colors.bullish,
            borderColor0: theme.colors.bearish,
            shadowBlur: 5,
            shadowColor: "inherit" // Glow effect
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
        },
      ],
    };
  }, [theme, data, locale, t]);

  const handleCsvExport = useCallback(async () => {
    if (!data || data.points.length === 0) return;
    setExportingCsv(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const rows = [
        ["Timestamp", "Open", "High", "Low", "Close", "Volume"],
        ...data.points.map((point) => [
          point.timestamp,
          point.open,
          point.high,
          point.low,
          point.close,
          point.volume ?? ""
        ])
      ];
      const csv = await buildCsv(rows);
      const startLabel = formatDateForFilename(start);
      const endLabel = formatDateForFilename(end);
      const symbolSuffix = data.symbol ? `-${sanitizeFilename(data.symbol)}` : "";
      const filename = `financial-candlestick${symbolSuffix}-${startLabel}-${endLabel}.csv`;
      downloadCsvFile(csv, filename);
      toast.success(
        t("dashboard.charts.downloadSuccess", { defaultValue: "Download completed" })
      );
    } catch {
      toast.error(
        t("dashboard.charts.downloadFailed", { defaultValue: "Download failed" })
      );
    } finally {
      setExportingCsv(false);
    }
  }, [data, end, start, t]);

  const csvLabel = exportingCsv
    ? t("dashboard.charts.exporting", { defaultValue: "Exporting..." })
    : t("dashboard.charts.downloadCsv", { defaultValue: "Download CSV" });

  if (isLoading && !data) {
    return (
      <div className="h-[350px] flex items-center">
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="h-[350px]">
        <ChartEmptyState
          variant="error"
          title={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={error instanceof Error ? error.message : emptyMessage}
          actionLabel={t("common.retry")}
          onAction={() => refetch()}
        />
      </div>
    );
  }

  if (!data || data.points.length === 0) {
    return (
      <div className="h-[350px]">
        <ChartEmptyState description={emptyMessage} />
      </div>
    );
  }

  return (
    <div className="relative h-[350px]">
      <DashboardChart
        group="dashboard-charts"
        option={option}
        height="100%"
        exportFilename={`financial-candlestick-${formatDateForFilename(
          start
        )}-${formatDateForFilename(end)}`}
        showExportImage
        actions={
          <Button
            size="small"
            type="default"
            onClick={handleCsvExport}
            loading={exportingCsv}
            disabled={!data || data.points.length === 0}
          >
            {csvLabel}
          </Button>
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
