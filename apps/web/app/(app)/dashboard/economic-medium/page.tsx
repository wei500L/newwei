"use client";

import { Card, Col, Empty, Row, Spin, Typography } from "antd";
import { TimeRangeControls } from "@/components/time-range-controls";
import { DashboardChart } from "@/components/echart";
import { useEconomicData } from "@/hooks/useEconomicData";
import {
  computeMovingAverage,
  filterValuesByDays,
  getSeriesField,
  getSortedValues,
} from "../utils/series";

const metalSeries = [
  { slug: "copper_futures_main", label: "沪铜" },
  { slug: "aluminum_futures_main", label: "沪铝" },
  { slug: "rebar_futures_main", label: "螺纹钢" },
];

export default function EconomicMediumPage() {
  const { loading, error, seriesMap } = useEconomicData({
    category: "economic-medium",
    pollInterval: 120_000,
  });

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
    legend: { data: ["GDP同比", "M2同比"] },
    xAxis: { type: "time" },
    yAxis: [
      { type: "value", name: "GDP同比(%)" },
      { type: "value", name: "M2同比(%)", alignTicks: true },
    ],
    series: [
      {
        name: "GDP同比",
        type: "line",
        smooth: true,
        data: gdpYoy.map((entry) => [entry.timestamp, entry.value]),
      },
      {
        name: "M2同比",
        type: "line",
        smooth: true,
        yAxisIndex: 1,
        data: m2Yoy.map((entry) => [entry.timestamp, entry.value]),
      },
    ],
  };

  const maSeries = metalSeries.map((metal) => {
    const source = getSeriesField(seriesMap, metal.slug, "收盘价");
    const averages = computeMovingAverage(source, 5);
    return {
      name: `${metal.label}MA`,
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
  const filteredChanges = pmiChanges.filter(Boolean) as Array<{
    timestamp: string;
    diff: number;
  }>;
  const formatLabel = (timestamp: string) => {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${date.getMonth() + 1}`;
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
          color: (params: any) =>
            (params.value ?? 0) >= 0 ? "#389e0d" : "#cf1322",
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
    legend: { data: ["GDP", "CPI", "PPI"] },
    xAxis: { type: "time" },
    yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
    series: [
      {
        name: "GDP",
        type: "line",
        smooth: true,
        data: usGdpSeries.map((entry) => [entry.timestamp, entry.value]),
      },
      {
        name: "CPI",
        type: "line",
        smooth: true,
        data: usCpiSeries.map((entry) => [entry.timestamp, entry.value]),
      },
      {
        name: "PPI",
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
    legend: { data: ["制造业PMI", "服务业PMI"] },
    xAxis: { type: "time" },
    yAxis: { type: "value", min: 40, max: 65 },
    series: [
      {
        name: "制造业PMI",
        type: "line",
        smooth: true,
        data: usManufacturingSeries.map((entry) => [
          entry.timestamp,
          entry.value,
        ]),
      },
      {
        name: "服务业PMI",
        type: "line",
        smooth: true,
        data: usServicesSeries.map((entry) => [entry.timestamp, entry.value]),
      },
    ],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>经济中期趋势</Typography.Title>
        <TimeRangeControls />
      </div>
      {loading && <Spin />}
      {error && (
        <Typography.Text type="danger">{error.message}</Typography.Text>
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="近6个月GDP / M2增速" className="content-card">
            {gdpYoy.length > 0 && m2Yoy.length > 0 ? (
              <DashboardChart option={dualAxisOption} height={320} />
            ) : (
              <Empty description="暂无GDP/M2增速数据" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="工业金属移动平均线 (5期)" className="content-card">
            {maSeries.some((entry) => entry.data.length > 0) ? (
              <DashboardChart option={maOption} height={320} />
            ) : (
              <Empty description="暂无金属价格数据" />
            )}
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card title="PMI环比变化" className="content-card">
            {filteredChanges.length > 0 ? (
              <DashboardChart option={pmiOption} height={320} />
            ) : (
              <Empty description="暂无PMI变化数据" />
            )}
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="美国GDP / CPI / PPI" className="content-card">
            {usGdpSeries.length > 0 ? (
              <DashboardChart option={usGrowthOption} height={320} />
            ) : (
              <Empty description="暂无美国经济数据" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="美国PMI走势" className="content-card">
            {usManufacturingSeries.length > 0 ? (
              <DashboardChart option={usPmiOption} height={320} />
            ) : (
              <Empty description="暂无美国PMI数据" />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
