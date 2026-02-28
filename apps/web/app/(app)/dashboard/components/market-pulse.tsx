"use client";

import { ArrowDownOutlined, ArrowUpOutlined, MinusOutlined } from "@ant-design/icons";
import { Card, Col, Row, Skeleton, Space, Tag, Tooltip, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useMemo, useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import dayjs from "@/lib/dayjs";
import { resolveEconomicUnit } from "@/lib/economic-units";
import { resolveLocale, formatDateTime } from "@/lib/i18n";
import {
  formatGranularityLabel,
  pickCoarsestGranularity,
  timeGranularityToUiGranularity,
  UiTimeGranularity,
  uiGranularityToInterval,
} from "@/lib/time-granularity";
import { useDashboardRangeStore } from "@/store/time-range";

// ... Sparkline component (update to use theme colors if possible, but it accepts color prop) ...
// Actually, I'll update Sparkline to use theme for area gradient properly if needed, but it takes `color` prop.

const Sparkline = ({ data, color }: { data: number[]; color: string }) => {
  const option: EChartsOption = {
    grid: { left: 0, right: 0, top: 5, bottom: 5 },
    xAxis: { type: "category", show: false },
    yAxis: { type: "value", show: false, min: (value) => value.min - (value.max - value.min) * 0.1 },
    series: [
      {
        data,
        type: "line",
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color },
        areaStyle: {
          color: {
            type: "linear",
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: color + "4D" }, // 30% opacity
              { offset: 1, color: "transparent" }
            ]
          }
        }
      },
    ],
    animation: false,
    tooltip: { show: false },
  };

  return <DashboardChart option={option} height={50} />;
};

// ... Metric Component with Flash ...

const MetricValue = ({ value, suffix, hasData }: { value: number | string, suffix?: string, hasData: boolean }) => {
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const prevValueRef = useRef(value);

  useEffect(() => {
    if (typeof value === 'number' && typeof prevValueRef.current === 'number') {
      if (value > prevValueRef.current) setFlash("up");
      else if (value < prevValueRef.current) setFlash("down");
    }
    prevValueRef.current = value;
    
    const timer = setTimeout(() => setFlash(null), 1000);
    return () => clearTimeout(timer);
  }, [value]);

  const flashClass = flash === "up"
    ? "bg-[var(--bullish)]/10 text-[var(--bullish)]"
    : flash === "down"
      ? "bg-[var(--bearish)]/10 text-[var(--bearish)]"
      : "";

  return (
    <span className={`text-3xl font-bold tracking-tight transition-all duration-500 px-1 rounded ${flash ? flashClass : hasData ? "text-[var(--foreground)]" : "text-secondary-foreground/40"}`}>
      {typeof value === 'number' ? value.toFixed(1) : value}
      {suffix && <span className="text-sm ml-1 text-secondary-foreground/60 font-medium">{suffix}</span>}
    </span>
  );
};

// ... existing interfaces ...
// ... (rest of imports and processSeries remain same) ...
interface HeroMetric {
  key: string;
  title: string;
  value: number | null;
  trend: number | null;
  data: number[];
  color: string;
  suffix?: string;
  hasData: boolean;
  granularity: UiTimeGranularity;
  lastTimestamp?: number;
  previousTimestamp?: number;
}

interface DataPoint {
  timestamp: string;
  effectiveGranularity?: string | null;
  value: number;
  unit?: string | null;
  dataType?: string | null;
  item?: { defaultUnit?: string | null } | null;
}

interface MarketPulseProps {
  loading: boolean;
  conflictData?: DataPoint[];
  marketData?: DataPoint[];
  resourceData?: DataPoint[];
  supplyData?: DataPoint[];
  onMetricClick?: (key: string) => void;
}

const processSeries = (data: DataPoint[] | undefined) => {
  if (!data || data.length === 0) {
    return {
      hasData: false,
      value: null,
      trend: null,
      history: [],
      unit: undefined as string | undefined,
      granularity: UiTimeGranularity.Unknown,
      lastTimestamp: undefined as number | undefined,
      previousTimestamp: undefined as number | undefined,
    };
  }

  const normalized = data
    .map((point) => {
      const ts = dayjs(point.timestamp).valueOf();
      const unit = resolveEconomicUnit({
        unit: point.unit ?? null,
        defaultUnit: point.item?.defaultUnit ?? null,
        dataType: point.dataType ?? null,
      });
      return {
        ts,
        value: point.value,
        unit: unit ?? undefined
      };
    })
    .filter((point) => Number.isFinite(point.ts) && Number.isFinite(point.value))
    .sort((a, b) => a.ts - b.ts);

  if (normalized.length === 0) {
    return {
      hasData: false,
      value: null,
      trend: null,
      history: [],
      unit: undefined as string | undefined,
      granularity: UiTimeGranularity.Unknown,
      lastTimestamp: undefined as number | undefined,
      previousTimestamp: undefined as number | undefined,
    };
  }

  const history = normalized.map((point) => point.value);
  const current = history.length ? history[history.length - 1]! : null;
  const previous = history.length > 1 ? history[history.length - 2]! : null;
  const lastTimestamp = normalized.length ? normalized[normalized.length - 1]!.ts : undefined;
  const previousTimestamp = normalized.length > 1 ? normalized[normalized.length - 2]!.ts : undefined;
  const trend =
    current === null || previous === null || previous === 0
      ? null
      : ((current - previous) / previous) * 100;
  const granularity = pickCoarsestGranularity(
    data.map((point) => timeGranularityToUiGranularity(point.effectiveGranularity)),
  );
  const unit = (() => {
    for (let i = normalized.length - 1; i >= 0; i -= 1) {
      const candidate = normalized[i]?.unit;
      if (candidate) {
        return candidate;
      }
    }
    return undefined;
  })();

  return { hasData: true, value: current, trend, history, unit, granularity, lastTimestamp, previousTimestamp };
};

