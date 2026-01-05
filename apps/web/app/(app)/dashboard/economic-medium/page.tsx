"use client";

import { Alert, Button, Card, Col, Empty, Row, Skeleton, Typography } from "antd";
import type { CallbackDataParams } from "echarts";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useEconomicData } from "@/hooks/useEconomicData";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

import {
  computeMovingAverage,
  filterValuesByDays,
  getSeriesField,
  getSortedValues,
} from "../utils/series";

const metalSeries = [
  { slug: "copper_futures_main", labelKey: "dashboard.economicMedium.metals.copper" },
  { slug: "aluminum_futures_main", labelKey: "dashboard.economicMedium.metals.aluminum" },
  { slug: "rebar_futures_main", labelKey: "dashboard.economicMedium.metals.rebar" },
];

export default function EconomicMediumPage() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { loading, error, seriesMap, refetch, hasData, latestTimestamp, isDelayed } = useEconomicData({
    category: "economic-medium",
    pollInterval: 120_000,
  });
  const isInitialLoading = loading && !hasData;

  const gdpYoy = filterValuesByDays(
    getSeriesField(seriesMap, "china_gdp", "国内生产总值-同比增长"),
    180,
  );
  const m2Yoy = filterValuesByDays(
    getSeriesField(
      seriesMap,
      "china_money_supply",
      "货币和准货币(M2)-同比增长",
    ),
    180,
  );

  const dualAxisOption = {
    tooltip: { trigger: "axis" },
    legend: { data: [t("dashboard.economicMedium.gdpYoy"), t("dashboard.economicMedium.m2Yoy")] },
    xAxis: { type: "time" },
    yAxis: [
      { type: "value", name: t("dashboard.economicMedium.gdpYoyAxis") },
      { type: "value", name: t("dashboard.economicMedium.m2YoyAxis"), alignTicks: true },
    ],
    series: [
      {
        name: t("dashboard.economicMedium.gdpYoy"),
        type: "line",
        smooth: true,
        data: gdpYoy.map((entry) => [entry.timestamp, entry.value]),
      },
      {
        name: t("dashboard.economicMedium.m2Yoy"),
        type: "line",
        smooth: true,
        yAxisIndex: 1,
        data: m2Yoy.map((entry) => [entry.timestamp, entry.value]),
      },
    ],
  };

  const localizedMetals = metalSeries.map((metal) => ({
    ...metal,
    label: t(metal.labelKey),
  }));

  const maSeries = localizedMetals.map((metal) => {
    const source = getSeriesField(seriesMap, metal.slug, "收盘价");
    const averages = computeMovingAverage(source, 5);
    return {
      name: t("dashboard.economicMedium.metalMa", { metal: metal.label }),
      data: averages.map((entry) => [entry.timestamp, entry.value]),
    };
  });

  const maOption = {
    tooltip: { trigger: "axis" },
    legend: { data: maSeries.map((series) => series.name) },
    xAxis: { type: "time" },
    yAxis: { type: "value" },
    series: maSeries.map((entry) => ({
      type: "line",
      name: entry.name,
      smooth: true,
      data: entry.data,
    })),
  };

  const pmiSeries = getSortedValues(
    getSeriesField(seriesMap, "china_pmi", "今值"),
  );
  const pmiChanges = pmiSeries.slice(-8).map((entry, index, arr) => {
    if (index === 0) {
      return null;
    }
    const prev = arr[index - 1];
    if (!prev) {
      return null;
    }
    return {
      timestamp: entry.timestamp,
      diff: Number((entry.value - prev.value).toFixed(2)),
    };
  });
  const filteredChanges = pmiChanges.filter(Boolean) as {
    timestamp: string;
    diff: number;
  }[];
  const formatLabel = (timestamp: string) => {
    return formatDateTime(timestamp, locale, {
      year: "numeric",
      month: "2-digit"
    });
  };
  const pmiOption = {
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: number) => `${value.toFixed(2)}`,
    },
    xAxis: {
      type: "category",
      data: filteredChanges.map((entry) => formatLabel(entry.timestamp)),
    },
    yAxis: { type: "value" },
    series: [
      {
        type: "bar",
        data: filteredChanges.map((entry) => entry.diff),
        itemStyle: {
          color: (params: CallbackDataParams) => {
            const value = typeof params.value === "number" ? params.value : 0;
            return value >= 0 ? "#389e0d" : "#cf1322";
          },
        },
      },
    ],
  };

  const usGdpSeries = getSortedValues(
    getSeriesField(seriesMap, "us_gdp_monthly", "今值"),
  );
  const usCpiSeries = getSortedValues(
    getSeriesField(seriesMap, "us_cpi_monthly", "今值"),
  );
  const usPpiSeries = getSortedValues(
    getSeriesField(seriesMap, "us_ppi_monthly", "今值"),
  );
  const usGrowthOption = {
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: number) => `${value.toFixed(2)}%`,
    },
    legend: {
      data: [
        t("dashboard.economicMedium.us.gdp"),
        t("dashboard.economicMedium.us.cpi"),
        t("dashboard.economicMedium.us.ppi"),
      ],
    },
    xAxis: { type: "time" },
    yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
    series: [
      {
        name: t("dashboard.economicMedium.us.gdp"),
        type: "line",
        smooth: true,
        data: usGdpSeries.map((entry) => [entry.timestamp, entry.value]),
      },
      {
        name: t("dashboard.economicMedium.us.cpi"),
        type: "line",
        smooth: true,
        data: usCpiSeries.map((entry) => [entry.timestamp, entry.value]),
      },
      {
        name: t("dashboard.economicMedium.us.ppi"),
        type: "line",
        smooth: true,
        data: usPpiSeries.map((entry) => [entry.timestamp, entry.value]),
      },
    ],
  };

  const usManufacturingSeries = getSortedValues(
    getSeriesField(seriesMap, "us_manufacturing_pmi", "今值"),
  );
  const usServicesSeries = getSortedValues(
    getSeriesField(seriesMap, "us_services_pmi", "current_value"),
  );
  const usPmiOption = {
    tooltip: { trigger: "axis" },
    legend: {
      data: [
        t("dashboard.economicMedium.us.manufacturingPmi"),
        t("dashboard.economicMedium.us.servicesPmi"),
      ],
    },
    xAxis: { type: "time" },
    yAxis: { type: "value", min: 40, max: 65 },
    series: [
      {
        name: t("dashboard.economicMedium.us.manufacturingPmi"),
        type: "line",
        smooth: true,
        data: usManufacturingSeries.map((entry) => [
          entry.timestamp,
          entry.value,
        ]),
      },
      {
        name: t("dashboard.economicMedium.us.servicesPmi"),
        type: "line",
        smooth: true,
        data: usServicesSeries.map((entry) => [entry.timestamp, entry.value]),
      },
    ],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>{t("dashboard.economicMedium.title")}</Typography.Title>
        <TimeRangeControls />
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          action={
            <Button size="small" onClick={() => refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : null}
      {isDelayed ? (
        <Alert
          type="warning"
          showIcon
          message={t("dashboard.dataDelayed.title", { defaultValue: "Data delayed" })}
          description={
            latestTimestamp
              ? t("dashboard.dataDelayed.latest", {
                  defaultValue: "Latest data at {{time}}.",
                  time: formatDateTime(latestTimestamp.toISOString(), locale, {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })
              : t("dashboard.dataDelayed.missing", { defaultValue: "Latest data time unavailable." })
          }
        />
      ) : null}
      {!loading && !hasData ? (
        <Empty description={t("dashboard.dataEmpty", { defaultValue: "No data" })} />
      ) : null}
      {isInitialLoading ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.economicMedium.cards.gdpM2")} className="content-card">
                {gdpYoy.length > 0 && m2Yoy.length > 0 ? (
                  <DashboardChart option={dualAxisOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.economicMedium.empty.gdpM2")} />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.economicMedium.cards.metalMa")} className="content-card">
                {maSeries.some((entry) => entry.data.length > 0) ? (
                  <DashboardChart option={maOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.economicMedium.empty.metals")} />
                )}
              </Card>
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <Card title={t("dashboard.economicMedium.cards.pmiChanges")} className="content-card">
                {filteredChanges.length > 0 ? (
                  <DashboardChart option={pmiOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.economicMedium.empty.pmi")} />
                )}
              </Card>
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.economicMedium.cards.usGrowth")} className="content-card">
                {usGdpSeries.length > 0 ? (
                  <DashboardChart option={usGrowthOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.economicMedium.empty.usEconomy")} />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.economicMedium.cards.usPmi")} className="content-card">
                {usManufacturingSeries.length > 0 ? (
                  <DashboardChart option={usPmiOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.economicMedium.empty.usPmi")} />
                )}
              </Card>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
