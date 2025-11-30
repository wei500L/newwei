"use client";

import { Col, Row, Spin, Typography } from "antd";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useEconomicData } from "@/hooks/useEconomicData";
import { EconomicChartCard } from "../components/economic-chart-card";
import { CandlestickCard } from "../components/candlestick-card";

export default function KeyMonitorPage() {
  const { loading, seriesMap } = useEconomicData({
    category: "key-monitor",
    pollInterval: 30_000,
  });
  const goldSeries = seriesMap.get("gold_futures_main");
  const oilSeries = seriesMap.get("crude_oil_futures_main");
  const copperSeries = seriesMap.get("copper_futures_main");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>重点监控</Typography.Title>
        <TimeRangeControls />
      </div>
      {loading && <Spin />}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <CandlestickCard title="黄金主力K线" group={goldSeries} />
        </Col>
        <Col xs={24} lg={8}>
          <CandlestickCard title="原油主力K线" group={oilSeries} />
        </Col>
        <Col xs={24} lg={8}>
          <CandlestickCard title="沪铜主力K线" group={copperSeries} />
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <EconomicChartCard
            title="上证指数 vs 标普500"
            description="中美核心指数对比"
            seriesMap={seriesMap}
            series={[
              {
                slug: "shanghai_composite_index",
                label: "上证指数",
                field: "close",
              },
              { slug: "sp500_index", label: "标普500", field: "close" },
            ]}
          />
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <EconomicChartCard
            title="人民币中间价(主要货币)"
            description="来自SAFE的人民币对主要货币中间价"
            seriesMap={seriesMap}
            series={[
              { slug: "china_fx_mid_rates", label: "美元", field: "美元" },
              { slug: "china_fx_mid_rates", label: "欧元", field: "欧元" },
              { slug: "china_fx_mid_rates", label: "日元", field: "日元" },
            ]}
          />
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <EconomicChartCard
            title="人民币汇率"
            description="美元/人民币与欧元/人民币即期走势"
            seriesMap={seriesMap}
            series={[
              { slug: "usd_cny_spot", label: "美元/人民币" },
              { slug: "eur_cny_spot", label: "欧元/人民币" },
            ]}
          />
        </Col>
      </Row>
    </div>
  );
}
