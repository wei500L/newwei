"use client";

import { Col, Row, Skeleton, Typography } from "antd";
import type { CallbackDataParams } from "echarts";
import { useTranslation } from "react-i18next";

import { ChartDataMeta } from "@/components/chart-data-meta";
import { ChartStateBanner } from "@/components/chart-state-banner";
import { DashboardChartCard } from "@/components/dashboard-chart-card";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useEconomicData } from "@/hooks/useEconomicData";
import { resolveLocale } from "@/lib/i18n";

import {
  getLatestValue,
  getSeriesField,
  getSortedValues,
} from "../utils/series";

const agConfigs = [
  { slug: "wheat_futures_main", labelKey: "dashboard.livelihood.agri.wheat" },
  { slug: "corn_futures_main", labelKey: "dashboard.livelihood.agri.corn" },
  { slug: "soybean_futures_main", labelKey: "dashboard.livelihood.agri.soybean" },
  { slug: "cotton_futures_main", labelKey: "dashboard.livelihood.agri.cotton" },
];

export default function LivelihoodPricesPage() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const {
    loading,
    error,
    seriesMap,
    refetch,
    hasData,
    latestTimestamp,
    delayMs,
    expectedIntervalMs,
    chartState
  } = useEconomicData({
    category: "livelihood-prices",
    pollInterval: 180_000,
  });
  const isInitialLoading = loading && !hasData;
  const chartMeta = (
    <ChartDataMeta
      state={chartState}
      latestTimestamp={latestTimestamp}
      locale={locale}
      onRefresh={() => refetch()}
    />
  );

  const cpiTreeData = [
    {
      name: t("dashboard.livelihood.cpi.food"),
      value:
        getLatestValue(getSeriesField(seriesMap, "china_cpi", "全国-环比增长"))
          ?.value ?? null,
    },
    {
      name: t("dashboard.livelihood.cpi.housing"),
      value:
        getLatestValue(getSeriesField(seriesMap, "china_cpi", "城市-环比增长"))
          ?.value ?? null,
    },
    {
      name: t("dashboard.livelihood.cpi.transport"),
      value:
        getLatestValue(getSeriesField(seriesMap, "china_cpi", "农村-环比增长"))
          ?.value ?? null,
    },
  ];
  const validCpiData = cpiTreeData.filter(
    (item): item is { name: string; value: number } => typeof item.value === "number",
  );

  const treeOption = {
    tooltip: {
      formatter: ({ name, value }: CallbackDataParams) =>
        t("dashboard.livelihood.cpi.tooltip", { name, value }),
    },
    series: [
      {
        type: "treemap",
        data: validCpiData.map((item) => ({
          ...item,
          value: Number(item.value.toFixed(2)),
        })),
      },
    ],
  };

  const radarData = agConfigs.map((config) => {
    const label = t(config.labelKey);
    const latest =
      getLatestValue(getSeriesField(seriesMap, config.slug, "收盘价"))?.value ??
      null;
    return { name: label, value: latest };
  });
  const validRadarData = radarData.filter(
    (item): item is { name: string; value: number } => typeof item.value === "number",
  );
  const radarMax =
    validRadarData.length > 0
      ? Math.max(...validRadarData.map((entry) => entry.value))
      : 1;
  const radarOption = {
    radar: {
      indicator: validRadarData.map((item) => ({
        name: item.name,
        max: radarMax,
      })),
    },
    series: [
      {
        type: "radar",
        data: [
          {
            value: validRadarData.map((item) => item.value),
            name: t("dashboard.livelihood.agri.radarName"),
          },
        ],
      },
    ],
  };

  const tourismSeries = getSeriesField(
    seriesMap,
    "china_international_tourism_fx",
    "数量",
  );
  const tourismRatioSeries = getSeriesField(
    seriesMap,
    "china_international_tourism_fx",
    "比重",
  );
  const tourismValues = getSortedValues(tourismSeries);
  const ratioValues = new Map(
    getSortedValues(tourismRatioSeries).map((entry) => [
      entry.timestamp,
      entry.value,
    ]),
  );
  const tourismOption = {
    tooltip: { trigger: "axis" },
    legend: {
      data: [
        t("dashboard.livelihood.tourism.fxIncome"),
        t("dashboard.livelihood.tourism.incomeShare"),
      ],
    },
    xAxis: { type: "time" },
    yAxis: [
      { type: "value", name: t("dashboard.livelihood.tourism.axisIncome") },
      { type: "value", name: "%", axisLabel: { formatter: "{value}%" } },
    ],
    series: [
      {
        name: t("dashboard.livelihood.tourism.fxIncome"),
        type: "line",
        areaStyle: {},
        data: tourismValues.map((entry) => [entry.timestamp, entry.value]),
      },
      {
        name: t("dashboard.livelihood.tourism.incomeShare"),
        type: "line",
        yAxisIndex: 1,
        data: tourismValues.map((entry) => [
          entry.timestamp,
          ratioValues.get(entry.timestamp) ?? null,
        ]),
      },
    ],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>{t("dashboard.livelihood.title")}</Typography.Title>
        <TimeRangeControls />
      </div>
      <ChartStateBanner
        state={chartState}
        hasData={hasData}
        error={error}
        latestTimestamp={latestTimestamp}
        delayMs={delayMs}
        expectedIntervalMs={expectedIntervalMs}
        locale={locale}
        onRetry={() => refetch()}
      />
      {isInitialLoading ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <DashboardChartCard
                title={t("dashboard.livelihood.cards.cpiTree")}
                className="content-card"
                extra={chartMeta}
                option={validCpiData.length > 0 ? treeOption : null}
                height={320}
                emptyDescription={t("dashboard.livelihood.empty.cpi")}
              />
            </Col>
            <Col xs={24} lg={12}>
              <DashboardChartCard
                title={t("dashboard.livelihood.cards.agriRadar")}
                className="content-card"
                extra={chartMeta}
                option={validRadarData.length > 0 ? radarOption : null}
                height={320}
                emptyDescription={t("dashboard.livelihood.empty.agri")}
              />
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <DashboardChartCard
                title={t("dashboard.livelihood.cards.tourism")}
                className="content-card"
                extra={chartMeta}
                option={tourismValues.length > 0 ? tourismOption : null}
                height={320}
                emptyDescription={t("dashboard.livelihood.empty.tourism")}
              />
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
