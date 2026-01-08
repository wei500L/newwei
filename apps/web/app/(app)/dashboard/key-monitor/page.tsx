"use client";

import { Col, Row, Skeleton, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { ChartDataMeta } from "@/components/chart-data-meta";
import { ChartStateBanner } from "@/components/chart-state-banner";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useEconomicData } from "@/hooks/useEconomicData";
import { resolveLocale } from "@/lib/i18n";

import { CandlestickCard } from "../components/candlestick-card";
import { EconomicChartCard } from "../components/economic-chart-card";

export default function KeyMonitorPage() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const {
    loading,
    seriesMap,
    error,
    refetch,
    hasData,
    latestTimestamp,
    delayMs,
    expectedIntervalMs,
    chartState
  } = useEconomicData({
    category: "key-monitor",
    pollInterval: 30_000,
  });
  const isInitialLoading = loading && !hasData;
  const goldSeries = seriesMap.get("gold_futures_main");
  const oilSeries = seriesMap.get("crude_oil_futures_main");
  const copperSeries = seriesMap.get("copper_futures_main");
  const chartMeta = (
    <ChartDataMeta
      state={chartState}
      latestTimestamp={latestTimestamp}
      locale={locale}
      onRefresh={() => refetch()}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>{t("dashboard.keyMonitor.title")}</Typography.Title>
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
            <Col xs={24} lg={8}>
              <CandlestickCard title={t("dashboard.keyMonitor.cards.gold")} group={goldSeries} meta={chartMeta} />
            </Col>
            <Col xs={24} lg={8}>
              <CandlestickCard title={t("dashboard.keyMonitor.cards.oil")} group={oilSeries} meta={chartMeta} />
            </Col>
            <Col xs={24} lg={8}>
              <CandlestickCard title={t("dashboard.keyMonitor.cards.copper")} group={copperSeries} meta={chartMeta} />
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <EconomicChartCard
                title={t("dashboard.keyMonitor.cards.shanghaiVsSp500.title")}
                description={t("dashboard.keyMonitor.cards.shanghaiVsSp500.description")}
                seriesMap={seriesMap}
                meta={chartMeta}
                series={[
                  {
                    slug: "shanghai_composite_index",
                    label: t("dashboard.keyMonitor.series.shanghaiComposite"),
                    field: "close",
                  },
                  { slug: "sp500_index", label: t("dashboard.keyMonitor.series.sp500"), field: "close" },
                ]}
              />
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <EconomicChartCard
                title={t("dashboard.keyMonitor.cards.fxMid.title")}
                description={t("dashboard.keyMonitor.cards.fxMid.description")}
                seriesMap={seriesMap}
                meta={chartMeta}
                series={[
                  { slug: "china_fx_mid_rates", label: t("dashboard.keyMonitor.series.usd"), field: "美元" },
                  { slug: "china_fx_mid_rates", label: t("dashboard.keyMonitor.series.eur"), field: "欧元" },
                  { slug: "china_fx_mid_rates", label: t("dashboard.keyMonitor.series.jpy"), field: "日元" },
                ]}
              />
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <EconomicChartCard
                title={t("dashboard.keyMonitor.cards.cnyFx.title")}
                description={t("dashboard.keyMonitor.cards.cnyFx.description")}
                seriesMap={seriesMap}
                meta={chartMeta}
                series={[
                  { slug: "usd_cny_spot", label: t("dashboard.keyMonitor.series.usdCny") },
                  { slug: "eur_cny_spot", label: t("dashboard.keyMonitor.series.eurCny") },
                ]}
              />
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
