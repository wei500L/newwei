"use client";

import { ArrowDownOutlined, ArrowUpOutlined, MinusOutlined, SoundOutlined } from "@ant-design/icons";
import { Card, Col, Row, Skeleton, Tag, Typography } from "antd";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

interface DataPoint {
  timestamp: string;
  value: number;
}

interface MarketPulseProps {
  loading: boolean;
  conflictData?: DataPoint[];
  marketData?: DataPoint[];
  resourceData?: DataPoint[];
  supplyData?: DataPoint[];
  onMetricClick?: (key: string) => void;
}

const processSeries = (data: DataPoint[] | undefined) => {
  if (!data || data.length === 0) {
    return { value: 0, trend: 0, history: [] };
  }
  const history = data.map(d => d.value);
  const current = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : current;
  const trend = previous !== 0 ? ((current - previous) / previous) * 100 : 0;
  return { value: current, trend, history };
};

const MetricCard = ({ 
  title, 
  value, 
  trend, 
  suffix = "", 
  color, 
  onClick 
}: { 
  title: string; 
  value: number | string; 
  trend: number; 
  suffix?: string; 
  color: string;
  onClick?: () => void;
}) => (
  <div 
    className="bg-gray-900 text-white p-4 rounded-xl cursor-pointer hover:bg-gray-800 transition-colors border border-gray-700"
    onClick={onClick}
  >
    <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">{title}</div>
    <div className="flex items-baseline gap-2">
      <span className="text-2xl font-bold" style={{ color }}>
         {typeof value === 'number' ? value.toFixed(1) : value}{suffix}
      </span>
      <div className={`text-xs ${trend > 0 ? "text-red-400" : trend < 0 ? "text-green-400" : "text-gray-400"}`}>
        {trend > 0 ? <ArrowUpOutlined /> : trend < 0 ? <ArrowDownOutlined /> : <MinusOutlined />}
        <span className="ml-1">{Math.abs(trend).toFixed(1)}%</span>
      </div>
    </div>
  </div>
);

export function MarketPulse({ 
  loading, 
  conflictData, 
  marketData, 
  resourceData, 
  supplyData, 
  onMetricClick 
}: MarketPulseProps) {
  const { t } = useTranslation();

  const metrics = useMemo(() => {
    const conflict = processSeries(conflictData);
    const market = processSeries(marketData);
    const resource = processSeries(resourceData);
    const supply = processSeries(supplyData);

    // Determine "Defcon" level based on conflict index (mock logic)
    // Assuming conflict index 0-100.
    let defcon = 5;
    if (conflict.value > 80) defcon = 1;
    else if (conflict.value > 60) defcon = 2;
    else if (conflict.value > 40) defcon = 3;
    else if (conflict.value > 20) defcon = 4;

    return {
      conflict,
      market,
      resource,
      supply,
      defcon
    };
  }, [conflictData, marketData, resourceData, supplyData]);

  if (loading) {
    return <Skeleton active />;
  }

  const defconColors: Record<number, string> = {
    1: "#ff4d4f", // Red
    2: "#fa8c16", // Orange
    3: "#fadb14", // Yellow
    4: "#52c41a", // Green
    5: "#1890ff", // Blue
  };

  return (
    <div className="w-full space-y-4">
      {/* Top Bar with Ticker and Defcon */}
      <div className="flex flex-col md:flex-row gap-4">
        {/* DEFCON Status */}
        <div className="flex-shrink-0 bg-black text-white px-6 py-3 rounded-xl flex items-center justify-center border-l-4" style={{ borderLeftColor: defconColors[metrics.defcon] }}>
          <div className="text-center">
            <div className="text-[10px] uppercase tracking-[0.2em] text-gray-400">Threat Level</div>
            <div className="text-3xl font-black tracking-widest" style={{ color: defconColors[metrics.defcon] }}>
              DEFCON {metrics.defcon}
            </div>
          </div>
        </div>

        {/* Ticker */}
        <div className="flex-grow bg-gray-900 rounded-xl overflow-hidden relative flex items-center px-4 border border-gray-800">
           <div className="absolute left-0 top-0 bottom-0 w-10 bg-gradient-to-r from-gray-900 to-transparent z-10" />
           <div className="absolute right-0 top-0 bottom-0 w-10 bg-gradient-to-l from-gray-900 to-transparent z-10" />
           <div className="flex whitespace-nowrap animate-marquee items-center text-sm font-mono text-green-400">
             <SoundOutlined className="mr-2" />
             <span className="mx-4">MARKET PULSE: Oil Prices Stabilize after slight dip...</span>
             <span className="mx-4 text-gray-500">|</span>
             <span className="mx-4">Tech Sector sees 2% growth in pre-market...</span>
             <span className="mx-4 text-gray-500">|</span>
             <span className="mx-4">Global Supply Chain Index shows improvement...</span>
             <span className="mx-4 text-gray-500">|</span>
             <span className="mx-4">New Trade Agreements signed in Asia-Pacific region...</span>
           </div>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
         <MetricCard 
           title={t("dashboard.hero.globalConflictIndex", "Conflict Idx")}
           value={metrics.conflict.value}
           trend={metrics.conflict.trend}
           color={metrics.conflict.value > 50 ? "#ff4d4f" : "#fff"}
           onClick={() => onMetricClick?.("global-conflict-index")}
         />
         <MetricCard 
           title={t("dashboard.hero.marketSentiment", "Sentiment")}
           value={metrics.market.value}
           trend={metrics.market.trend}
           color="#faad14"
           onClick={() => onMetricClick?.("market-sentiment")}
         />
         <MetricCard 
           title={t("dashboard.hero.resourceScarcity", "Res. Scarcity")}
           value={metrics.resource.value}
           trend={metrics.resource.trend}
           color="#13c2c2"
           onClick={() => onMetricClick?.("resource-scarcity")}
         />
         <MetricCard 
           title={t("dashboard.hero.supplyChain", "Supply Chain")}
           value={metrics.supply.value}
           trend={metrics.supply.trend}
           suffix="%"
           color="#52c41a"
           onClick={() => onMetricClick?.("supply-chain-stability")}
         />
      </div>

      <style jsx global>{`
        @keyframes marquee {
          0% { transform: translateX(100%); }
          100% { transform: translateX(-100%); }
        }
        .animate-marquee {
          animation: marquee 30s linear infinite;
        }
        .animate-marquee:hover {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  );
}
