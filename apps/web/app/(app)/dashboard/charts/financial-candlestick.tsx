"use client";

import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Spin } from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { DashboardChart } from "@/components/echart";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { createApiClient } from "@/lib/api-client";
import { useChartTheme } from "@/hooks/use-chart-theme";
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

const buildCsv = async (rows: Array<Array<string | number | null | undefined>>) => {
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    lines.push(rows[i].map(escapeCsvValue).join(","));
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
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export function FinancialCandlestick() {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const { start, end } = useDashboardRangeStore();
  const theme = useChartTheme();
  const [exportingCsv, setExportingCsv] = useState(false);
  const emptyMessage = t("dashboard.charts.noDataRange", {
    defaultValue: "No Data Found for Selected Range"
  });

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

    return {
      backgroundColor: "transparent",
      title: {
        text: data.symbol || t("dashboard.charts.financialCandlestick.title", { defaultValue: "Market Index" }),
        subtext: data.updatedAt ? new Date(data.updatedAt).toLocaleString() : undefined,
        left: 0,
        textStyle: { color: theme.colors.tooltipText, fontFamily: theme.fontFamily },
      },
      tooltip: {
        trigger: "axis",
        axisPointer: {
          type: "cross",
        },
        backgroundColor: theme.colors.tooltipBg,
        borderColor: theme.colors.grid,
        textStyle: { color: theme.colors.tooltipText },
      },
      grid: {
        left: "10%",
        right: "10%",
        bottom: "15%",
      },
      xAxis: {
        type: "category",
        data: timestamps,
        scale: true,
        boundaryGap: false,
        axisLine: { onZero: false, lineStyle: { color: theme.colors.grid } },
        axisLabel: { color: theme.colors.foreground, fontFamily: theme.fontFamily },
        splitLine: { show: false },
        splitNumber: 20,
      },
      yAxis: {
        scale: true,
        splitArea: {
          show: true,
          areaStyle: { color: ["rgba(255,255,255,0.02)", "rgba(255,255,255,0.05)"] }
        },
        splitLine: { lineStyle: { color: theme.colors.grid } },
        axisLabel: { color: theme.colors.foreground, fontFamily: theme.fontFamily },
      },
      dataZoom: [
        {
          type: "inside",
          start: 0,
          end: 100,
        },
        {
          show: true,
          type: "slider",
          top: "90%",
          start: 0,
          end: 100,
          borderColor: theme.colors.grid,
          textStyle: { color: theme.colors.foreground },
        },
      ],
      animationDurationUpdate: 300,
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
          },
        },
      ],
    };
  }, [theme, data, t]);

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
    } catch (error) {
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
      <div className="flex h-[350px] items-center justify-center">
        <Spin />
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="flex h-[350px] items-center justify-center">
        <Alert
          type="error"
          showIcon
          message={t("dashboard.widgets.loadFailed", {
            defaultValue: "Failed to load data"
          })}
          description={error instanceof Error ? error.message : undefined}
          action={
            <Button size="small" onClick={() => refetch()}>
              {t("common.retry")}
            </Button>
          }
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
          <Spin />
        </div>
      ) : null}
    </div>
  );
}
