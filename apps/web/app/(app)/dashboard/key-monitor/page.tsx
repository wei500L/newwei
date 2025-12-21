"use client";

import { Alert, Button, Col, Empty, Row, Spin, Typography } from "antd";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useEconomicData } from "@/hooks/useEconomicData";
import { EconomicChartCard } from "../components/economic-chart-card";
import { CandlestickCard } from "../components/candlestick-card";
import { useTranslation } from "react-i18next";

export default function KeyMonitorPage() {
  const { t } = useTranslation();
  const { loading, seriesMap, error, refetch } = useEconomicData({
    category: "key-monitor",
    pollInterval: 30_000,
  });
  const goldSeries = seriesMap.get("gold_futures_main");
  const oilSeries = seriesMap.get("crude_oil_futures_main");
  const copperSeries = seriesMap.get("copper_futures_main");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>{t("dashboard.keyMonitor.title")}</Typography.Title>
        <TimeRangeControls />
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("dashboard.keyMonitor.loadFailed")}
          action={
            <Button size="small" onClick={() => refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : null}
      {!loading && seriesMap.size === 0 ? (
        <Empty description={t("dashboard.keyMonitor.empty")} />
      ) : null}
      {loading && <Spin />}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <CandlestickCard title={t("dashboard.keyMonitor.cards.gold")} group={goldSeries} />
        </Col>
        <Col xs={24} lg={8}>
          <CandlestickCard title={t("dashboard.keyMonitor.cards.oil")} group={oilSeries} />
        </Col>
        <Col xs={24} lg={8}>
          <CandlestickCard title={t("dashboard.keyMonitor.cards.copper")} group={copperSeries} />
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <EconomicChartCard
            title={t("dashboard.keyMonitor.cards.shanghaiVsSp500.title")}
            description={t("dashboard.keyMonitor.cards.shanghaiVsSp500.description")}
            seriesMap={seriesMap}
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
            series={[
              { slug: "usd_cny_spot", label: t("dashboard.keyMonitor.series.usdCny") },
              { slug: "eur_cny_spot", label: t("dashboard.keyMonitor.series.eurCny") },
            ]}
          />
        </Col>
      </Row>
    </div>
  );
}
