"use client";

import { Card, Col, Empty, Row, Spin, Typography } from "antd";
import { TimeRangeControls } from "@/components/time-range-controls";
import { DashboardChart } from "@/components/echart";
import { useEconomicData } from "@/hooks/useEconomicData";
import {
  getLatestValue,
  getSeriesField,
  getSortedValues,
} from "../utils/series";

const agConfigs = [
  { slug: "wheat_futures_main", label: "小麦" },
  { slug: "corn_futures_main", label: "玉米" },
  { slug: "soybean_futures_main", label: "大豆" },
  { slug: "cotton_futures_main", label: "棉花" },
];

export default function LivelihoodPricesPage() {
  const { loading, error, seriesMap } = useEconomicData({
    category: "livelihood-prices",
    pollInterval: 180_000,
  });

  const cpiTreeData = [
    {
      name: "食品 (全国环比)",
      value:
        getLatestValue(getSeriesField(seriesMap, "china_cpi", "全国-环比增长"))
          ?.value ?? 0,
    },
    {
      name: "居住 (城市环比)",
      value:
        getLatestValue(getSeriesField(seriesMap, "china_cpi", "城市-环比增长"))
          ?.value ?? 0,
    },
    {
      name: "交通 (农村环比)",
      value:
        getLatestValue(getSeriesField(seriesMap, "china_cpi", "农村-环比增长"))
          ?.value ?? 0,
    },
  ];

  const treeOption = {
    tooltip: { formatter: ({ name, value }: any) => `${name}：${value}%` },
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
    const latest =
      getLatestValue(getSeriesField(seriesMap, config.slug, "收盘价"))?.value ??
      0;
    return { name: config.label, value: latest };
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
            name: "农产品价格",
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
    legend: { data: ["外汇收入", "收入占比"] },
    xAxis: { type: "time" },
    yAxis: [
      { type: "value", name: "百万美元" },
      { type: "value", name: "%", axisLabel: { formatter: "{value}%" } },
    ],
    series: [
      {
        name: "外汇收入",
        type: "line",
        areaStyle: {},
        data: tourismValues.map((entry) => [entry.timestamp, entry.value]),
      },
      {
        name: "收入占比",
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
        <Typography.Title level={4}>民生物价</Typography.Title>
        <TimeRangeControls />
      </div>
      {loading && <Spin />}
      {error && (
        <Typography.Text type="danger">{error.message}</Typography.Text>
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="CPI分类环比树状图" className="content-card">
            {cpiTreeData.some((item) => item.value !== 0) ? (
              <DashboardChart option={treeOption} height={320} />
            ) : (
              <Empty description="等待最新CPI分类数据" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="主要农产品价格雷达图" className="content-card">
            {radarData.some((item) => item.value !== 0) ? (
              <DashboardChart option={radarOption} height={320} />
            ) : (
              <Empty description="暂无农产品数据" />
            )}
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card title="国际旅游外汇收入趋势" className="content-card">
            {tourismValues.length > 0 ? (
              <DashboardChart option={tourismOption} height={320} />
            ) : (
              <Empty description="暂无旅游外汇数据" />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
