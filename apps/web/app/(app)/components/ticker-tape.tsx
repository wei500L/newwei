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
      buildItem(t("dashboard.hero.marketSentiment", { defaultValue: "Market Sentiment" }), data.market),
      buildItem(t("dashboard.hero.globalConflictIndex", { defaultValue: "Conflict Index" }), data.conflict),
      buildItem(t("dashboard.hero.resourceScarcity", { defaultValue: "Resource Scarcity" }), data.resource),
      buildItem(t("dashboard.hero.supplyChain", { defaultValue: "Supply Stability" }), data.supply)
    ];
    return resolved.filter(
      (item): item is { label: string; value: number; trend: number; unit: string | null } => Boolean(item)
    );
  }, [data, t]);

  if (items.length === 0) {
    const message =
      accessState.kind === "forbidden"
        ? t("dashboard.ticker.permissionRequired", {
            defaultValue: "Economic metrics require economicdata.read",
          })
        : loading
          ? t("dashboard.ticker.loading", { defaultValue: "Loading metrics..." })
          : error
            ? t("dashboard.ticker.unavailable", { defaultValue: "Metrics unavailable" })
            : t("dashboard.ticker.empty", { defaultValue: "No metrics yet" });
    const errorMessage = error ? (error instanceof Error ? error.message : String(error)) : null;
    const titleParts = [`Range ${range}`, windowLabel];
    if (accessState.kind === "forbidden") {
      titleParts.unshift(t("common.accessDenied", { defaultValue: "Access denied" }));
    } else if (hasData) {
      titleParts.unshift(bucketTitle);
    }

    return (
      <div
        className="w-full bg-white/85 border-b border-[var(--border)] h-8 flex items-center overflow-hidden relative select-none"
        title={titleParts.join(" · ")}
      >
        <div className="absolute left-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-r from-white to-transparent" />
        <div className="absolute right-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-l from-white to-transparent" />
        <div className="flex items-center gap-2 px-8 text-xs">
          {loading ? <LoadingOutlined className="text-slate-400" aria-hidden /> : null}
          <span
            className={error ? "text-red-600" : "text-slate-500"}
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
      className="w-full bg-white/85 border-b border-[var(--border)] h-8 flex items-center overflow-hidden relative select-none"
      title={`${bucketTitle} · Range ${range} · ${windowLabel}`}
    >
       <div className="absolute left-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-r from-white to-transparent" />
       <div className="absolute right-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-l from-white to-transparent" />

       <div className="animate-ticker flex whitespace-nowrap items-center gap-8 pl-8">
          {[...items, ...items, ...items].map((item, i) => (
             <div key={`${item?.label ?? "metric"}-${i}`} className="flex items-center gap-2 text-xs">
                <span className="text-slate-500 font-semibold">{item.label}</span>
                <span className="text-slate-700">
                  {typeof item.value === "number" ? item.value.toFixed(2) : "--"}
                  {item.unit ? <span className="text-slate-400 ml-1">{item.unit}</span> : null}
                </span>
                <span className={`${item.trend > 0 ? 'text-[var(--bullish)]' : item.trend < 0 ? 'text-[var(--bearish)]' : 'text-slate-400'} flex items-center`}>
                   {item.trend > 0 ? <ArrowUpOutlined style={{fontSize: 10}}/> : item.trend < 0 ? <ArrowDownOutlined style={{fontSize: 10}}/> : null}
                   <span className="ml-1">{Math.abs(item.trend).toFixed(2)}%</span>
                </span>
             </div>
          ))}
       </div>
    </div>
  );
}
