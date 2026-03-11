"use client";

import { Card, Skeleton, Typography } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { FinancialCandlestick } from "@/app/(app)/dashboard/charts/financial-candlestick";
import { SectorHeatmap } from "@/app/(app)/dashboard/charts/sector-heatmap";
import { MarketPulse } from "@/app/(app)/dashboard/components/market-pulse";
import { MetricDrillDown } from "@/app/(app)/dashboard/metric-drilldown";
import { ChartEmptyState } from "@/components/chart-empty-state";
import { RequestErrorBanner } from "@/components/request-error-banner";
import { TimeRangeControls } from "@/components/time-range-controls";
import { useHeroMetrics } from "@/lib/hero-metrics";
import { useDashboardRangeStore } from "@/store/time-range";

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

      {heroAccessState.kind === "forbidden" ? (
        <ChartEmptyState
          className="h-auto"
          variant="permission"
          title={t("common.accessDenied", { defaultValue: "Access denied" })}
          description={t("finance.market.permissionRequired", {
            defaultValue:
              "Market overview hero metrics require the economicdata.read permission.",
          })}
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
