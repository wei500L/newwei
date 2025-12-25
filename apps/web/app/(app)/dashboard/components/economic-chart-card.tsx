"use client";

import { ArrowDownOutlined, ArrowUpOutlined, BulbOutlined } from "@ant-design/icons";
import { Card, Empty, Flex, Statistic, Typography, theme } from "antd";
import type { EChartsOption, SeriesOption } from "echarts";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import type { EconomicSeriesMap } from "@/hooks/useEconomicData";

export interface SeriesConfig {
  slug: string;
  label?: string;
  field?: string;
  type?: "line" | "bar" | "area" | "radar";
}

export interface EconomicChartCardProps {
  title: string;
  description?: string;
  seriesMap: EconomicSeriesMap;
  series: SeriesConfig[];
}

export function EconomicChartCard({
  title,
  description,
  seriesMap,
  series,
}: EconomicChartCardProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  
  const option = useMemo(() => buildOption(seriesMap, series), [seriesMap, series]);
  const seriesList = useMemo(() => {
    const s = option.series;
    return Array.isArray(s) ? s : s ? [s] : [];
  }, [option.series]);

  const stats = useMemo(() => {
    if (!seriesList.length || !series[0]) return null;
    const config = series[0];
    const record = seriesMap.get(config.slug);
    if (!record || record.fields.size === 0) return null;
    
    const fieldKey = config.field ?? Array.from(record.fields.keys())[0];
    const fieldSeries = fieldKey ? record.fields.get(fieldKey) : undefined;
    
    if (!fieldSeries || fieldSeries.values.length < 2) return null;

    const sorted = [...fieldSeries.values].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    
    const current = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    
    const change = current.value - prev.value;
    const percentChange = (change / prev.value) * 100;
    
    // Generate insight
    const avg = sorted.reduce((acc, curr) => acc + curr.value, 0) / sorted.length;
    const diffFromAvg = ((current.value - avg) / avg) * 100;
    
    let insight = "";
    if (Math.abs(diffFromAvg) > 20) {
      insight = `${t("dashboard.insight.volatility", { 
        percent: Math.abs(diffFromAvg).toFixed(1),
        direction: diffFromAvg > 0 ? t("common.above") : t("common.below")
      })}`;
    } else if (Math.abs(percentChange) > 5) {
      insight = `${t("dashboard.insight.trend", {
        percent: Math.abs(percentChange).toFixed(1),
        direction: percentChange > 0 ? t("common.increase") : t("common.decrease")
      })}`;
    } else {
      insight = t("dashboard.insight.stable");
    }

    // Default Fallback if translation keys are missing (for safety)
    if (insight.startsWith("dashboard.insight")) {
       insight = `Current value is ${Math.abs(diffFromAvg).toFixed(1)}% ${diffFromAvg > 0 ? "above" : "below"} historical average.`;
    }

    return {
      currentValue: current.value,
      change,
      percentChange,
      unit: record.unit,
      insight
    };
  }, [seriesMap, series, seriesList, t]);

  return (
    <Card 
      className="content-card" 
      style={{ marginBottom: 16 }}
      title={
        <Flex justify="space-between" align="start" style={{ width: '100%' }}>
          <div>
            <Typography.Text strong style={{ fontSize: 16 }}>{title}</Typography.Text>
            {description && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0, fontWeight: 'normal' }}>
                {description}
              </Typography.Paragraph>
            )}
          </div>
          {stats && (
            <Flex vertical align="end">
              <Statistic 
                value={stats.currentValue} 
                precision={2} 
                suffix={<span style={{ fontSize: 14, color: token.colorTextSecondary }}>{stats.unit}</span>}
                valueStyle={{ fontSize: 24, fontWeight: 600, lineHeight: 1.2 }}
              />
              <Flex gap={4} align="center">
                <Typography.Text 
                  type={stats.percentChange > 0 ? "success" : stats.percentChange < 0 ? "danger" : "secondary"}
                  style={{ fontSize: 12, fontWeight: 500 }}
                >
                   {stats.percentChange > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                   {Math.abs(stats.percentChange).toFixed(2)}%
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>vs prev</Typography.Text>
              </Flex>
            </Flex>
          )}
        </Flex>
      }
    >
      {seriesList.length > 0 ? (
        <>
          <DashboardChart option={option} height={360} />
          {stats?.insight && (
            <Flex 
              align="center" 
              gap={8} 
              style={{ 
                marginTop: 16, 
                padding: '8px 12px', 
                background: token.colorFillAlter, 
                borderRadius: token.borderRadius,
                border: `1px solid ${token.colorBorderSecondary}`
              }}
            >
               <BulbOutlined style={{ color: token.colorPrimary }} />
               <Typography.Text style={{ fontSize: 13, color: token.colorTextSecondary }}>
                 AI Insight: {stats.insight}
               </Typography.Text>
            </Flex>
          )}
        </>
      ) : (
        <Empty description={t("common.empty")} />
      )}
    </Card>
  );
}

function buildOption(
  seriesMap: EconomicSeriesMap,
  configs: SeriesConfig[],
): EChartsOption {
  const dataset = configs
    .map((config) => {
      const record = seriesMap.get(config.slug);
      if (!record || record.fields.size === 0) {
        return undefined;
      }
      const fieldKey = config.field ?? Array.from(record.fields.keys())[0];
      const fieldSeries = fieldKey ? record.fields.get(fieldKey) : undefined;
      if (!fieldSeries) {
        return undefined;
      }
      return {
        name: config.label ?? fieldSeries.label ?? record.name,
        type: config.type === "bar" ? "bar" : "line",
        smooth: true,
        showSymbol: false,
        areaStyle: config.type === "area" ? {} : undefined,
        data: fieldSeries.values
          .map<[string, number]>((point) => [point.timestamp, point.value])
          .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime()),
      };
    })
    .filter(Boolean) as SeriesOption[];

  return {
    tooltip: {
      trigger: "axis",
    },
    legend: {
      top: 0,
      data: dataset.map((d) => d.name as string),
    },
    grid: {
      left: "1%",
      right: "1%",
      bottom: 20,
      top: 40,
      containLabel: true,
    },
    xAxis: {
      type: "time",
      boundaryGap: ["0%", "0%"],
      axisLabel: {
        hideOverlap: true
      }
    },
    yAxis: {
      type: "value",
      scale: true,
    },
    dataZoom: [
      {
        type: "inside",
      },
    ],
    series: dataset,
  };
}