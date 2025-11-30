"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Spin,
  Tabs,
  Typography,
} from "antd";
import { useState } from "react";
import { TimeRangeControls } from "@/components/time-range-controls";
import { DashboardChart } from "@/components/echart";
import { useEconomicData } from "@/hooks/useEconomicData";
import { CandlestickCard } from "../components/candlestick-card";
import {
  calculatePercentChange,
  filterValuesByDays,
  getSeriesField,
} from "../utils/series";

const indexTabs = [
  { key: "shanghai_composite_index", label: "上证指数" },
  { key: "csi300_index", label: "沪深300" },
  { key: "sz_component_index", label: "深证成指" },
  { key: "csi1000_index", label: "中证1000" },
];

const fxPairs = [
  { slug: "usd_cny_spot", label: "USD/CNY" },
  { slug: "eur_cny_spot", label: "EUR/CNY" },
];

const heatmapBuckets = [
  { label: "1日", period: 1 },
  { label: "3日", period: 3 },
  { label: "7日", period: 7 },
];

export default function EconomicShortPage() {
  const { loading, seriesMap, error, refetch } = useEconomicData({
    category: "economic-short",
    pollInterval: 60_000,
  });
  const [activeIndex, setActiveIndex] = useState(indexTabs[0]?.key ?? "growth");

  const heatmapData = fxPairs.flatMap((pair, xIndex) =>
    heatmapBuckets.map((bucket, yIndex) => {
      const series = getSeriesField(seriesMap, pair.slug, "最新价");
      const change = calculatePercentChange(series, bucket.period) ?? 0;
      return [xIndex, yIndex, Number(change.toFixed(3))];
    }),
  );

  const heatmapOption = {
    tooltip: {
      position: "top",
      formatter: ({ value }: any) => {
        const bucket = heatmapBuckets[value[1]];
        const pair = fxPairs[value[0]];
        if (!bucket || !pair) return "";
        return `${bucket.label} ${pair.label}：${value[2]}%`;
      },
    },
    xAxis: {
      type: "category",
      data: fxPairs.map((pair) => pair.label),
    },
    yAxis: {
      type: "category",
      data: heatmapBuckets.map((bucket) => bucket.label),
    },
    visualMap: {
      min: -2,
      max: 2,
      orient: "horizontal",
      left: "center",
    },
    series: [
      {
        type: "heatmap",
        data: heatmapData,
        label: {
          show: true,
          formatter: ({ value }: any) => `${value?.[2] ?? 0}%`,
        },
      },
    ],
  };

  const btcSeries = getSeriesField(
    seriesMap,
    "bitcoin_spot_price",
    "latest_price",
  );
  const btcValues = filterValuesByDays(btcSeries, 3);
  const cryptoOption = {
    tooltip: { trigger: "axis" },
    xAxis: { type: "time" },
    yAxis: { type: "value" },
    series: [
      {
        type: "line",
        name: "BTC",
        smooth: true,
        data: btcValues.map((entry) => [entry.timestamp, entry.value]),
      },
    ],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>经济短期趋势</Typography.Title>
        <TimeRangeControls />
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          message="获取经济短期数据失败"
          description={error.message}
          action={
            <Button size="small" onClick={() => refetch()}>
              重试
            </Button>
          }
        />
      ) : null}
      {!loading && seriesMap.size === 0 ? (
        <Empty description="暂无短期数据" />
      ) : null}
      {loading && <Spin />}
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card className="content-card" title="近1个月股指K线">
            <Tabs
              activeKey={activeIndex}
              onChange={setActiveIndex}
              items={indexTabs.map((tab) => ({
                key: tab.key,
                label: tab.label,
                children: (
                  <CandlestickCard
                    title={tab.label}
                    group={seriesMap.get(tab.key)}
                  />
                ),
              }))}
            />
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="外汇波动率热力图" className="content-card">
            {heatmapData.some((entry) => entry[2] !== 0) ? (
              <DashboardChart option={heatmapOption} height={320} />
            ) : (
              <Empty description="暂无波动率数据" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="近3日加密货币价格" className="content-card">
            {btcValues.length > 0 ? (
              <DashboardChart option={cryptoOption} height={320} />
            ) : (
              <Empty description="等待更多加密货币数据" />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
