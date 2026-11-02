"use client";

import { Card, Skeleton } from "antd";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { PageHeader } from "@/components/page-header";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useHeroMetrics } from "@/lib/hero-metrics";
import { useDashboardRangeStore } from "@/store/time-range";

const MarketPulse = dynamic(
  () =>
    import("@/app/(app)/dashboard/components/market-pulse").then(
      (mod) => mod.MarketPulse,
    ),
  { loading: () => <Skeleton active paragraph={{ rows: 4 }} /> },
);

const MetricDrillDown = dynamic(
  () =>
    import("@/app/(app)/dashboard/metric-drilldown").then(
      (mod) => mod.MetricDrillDown,
    ),
  {
    ssr: false,
    loading: () => <Skeleton active paragraph={{ rows: 8 }} />,
  },
);

const SectorHeatmap = dynamic(
  () =>
    import("@/app/(app)/dashboard/charts/sector-heatmap").then(
      (mod) => mod.SectorHeatmap,
    ),
  { loading: () => <Skeleton active paragraph={{ rows: 6 }} /> },
);

const FinancialCandlestick = dynamic(
  () =>
    import("@/app/(app)/dashboard/charts/financial-candlestick").then(
      (mod) => mod.FinancialCandlestick,
    ),
  { loading: () => <Skeleton active paragraph={{ rows: 6 }} /> },
);

export function MarketOverview() {
  const { t } = useTranslation();
  const { start, end } = useDashboardRangeStore();
  const [activeMetricKey, setActiveMetricKey] = useState<string | null>(null);
  const {
    data: heroData,
    accessState: heroAccessState,
    error: heroError,
    granularityInfo: appliedHeroGranularityInfo,
    hasData: heroHasData,
    loading: heroLoading,
    refetch: refetchHero
  } = useHeroMetrics({ start, end });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        size="compact"
        kicker={t("nav.groups.situation")}
        title={t("finance.market.overviewTitle")}
        description={t("finance.market.overviewSubtitle")}
      />
      <TimeRangeControls
        appliedGranularity={appliedHeroGranularityInfo.coarsest}
        appliedGranularityRange={appliedHeroGranularityInfo.range}
      />

      {heroAccessState.kind === "forbidden" ? (
        <ChartEmptyState
          className="h-auto"
          variant="permission"
          title={t("common.accessDenied")}
          description={t("finance.market.permissionRequired")}
        />
      ) : heroError && !heroHasData ? (
        <RequestErrorBanner
          presentation="center"
          error={heroError}
          onRetry={() => void refetchHero()}
        />
      ) : null}

      {heroError && heroHasData ? (
        <RequestErrorBanner
          error={heroError}
          onRetry={() => void refetchHero()}
          showCachedDataHint
        />
      ) : null}

      {heroAccessState.kind === "forbidden" ? null : heroLoading && !heroHasData ? (
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
          description={t("dashboard.dataEmpty")}
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
          title={t("finance.market.sectorHeatmap")}
          className="content-card xl:col-span-2"
        >
          <SectorHeatmap />
        </Card>
        <Card
          title={t("finance.market.candlestick")}
          className="content-card"
        >
          <FinancialCandlestick />
        </Card>
      </div>
    </div>
  );
}
