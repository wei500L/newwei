"use client";

import { ArrowDownOutlined, ArrowUpOutlined, LoadingOutlined } from "@ant-design/icons";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useDashboardHeroMetricsQuery } from "@/graphql/generated";
import dayjs from "@/lib/dayjs";

interface MetricPoint {
  value: number;
}

type MetricSeries = readonly MetricPoint[];

export function TickerTape() {
  const { t } = useTranslation();
  const heroDateRange = useMemo(() => ({
    start: dayjs.utc().subtract(30, "day").startOf("day").toISOString(),
    end: dayjs.utc().endOf("day").toISOString()
  }), []);

  const { data, loading, error } = useDashboardHeroMetricsQuery({
    variables: heroDateRange,
    pollInterval: 60000,
    fetchPolicy: "cache-and-network"
  });

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
      return {
        label,
        value: last.value,
        trend: getTrend(series)
      };
    };

    const resolved = [
      buildItem("Market Sentiment", data.market),
      buildItem("Conflict Index", data.conflict),
      buildItem("Resource Scarcity", data.resource),
      buildItem("Supply Stability", data.supply)
    ];
    return resolved.filter(
      (item): item is { label: string; value: number; trend: number } => Boolean(item)
    );
  }, [data]);

  if (items.length === 0) {
    const message = loading
      ? t("dashboard.ticker.loading", { defaultValue: "Loading metrics..." })
      : error
        ? t("dashboard.ticker.unavailable", { defaultValue: "Metrics unavailable" })
        : t("dashboard.ticker.empty", { defaultValue: "No metrics yet" });
    const errorMessage = error ? (error instanceof Error ? error.message : String(error)) : null;

    return (
      <div className="w-full bg-white/85 border-b border-[var(--border)] h-8 flex items-center overflow-hidden relative select-none">
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
    <div className="w-full bg-white/85 border-b border-[var(--border)] h-8 flex items-center overflow-hidden relative select-none">
       <div className="absolute left-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-r from-white to-transparent" />
       <div className="absolute right-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-l from-white to-transparent" />

       <div className="animate-ticker flex whitespace-nowrap items-center gap-8 pl-8">
          {[...items, ...items, ...items].map((item, i) => (
             <div key={`${item?.label ?? "metric"}-${i}`} className="flex items-center gap-2 text-xs">
                <span className="text-slate-500 font-semibold">{item.label}</span>
                <span className="text-slate-700">{typeof item.value === 'number' ? item.value.toFixed(2) : '--'}</span>
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
