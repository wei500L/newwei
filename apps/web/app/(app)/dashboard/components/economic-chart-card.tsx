"use client";

import { ArrowDownOutlined, ArrowUpOutlined, BulbOutlined } from "@ant-design/icons";
import { Card, Flex, Statistic, Typography, theme } from "antd";
import type { EChartsOption, SeriesOption } from "echarts";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { DashboardChart } from "@/components/echart";
import type { EconomicSeriesInsightsMap, EconomicSeriesMap } from "@/hooks/useEconomicData";
import dayjs from "@/lib/dayjs";
import { normalizeUnit } from "@/lib/economic-units";

import { getSeriesField } from "../utils/series";

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
  insights?: EconomicSeriesInsightsMap;
  meta?: ReactNode;
}

export function EconomicChartCard({
  title,
  description,
  seriesMap,
  series,
  insights,
  meta,
}: EconomicChartCardProps) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  
  const option = useMemo(() => buildOption(seriesMap, series), [seriesMap, series]);
  const hasSeries = useMemo(() => {
    const s = option.series;
    if (!s) return false;
    return Array.isArray(s) ? s.length > 0 : true;
  }, [option.series]);

  const stats = useMemo(() => {
    if (!series[0]) return null;
    const config = series[0];
    const record = seriesMap[config.slug];
    if (!record || Object.keys(record.fields).length === 0) return null;

    const fieldSeries = getSeriesField(seriesMap, config.slug, config.field);
    
    if (!fieldSeries || fieldSeries.values.length === 0) return null;

    const insight = insights?.[config.slug]?.[fieldSeries.key];

    const sorted = [...fieldSeries.values].sort(
      (a, b) => dayjs(a.timestamp).valueOf() - dayjs(b.timestamp).valueOf()
    );
    
    const current = sorted.at(-1);
    const prev = sorted.at(-2);
    if (!current) {
      return null;
    }
    
    const fallbackChange = prev ? current.value - prev.value : null;
    const fallbackPercentChange =
      prev && prev.value !== 0 ? (fallbackChange! / prev.value) * 100 : null;
    
    const avg = sorted.reduce((acc, curr) => acc + curr.value, 0) / sorted.length;
    const diffFromAvg = avg !== 0 ? ((current.value - avg) / avg) * 100 : null;

    const percentChange = insight?.percentChange ?? fallbackPercentChange;
    const change = insight?.change ?? fallbackChange;
    const unit =
      normalizeUnit(insight?.unit) ??
      normalizeUnit(fieldSeries.unit) ??
      normalizeUnit(record.unit);

    const message =
      insight?.message ??
      (() => {
        if (diffFromAvg !== null && Math.abs(diffFromAvg) > 20) {
          return `Current value is ${Math.abs(diffFromAvg).toFixed(1)}% ${diffFromAvg > 0 ? "above" : "below"} historical average.`;
        }
        if (percentChange !== null && Math.abs(percentChange) > 5) {
          return `Latest value changed ${Math.abs(percentChange).toFixed(1)}% ${percentChange > 0 ? "up" : "down"} vs previous point.`;
        }
        if (sorted.length < 2) {
          return "Not enough data to infer a trend.";
        }
        return "Series is stable around its recent mean.";
      })();

    return {
      currentValue: insight?.currentValue ?? current.value,
      change,
      percentChange,
      unit,
      insight: message
    };
  }, [insights, seriesMap, series]);

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
          {stats || meta ? (
            <Flex vertical align="end" gap={4}>
              {meta ? <div>{meta}</div> : null}
              {stats ? (
                <>
                  <Statistic 
                    value={stats.currentValue} 
                    precision={2} 
                    suffix={<span style={{ fontSize: 14, color: token.colorTextSecondary }}>{stats.unit}</span>}
                    valueStyle={{ fontSize: 24, fontWeight: 600, lineHeight: 1.2 }}
                  />
                  <Flex gap={4} align="center">
                    {stats.percentChange !== null ? (
                      <>
                        <Typography.Text
                          type={stats.percentChange > 0 ? "success" : stats.percentChange < 0 ? "danger" : "secondary"}
                          style={{ fontSize: 12, fontWeight: 500 }}
                        >
                          {stats.percentChange > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                          {Math.abs(stats.percentChange).toFixed(2)}%
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>vs prev</Typography.Text>
                      </>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>--</Typography.Text>
                    )}
                  </Flex>
                </>
              ) : null}
            </Flex>
          ) : null}
        </Flex>
      }
    >
      {hasSeries ? (
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
                 {t("dashboard.insight.label", { defaultValue: "Insight" })}: {stats.insight}
               </Typography.Text>
            </Flex>
          )}
        </>
      ) : (
        <ChartEmptyState
          className="h-[360px]"
          title={t("dashboard.charts.noDataRange", { defaultValue: "No Data Found for Selected Range" })}
          description={t("dashboard.dataEmptyHint", {
            defaultValue: "No data for the selected range. Try expanding the range."
          })}
        />
      )}
    </Card>
  );
}

