"use client";

import { ArrowDownOutlined, ArrowUpOutlined, MinusOutlined } from "@ant-design/icons";
import { Card, Col, Row, Skeleton, Space, Tag, Tooltip, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { memo, useMemo, useState, useEffect, useRef } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import dayjs from "@/lib/dayjs";
import { resolveEconomicUnit } from "@/lib/economic-units";
import { resolveLocale, formatDateTime } from "@/lib/i18n";
import {
  formatGranularityLabelLocalized,
  pickCoarsestGranularity,
  timeGranularityToUiGranularity,
  UiTimeGranularity,
  uiGranularityToInterval,
} from "@/lib/time-granularity";
import { useDashboardRangeStore } from "@/store/time-range";

const Sparkline = memo(function Sparkline({
  data,
  color,
}: {
  data: number[];
  color: string;
}) {
  const option = useMemo<EChartsOption>(
    () => ({
      grid: { left: 0, right: 0, top: 5, bottom: 5 },
      xAxis: { type: "category", show: false },
      yAxis: {
        type: "value",
        show: false,
        min: (value) => value.min - (value.max - value.min) * 0.1,
      },
      series: [
        {
          data,
          type: "line",
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2, color, shadowBlur: 8, shadowColor: `${color}66` },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: `${color}33` },
                { offset: 1, color: "transparent" },
              ],
            },
          },
        },
      ],
      animation: false,
      tooltip: { show: false },
    }),
    [color, data],
  );

  return <DashboardChart option={option} height={40} />;
});

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
    ? "bg-[var(--bullish)]/15 text-[var(--bullish)]"
    : flash === "down"
      ? "bg-[var(--bearish)]/15 text-[var(--bearish)]"
      : "";

  return (
    <span className={`text-4xl font-bold tracking-tight transition-all duration-500 px-1 rounded-md tabular-nums ${flash ? flashClass : hasData ? "text-[var(--foreground)]" : "text-secondary-foreground/30"}`}>
      {typeof value === 'number' ? value.toFixed(1) : value}
      {suffix && <span className="text-sm ml-1.5 text-secondary-foreground/50 font-medium">{suffix}</span>}
    </span>
  );
};

