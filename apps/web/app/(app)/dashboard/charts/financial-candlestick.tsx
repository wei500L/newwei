"use client";

import { useQuery } from "@tanstack/react-query";
import { Button, Skeleton, Space, Tag } from "antd";
import type { EChartsOption } from "echarts";
import { useSession } from "next-auth/react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import { useCsvExport } from "@/hooks/use-csv-export";
import { usePendingAction } from "@/hooks/use-pending-action";
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
  formatGranularityLabelLocalized,
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
  latestObservedAt?: string;
  skippedIncompleteCount?: number;
}

export function FinancialCandlestick() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { data: session, status: sessionStatus } = useSession();
  const { range, start, end } = useDashboardRangeStore();
  const theme = useChartTheme();
  const { exporting: exportingCsv, label: csvLabel, exportCsv } = useCsvExport();
  const emptyTitle = t("dashboard.dataEmpty", { defaultValue: "No data" });
  const emptyHint = t("dashboard.candlestick.emptyHintRefresh", {
    defaultValue: "No data for the selected range. Try expanding the range or refresh the data."
  });
  const rangeLabel = t("dashboard.charts.rangeLabel", { defaultValue: "Range" });
  const windowLabelText = t("dashboard.charts.windowLabel", { defaultValue: "Window" });
  const intervalLabel = t("dashboard.candlestick.interval", { defaultValue: "Interval" });
  const bucketLabelText = t("dashboard.candlestick.bucket", { defaultValue: "Bucket" });
  const openLabel = t("dashboard.candlestick.open", { defaultValue: "Open" });
  const highLabel = t("dashboard.candlestick.high", { defaultValue: "High" });
  const lowLabel = t("dashboard.candlestick.low", { defaultValue: "Low" });
  const closeLabel = t("dashboard.candlestick.close", { defaultValue: "Close" });
  const changeLabel = t("dashboard.candlestick.change", { defaultValue: "Change" });
  const sessionRangeLabel = t("dashboard.candlestick.sessionRange", {
    defaultValue: "Session range"
  });
  const timestampLabel = t("dashboard.candlestick.timestamp", { defaultValue: "Timestamp" });
  const volumeLabel = t("dashboard.candlestick.volume", { defaultValue: "Volume" });
  const latestCloseLabelText = t("dashboard.candlestick.latestClose", {
    defaultValue: "Latest close"
  });
  const windowChangeLabelText = t("dashboard.candlestick.windowChange", {
    defaultValue: "Window change"
  });
  const notAvailableShort = t("dashboard.candlestick.notAvailableShort", {
    defaultValue: "N/A"
  });
  const startLabel = formatDateForFilename(start);
  const endLabel = formatDateForFilename(end);
  const windowLabel = `${startLabel} - ${endLabel}`;
  const numberFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        maximumFractionDigits: 2
      }),
    [locale]
  );
  const signedNumberFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        maximumFractionDigits: 2,
        signDisplay: "always"
      }),
    [locale]
  );

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
  });
  const { pending: refreshingCandles, run: refreshCandles } = usePendingAction(
    () => refetch(),
  );

  const updatedAtLabel = useMemo(() => {
    const iso = data?.updatedAt;
    if (!iso) return null;
    const formatted = formatUpdatedAt(iso, locale);
    return formatted ? formatted : null;
  }, [data?.updatedAt, locale]);

  const latestObservedAtLabel = useMemo(() => {
    const iso = data?.latestObservedAt;
    if (!iso || iso === data?.updatedAt) return null;
    const formatted = formatUpdatedAt(iso, locale);
    return formatted ? formatted : null;
  }, [data?.latestObservedAt, data?.updatedAt, locale]);

  const updatedAtTagText = useMemo(() => {
    if (!updatedAtLabel) return null;
    if (data?.skippedIncompleteCount) {
      return t("dashboard.candlestick.latestComplete", {
        time: updatedAtLabel,
        defaultValue: "Latest complete: {{time}}"
      });
    }
    return t("dashboard.updatedAt", {
      time: updatedAtLabel,
      defaultValue: "Updated: {{time}}"
    });
  }, [data?.skippedIncompleteCount, t, updatedAtLabel]);

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

  const summaryMetrics = useMemo(() => {
    if (!data || normalizedPoints.length === 0) return null;
    const first = normalizedPoints[0];
    const last = normalizedPoints.at(-1);
    if (!first || !last) return null;

    const unitSuffix = data.unit ? ` ${data.unit}` : "";
    const latestCloseText = `${numberFormatter.format(last.close)}${unitSuffix}`;
    if (normalizedPoints.length < 2 || !Number.isFinite(first.close) || first.close === 0) {
      return {
        latestCloseText,
        windowChangeText: null,
        windowChangeColor: "default" as const
      };
    }

    const absoluteChange = last.close - first.close;
    const percentChange = (absoluteChange / first.close) * 100;
    const absoluteText = `${signedNumberFormatter.format(absoluteChange)}${unitSuffix}`;
    const percentText = `${signedNumberFormatter.format(percentChange)}%`;
    const windowChangeColor =
      absoluteChange > 0 ? "success" : absoluteChange < 0 ? "error" : "default";

    return {
      latestCloseText,
      windowChangeText: `${absoluteText} (${percentText})`,
      windowChangeColor
    };
  }, [data, normalizedPoints, numberFormatter, signedNumberFormatter]);

  const option = useMemo<EChartsOption>(() => {
    if (!data || normalizedPoints.length === 0) return {};
    const parsedInterval = parseInterval(data.interval);
    const intervalGranularity = intervalToGranularity(parsedInterval);
    const intervalGranularityLabel = formatGranularityLabelLocalized(intervalGranularity, t);
    const intervalUnitSuffix = data.interval ? ` (${data.interval})` : "";
    const showTime =
      intervalGranularity === UiTimeGranularity.Minute ||
      intervalGranularity === UiTimeGranularity.Hour ||
      intervalGranularity === UiTimeGranularity.Realtime;
    const timestamps = normalizedPoints.map((point) => point.timestamp);
    const ohlc = normalizedPoints.map((point) => [
      point.open,
      point.close,
      point.low,
      point.high
    ]);
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
            typeof value === "number"
              ? `${numberFormatter.format(value)}${unitSuffix}`
              : notAvailableShort;
          const fmtSigned = (value: number | undefined) =>
            typeof value === "number"
              ? `${signedNumberFormatter.format(value)}${unitSuffix}`
              : notAvailableShort;
          const fmtPercent = (value: number | undefined) =>
            typeof value === "number" ? `${signedNumberFormatter.format(value)}%` : null;
          const open = Array.isArray(values) ? values[0] : undefined;
          const close = Array.isArray(values) ? values[1] : undefined;
          const low = Array.isArray(values) ? values[2] : undefined;
          const high = Array.isArray(values) ? values[3] : undefined;
          const change =
            typeof open === "number" && typeof close === "number" ? close - open : undefined;
          const changePercent =
            typeof change === "number" && typeof open === "number" && open !== 0
              ? (change / open) * 100
              : undefined;
          const sessionRange =
            typeof high === "number" && typeof low === "number" ? high - low : undefined;
          const changeText = fmtPercent(changePercent)
            ? `${fmtSigned(change)} (${fmtPercent(changePercent)})`
            : fmtSigned(change);

          return [
            `<div style="min-width:220px;">`,
            `<div style="font-weight:600;margin-bottom:6px;">${bucketLabel}</div>`,
            `<div style="display:flex;justify-content:space-between;"><span>${openLabel}</span><span>${fmt(open)}</span></div>`,
            `<div style="display:flex;justify-content:space-between;"><span>${highLabel}</span><span>${fmt(high)}</span></div>`,
            `<div style="display:flex;justify-content:space-between;"><span>${lowLabel}</span><span>${fmt(low)}</span></div>`,
            `<div style="display:flex;justify-content:space-between;"><span>${closeLabel}</span><span>${fmt(close)}</span></div>`,
            `<div style="display:flex;justify-content:space-between;"><span>${changeLabel}</span><span>${changeText}</span></div>`,
            `<div style="display:flex;justify-content:space-between;"><span>${sessionRangeLabel}</span><span>${fmt(sessionRange)}</span></div>`,
            `<div style="margin-top:8px;color:#64748b;">${bucketLabelText}: ${intervalGranularityLabel}${intervalUnitSuffix}</div>`,
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
      ],
    };
  }, [
    theme,
    data,
    locale,
    normalizedPoints,
    t,
    bucketLabelText,
    closeLabel,
    changeLabel,
    highLabel,
    lowLabel,
    notAvailableShort,
    numberFormatter,
    openLabel,
    sessionRangeLabel,
    signedNumberFormatter,
  ]);

  const parsedInterval = useMemo(() => parseInterval(data?.interval), [data?.interval]);
  const intervalGranularity = intervalToGranularity(parsedInterval);
  const intervalGranularityLabel = formatGranularityLabelLocalized(intervalGranularity, t);
  const intervalColor =
    intervalGranularity === UiTimeGranularity.Unknown ? "default" : "geekblue";
  const intervalDescriptor = data?.interval
    ? `${intervalGranularityLabel} (${data.interval})`
    : intervalGranularityLabel;
  const intervalTagText = `${intervalLabel}: ${intervalDescriptor}`;

  const handleCsvExport = useCallback(async () => {
    if (!data || normalizedPoints.length === 0) return;
    const rows = [
      [timestampLabel, openLabel, highLabel, lowLabel, closeLabel, volumeLabel],
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
  }, [closeLabel, data, endLabel, exportCsv, highLabel, lowLabel, normalizedPoints, openLabel, startLabel, timestampLabel, volumeLabel]);
  // csvLabel handled by useCsvExport

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

  if (isError) {
    const emptyState = buildRequestErrorEmptyState({
      t,
      error,
      onRetry: () => {
        void refreshCandles();
      },
      actionLoading: refreshingCandles,
      actionLabelOverride: t("dashboard.actions.retryFetch", {
        defaultValue: "Retry fetch"
      }),
    });
    return (
      <div className="h-[350px] transition-all duration-300">
        <ChartEmptyState {...emptyState} />
      </div>
    );
  }

  if (!data || normalizedPoints.length === 0) {
    const awaitingCompleteCandle = Boolean(data?.skippedIncompleteCount);
    const emptyStateTitle = awaitingCompleteCandle
      ? t("dashboard.candlestick.awaitingCompleteTitle", {
          defaultValue: "Awaiting complete candle"
        })
      : emptyTitle;
    const emptyStateDescription = awaitingCompleteCandle
      ? latestObservedAtLabel
        ? t("dashboard.candlestick.awaitingCompleteDescriptionWithTime", {
            time: latestObservedAtLabel,
            defaultValue:
              "Latest observed data at {{time}} is still in progress, so no complete candle can be shown yet. Try again shortly."
          })
        : t("dashboard.candlestick.awaitingCompleteDescription", {
            defaultValue:
              "The latest observation is still in progress, so no complete candle can be shown yet. Try again shortly."
          })
      : emptyHint;
    return (
      <div className="h-[350px] transition-all duration-300">
        <ChartEmptyState
          title={emptyStateTitle}
          description={emptyStateDescription}
          actionLabel={t("dashboard.actions.fetchLatest", {
            defaultValue: "Pull latest data"
          })}
          actionLoading={refreshingCandles}
          onAction={() => {
            void refreshCandles();
          }}
        />
      </div>
    );
  }

  return (
    <div className="relative h-[350px] transition-all duration-300">
      <div className="absolute left-2 top-2 z-10 flex flex-wrap items-center gap-2">
        <Tag color="default" className="text-xs">
          {rangeLabel}: {range}
        </Tag>
        <Tag color="default" className="text-xs">
          {windowLabelText}: {windowLabel}
        </Tag>
        <Tag color={intervalColor} className="text-xs">
          {intervalTagText}
        </Tag>
        <Tag color="default" className="text-xs">
          {t("dashboard.candlestick.candlesCount", {
            count: normalizedPoints.length,
            defaultValue: "Candles: {{count}}"
          })}
        </Tag>
        {summaryMetrics?.latestCloseText ? (
          <Tag color="default" className="text-xs">
            {latestCloseLabelText}: {summaryMetrics.latestCloseText}
          </Tag>
        ) : null}
        {summaryMetrics?.windowChangeText ? (
          <Tag color={summaryMetrics.windowChangeColor} className="text-xs">
            {windowChangeLabelText}: {summaryMetrics.windowChangeText}
          </Tag>
        ) : null}
        {updatedAtTagText ? (
          <Tag color="default" className="text-xs">
            {updatedAtTagText}
          </Tag>
        ) : null}
        {latestObservedAtLabel && data?.skippedIncompleteCount ? (
          <Tag color="processing" className="text-xs">
            {t("dashboard.candlestick.observedThrough", {
              time: latestObservedAtLabel,
              defaultValue: "Observed through: {{time}}"
            })}
          </Tag>
        ) : null}
        {data?.skippedIncompleteCount ? (
          <Tag color="orange" className="text-xs">
            {t("dashboard.candlestick.inProgressOmitted", {
              count: data.skippedIncompleteCount,
              defaultValue: "In-progress candles omitted: {{count}}"
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
