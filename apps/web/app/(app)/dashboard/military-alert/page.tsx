"use client";

import {
  Badge,
  Card,
  Col,
  Empty,
  List,
  Row,
  Skeleton,
  Typography,
} from "antd";
import type { CallbackDataParams } from "echarts/types/dist/shared";
import { useTranslation } from "react-i18next";

import { ChartDataMeta } from "@/components/chart-data-meta";
import { ChartStateBanner } from "@/components/chart-state-banner";
import { DashboardChart } from "@/components/echart";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useEconomicData } from "@/hooks/useEconomicData";
import { resolveLocale } from "@/lib/i18n";

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
    category: "military-alert",
    pollInterval: 60_000,
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

  const radarIndicators: { name: string; max: number }[] = [];
  const radarValues: number[] = [];
  const alertItems = metalConfigs.map((config) => {
    const label = t(config.labelKey);
    const latestSeries = getSeriesField(seriesMap, config.slug, "收盘价");
    const dailyChange = calculatePercentChange(latestSeries, 1);
    const swing3d = calculatePercentChange(latestSeries, 3);
    const hasChange = typeof dailyChange === "number";
    const hasSwing = typeof swing3d === "number";
    const sameDirection =
      hasChange &&
      hasSwing &&
      Math.sign(dailyChange) !== 0 &&
      Math.sign(dailyChange) === Math.sign(swing3d) &&
      Math.abs(swing3d) >= 10;
    if (hasChange) {
      radarIndicators.push({ name: label, max: 12 });
      radarValues.push(Math.min(Math.abs(dailyChange), 12));
    }
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
    const change = calculatePercentChange(series, 7);
    return { name: label, change };
  });
  const hasAgData = agBarData.some((item) => typeof item.change === "number");

  const agOption = {
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: number) =>
        typeof value === "number"
          ? `${value.toFixed(2)}%`
          : t("common.notAvailable", { defaultValue: "N/A" }),
    },
    xAxis: { type: "category", data: agBarData.map((item) => item.name) },
    yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
    series: [
      {
        type: "bar",
        data: agBarData.map((item) =>
          typeof item.change === "number" ? item.change : null,
        ),
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
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.militaryAlert.cards.metalRadar")} className="content-card" extra={chartMeta}>
                {radarValues.length > 0 ? (
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
                            {typeof item.dailyChange === "number" && Math.abs(item.dailyChange) >= 5 && (
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
                              typeof item.dailyChange === "number" && Math.abs(item.dailyChange) >= 5
                                ? "danger"
                                : "secondary"
                            }
                          >
                            {t("dashboard.militaryAlert.alertItemDescription", {
                              daily:
                                typeof item.dailyChange === "number"
                                  ? item.dailyChange.toFixed(2)
                                  : t("common.notAvailable", { defaultValue: "N/A" }),
                              threeDay:
                                typeof item.swing3d === "number"
                                  ? item.swing3d.toFixed(2)
                                  : t("common.notAvailable", { defaultValue: "N/A" }),
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
              <Card title={t("dashboard.militaryAlert.cards.agriAlert")} className="content-card" extra={chartMeta}>
                {hasAgData ? (
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
                meta={chartMeta}
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
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <EconomicChartCard
                title={t("dashboard.militaryAlert.cards.risk.title")}
                description={t("dashboard.militaryAlert.cards.risk.description")}
                seriesMap={seriesMap}
                meta={chartMeta}
                series={[
                  {
                    slug: "global_shipping_bdi",
                    label: t("dashboard.militaryAlert.cards.risk.bdi"),
                    field: "BDI",
                    type: "line",
                  },
                  {
                    slug: "global_epu_index",
                    label: t("dashboard.militaryAlert.cards.risk.epuGlobal"),
                    field: "Global EPU",
                    type: "line",
                  },
                  {
                    slug: "china_epu_index",
                    label: t("dashboard.militaryAlert.cards.risk.epuChina"),
                    field: "China EPU",
                    type: "line",
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
