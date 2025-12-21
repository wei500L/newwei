"use client";

import { Card, Col, Empty, Row, Spin, Typography } from "antd";
import { useTranslation } from "react-i18next";
import { TimeRangeControls } from "@/components/time-range-controls";
import { DashboardChart } from "@/components/echart";
import { useEconomicData } from "@/hooks/useEconomicData";
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
  const { t } = useTranslation();
  const { loading, error, seriesMap } = useEconomicData({
    category: "livelihood-prices",
    pollInterval: 180_000,
  });

  const cpiTreeData = [
    {
      name: t("dashboard.livelihood.cpi.food"),
      value:
        getLatestValue(getSeriesField(seriesMap, "china_cpi", "全国-环比增长"))
          ?.value ?? 0,
    },
    {
      name: t("dashboard.livelihood.cpi.housing"),
      value:
        getLatestValue(getSeriesField(seriesMap, "china_cpi", "城市-环比增长"))
          ?.value ?? 0,
    },
    {
      name: t("dashboard.livelihood.cpi.transport"),
      value:
        getLatestValue(getSeriesField(seriesMap, "china_cpi", "农村-环比增长"))
          ?.value ?? 0,
    },
  ];

  const treeOption = {
    tooltip: {
      formatter: ({ name, value }: any) =>
        t("dashboard.livelihood.cpi.tooltip", { name, value }),
    },
    series: [
      {
        type: "treemap",
        data: cpiTreeData.map((item) => ({
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
      0;
    return { name: label, value: latest };
  });
  const radarOption = {
    radar: {
      indicator: radarData.map((item) => ({
        name: item.name,
        max: Math.max(...radarData.map((entry) => entry.value)) || 1,
      })),
    },
    series: [
      {
        type: "radar",
        data: [
          {
            value: radarData.map((item) => item.value),
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
      {loading && <Spin />}
      {error && (
        <Typography.Text type="danger">{error.message}</Typography.Text>
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title={t("dashboard.livelihood.cards.cpiTree")} className="content-card">
            {cpiTreeData.some((item) => item.value !== 0) ? (
              <DashboardChart option={treeOption} height={320} />
            ) : (
              <Empty description={t("dashboard.livelihood.empty.cpi")} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={t("dashboard.livelihood.cards.agriRadar")} className="content-card">
            {radarData.some((item) => item.value !== 0) ? (
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
    </div>
  );
}
