"use client";

import { Alert, Button, Card, Col, Empty, Row, Spin, Typography } from "antd";
import { TimeRangeControls } from "@/components/time-range-controls";
import { DashboardChart } from "@/components/echart";
import { useEconomicData } from "@/hooks/useEconomicData";
import {
  getLatestValue,
  getSeriesField,
  getSortedValues,
} from "../utils/series";

export default function EconomicAlertPage() {
  const { loading, error, seriesMap, refetch } = useEconomicData({
    category: "economic-alert",
    pollInterval: 60_000,
  });

  const cpiSeries = getSeriesField(seriesMap, "china_cpi", "全国-同比增长");
  const cpiValue = getLatestValue(cpiSeries)?.value ?? null;
  const ppiSeries = getSeriesField(seriesMap, "china_ppi", "今值");
  const ppiValue = getLatestValue(ppiSeries)?.value ?? null;
  const chinaPmiSeries = getSeriesField(seriesMap, "china_pmi", "今值");
  const usPmiSeries = getSeriesField(
    seriesMap,
    "us_services_pmi",
    "current_value",
  );
  const usCpiSeries = getSeriesField(seriesMap, "us_cpi_monthly", "今值");
  const usPpiSeries = getSeriesField(seriesMap, "us_ppi_monthly", "今值");
  const usManufacturingPmiSeries = getSeriesField(
    seriesMap,
    "us_manufacturing_pmi",
    "今值",
  );

  const tenYearSeries = getSeriesField(
    seriesMap,
    "us_treasury_yield_curve",
    "美国国债收益率10年",
  );
  const twoYearSeries = getSeriesField(
    seriesMap,
    "us_treasury_yield_curve",
    "美国国债收益率2年",
  );
  const twoYearMap = new Map(
    getSortedValues(twoYearSeries).map((point) => [
      point.timestamp,
      point.value,
    ]),
  );
  const spreadSeries = getSortedValues(tenYearSeries)
    .map((point) => {
      const short = twoYearMap.get(point.timestamp);
      if (short === undefined) {
        return undefined;
      }
      return {
        timestamp: point.timestamp,
        value: Number((point.value - short).toFixed(3)),
      };
    })
    .filter(Boolean) as Array<{ timestamp: string; value: number }>;

  const latestSpread = spreadSeries.at(-1)?.value ?? null;
  const alerts: string[] = [];
  if (cpiValue !== null && cpiValue > 3) {
    alerts.push("CPI同比超过3%");
  }
  if (
    getLatestValue(chinaPmiSeries)?.value !== undefined &&
    (getLatestValue(chinaPmiSeries)?.value ?? 0) < 50
  ) {
    alerts.push("中国PMI跌破荣枯线");
  }
  if (latestSpread !== null && latestSpread < 0) {
    alerts.push("美国2Y/10Y收益率倒挂");
  }

  const gaugeOption = {
    series: [
      {
        type: "gauge",
        min: -5,
        max: 6,
        center: ["25%", "55%"],
        title: { offsetCenter: [0, "70%"] },
        data: [{ value: cpiValue ?? 0, name: "CPI同比" }],
      },
      {
        type: "gauge",
        min: -10,
        max: 10,
        center: ["75%", "55%"],
        title: { offsetCenter: [0, "70%"] },
        data: [{ value: ppiValue ?? 0, name: "PPI同比" }],
      },
    ],
  };

  const pmiOption = {
    tooltip: { trigger: "axis" },
    legend: { data: ["中国PMI", "美国PMI"] },
    grid: { left: 40, right: 20, top: 60, bottom: 60 },
    xAxis: { type: "time" },
    yAxis: { type: "value", min: 40, max: 60, splitNumber: 4 },
    series: [
      {
        name: "中国PMI",
        type: "line",
        data: getSortedValues(chinaPmiSeries).map((point) => [
          point.timestamp,
          point.value,
        ]),
        smooth: true,
      },
      {
        name: "美国PMI",
        type: "line",
        data: getSortedValues(usPmiSeries).map((point) => [
          point.timestamp,
          point.value,
        ]),
        smooth: true,
      },
      {
        type: "line",
        name: "荣枯线",
        data: getSortedValues(chinaPmiSeries)
          .slice(-50)
          .map((entry) => [entry.timestamp, 50]),
        lineStyle: { type: "dashed", color: "#999" },
        symbol: "none",
      },
    ],
  };

  const yieldOption = {
    tooltip: { trigger: "axis" },
    xAxis: { type: "time" },
    yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
    dataZoom: [{ type: "inside" }, { type: "slider" }],
    series: [
      {
        type: "line",
        name: "10Y-2Y",
        data: spreadSeries.map((entry) => [entry.timestamp, entry.value]),
        smooth: true,
        lineStyle: { width: 2 },
      },
    ],
  };

  const usInflationOption = {
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: number) => `${value.toFixed(2)}%`,
    },
    legend: { data: ["美国CPI", "美国PPI"] },
    xAxis: { type: "time" },
    yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
    series: [
      {
        name: "美国CPI",
        type: "line",
        smooth: true,
        data: getSortedValues(usCpiSeries).map((point) => [
          point.timestamp,
          point.value,
        ]),
      },
      {
        name: "美国PPI",
        type: "line",
        smooth: true,
        data: getSortedValues(usPpiSeries).map((point) => [
          point.timestamp,
          point.value,
        ]),
      },
    ],
  };

  const usPmiCompareOption = {
    tooltip: { trigger: "axis" },
    legend: { data: ["制造业PMI", "服务业PMI"] },
    xAxis: { type: "time" },
    yAxis: { type: "value", min: 40, max: 65 },
    series: [
      {
        name: "制造业PMI",
        type: "line",
        smooth: true,
        data: getSortedValues(usManufacturingPmiSeries).map((point) => [
          point.timestamp,
          point.value,
        ]),
      },
      {
        name: "服务业PMI",
        type: "line",
        smooth: true,
        data: getSortedValues(usPmiSeries).map((point) => [
          point.timestamp,
          point.value,
        ]),
      },
    ],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>经济预警</Typography.Title>
        <TimeRangeControls />
      </div>
      {error ? (
        <Alert
          type="error"
          message="经济数据加载失败"
          description={error.message}
          showIcon
          action={
            <Button size="small" onClick={() => refetch()}>
              重试
            </Button>
          }
        />
      ) : null}
      {!loading && seriesMap.size === 0 ? (
        <Empty description="暂无宏观数据" />
      ) : null}
      {alerts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="触发经济预警"
          description={alerts.join("、")}
        />
      )}
      {loading && <Spin />}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="CPI / PPI 同比仪表盘" className="content-card">
            {cpiValue !== null || ppiValue !== null ? (
              <DashboardChart option={gaugeOption} height={360} />
            ) : (
              <Empty description="暂未获取到CPI/PPI数据" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="PMI荣枯线对比" className="content-card">
            {getSortedValues(chinaPmiSeries).length > 0 ? (
              <DashboardChart option={pmiOption} height={360} />
            ) : (
              <Empty description="暂无PMI数据" />
            )}
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card title="国债收益率倒挂监测" className="content-card">
            {spreadSeries.length > 0 ? (
              <DashboardChart option={yieldOption} height={360} />
            ) : (
              <Empty description="暂无收益率数据" />
            )}
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="美国CPI / PPI走势" className="content-card">
            {getSortedValues(usCpiSeries).length > 0 ? (
              <DashboardChart option={usInflationOption} height={320} />
            ) : (
              <Empty description="暂无美国通胀数据" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="美国PMI对比" className="content-card">
            {getSortedValues(usManufacturingPmiSeries).length > 0 ? (
              <DashboardChart option={usPmiCompareOption} height={320} />
            ) : (
              <Empty description="暂无美国PMI数据" />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
