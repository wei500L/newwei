"use client";

import { Col, Row, Skeleton, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useTranslation } from "react-i18next";

import { ChartDataMeta } from "@/components/chart-data-meta";
import { ChartStateBanner } from "@/components/chart-state-banner";
import { DashboardChartCard } from "@/components/dashboard-chart-card";
import { TimeRangeControls } from "@/components/time-range-controls";
import type { EconomicSeriesField, EconomicSeriesMap } from "@/hooks/useEconomicData";
import { useEconomicData } from "@/hooks/useEconomicData";
import dayjs from "@/lib/dayjs";
import { resolveLocale } from "@/lib/i18n";

import {
  filterValuesByDays,
  getSeriesField,
  getSortedValues,
} from "../utils/series";

export default function EconomicLongPage() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const {
    loading,
    error,
    seriesMap,
    refetch,
    refreshing,
    hasData,
    latestTimestamp,
    appliedGranularity,
    appliedGranularityRange,
    delayMs,
    expectedIntervalMs,
    chartState
  } = useEconomicData({
    category: "economic-long",
    pollInterval: 300_000,
  });
  const isInitialLoading = loading && !hasData;
  const chartMeta = (
    <ChartDataMeta
      state={chartState}
      latestTimestamp={latestTimestamp}
      locale={locale}
      refreshing={refreshing}
      onRefresh={() => refetch()}
    />
  );

  const gdpSeries = getSeriesField(
    seriesMap,
    "china_gdp",
    "国内生产总值-绝对值",
  );
  const gdpByYear = new Map<number, number>();
  for (const point of getSortedValues(gdpSeries)) {
    const year = dayjs(point.timestamp).year();
    gdpByYear.set(year, (gdpByYear.get(year) ?? 0) + point.value);
  }
  const gdpBarData = Array.from(gdpByYear.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(-3);
  const gdpOption = {
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: gdpBarData.map((entry) => entry[0].toString()),
    },
    yAxis: { type: "value" },
    series: [
      {
        type: "bar",
        data: gdpBarData.map((entry) => Number(entry[1].toFixed(0))),
        itemStyle: { color: "#0958d9" },
      },
    ],
  };

  const yieldTimelineOption = buildYieldTimeline(
    seriesMap,
    "us_treasury_yield_curve",
    t,
  );

  const reserveSeries = filterValuesByDays(
    getSeriesField(seriesMap, "china_fx_gold_reserve", "国家外汇储备-数值"),
    730,
  );
  const reserveOption = {
    tooltip: { trigger: "axis" },
    xAxis: { type: "time" },
    yAxis: { type: "value", axisLabel: { formatter: "{value}亿美元" } },
    series: [
      {
        type: "line",
        areaStyle: {},
        data: reserveSeries.map((entry) => [entry.timestamp, entry.value]),
      },
    ],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>{t("dashboard.economicLong.title")}</Typography.Title>
        <TimeRangeControls
          appliedGranularity={appliedGranularity}
          appliedGranularityRange={appliedGranularityRange}
        />
      </div>
      <ChartStateBanner
        state={chartState}
        hasData={hasData}
        error={error}
        latestTimestamp={latestTimestamp}
        delayMs={delayMs}
        expectedIntervalMs={expectedIntervalMs}
        locale={locale}
        refreshing={refreshing}
        onRetry={() => refetch()}
      />
      {isInitialLoading ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={8}>
              <DashboardChartCard
                title={t("dashboard.economicLong.cards.gdp3y")}
                className="content-card"
                extra={chartMeta}
                option={gdpBarData.length > 0 ? gdpOption : null}
                height={320}
                emptyDescription={t("dashboard.economicLong.empty.gdp")}
              />
            </Col>
            <Col xs={24} lg={16}>
              <DashboardChartCard
                title={t("dashboard.economicLong.cards.yieldCurve")}
                className="content-card"
                extra={chartMeta}
                option={yieldTimelineOption}
                height={320}
                emptyDescription={t("dashboard.economicLong.empty.yieldCurve")}
              />
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <DashboardChartCard
                title={t("dashboard.economicLong.cards.reserves")}
                className="content-card"
                extra={chartMeta}
                option={reserveSeries.length > 0 ? reserveOption : null}
                height={320}
                emptyDescription={t("dashboard.economicLong.empty.reserves")}
              />
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}

function buildYieldTimeline(
  seriesMap: EconomicSeriesMap,
  slug: string,
  t: (key: string, options?: Record<string, unknown>) => string
): EChartsOption | null {
  if (!seriesMap[slug]) {
    return null;
  }
  const fieldMap = [
    { field: "美国国债收益率2年", label: "2Y" },
    { field: "美国国债收益率5年", label: "5Y" },
    { field: "美国国债收益率10年", label: "10Y" },
    { field: "美国国债收益率30年", label: "30Y" },
  ];
  const seriesEntries = fieldMap
    .map((field) => ({
      label: field.label,
      series: getSeriesField(seriesMap, slug, field.field),
    }))
    .filter((entry): entry is { label: string; series: EconomicSeriesField } => Boolean(entry.series));
  if (seriesEntries.length === 0) {
    return null;
  }
  const buckets = new Map<
    string,
    Record<string, number>
  >();
  for (const { label, series } of seriesEntries) {
    for (const entry of series.values) {
      const bucket = buckets.get(entry.timestamp) ?? {};
      bucket[label] = entry.value;
      buckets.set(entry.timestamp, bucket);
    }
  }
  const yearSnapshots = new Map<number, string>();
  const sortedDates = Array.from(buckets.keys()).sort(
    (a, b) => dayjs(a).valueOf() - dayjs(b).valueOf(),
  );
  for (const date of sortedDates) {
    const year = dayjs(date).year();
    yearSnapshots.set(year, date);
  }
  const selectedDates = Array.from(yearSnapshots.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(-5)
    .map(([, date]) => date);
  if (selectedDates.length === 0) {
    return null;
  }
  const timelineLabels = selectedDates.map((date) =>
    dayjs(date).year().toString(),
  );
  const options: EChartsOption[] = selectedDates.map((date, index) => {
    const values = buckets.get(date);
    return {
      title: { text: t("dashboard.economicLong.yieldCurve.yearLabel", { year: timelineLabels[index] }) },
      series: [
        {
          type: "line",
          data: fieldMap.map((field) => {
            const value = values?.[field.label];
            return typeof value === "number" ? value : null;
          }),
          name: t("dashboard.economicLong.yieldCurve.yieldLabel"),
          areaStyle: { opacity: 0.15 },
        },
      ],
    };
  });
  return {
    baseOption: {
      timeline: {
        axisType: "category",
        autoPlay: true,
        playInterval: 2500,
        data: timelineLabels,
      },
      xAxis: {
        type: "category",
        data: fieldMap.map((field) => field.label),
      },
      yAxis: {
        type: "value",
        axisLabel: { formatter: "{value}%" },
      },
      series: [{ type: "line" }],
    },
    options,
  };
}