function buildOption(
  seriesMap: EconomicSeriesMap,
  configs: SeriesConfig[],
): EChartsOption {
  const unitBySeriesName = new Map<string, string>();
  const dataset = configs
    .map((config) => {
    const record = seriesMap[config.slug];
    if (!record || Object.keys(record.fields).length === 0) {
      return undefined;
    }
    const fieldSeries = getSeriesField(seriesMap, config.slug, config.field);
    if (!fieldSeries) {
      return undefined;
    }
    const unit = fieldSeries.unit ?? record.unit;
    const seriesName = config.label ?? fieldSeries.label ?? record.name;
    if (unit) {
      unitBySeriesName.set(seriesName, unit);
    }
    return {
      name: seriesName,
        type: config.type === "bar" ? "bar" : "line",
        smooth: true,
        showSymbol: false,
        areaStyle: config.type === "area" ? {} : undefined,
        data: fieldSeries.values
          .map<[string, number]>((point) => [point.timestamp, point.value])
          .sort((a, b) => dayjs(a[0]).valueOf() - dayjs(b[0]).valueOf()),
      };
    })
    .filter(Boolean) as SeriesOption[];

  const uniqueUnits = Array.from(new Set(Array.from(unitBySeriesName.values()))).filter(Boolean);
  const yAxisUnitSuffix = uniqueUnits.length === 1 ? ` ${uniqueUnits[0]}` : "";

  type TooltipSeriesValue = unknown[] | number | string | null | undefined;

  interface TooltipParam {
    axisValueLabel?: string;
    axisValue?: string | number;
    seriesName?: string;
    marker?: string;
    value?: TooltipSeriesValue;
  }

  return {
    tooltip: {
      trigger: "axis",
      formatter: (params: unknown) => {
        const entries = Array.isArray(params) ? params : [params];
        const normalized = entries.filter(
          (entry): entry is TooltipParam => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
        );

        if (normalized.length === 0) {
          return "";
        }
        const axisValue = normalized[0]?.axisValueLabel ?? normalized[0]?.axisValue ?? "";
        const lines = [`<div>${axisValue}</div>`];
        normalized.forEach((entry) => {
          const seriesName = entry.seriesName ?? "";
          const marker = entry.marker ?? "";
          const rawValue = (() => {
            const value = entry.value;
            if (Array.isArray(value)) {
              return value[1];
            }
            return value;
          })();
          const unit = unitBySeriesName.get(seriesName);
          lines.push(`${marker}${seriesName}: ${rawValue}${unit ? ` ${unit}` : ""}`);
        });
        return lines.join("<br/>");
      }
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
      axisLabel: {
        formatter: (value: unknown) => `${value}${yAxisUnitSuffix}`
      }
    },
    dataZoom: [
      {
        type: "inside",
      },
    ],
    series: dataset,
  };
}
