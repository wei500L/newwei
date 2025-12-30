"use client";

import {
  Alert,
  Badge,
  Card,
  Col,
  Empty,
  List,
  Row,
  Skeleton,
  Typography,
} from "antd";
import type { CallbackDataParams } from "echarts";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useEconomicData } from "@/hooks/useEconomicData";

import { EconomicChartCard } from "../components/economic-chart-card";
import { calculatePercentChange, getSeriesField } from "../utils/series";

const metalConfigs = [
  { slug: "copper_futures_main", labelKey: "dashboard.militaryAlert.metals.copper" },
  { slug: "rebar_futures_main", labelKey: "dashboard.militaryAlert.metals.rebar" },
  { slug: "aluminum_futures_main", labelKey: "dashboard.militaryAlert.metals.aluminum" },
  { slug: "platinum_spot_sge", labelKey: "dashboard.militaryAlert.metals.platinum" },
  { slug: "palladium_spot_sge", labelKey: "dashboard.militaryAlert.metals.palladium" },
];

const agConfigs = [
  { slug: "wheat_futures_main", labelKey: "dashboard.militaryAlert.agri.wheat" },
  { slug: "corn_futures_main", labelKey: "dashboard.militaryAlert.agri.corn" },
  { slug: "soybean_futures_main", labelKey: "dashboard.militaryAlert.agri.soybean" },
];

export default function MilitaryAlertPage() {
  const { t } = useTranslation();
  const { loading, error, seriesMap } = useEconomicData({
    category: "military-alert",
    pollInterval: 60_000,
  });
  const isInitialLoading = loading && seriesMap.size === 0;

  const radarIndicators: { name: string; max: number }[] = [];
  const radarValues: number[] = [];
  const alertItems = metalConfigs.map((config) => {
    const label = t(config.labelKey);
    const latestSeries = getSeriesField(seriesMap, config.slug, "收盘价");
    const dailyChange = calculatePercentChange(latestSeries, 1) ?? 0;
    const swing3d = calculatePercentChange(latestSeries, 3) ?? 0;
    const sameDirection =
      Math.sign(dailyChange) !== 0 &&
      Math.sign(dailyChange) === Math.sign(swing3d) &&
      Math.abs(swing3d) >= 10;
    radarIndicators.push({ name: label, max: 12 });
    radarValues.push(Math.min(Math.abs(dailyChange), 12));
    return {
      title: label,
      dailyChange,
      swing3d,
      sameDirection,
    };
  });

  const radarOption = {
    tooltip: { trigger: "item" },
    radar: {
      indicator: radarIndicators,
      radius: "65%",
    },
    series: [
      {
        type: "radar",
        areaStyle: { opacity: 0.2 },
        data: [
          {
            value: radarValues,
            name: t("dashboard.militaryAlert.radar.dailySwing"),
          },
        ],
      },
    ],
  };

  const agBarData = agConfigs.map((config) => {
    const label = t(config.labelKey);
    const series = getSeriesField(seriesMap, config.slug, "收盘价");
    const change = calculatePercentChange(series, 7) ?? 0;
    return { name: label, change };
  });

  const agOption = {
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: number) => `${value.toFixed(2)}%`,
    },
    xAxis: { type: "category", data: agBarData.map((item) => item.name) },
    yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
    series: [
      {
        type: "bar",
        data: agBarData.map((item) => item.change),
        itemStyle: {
          color: (params: CallbackDataParams) => {
            const value = typeof params.value === "number" ? params.value : 0;
            return value > 5 ? "#cf1322" : "#0958d9";
          },
        },
      },
    ],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>{t("dashboard.militaryAlert.title")}</Typography.Title>
        <TimeRangeControls />
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={t("dashboard.militaryAlert.loadFailed")}
          description={error.message}
        />
      )}
      {isInitialLoading ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.militaryAlert.cards.metalRadar")} className="content-card">
                {radarValues.some((value) => value > 0) ? (
                  <DashboardChart option={radarOption} height={360} />
                ) : (
                  <Empty description={t("dashboard.militaryAlert.empty.metalRadar")} />
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
                            {Math.abs(item.dailyChange) >= 5 && (
                              <Badge
                                color="red"
                                text={t("dashboard.militaryAlert.badges.daily")}
                                style={{ marginLeft: 8 }}
                              />
                            )}
                            {item.sameDirection && (
                              <Badge
                                color="orange"
                                text={t("dashboard.militaryAlert.badges.threeDay")}
                                style={{ marginLeft: 8 }}
                              />
                            )}
                          </span>
                        }
                        description={
                          <Typography.Text
                            type={
                              Math.abs(item.dailyChange) >= 5
                                ? "danger"
                                : "secondary"
                            }
                          >
                            {t("dashboard.militaryAlert.alertItemDescription", {
                              daily: item.dailyChange.toFixed(2),
                              threeDay: item.swing3d.toFixed(2),
                            })}
                          </Typography.Text>
                        }
                      />
                    </List.Item>
                  )}
                />
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.militaryAlert.cards.agriAlert")} className="content-card">
                {agBarData.some((item) => item.change !== 0) ? (
                  <DashboardChart option={agOption} height={360} />
                ) : (
                  <Empty description={t("dashboard.militaryAlert.empty.agri")} />
                )}
              </Card>
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <EconomicChartCard
                title={t("dashboard.militaryAlert.cards.energy.title")}
                description={t("dashboard.militaryAlert.cards.energy.description")}
                seriesMap={seriesMap}
                series={[
                  {
                    slug: "crude_oil_futures_main",
                    label: t("dashboard.militaryAlert.cards.energy.oil"),
                    field: "收盘价",
                    type: "area",
                  },
                  {
                    slug: "natural_gas_futures_main",
                    label: t("dashboard.militaryAlert.cards.energy.gas"),
                    field: "收盘价",
                    type: "area",
                  },
                ]}
              />
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
