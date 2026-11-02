"use client";

import { ArrowDownOutlined, ArrowUpOutlined, LoadingOutlined } from "@ant-design/icons";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { formatDashboardWindowLabel } from "@/lib/dashboard-time";
import { resolveEconomicUnit } from "@/lib/economic-units";
import { useHeroMetrics } from "@/lib/hero-metrics";
import {
  formatGranularityLabel,
  pickCoarsestGranularity,
  timeGranularityToUiGranularity,
} from "@/lib/time-granularity";
import { useDashboardRangeStore } from "@/store/time-range";

interface MetricPoint {
  value: number;
  unit?: string | null;
  dataType?: string | null;
  item?: { defaultUnit?: string | null } | null;
}

type MetricSeries = readonly MetricPoint[];

export function TickerTape() {
  const { t } = useTranslation();
  const { range, start, end } = useDashboardRangeStore();
  const windowLabel = formatDashboardWindowLabel(start, end);

  const {
    accessState,
    data,
    error,
    hasData,
    loading,
  } = useHeroMetrics({ start, end });

  const inferredGranularity = useMemo(() => {
    const effective = [
      ...(data?.market ?? []),
      ...(data?.conflict ?? []),
      ...(data?.resource ?? []),
      ...(data?.supply ?? []),
    ].map((point) => timeGranularityToUiGranularity(point.effectiveGranularity));
    return pickCoarsestGranularity(effective);
  }, [data]);

  const bucketLabelText = formatGranularityLabel(inferredGranularity);
  const bucketTitle = `${bucketLabelText} buckets`;

  const items = useMemo(() => {
    if (!data) return [];

    const getTrend = (series: MetricSeries) => {
      const curr = series.at(-1)?.value;
      const prev = series.at(-2)?.value;
      if (curr == null || prev == null) return 0;
      return prev !== 0 ? ((curr - prev) / prev) * 100 : 0;
    };

    const buildItem = (label: string, series: MetricSeries | null | undefined) => {
      if (!series || series.length === 0) return null;
      const last = series.at(-1);
      if (!last) return null;
      const unit = resolveEconomicUnit({
        unit: last.unit ?? null,
        defaultUnit: last.item?.defaultUnit ?? null,
        dataType: last.dataType ?? null,
      });
      return {
        label,
        value: last.value,
        trend: getTrend(series),
        unit
      };
    };

    const resolved = [
      buildItem(t("dashboard.hero.marketSentiment"), data.market),
      buildItem(t("dashboard.hero.globalConflictIndex"), data.conflict),
      buildItem(t("dashboard.hero.resourceScarcity"), data.resource),
      buildItem(t("dashboard.hero.supplyChain"), data.supply)
    ];
    return resolved.filter(
      (item): item is { label: string; value: number; trend: number; unit: string | null } => Boolean(item)
    );
  }, [data, t]);

  if (items.length === 0) {
    const message =
      accessState.kind === "forbidden"
        ? t("dashboard.ticker.permissionRequired")
        : loading
          ? t("dashboard.ticker.loading")
          : error
            ? t("dashboard.ticker.unavailable")
            : t("dashboard.ticker.empty");
    const errorMessage = error ? (error instanceof Error ? error.message : String(error)) : null;
    const titleParts = [t("ticker.range", { range }), windowLabel];
    if (accessState.kind === "forbidden") {
      titleParts.unshift(t("common.accessDenied"));
    } else if (hasData) {
      titleParts.unshift(bucketTitle);
    }

    return (
      <div
        className="relative flex h-[var(--ticker-height)] w-full select-none items-center overflow-hidden border-b border-[var(--border)] bg-[var(--ticker-bg)] text-[var(--ticker-fg)]"
        title={titleParts.join(" · ")}
      >
        <div className="absolute left-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-r from-[var(--ticker-bg)] to-transparent" />
        <div className="absolute right-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-l from-[var(--ticker-bg)] to-transparent" />
        <div className="flex items-center gap-2 px-8 text-xs">
          {loading ? <LoadingOutlined className="text-[var(--ticker-muted)]" aria-hidden /> : null}
          <span
            className={error ? "text-[var(--destructive)]" : "text-[var(--ticker-muted)]"}
            title={errorMessage ?? undefined}
          >
            {message}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative flex h-[var(--ticker-height)] w-full select-none items-center overflow-hidden border-b border-[var(--border)] bg-[var(--ticker-bg)] text-[var(--ticker-fg)]"
      title={`${bucketTitle} · ${t("ticker.range", { range })} · ${windowLabel}`}
    >
       <div className="absolute left-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-r from-[var(--ticker-bg)] to-transparent" />
       <div className="absolute right-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-l from-[var(--ticker-bg)] to-transparent" />

       <div className="animate-ticker flex whitespace-nowrap items-center gap-8 pl-8">
          {[...items, ...items, ...items].map((item, i) => (
             <div key={`${item?.label ?? "metric"}-${i}`} className="flex items-center gap-2 text-xs">
                <span className="font-semibold uppercase tracking-wider text-[var(--ticker-muted)] text-[11px]">{item.label}</span>
                <span className="font-mono tabular-nums text-[var(--ticker-fg)]">
                  {typeof item.value === "number" ? item.value.toFixed(2) : "--"}
                  {item.unit ? <span className="text-[var(--ticker-muted)] ml-1">{item.unit}</span> : null}
                </span>
                <span className={`${item.trend > 0 ? 'text-[var(--bullish)]' : item.trend < 0 ? 'text-[var(--bearish)]' : 'text-[var(--ticker-muted)]'} flex items-center`}>
                   {item.trend > 0 ? <ArrowUpOutlined className="text-[10px]"/> : item.trend < 0 ? <ArrowDownOutlined className="text-[10px]"/> : null}
                   <span className="ml-1 font-mono tabular-nums">{Math.abs(item.trend).toFixed(2)}%</span>
                </span>
             </div>
          ))}
       </div>
    </div>
  );
}