const AuraMetricCard = ({ 
  metric, 
  onClick, 
  children 
}: { 
  metric: HeroMetric, 
  onClick?: () => void, 
  children: React.ReactNode 
}) => {
  const cardRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: MouseEvent) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    cardRef.current.style.setProperty(
      "--market-pulse-x",
      `${Math.round(e.clientX - rect.left)}px`,
    );
    cardRef.current.style.setProperty(
      "--market-pulse-y",
      `${Math.round(e.clientY - rect.top)}px`,
    );
  };

  return (
    <div 
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onClick={onClick}
      className="relative group overflow-hidden flex flex-col h-full px-5 py-4 transition-all duration-500 cursor-pointer active:scale-[0.98] active:brightness-105 rounded-2xl border-l border-white/10 first:border-l-0"
      style={
        {
          "--market-pulse-x": "50%",
          "--market-pulse-y": "120px",
        } as CSSProperties
      }
    >
      {/* Hover Glow Effect */}
      <div 
        className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          background: `radial-gradient(400px circle at var(--market-pulse-x) var(--market-pulse-y), ${metric.color}0D, transparent 80%)`,
        }}
      />
      
      <Typography.Text className="mb-3 text-[11px] font-bold uppercase tracking-[0.15em] text-slate-400 dark:text-slate-500 font-serif group-hover:text-[var(--primary)] transition-colors">
        {metric.title}
      </Typography.Text>
      
      {children}
    </div>
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

  const aggregationLabel = t("dashboard.timeRange.aggregation", { defaultValue: "Aggregation" });
  const granularityLabel = formatGranularityLabelLocalized(activeGranularity, t);
  const granularityTagText = `${aggregationLabel}: ${granularityLabel}`;
  const granularityTooltip = (() => {
    const detailParts = metrics
      .filter((metric) => metric.hasData && metric.granularity !== UiTimeGranularity.Unknown)
      .map((metric) => `${metric.title}: ${formatGranularityLabelLocalized(metric.granularity, t)}`);
    const baseTooltip = t("dashboard.timeRange.aggregationHintHeroCoarsest", {
      defaultValue: "Aggregation is reported by the backend. Displayed value uses the coarsest bucket across hero metrics.",
    });
    if (!detailParts.length) {
      return baseTooltip;
    }
    const perMetricLabel = t("dashboard.timeRange.aggregationHintPerMetric", {
      defaultValue: "Per metric",
    });
    return `${baseTooltip} ${perMetricLabel}: ${detailParts.join(" · ")}.`;
  })();

  return (
    <div className="mb-6 glass-panel p-1.5 overflow-hidden">
      <div className="px-6 pt-5 pb-2 flex items-center justify-between gap-3">
        <Typography.Text className="text-[11px] font-bold tracking-[0.08em] text-secondary-foreground/50 uppercase">
          {range} ·{" "}
          {formatDateTime(start, locale, { dateStyle: "medium" })} —{" "}
          {formatDateTime(end, locale, { dateStyle: "medium" })}
        </Typography.Text>
        <Space size={6} wrap>
          <Tooltip title={granularityTooltip}>
            <Tag className="text-[10px] border-none bg-secondary/60 text-secondary-foreground/80 font-bold px-2 rounded-full backdrop-blur-md">
              {granularityTagText}
            </Tag>
          </Tooltip>
        </Space>
      </div>
      
      <Row gutter={[0, 0]} align="stretch" className="relative z-10">
        {metrics.map((metric) => (
          <Col xs={24} sm={12} lg={6} key={metric.key}>
            <AuraMetricCard 
              metric={metric} 
              onClick={() => onMetricClick?.(metric.key)}
            >
              <div className="flex flex-col flex-1">
                <div className="flex items-baseline gap-2 mb-4">
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
                            const bucketLabel = endLabel ? `${startLabel} — ${endLabel}` : startLabel;
                            return t("dashboard.hero.latestBucket", {
                              bucket: bucketLabel,
                              granularity: formatGranularityLabelLocalized(metric.granularity, t),
                              defaultValue: "Latest bucket: {{bucket}} ({{granularity}})",
                            });
                          })()
                        : undefined
                    }
                  >
                    <div className="relative z-20">
                      <MetricValue
                        value={metric.hasData && metric.value !== null ? metric.value : notAvailableLabel}
                        suffix={metric.hasData ? metric.suffix : undefined}
                        hasData={metric.hasData}
                      />
                    </div>
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
                            ? t("dashboard.hero.trendVsPreviousGranularity", {
                                granularity: formatGranularityLabelLocalized(metric.granularity, t).toLowerCase(),
                                defaultValue: "vs prev. {{granularity}}",
                              })
                            : t("dashboard.hero.trendVsPreviousPoint", {
                                defaultValue: "vs prev. data point",
                              })
                        }
                      >
                        <div className={`flex items-center text-[11px] font-black px-2 py-0.5 rounded-full ${trendClass} backdrop-blur-sm border border-current/5`}>
                          <Icon className="text-[10px]" />
                          <span className="ml-1 tracking-tight">{trendLabel}</span>
                        </div>
                      </Tooltip>
                    );
                  })()}
                </div>
                
                <div className="mt-auto pt-2 w-full opacity-40 group-hover:opacity-100 transition-all duration-700 transform group-hover:translate-y-[-2px]">
                  {metric.data.length > 1 ? (
                    <Sparkline data={metric.data} color={metric.color} />
                  ) : (
                    <div className="h-[40px] flex items-end">
                      <Typography.Text className="text-[10px] text-slate-400 dark:text-slate-600 font-bold uppercase tracking-widest italic opacity-50">
                        {metric.hasData
                          ? t("dashboard.hero.insufficientData", "Insufficient Data")
                          : notAvailableLabel}
                      </Typography.Text>
                    </div>
                  )}
                </div>
              </div>
            </AuraMetricCard>
          </Col>
        ))}
      </Row>
    </div>
  );
}
