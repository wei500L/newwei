"use client";

import {
  Card,
  Col,
  Empty,
  Row,
  Skeleton,
  Select,
  Typography,
} from "antd";
import type { CallbackDataParams } from "echarts/types/dist/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartDataMeta } from "@/components/chart-data-meta";
import { ChartStateBanner } from "@/components/chart-state-banner";
import { DashboardChart } from "@/components/echart";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useEconomicData } from "@/hooks/useEconomicData";
import { resolveLocale } from "@/lib/i18n";

import { CandlestickCard } from "../components/candlestick-card";
import {
  calculatePercentChange,
  filterValuesByDays,
  getSeriesField,
} from "../utils/series";
import {
  formatAxisLabelMultiline,
  resolveEconomicSeriesLabel,
} from "../utils/economic-series-labels";

const indexTabs = [
  { key: "shanghai_composite_index" },
  { key: "csi300_index" },
  { key: "sz_component_index" },
  { key: "csi1000_index" },
];

const fxPairs = [
  { slug: "usd_cny_spot" },
  { slug: "eur_cny_spot" },
];

const heatmapBuckets = [
  {
    labelKey: "dashboard.economicShort.heatmap.buckets.1d",
    period: 1,
    fallback: { "en-US": "1D", "zh-CN": "1日" },
  },
  {
    labelKey: "dashboard.economicShort.heatmap.buckets.3d",
    period: 3,
    fallback: { "en-US": "3D", "zh-CN": "3日" },
  },
  {
    labelKey: "dashboard.economicShort.heatmap.buckets.7d",
    period: 7,
    fallback: { "en-US": "7D", "zh-CN": "7日" },
  },
];

export default function EconomicShortPage() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.language);
  const {
    loading,
    seriesMap,
    error,
    refetch,
    refreshing,
    hasData,
    latestTimestamp,
    appliedGranularity,
    appliedGranularityRange,
    delayMs,
    expectedIntervalMs,
    chartState
  } = useEconomicData({
    category: "economic-short",
    pollInterval: 60_000,
  });
  const [activeIndex, setActiveIndex] = useState(indexTabs[0]?.key ?? "growth");
  const isInitialLoading = loading && !hasData;
  const chartMeta = (
    <ChartDataMeta
      state={chartState}
      latestTimestamp={latestTimestamp}
      locale={locale}
      refreshing={refreshing}
      onRefresh={() => refetch()}
    />
  );

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
  const resolveSeriesLabel = (slug: string) =>
    resolveEconomicSeriesLabel({ slug, locale, t, seriesMap });
  const activeIndexLabel = resolveSeriesLabel(activeIndex);
  const indexOptions = indexTabs.map((tab) => ({
    value: tab.key,
    label: resolveSeriesLabel(tab.key),
  }));

  const localizedPairs = fxPairs.map((pair) => ({
    ...pair,
    label: resolveSeriesLabel(pair.slug),
  }));
  const localizedBuckets = heatmapBuckets.map((bucket) => ({
    ...bucket,
    label: t(bucket.labelKey, { defaultValue: bucket.fallback[locale] }),
  }));
  const heatmapTooltipDefault =
    locale === "zh-CN"
      ? "{{pair}} · {{period}} 变动 {{value}}"
      : "{{pair}} · {{period}} change {{value}}";
  const heatmapXAxisLabelWidth = locale === "zh-CN" ? 84 : 124;
  const heatmapXAxisCharsPerLine = locale === "zh-CN" ? 7 : 12;

  const heatmapOption = {
    grid: {
      left: 24,
      right: 16,
      top: 24,
      bottom: 64,
      containLabel: true,
    },
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
          defaultValue: heatmapTooltipDefault,
          period: bucket.label,
          pair: pair.label,
          value: formattedScore,
        });
      },
    },
    xAxis: {
      type: "category",
      data: localizedPairs.map((pair) => pair.label),
      axisLabel: {
        interval: 0,
        width: heatmapXAxisLabelWidth,
        overflow: "truncate",
        lineHeight: 16,
        formatter: (value: string) =>
          formatAxisLabelMultiline(String(value), heatmapXAxisCharsPerLine, 2),
      },
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
        name: resolveSeriesLabel("bitcoin_spot_price"),
        smooth: true,
        data: btcValues.map((entry) => [entry.timestamp, entry.value]),
      },
    ],
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={4}>{t("dashboard.economicShort.title")}</Typography.Title>
        <TimeRangeControls
          loading={loading}
          appliedGranularity={appliedGranularity}
          appliedGranularityRange={appliedGranularityRange}
        />
      </div>
      <ChartStateBanner
        state={chartState}
        hasData={hasData}
        error={error}
        latestTimestamp={latestTimestamp}
        delayMs={delayMs}
        expectedIntervalMs={expectedIntervalMs}
        locale={locale}
        refreshing={refreshing}
        onRetry={() => refetch()}
      />
      {isInitialLoading ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <Card
                className="content-card"
                title={t("dashboard.economicShort.cards.indexCandlestick")}
                extra={chartMeta}
              >
                <div style={{ marginBottom: 12 }}>
                  <Select
                    value={activeIndex}
                    onChange={setActiveIndex}
                    options={indexOptions}
                    popupMatchSelectWidth={false}
                    style={{ width: "100%", maxWidth: 360 }}
                    optionFilterProp="label"
                    showSearch
                  />
                </div>
                <CandlestickCard
                  title={activeIndexLabel}
                  group={seriesMap[activeIndex]}
                />
              </Card>
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card
                title={t("dashboard.economicShort.cards.fxHeatmap")}
                className="content-card"
                extra={chartMeta}
              >
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
              <Card
                title={t("dashboard.economicShort.cards.cryptoPrices")}
                className="content-card"
                extra={chartMeta}
              >
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
