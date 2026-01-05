"use client";

import { Alert, Card, Col, Empty, Row, Skeleton, Typography } from "antd";
import type { CallbackDataParams } from "echarts";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useEconomicData } from "@/hooks/useEconomicData";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

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
  const { loading, error, seriesMap, hasData, latestTimestamp, isDelayed } = useEconomicData({
    category: "livelihood-prices",
    pollInterval: 180_000,
  });
  const isInitialLoading = loading && !hasData;

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
      {error && (
        <Alert
          type="error"
          showIcon
          message={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={error.message}
        />
      )}
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
      {isInitialLoading ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.livelihood.cards.cpiTree")} className="content-card">
                {validCpiData.length > 0 ? (
                  <DashboardChart option={treeOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.livelihood.empty.cpi")} />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.livelihood.cards.agriRadar")} className="content-card">
                {validRadarData.length > 0 ? (
                  <DashboardChart option={radarOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.livelihood.empty.agri")} />
                )}
              </Card>
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <Card title={t("dashboard.livelihood.cards.tourism")} className="content-card">
                {tourismValues.length > 0 ? (
                  <DashboardChart option={tourismOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.livelihood.empty.tourism")} />
                )}
              </Card>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
