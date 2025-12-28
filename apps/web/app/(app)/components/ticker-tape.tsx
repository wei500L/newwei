"use client";

import { useDashboardHeroMetricsQuery } from "@/graphql/generated";
import { useMemo } from "react";
import dayjs from "@/lib/dayjs";
import { ArrowUpOutlined, ArrowDownOutlined } from "@ant-design/icons";

export function TickerTape() {
  const heroDateRange = useMemo(() => ({
    start: dayjs.utc().subtract(30, "day").startOf("day").toISOString(),
    end: dayjs.utc().endOf("day").toISOString()
  }), []);

  const { data } = useDashboardHeroMetricsQuery({
    variables: heroDateRange,
    pollInterval: 60000,
    fetchPolicy: "cache-and-network"
  });

  const items = useMemo(() => {
    if (!data?.market) return [];
    // Process market data into ticker items
    // Assuming market data comes as time series, we take the latest points of different series if available.
    // Since the current API returns a flat list of DataPoints for "market", it might be a single index or mixed.
    // Let's assume for now it's a single aggregate index or we just simulate multiple items from the data trends if possible,
    // OR we use the different categories (market, resource, conflict, supply) as ticker items.
    
    const getTrend = (series: any[]) => {
       if (!series || series.length < 2) return 0;
       const curr = series[series.length - 1].value;
       const prev = series[series.length - 2].value;
       return prev !== 0 ? ((curr - prev) / prev) * 100 : 0;
    };

    return [
      { label: "GLOBAL_MKT", value: data.market?.[data.market.length - 1]?.value, trend: getTrend(data.market ?? []) },
      { label: "CONFLICT_IDX", value: data.conflict?.[data.conflict.length - 1]?.value, trend: getTrend(data.conflict ?? []) },
      { label: "RSRC_SCARCITY", value: data.resource?.[data.resource.length - 1]?.value, trend: getTrend(data.resource ?? []) },
      { label: "SUPPLY_STABILITY", value: data.supply?.[data.supply.length - 1]?.value, trend: getTrend(data.supply ?? []) },
      { label: "OIL_BRENT", value: 82.4, trend: 1.2 }, // Placeholder for realism until real feeds
      { label: "GOLD_XAU", value: 2150.5, trend: 0.5 },
      { label: "BTC_USD", value: 64200, trend: -1.4 },
      { label: "EUR_USD", value: 1.08, trend: -0.1 },
    ];
  }, [data]);

  return (
    <div className="w-full bg-[#030712] border-b border-[var(--border)] h-8 flex items-center overflow-hidden relative select-none">
       {/* Gradient masks for smooth fade */}
       <div className="absolute left-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-r from-[#030712] to-transparent" />
       <div className="absolute right-0 top-0 bottom-0 w-8 z-10 bg-gradient-to-l from-[#030712] to-transparent" />
       
       <div className="animate-ticker flex whitespace-nowrap items-center gap-8 pl-8">
          {[...items, ...items, ...items].map((item, i) => (
             <div key={i} className="flex items-center gap-2 text-xs font-mono">
                <span className="text-gray-500 font-bold">{item.label}</span>
                <span className="text-gray-300">{typeof item.value === 'number' ? item.value.toFixed(2) : '--'}</span>
                <span className={`${item.trend > 0 ? 'text-[var(--bullish)]' : item.trend < 0 ? 'text-[var(--bearish)]' : 'text-gray-500'} flex items-center`}>
                   {item.trend > 0 ? <ArrowUpOutlined style={{fontSize: 10}}/> : item.trend < 0 ? <ArrowDownOutlined style={{fontSize: 10}}/> : null}
                   <span className="ml-1">{Math.abs(item.trend).toFixed(2)}%</span>
                </span>
             </div>
          ))}
       </div>
    </div>
  );
}
