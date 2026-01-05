"use client";

import { Alert, Button, Card, Col, Empty, Row, Skeleton, Typography } from "antd";
import type { EChartsOption, SeriesOption } from "echarts";
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

export default function EconomicAlertPage() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { loading, error, seriesMap, refetch, hasData, latestTimestamp, isDelayed } = useEconomicData({
    category: "economic-alert",
    pollInterval: 60_000,
  });
  const isInitialLoading = loading && !hasData;

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
    .filter(Boolean) as { timestamp: string; value: number }[];

  const latestSpread = spreadSeries.at(-1)?.value ?? null;
  const chinaPmiLatest = getLatestValue(chinaPmiSeries)?.value;
  const alerts: string[] = [];
  if (cpiValue !== null && cpiValue > 3) {
    alerts.push(t("dashboard.economicAlert.alerts.cpiHigh"));
  }
  if (chinaPmiLatest !== undefined && chinaPmiLatest < 50) {
    alerts.push(t("dashboard.economicAlert.alerts.chinaPmiLow"));
  }
  if (latestSpread !== null && latestSpread < 0) {
    alerts.push(t("dashboard.economicAlert.alerts.usYieldInversion"));
  }

  const hasCpi = typeof cpiValue === "number";
  const hasPpi = typeof ppiValue === "number";
  const gaugeSeries: SeriesOption[] = [];
  if (hasCpi) {
    gaugeSeries.push({
      type: "gauge",
      min: -5,
      max: 6,
      center: [hasPpi ? "25%" : "50%", "55%"],
      title: { offsetCenter: [0, "70%"] },
      data: [{ value: cpiValue, name: t("dashboard.economicAlert.gauges.cpi") }],
    });
  }
  if (hasPpi) {
    gaugeSeries.push({
      type: "gauge",
      min: -10,
      max: 10,
      center: [hasCpi ? "75%" : "50%", "55%"],
      title: { offsetCenter: [0, "70%"] },
      data: [{ value: ppiValue, name: t("dashboard.economicAlert.gauges.ppi") }],
    });
  }
  const gaugeOption: EChartsOption | null =
    gaugeSeries.length > 0 ? { series: gaugeSeries } : null;

  const pmiOption = {
    tooltip: { trigger: "axis" },
    legend: { data: [t("dashboard.economicAlert.pmi.china"), t("dashboard.economicAlert.pmi.us")] },
    grid: { left: 40, right: 20, top: 60, bottom: 60 },
    xAxis: { type: "time" },
    yAxis: { type: "value", min: 40, max: 60, splitNumber: 4 },
    series: [
      {
        name: t("dashboard.economicAlert.pmi.china"),
        type: "line",
        data: getSortedValues(chinaPmiSeries).map((point) => [
          point.timestamp,
          point.value,
        ]),
        smooth: true,
      },
      {
        name: t("dashboard.economicAlert.pmi.us"),
        type: "line",
        data: getSortedValues(usPmiSeries).map((point) => [
          point.timestamp,
          point.value,
        ]),
        smooth: true,
      },
      {
        type: "line",
        name: t("dashboard.economicAlert.pmi.threshold"),
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
        name: t("dashboard.economicAlert.yield.spread"),
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
    legend: { data: [t("dashboard.economicAlert.us.cpi"), t("dashboard.economicAlert.us.ppi")] },
    xAxis: { type: "time" },
    yAxis: { type: "value", axisLabel: { formatter: "{value}%" } },
    series: [
      {
        name: t("dashboard.economicAlert.us.cpi"),
        type: "line",
        smooth: true,
        data: getSortedValues(usCpiSeries).map((point) => [
          point.timestamp,
          point.value,
        ]),
      },
      {
        name: t("dashboard.economicAlert.us.ppi"),
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
    legend: {
      data: [
        t("dashboard.economicAlert.us.manufacturingPmi"),
        t("dashboard.economicAlert.us.servicesPmi"),
      ],
    },
    xAxis: { type: "time" },
    yAxis: { type: "value", min: 40, max: 65 },
    series: [
      {
        name: t("dashboard.economicAlert.us.manufacturingPmi"),
        type: "line",
        smooth: true,
        data: getSortedValues(usManufacturingPmiSeries).map((point) => [
          point.timestamp,
          point.value,
        ]),
      },
      {
        name: t("dashboard.economicAlert.us.servicesPmi"),
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
        <Typography.Title level={4}>{t("dashboard.economicAlert.title")}</Typography.Title>
        <TimeRangeControls />
      </div>
      {error ? (
        <Alert
          type="error"
          message={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={error.message}
          showIcon
          action={
            <Button size="small" onClick={() => refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : null}
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
      {!loading && !hasData ? (
        <Empty description={t("dashboard.dataEmpty", { defaultValue: "No data" })} />
      ) : null}
      {alerts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={t("dashboard.economicAlert.triggered")}
          description={alerts.join("、")}
        />
      )}
      {isInitialLoading ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.economicAlert.cards.cpiPpiGauge")} className="content-card">
                {gaugeOption ? (
                  <DashboardChart option={gaugeOption} height={360} />
                ) : (
                  <Empty description={t("dashboard.economicAlert.emptyCpiPpi")} />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.economicAlert.cards.pmiCompare")} className="content-card">
                {getSortedValues(chinaPmiSeries).length > 0 ? (
                  <DashboardChart option={pmiOption} height={360} />
                ) : (
                  <Empty description={t("dashboard.economicAlert.emptyPmi")} />
                )}
              </Card>
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <Card title={t("dashboard.economicAlert.cards.yieldInversion")} className="content-card">
                {spreadSeries.length > 0 ? (
                  <DashboardChart option={yieldOption} height={360} />
                ) : (
                  <Empty description={t("dashboard.economicAlert.emptyYield")} />
                )}
              </Card>
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.economicAlert.cards.usInflation")} className="content-card">
                {getSortedValues(usCpiSeries).length > 0 ? (
                  <DashboardChart option={usInflationOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.economicAlert.emptyUsInflation")} />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.economicAlert.cards.usPmiCompare")} className="content-card">
                {getSortedValues(usManufacturingPmiSeries).length > 0 ? (
                  <DashboardChart option={usPmiCompareOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.economicAlert.emptyUsPmi")} />
                )}
              </Card>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
