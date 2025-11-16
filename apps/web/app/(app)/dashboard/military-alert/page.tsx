"use client";

import { Alert, Badge, Card, Col, Empty, List, Row, Spin, Typography } from "antd";
import { TimeRangeControls } from "@/components/time-range-controls";
import { DashboardChart } from "@/components/echart";
import { useEconomicData } from "@/hooks/useEconomicData";
import { EconomicChartCard } from "../components/economic-chart-card";
import { calculatePercentChange, getSeriesField } from "../utils/series";

const metalConfigs = [
  { slug: "copper_futures_main", label: "铜" },
  { slug: "rebar_futures_main", label: "螺纹钢" },
  { slug: "aluminum_futures_main", label: "铝" },
  { slug: "platinum_spot_sge", label: "铂金" },
  { slug: "palladium_spot_sge", label: "钯金" }
];

const agConfigs = [
  { slug: "wheat_futures_main", label: "小麦" },
  { slug: "corn_futures_main", label: "玉米" },
  { slug: "soybean_futures_main", label: "大豆" }
];

export default function MilitaryAlertPage() {
  const { loading, error, seriesMap } = useEconomicData({ category: "military-alert", pollInterval: 60_000 });

  const radarIndicators: { name: string; max: number }[] = [];
  const radarValues: number[] = [];
  const alertItems = metalConfigs.map((config) => {
    const latestSeries = getSeriesField(seriesMap, config.slug, "收盘价");
    const dailyChange = calculatePercentChange(latestSeries, 1) ?? 0;
    const swing3d = calculatePercentChange(latestSeries, 3) ?? 0;
    const sameDirection =
      Math.sign(dailyChange) !== 0 && Math.sign(dailyChange) === Math.sign(swing3d) && Math.abs(swing3d) >= 10;
    radarIndicators.push({ name: config.label, max: 12 });
    radarValues.push(Math.min(Math.abs(dailyChange), 12));
    return {
      title: config.label,
      dailyChange,
      swing3d,
      sameDirection
    };
  });

  const radarOption = {
    tooltip: { trigger: "item" },
    radar: {
      indicator: radarIndicators,
      radius: "65%"
    },
    series: [
      {
        type: "radar",
        areaStyle: { opacity: 0.2 },
        data: [
          {
            value: radarValues,
            name: "单日波动(%)"
          }
        ]
      }
    ]
  };

  const agBarData = agConfigs.map((config) => {
    const series = getSeriesField(seriesMap, config.slug, "收盘价");
    const change = calculatePercentChange(series, 7) ?? 0;
    return { name: config.label, change };
  });

  const agOption = {
    tooltip: { trigger: "axis", valueFormatter: (value: number) => `${value.toFixed(2)}%` },
    xAxis: { type: "category", data: agBarData.map((item) => item.name) },
    yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
    series: [
      {
        type: "bar",
        data: agBarData.map((item) => item.change),
        itemStyle: {
          color: (params: any) => ((params.value ?? 0) > 5 ? "#cf1322" : "#0958d9")
        }
      }
    ]
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>军事预警看板</Typography.Title>
        <TimeRangeControls />
      </div>
      {error && <Alert type="error" showIcon message="军事数据加载失败" description={error.message} />}
      {loading && <Spin />}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="工业金属波动雷达图" className="content-card">
            {radarValues.some((value) => value > 0) ? (
              <DashboardChart option={radarOption} height={360} />
            ) : (
              <Empty description="暂无波动数据" />
            )}
            <List
              dataSource={alertItems}
              size="small"
              renderItem={(item) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <span>
                        {item.title}
                        {Math.abs(item.dailyChange) >= 5 && <Badge color="red" text="单日>5%" style={{ marginLeft: 8 }} />}
                        {item.sameDirection && <Badge color="orange" text="3日同向>10%" style={{ marginLeft: 8 }} />}
                      </span>
                    }
                    description={
                      <Typography.Text type={Math.abs(item.dailyChange) >= 5 ? "danger" : "secondary"}>
                        日变动 {item.dailyChange.toFixed(2)}% • 三日累积 {item.swing3d.toFixed(2)}%
                      </Typography.Text>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="战略农产品库存/价格预警" className="content-card">
            {agBarData.some((item) => item.change !== 0) ? (
              <DashboardChart option={agOption} height={360} />
            ) : (
              <Empty description="暂无农产品数据" />
            )}
          </Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <EconomicChartCard
            title="能源价格趋势"
            description="原油与天然气主力合约近走势"
            seriesMap={seriesMap}
            series={[
              { slug: "crude_oil_futures_main", label: "原油", field: "收盘价", type: "area" },
              { slug: "natural_gas_futures_main", label: "天然气", field: "收盘价", type: "area" }
            ]}
          />
        </Col>
      </Row>
    </div>
  );
}
