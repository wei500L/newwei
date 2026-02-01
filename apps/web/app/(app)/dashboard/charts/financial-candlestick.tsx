"use client";

import { useQuery } from "@tanstack/react-query";
import { Button, Skeleton, Space, Tag } from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { createApiClient } from "@/lib/api-client";
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
  const { data: session, status: sessionStatus } = useSession();
  const { range, start, end } = useDashboardRangeStore();
  const theme = useChartTheme();
  const [exportingCsv, setExportingCsv] = useState(false);
  const emptyTitle = t("dashboard.dataEmpty", { defaultValue: "No data" });
  const emptyHint = t("dashboard.dataEmptyHint", {
    defaultValue: "No data for the selected range. Try expanding the range."
  });
  const windowLabel = `${formatDateForFilename(start)} - ${formatDateForFilename(end)}`;

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

  const option = useMemo<EChartsOption>(() => {
    if (!data || data.points.length === 0) return {};
    const parsedInterval = parseInterval(data.interval);
    const intervalGranularity = intervalToGranularity(parsedInterval);
    const intervalGranularityLabel = formatGranularityLabel(intervalGranularity);
    const intervalUnitSuffix = data.interval ? ` (${data.interval})` : "";
    const showTime =
      intervalGranularity === UiTimeGranularity.Minute ||
      intervalGranularity === UiTimeGranularity.Hour ||
      intervalGranularity === UiTimeGranularity.Realtime;
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
        formatter: (params: any) => {
          const payload = Array.isArray(params) ? params[0] : params;
          const axisValue = payload?.axisValue as string | undefined;
          const values = payload?.data as number[] | undefined;
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
  }, [theme, data, locale]);

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

  const hasRenderableData = Boolean(data && data.points.length > 0);
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

  if (!data || data.points.length === 0) {
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
        group="dashboard-charts"
        option={option}
        height="100%"
        exportFilename={`financial-candlestick-${formatDateForFilename(
          start
        )}-${formatDateForFilename(end)}`}
        showExportImage
        actions={
          <Space size={8}>
            <Button
              size="small"
              type="default"
              onClick={handleCsvExport}
              loading={exportingCsv}
              disabled={!data || data.points.length === 0}
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
