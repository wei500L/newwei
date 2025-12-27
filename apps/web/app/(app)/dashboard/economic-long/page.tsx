"use client";

import { Alert, Button, Card, Col, Empty, Row, Spin, Typography } from "antd";
import type { EChartsOption } from "echarts";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { TimeRangeControls } from "@/components/time-range-controls";
import type { EconomicSeriesGroup } from "@/hooks/useEconomicData";
import { useEconomicData  } from "@/hooks/useEconomicData";
import dayjs from "@/lib/dayjs";

import {
  filterValuesByDays,
  getSeriesField,
  getSortedValues,
} from "../utils/series";

export default function EconomicLongPage() {
  const { t } = useTranslation();
  const { loading, error, seriesMap, refetch } = useEconomicData({
    category: "economic-long",
    pollInterval: 300_000,
  });

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
    seriesMap.get("us_treasury_yield_curve"),
    t,
  );

  const reserveSeries = filterValuesByDays(
    getSeriesField(seriesMap, "china_fx_gold", "国家外汇储备-数值"),
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
        <TimeRangeControls />
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("dashboard.economicLong.loadFailed")}
          action={
            <Button size="small" onClick={() => refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : null}
      {!loading && seriesMap.size === 0 ? (
        <Empty description={t("common.empty")} />
      ) : null}
      {loading && <Spin />}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card title={t("dashboard.economicLong.cards.gdp3y")} className="content-card">
            {gdpBarData.length > 0 ? (
              <DashboardChart option={gdpOption} height={320} />
            ) : (
              <Empty description={t("dashboard.economicLong.empty.gdp")} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={16}>
          <Card title={t("dashboard.economicLong.cards.yieldCurve")} className="content-card">
            {yieldTimelineOption ? (
              <DashboardChart option={yieldTimelineOption} height={320} />
            ) : (
              <Empty description={t("dashboard.economicLong.empty.yieldCurve")} />
            )}
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card title={t("dashboard.economicLong.cards.reserves")} className="content-card">
            {reserveSeries.length > 0 ? (
              <DashboardChart option={reserveOption} height={320} />
            ) : (
              <Empty description={t("dashboard.economicLong.empty.reserves")} />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}

function buildYieldTimeline(
  group: EconomicSeriesGroup | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): EChartsOption | null {
  if (!group) {
    return null;
  }
  const fieldMap = [
    { field: "美国国债收益率2年", label: "2Y" },
    { field: "美国国债收益率5年", label: "5Y" },
    { field: "美国国债收益率10年", label: "10Y" },
    { field: "美国国债收益率30年", label: "30Y" },
  ];
  const buckets = new Map<
    string,
    Record<string, number>
  >();
  for (const { field, label } of fieldMap) {
    const series = group.fields.get(field);
    if (!series) {
      continue;
    }
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
  const options = selectedDates.map((date, index) => {
    const values = buckets.get(date);
    return {
      title: { text: t("dashboard.economicLong.yieldCurve.yearLabel", { year: timelineLabels[index] }) },
      series: [
        {
          type: "line",
          data: fieldMap.map((field) => values?.[field.label] ?? 0),
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
