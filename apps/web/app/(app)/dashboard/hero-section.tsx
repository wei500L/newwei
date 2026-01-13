"use client";

import { ArrowDownOutlined, ArrowUpOutlined, MinusOutlined } from "@ant-design/icons";
import { Card, Col, Row, Skeleton, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { useChartTheme } from "@/hooks/use-chart-theme";

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
              { offset: 1, color: "rgba(255,255,255,0)" }
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

interface HeroMetric {
  key: string;
  title: string;
  value: number;
  trend: number;
  data: number[];
  color: string;
  suffix?: string;
}

interface DataPoint {
  timestamp: string;
  value: number;
}

interface HeroSectionProps {
  loading: boolean;
  conflictData?: DataPoint[];
  marketData?: DataPoint[];
  resourceData?: DataPoint[];
  supplyData?: DataPoint[];
  onMetricClick?: (key: string) => void;
}

const processSeries = (data: DataPoint[] | undefined) => {
  if (!data || data.length === 0) {
    return { value: 0, trend: 0, history: [] };
  }
  const history = data.map((d) => d.value);
  const current = history[history.length - 1] ?? 0;
  const previous = history.length > 1 ? history[history.length - 2] ?? current : current;
  const trend = previous !== 0 ? ((current - previous) / previous) * 100 : 0;
  return { value: current, trend, history };
};

export function HeroSection({ 
  loading, 
  conflictData, 
  marketData, 
  resourceData, 
  supplyData, 
  onMetricClick 
}: HeroSectionProps) {
  const { t } = useTranslation();
  const theme = useChartTheme();

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
        color: theme.colors.bearish,
      },
      {
        key: "market-sentiment",
        title: t("dashboard.hero.marketSentiment", "Market Sentiment"),
        value: market.value,
        trend: market.trend,
        data: market.history,
        color: theme.colors.accent,
      },
      {
        key: "resource-scarcity",
        title: t("dashboard.hero.resourceScarcity", "Resource Scarcity"),
        value: resource.value,
        trend: resource.trend,
        data: resource.history,
        color: theme.colors.primary,
      },
      {
        key: "supply-chain-stability",
        title: t("dashboard.hero.supplyChain", "Supply Chain Stability"),
        value: supply.value,
        trend: supply.trend,
        data: supply.history,
        color: theme.colors.bullish,
        suffix: "%",
      },
    ];
  }, [t, conflictData, marketData, resourceData, supplyData, theme.colors]);

  if (loading) {
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

  return (
    <div className="mb-10 glass-panel border border-[var(--border)] rounded-3xl p-8 shadow-sm">
      <Row gutter={[32, 32]} align="middle">
        {metrics.map((metric) => (
          <Col xs={24} sm={12} lg={6} key={metric.key}>
            <div 
              className="flex flex-col h-full px-4 py-2 rounded-2xl transition-all duration-300 cursor-pointer hover:bg-slate-50 hover:shadow-md hover:-translate-y-1 group border border-transparent hover:border-[var(--border)]"
              onClick={() => onMetricClick?.(metric.key)}
            >
              <Typography.Text type="secondary" className="mb-3 text-[12px] font-medium tracking-wide opacity-70 group-hover:opacity-100 transition-opacity text-slate-500">
                {metric.title}
              </Typography.Text>
              <div className="flex items-baseline gap-2 mb-4">
                <span className="text-4xl font-semibold text-slate-900 tracking-tight">
                  {metric.value.toFixed(1)}
                  {metric.suffix && <span className="text-xl ml-1 text-slate-400 font-medium">{metric.suffix}</span>}
                </span>
                <div className={`flex items-center text-xs font-bold px-2 py-0.5 rounded-full ${
                  metric.trend > 0 
                    ? "bg-emerald-50 text-[var(--bullish)]" 
                    : metric.trend < 0 
                      ? "bg-amber-50 text-[var(--bearish)]" 
                      : "bg-slate-100 text-slate-400"
                }`}>
                  {metric.trend > 0 ? <ArrowUpOutlined className="text-[10px]" /> : metric.trend < 0 ? <ArrowDownOutlined className="text-[10px]" /> : <MinusOutlined className="text-[10px]" />}
                  <span className="ml-1">{Math.abs(metric.trend).toFixed(1)}%</span>
                </div>
              </div>
              <div className="mt-auto h-[50px] w-full opacity-60 group-hover:opacity-100 transition-all duration-500">
                <Sparkline data={metric.data} color={metric.color} />
              </div>
            </div>
          </Col>
        ))}
      </Row>
    </div>
  );
}