export function MarketPulse({ 
  loading, 
  conflictData, 
  marketData, 
  resourceData, 
  supplyData, 
  onMetricClick 
}: MarketPulseProps) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const theme = useChartTheme();
  const { range, start, end } = useDashboardRangeStore();
  const notAvailableLabel = t("common.notAvailable", { defaultValue: "Not available" });
  const emptyTitle = t("dashboard.charts.noDataRange", { defaultValue: "No Data Found for Selected Range" });
  const emptyDescription = t("dashboard.hero.emptyDescription", {
    defaultValue: "Hero metrics are unavailable for the selected time range."
  });

  const metrics = useMemo<HeroMetric[]>(() => {
    const conflict = processSeries(conflictData);
    const market = processSeries(marketData);
    const resource = processSeries(resourceData);
    const supply = processSeries(supplyData);

    return [
      {
        key: "global-conflict-index",
        title: t("dashboard.hero.globalConflictIndex", "Global Conflict Index"),
        value: conflict.value,
        trend: conflict.trend,
        data: conflict.history,
        color: theme.colors.bearish, // High conflict is bad/red (or bullish color if it means 'high' value? Usually red for danger)
        suffix: conflict.hasData ? conflict.unit : undefined,
        hasData: conflict.hasData,
        granularity: conflict.granularity,
        lastTimestamp: conflict.lastTimestamp,
        previousTimestamp: conflict.previousTimestamp,
      },
      {
        key: "market-sentiment",
        title: t("dashboard.hero.marketSentiment", "Market Sentiment"),
        value: market.value,
        trend: market.trend,
        data: market.history,
        color: theme.colors.accent, // Neutral/Warning
        suffix: market.hasData ? market.unit : undefined,
        hasData: market.hasData,
        granularity: market.granularity,
        lastTimestamp: market.lastTimestamp,
        previousTimestamp: market.previousTimestamp,
      },
      {
        key: "resource-scarcity",
        title: t("dashboard.hero.resourceScarcity", "Resource Scarcity"),
        value: resource.value,
        trend: resource.trend,
        data: resource.history,
        color: "#13c2c2", // Cyan
        suffix: resource.hasData ? resource.unit : undefined,
        hasData: resource.hasData,
        granularity: resource.granularity,
        lastTimestamp: resource.lastTimestamp,
        previousTimestamp: resource.previousTimestamp,
      },
      {
        key: "supply-chain-stability",
        title: t("dashboard.hero.supplyChain", "Supply Chain Stability"),
        value: supply.value,
        trend: supply.trend,
        data: supply.history,
        color: theme.colors.bullish, // Stability is good
        suffix: supply.hasData ? supply.unit : undefined,
        hasData: supply.hasData,
        granularity: supply.granularity,
        lastTimestamp: supply.lastTimestamp,
        previousTimestamp: supply.previousTimestamp,
      },
    ];
  }, [t, conflictData, marketData, resourceData, supplyData, theme.colors]);

  const allMissing = metrics.every((metric) => !metric.hasData);

  if (loading) {
    // ... skeleton ...
    return (
        <div className="mb-6">
          <Row gutter={[20, 20]}>
            {[1, 2, 3, 4].map((i) => (
              <Col xs={24} sm={12} lg={6} key={i}>
                <Card variant="borderless" className="shadow-sm">
                  <Skeleton active paragraph={{ rows: 2 }} />
                </Card>
              </Col>
            ))}
          </Row>
        </div>
      );
  }

  if (allMissing) {
    return (
      <div className="mb-6 glass-panel border border-[var(--border)] p-6 shadow-[0_8px_20px_rgba(15,23,42,0.08)]">
        <ChartEmptyState title={emptyTitle} description={emptyDescription} />
      </div>
    );
  }

  const activeGranularity = pickCoarsestGranularity(
    metrics.filter((metric) => metric.hasData).map((metric) => metric.granularity),
  );
  const granularityLabel = formatGranularityLabel(activeGranularity);
  const granularityColor =
    activeGranularity === UiTimeGranularity.Unknown ? "default" : "geekblue";
  const granularityTagText = `Aggregation: ${granularityLabel}`;
  const granularityTooltip = (() => {
    const detailParts = metrics
      .filter((metric) => metric.hasData && metric.granularity !== UiTimeGranularity.Unknown)
      .map((metric) => `${metric.title}: ${formatGranularityLabel(metric.granularity)}`);
    const details = detailParts.length ? ` Per metric: ${detailParts.join(" · ")}.` : "";
    return `Aggregation is reported by the backend. Displayed value uses the coarsest bucket across hero metrics.${details}`;
  })();

  return (
    <div className="mb-6 glass-panel border border-[var(--border)] p-6 shadow-[0_8px_20px_rgba(15,23,42,0.08)]">
      <div className="flex items-center justify-between gap-3 mb-4">
        <Typography.Text type="secondary" className="text-xs font-medium">
          Range: {range} ·{" "}
          {formatDateTime(start, locale, { dateStyle: "medium" })} -{" "}
          {formatDateTime(end, locale, { dateStyle: "medium" })}
        </Typography.Text>
        <Space size={6} wrap>
          <Tooltip title={granularityTooltip}>
            <Tag color={granularityColor} className="text-xs border-none bg-secondary text-secondary-foreground">
              {granularityTagText}
            </Tag>
          </Tooltip>
        </Space>
      </div>
      <Row gutter={[24, 24]} align="middle">
        {metrics.map((metric) => (
          <Col xs={24} sm={12} lg={6} key={metric.key}>
            <div 
              className="flex flex-col h-full px-4 py-3 transition-all duration-300 cursor-pointer hover:bg-[var(--secondary)]/40 rounded-xl group border-l border-[var(--border)] first:border-l-0"
              onClick={() => onMetricClick?.(metric.key)}
            >
              <Typography.Text className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-slate-500 group-hover:text-[var(--primary)] transition-colors">
                {metric.title}
              </Typography.Text>
              <div className="flex items-baseline gap-2 mb-2">
                <Tooltip
                  title={
                    metric.hasData && metric.lastTimestamp
                      ? (() => {
                          const interval = uiGranularityToInterval(metric.granularity);
                          const showTime =
                            metric.granularity === UiTimeGranularity.Hour ||
                            metric.granularity === UiTimeGranularity.Minute;
                          const startIso = dayjs(metric.lastTimestamp).toISOString();
                          const endIso =
                            interval && startIso
                              ? dayjs(startIso).add(interval.count, interval.unit).toISOString()
                              : "";
                          const startLabel = formatDateTime(startIso, locale, showTime
                            ? { dateStyle: "medium", timeStyle: "short" }
                            : { dateStyle: "medium" });
                          const endLabel = endIso
                            ? formatDateTime(endIso, locale, showTime
                                ? { dateStyle: "medium", timeStyle: "short" }
                                : { dateStyle: "medium" })
                            : "";
                          const bucketLabel = endLabel ? `${startLabel} - ${endLabel}` : startLabel;
                          return `Latest bucket: ${bucketLabel} (${formatGranularityLabel(metric.granularity)})`;
                        })()
                      : undefined
                  }
                >
                  <span>
                    <MetricValue
                      value={metric.hasData && metric.value !== null ? metric.value : notAvailableLabel}
                      suffix={metric.hasData ? metric.suffix : undefined}
                      hasData={metric.hasData}
                    />
                  </span>
                </Tooltip>
                
                {(() => {
                  const trend = metric.trend;
                  const hasTrend = trend !== null && Number.isFinite(trend);
                  if (!metric.hasData || !hasTrend) return null;

                  const trendLabel = `${Math.abs(trend).toFixed(1)}%`;
                  const trendClass =
                    trend > 0
                      ? "text-[var(--bullish)] bg-[var(--bullish)]/10"
                      : trend < 0
                        ? "text-[var(--bearish)] bg-[var(--bearish)]/10"
                        : "text-slate-400 bg-slate-100 dark:bg-slate-800";
                  const Icon = trend > 0 ? ArrowUpOutlined : trend < 0 ? ArrowDownOutlined : MinusOutlined;
                  return (
                    <Tooltip
                      title={
                        metric.hasData && metric.previousTimestamp && metric.lastTimestamp
                          ? `Change vs previous ${formatGranularityLabel(metric.granularity).toLowerCase()} bucket`
                          : "Change vs previous data point"
                      }
                    >
                      <div className={`flex items-center text-xs font-bold px-2 py-0.5 rounded-full ${trendClass}`}>
                        <Icon className="text-[10px]" />
                        <span className="ml-1">{trendLabel}</span>
                      </div>
                    </Tooltip>
                  );
                })()}
              </div>
              <div className="mt-auto h-[40px] w-full opacity-60 group-hover:opacity-100 transition-all duration-500">
                {metric.data.length > 1 ? (
                  <Sparkline data={metric.data} color={metric.color} />
                ) : (
                  <Typography.Text className="text-[11px] text-slate-400 dark:text-slate-600 font-medium italic">
                    {metric.hasData
                      ? t("dashboard.hero.insufficientData", { defaultValue: "Insufficient data points" })
                      : notAvailableLabel}
                  </Typography.Text>
                )}
              </div>
            </div>
          </Col>
        ))}
      </Row>
    </div>
  );
}
