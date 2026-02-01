"use client";

import { Alert, Button, Card, Skeleton, Typography } from "antd";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { FinancialCandlestick } from "@/app/(app)/dashboard/charts/financial-candlestick";
import { SectorHeatmap } from "@/app/(app)/dashboard/charts/sector-heatmap";
import { MarketPulse } from "@/app/(app)/dashboard/components/market-pulse";
import { MetricDrillDown } from "@/app/(app)/dashboard/metric-drilldown";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { TimeRangeControls } from "@/components/time-range-controls";
import { TimeGranularity, useDashboardHeroMetricsQuery } from "@/graphql/generated";
import {
  pickCoarsestGranularity,
  pickFinestGranularity,
  resolveDefaultGranularityForRangePreset,
  timeGranularityToUiGranularity,
  UiTimeGranularity,
} from "@/lib/time-granularity";
import { useDashboardRangeStore } from "@/store/time-range";

export function MarketOverview() {
  const { t } = useTranslation();
  const { range, start, end } = useDashboardRangeStore();
  const [activeMetricKey, setActiveMetricKey] = useState<string | null>(null);
  const defaultGranularity = resolveDefaultGranularityForRangePreset(range, start, end);
  const heroGranularity = useMemo(() => {
    switch (defaultGranularity) {
      case UiTimeGranularity.Year:
        return TimeGranularity.Year;
      case UiTimeGranularity.Quarter:
        return TimeGranularity.Quarter;
      case UiTimeGranularity.Month:
        return TimeGranularity.Month;
      case UiTimeGranularity.Week:
        return TimeGranularity.Week;
      case UiTimeGranularity.Day:
      default:
        return TimeGranularity.Day;
    }
  }, [defaultGranularity]);

  const {
    data: heroData,
    loading: heroLoading,
    error: heroError,
    refetch: refetchHero
  } = useDashboardHeroMetricsQuery({
    variables: {
      start: start.toISOString(),
      end: end.toISOString(),
      granularity: heroGranularity
    },
    fetchPolicy: "cache-and-network"
  });
  const appliedHeroGranularityInfo = useMemo(() => {
    const effective = [
      ...(heroData?.conflict ?? []),
      ...(heroData?.market ?? []),
      ...(heroData?.resource ?? []),
      ...(heroData?.supply ?? []),
    ].map((point) => timeGranularityToUiGranularity(point.effectiveGranularity));
    const coarsest = pickCoarsestGranularity(effective);
    const finest = pickFinestGranularity(effective);
    const range =
      coarsest !== UiTimeGranularity.Unknown &&
      finest !== UiTimeGranularity.Unknown &&
      coarsest !== finest
        ? { finest, coarsest }
        : null;
    return { coarsest, range };
  }, [heroData]);

  const heroSeries = [
    heroData?.conflict ?? [],
    heroData?.market ?? [],
    heroData?.resource ?? [],
    heroData?.supply ?? []
  ];
  const heroHasData = heroSeries.some((series) => series.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("finance.market.overviewTitle", { defaultValue: "Market Overview" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("finance.market.overviewSubtitle", {
            defaultValue: "Track macro and market signals across the selected time range."
          })}
        </Typography.Text>
        <TimeRangeControls
          appliedGranularity={appliedHeroGranularityInfo.coarsest}
          appliedGranularityRange={appliedHeroGranularityInfo.range}
        />
      </div>

      {heroError ? (
        <Alert
          type="error"
          showIcon
          message={t("dashboard.dataAbnormal", { defaultValue: "Data error" })}
          description={heroError.message}
          action={
            <Button size="small" onClick={() => refetchHero()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : null}

      {heroLoading && !heroHasData ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : heroHasData ? (
        <MarketPulse
          loading={heroLoading}
          conflictData={heroData?.conflict ?? []}
          marketData={heroData?.market ?? []}
          resourceData={heroData?.resource ?? []}
          supplyData={heroData?.supply ?? []}
          onMetricClick={setActiveMetricKey}
        />
      ) : (
        <ChartEmptyState
          className="h-auto"
          description={t("dashboard.dataEmpty", { defaultValue: "No data" })}
        />
      )}

      {activeMetricKey ? (
        <MetricDrillDown
          visible
          metricKey={activeMetricKey}
          onClose={() => setActiveMetricKey(null)}
        />
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card
          title={t("finance.market.sectorHeatmap", { defaultValue: "Sector Heatmap" })}
          className="content-card xl:col-span-2"
        >
          <SectorHeatmap />
        </Card>
        <Card
          title={t("finance.market.candlestick", { defaultValue: "Candlestick" })}
          className="content-card"
        >
          <FinancialCandlestick />
        </Card>
      </div>
    </div>
  );
}
