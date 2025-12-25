"use client";

import { ArrowDownOutlined, ArrowUpOutlined, MinusOutlined } from "@ant-design/icons";
import { Card, Col, Row, Skeleton, Statistic, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useTranslation } from "react-i18next";
import { useMemo } from "react";

import { DashboardChart } from "@/components/echart";

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
  const history = data.map(d => d.value);
  const current = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : current;
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
        color: "#ff4d4f",
      },
      {
        key: "market-sentiment",
        title: t("dashboard.hero.marketSentiment", "Market Sentiment"),
        value: market.value,
        trend: market.trend,
        data: market.history,
        color: "#faad14",
      },
      {
        key: "resource-scarcity",
        title: t("dashboard.hero.resourceScarcity", "Resource Scarcity"),
        value: resource.value,
        trend: resource.trend,
        data: resource.history,
        color: "#13c2c2",
      },
      {
        key: "supply-chain-stability",
        title: t("dashboard.hero.supplyChain", "Supply Chain Stability"),
        value: supply.value,
        trend: supply.trend,
        data: supply.history,
        color: "#52c41a",
        suffix: "%",
      },
    ];
  }, [t, conflictData, marketData, resourceData, supplyData]);

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
    <div className="mb-6">
      <Row gutter={[20, 20]}>
        {metrics.map((metric) => (
          <Col xs={24} sm={12} lg={6} key={metric.key}>
            <Card 
              bordered={false} 
              className="shadow-sm hover:shadow-lg transition-all duration-200 cursor-pointer hover:-translate-y-1"
              onClick={() => onMetricClick?.(metric.key)}
            >
              <div className="flex flex-col h-full">
                <Typography.Text type="secondary" className="mb-1 text-xs uppercase font-semibold tracking-wider">
                  {metric.title}
                </Typography.Text>
                <div className="flex items-end justify-between mb-2">
                  <Statistic
                    value={metric.value}
                    precision={1}
                    suffix={metric.suffix}
                    valueStyle={{ fontWeight: 600, fontSize: "1.75rem", lineHeight: 1.2 }}
                  />
                  <div className={`flex items-center text-sm font-medium ${
                    metric.trend > 0 ? "text-red-500" : metric.trend < 0 ? "text-green-500" : "text-gray-400"
                  }`}>
                    {metric.trend > 0 ? <ArrowUpOutlined /> : metric.trend < 0 ? <ArrowDownOutlined /> : <MinusOutlined />}
                    <span className="ml-1">{Math.abs(metric.trend).toFixed(1)}%</span>
                  </div>
                </div>
                <div className="mt-auto pt-2">
                  <Sparkline data={metric.data} color={metric.color} />
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
