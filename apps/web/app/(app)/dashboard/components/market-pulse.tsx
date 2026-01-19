"use client";

import { ArrowDownOutlined, ArrowUpOutlined, MinusOutlined } from "@ant-design/icons";
import { Card, Col, Row, Skeleton, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useMemo, useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";
import dayjs from "@/lib/dayjs";

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
              { offset: 0, color: color },
              { offset: 1, color: "rgba(255,255,255,0)" } // Could use theme.colors.background but transparent is safe
            ]
          },
          opacity: 0.2
        }
      },
    ],
    tooltip: { show: false },
  };

  return <DashboardChart option={option} height={50} />;
};

// ... Metric Component with Flash ...

const MetricValue = ({ value, suffix }: { value: number | string, suffix?: string }) => {
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
    ? "bg-emerald-50 text-[var(--bullish)]"
    : flash === "down"
      ? "bg-amber-50 text-[var(--bearish)]"
      : "";

  return (
    <span className={`text-3xl font-semibold tracking-tight transition-all duration-500 px-1 ${flash ? flashClass : "text-slate-900"}`}>
      {typeof value === 'number' ? value.toFixed(1) : value}
      {suffix && <span className="text-lg ml-1 text-slate-400 font-medium">{suffix}</span>}
    </span>
  );
};

// ... existing interfaces ...
interface HeroMetric {
  key: string;
  title: string;
  value: number | null;
  trend: number | null;
  data: number[];
  color: string;
  suffix?: string;
  hasData: boolean;
}

interface DataPoint {
  timestamp: string;
  value: number;
  unit?: string | null;
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
    return { hasData: false, value: null, trend: null, history: [], unit: undefined as string | undefined };
  }

  const normalized = data
    .map((point) => {
      const ts = dayjs(point.timestamp).valueOf();
      return {
        ts,
        value: point.value,
        unit: typeof point.unit === "string" && point.unit.trim() ? point.unit : undefined
      };
    })
    .filter((point) => Number.isFinite(point.ts) && Number.isFinite(point.value))
    .sort((a, b) => a.ts - b.ts);

  if (normalized.length === 0) {
    return { hasData: false, value: null, trend: null, history: [], unit: undefined as string | undefined };
  }

  const history = normalized.map((point) => point.value);
  const current = history.length ? history[history.length - 1]! : null;
  const previous = history.length > 1 ? history[history.length - 2]! : null;
  const trend =
    current === null || previous === null || previous === 0
      ? null
      : ((current - previous) / previous) * 100;
  const unit = (() => {
    for (let i = normalized.length - 1; i >= 0; i -= 1) {
      const candidate = normalized[i]?.unit;
      if (candidate) {
        return candidate;
      }
    }
    return undefined;
  })();

  return { hasData: true, value: current, trend, history, unit };
};

export function MarketPulse({ 
  loading, 
  conflictData, 
  marketData, 
  resourceData, 
  supplyData, 
  onMetricClick 
}: MarketPulseProps) {
  const { t } = useTranslation();
  const theme = useChartTheme();
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
                <Card bordered={false} className="shadow-sm">
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

  return (
    <div className="mb-6 glass-panel border border-[var(--border)] p-6 shadow-[0_8px_20px_rgba(15,23,42,0.08)]">
      <Row gutter={[24, 24]} align="middle">
        {metrics.map((metric) => (
          <Col xs={24} sm={12} lg={6} key={metric.key}>
            <div 
              className="flex flex-col h-full px-4 py-3 transition-all duration-300 cursor-pointer hover:bg-slate-50 group border-l border-[var(--border)] first:border-l-0"
              onClick={() => onMetricClick?.(metric.key)}
            >
              <Typography.Text type="secondary" className="mb-2 text-[12px] font-medium tracking-wide text-slate-500 group-hover:text-[var(--primary)] transition-colors">
                {metric.title}
              </Typography.Text>
              <div className="flex items-baseline gap-3 mb-2">
                <MetricValue
                  value={metric.hasData && metric.value !== null ? metric.value : notAvailableLabel}
                  suffix={metric.hasData ? metric.suffix : undefined}
                />
                
                {(() => {
                  const trend = metric.trend;
                  const hasTrend = trend !== null && Number.isFinite(trend);
                  const trendLabel = hasTrend ? `${Math.abs(trend).toFixed(1)}%` : notAvailableLabel;
                  const trendClass =
                    !hasTrend
                      ? "text-slate-400"
                      : trend > 0
                        ? "text-[var(--bullish)]"
                        : trend < 0
                          ? "text-[var(--bearish)]"
                          : "text-slate-400";
                  const Icon = !hasTrend ? MinusOutlined : trend > 0 ? ArrowUpOutlined : trend < 0 ? ArrowDownOutlined : MinusOutlined;
                  return (
                    <div className={`flex items-center text-xs font-bold px-1.5 py-0.5 ${trendClass}`}>
                      <Icon className="text-[10px]" />
                      <span className="ml-1">{trendLabel}</span>
                    </div>
                  );
                })()}
              </div>
              <div className="mt-auto h-[40px] w-full opacity-50 group-hover:opacity-100 transition-all duration-500">
                {metric.data.length > 1 ? (
                  <Sparkline data={metric.data} color={metric.color} />
                ) : (
                  <Typography.Text type="secondary" className="text-xs">
                    {metric.hasData
                      ? t("dashboard.hero.insufficientData", { defaultValue: "Not enough data points" })
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
