"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Skeleton,
  Tabs,
  Typography,
} from "antd";
import type { CallbackDataParams } from "echarts";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DashboardChart } from "@/components/echart";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useEconomicData } from "@/hooks/useEconomicData";
import { formatDateTime, resolveLocale } from "@/lib/i18n";

import { CandlestickCard } from "../components/candlestick-card";
import {
  calculatePercentChange,
  filterValuesByDays,
  getSeriesField,
} from "../utils/series";

const indexTabs = [
  { key: "shanghai_composite_index", labelKey: "dashboard.economicShort.indexes.shanghai" },
  { key: "csi300_index", labelKey: "dashboard.economicShort.indexes.csi300" },
  { key: "sz_component_index", labelKey: "dashboard.economicShort.indexes.szComponent" },
  { key: "csi1000_index", labelKey: "dashboard.economicShort.indexes.csi1000" },
];

const fxPairs = [
  { slug: "usd_cny_spot", labelKey: "dashboard.economicShort.fx.usdCny" },
  { slug: "eur_cny_spot", labelKey: "dashboard.economicShort.fx.eurCny" },
];

const heatmapBuckets = [
  { labelKey: "dashboard.economicShort.heatmap.buckets.1d", period: 1 },
  { labelKey: "dashboard.economicShort.heatmap.buckets.3d", period: 3 },
  { labelKey: "dashboard.economicShort.heatmap.buckets.7d", period: 7 },
];

export default function EconomicShortPage() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const { loading, seriesMap, error, refetch, hasData, latestTimestamp, isDelayed } = useEconomicData({
    category: "economic-short",
    pollInterval: 60_000,
  });
  const [activeIndex, setActiveIndex] = useState(indexTabs[0]?.key ?? "growth");
  const isInitialLoading = loading && !hasData;

  const heatmapData = fxPairs.flatMap((pair, xIndex) =>
    heatmapBuckets.map((bucket, yIndex) => {
      const series = getSeriesField(seriesMap, pair.slug, "最新价");
      const change = calculatePercentChange(series, bucket.period);
      const isValidChange = typeof change === "number" && Number.isFinite(change);
      return [
        xIndex,
        yIndex,
        isValidChange ? Number(change.toFixed(3)) : null,
      ];
    }),
  );

  const localizedPairs = fxPairs.map((pair) => ({
    ...pair,
    label: t(pair.labelKey),
  }));
  const localizedBuckets = heatmapBuckets.map((bucket) => ({
    ...bucket,
    label: t(bucket.labelKey),
  }));

  const heatmapOption = {
    tooltip: {
      position: "top",
      formatter: (params: CallbackDataParams) => {
        const values = Array.isArray(params.value) ? params.value : [];
        const pairIndex = typeof values[0] === "number" ? values[0] : -1;
        const bucketIndex = typeof values[1] === "number" ? values[1] : -1;
        const score = values[2];
        const bucket = localizedBuckets[bucketIndex];
        const pair = localizedPairs[pairIndex];
        if (!bucket || !pair) return "";
        const formattedScore =
          typeof score === "number"
            ? score
            : t("common.notAvailable", { defaultValue: "N/A" });
        return t("dashboard.economicShort.heatmap.tooltip", {
          period: bucket.label,
          pair: pair.label,
          value: formattedScore,
        });
      },
    },
    xAxis: {
      type: "category",
      data: localizedPairs.map((pair) => pair.label),
    },
    yAxis: {
      type: "category",
      data: localizedBuckets.map((bucket) => bucket.label),
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
          formatter: (params: CallbackDataParams) => {
            const values = Array.isArray(params.value) ? params.value : [];
            const score = values[2];
            const numericScore = typeof score === "number" ? score : null;
            return numericScore === null ? "-" : `${numericScore}%`;
          },
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
        name: t("dashboard.economicShort.crypto.btc"),
        smooth: true,
        data: btcValues.map((entry) => [entry.timestamp, entry.value]),
      },
    ],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>{t("dashboard.economicShort.title")}</Typography.Title>
        <TimeRangeControls />
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          message={t("dashboard.economicShort.loadFailed")}
          description={error.message}
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
          message={t("dashboard.dataDelayed", { defaultValue: "Data delayed" })}
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
        <Empty description={t("dashboard.economicShort.empty")} />
      ) : null}
      {isInitialLoading ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <Card className="content-card" title={t("dashboard.economicShort.cards.indexCandlestick")}>
                <Tabs
                  activeKey={activeIndex}
                  onChange={setActiveIndex}
                  items={indexTabs.map((tab) => ({
                    key: tab.key,
                    label: t(tab.labelKey),
                    children: (
                      <CandlestickCard
                        title={t(tab.labelKey)}
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
              <Card title={t("dashboard.economicShort.cards.fxHeatmap")} className="content-card">
                {heatmapData.some(
                  (entry) => typeof entry[2] === "number" && Number.isFinite(entry[2]),
                ) ? (
                  <DashboardChart option={heatmapOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.economicShort.heatmap.empty")} />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title={t("dashboard.economicShort.cards.cryptoPrices")} className="content-card">
                {btcValues.length > 0 ? (
                  <DashboardChart option={cryptoOption} height={320} />
                ) : (
                  <Empty description={t("dashboard.economicShort.crypto.empty")} />
                )}
              </Card>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
