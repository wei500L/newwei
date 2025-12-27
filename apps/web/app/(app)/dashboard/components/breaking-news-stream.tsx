"use client";

import { ClockCircleOutlined, ThunderboltFilled } from "@ant-design/icons";
import { Tag, Typography } from "antd";
import { useTranslation } from "react-i18next";

interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  time: string;
  tag: string;
  priority: 'high' | 'medium' | 'low';
}

const MOCK_NEWS: NewsItem[] = [
  {
    id: '1',
    title: 'Suez Canal Blockage Reports Confirmed',
    summary: 'Satellite imagery confirms massive container ship stuck in southern canal section, potential 3-day backlog.',
    source: 'Reuters',
    time: '2m ago',
    tag: 'Logistics',
    priority: 'high'
  },
  {
    id: '2',
    title: 'Fed Signals Rate Cut Possibility',
    summary: 'Chairman Powell hints at 25bps cut in next meeting if inflation data remains stable.',
    source: 'Bloomberg',
    time: '15m ago',
    tag: 'Finance',
    priority: 'high'
  },
  {
    id: '3',
    title: 'New Lithium Deposit Discovered in Chile',
    summary: 'Estimated 500k tons of high-grade ore found in Atacama region.',
    source: 'Mining Weekly',
    time: '42m ago',
    tag: 'Resources',
    priority: 'medium'
  },
  {
    id: '4',
    title: 'OPEC+ Meeting Ends Without Consensus',
    summary: 'Oil output quotas remain unchanged as members fail to agree on cuts.',
    source: 'OilPrice.com',
    time: '1h ago',
    tag: 'Energy',
    priority: 'medium'
  },
];

export function BreakingNewsStream() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col h-full bg-[#1e293b]/50 backdrop-blur-md border border-white/10 rounded-2xl overflow-hidden shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/5">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-500 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-600"></span>
          </span>
          <span className="text-sm font-bold text-white tracking-wide uppercase">
            {t("dashboard.news.title", "Live Wire")}
          </span>
        </div>
        <Tag className="border-0 bg-rose-500/20 text-rose-400 text-[10px] font-mono px-1">LIVE</Tag>
      </div>

      {/* Feed List */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent p-2 space-y-2">
        {MOCK_NEWS.map((item) => (
          <div 
            key={item.id}
            className={`
              relative p-3 rounded-xl border transition-all duration-200 cursor-pointer group
              ${item.priority === 'high' 
                ? 'bg-gradient-to-r from-rose-500/10 to-transparent border-rose-500/20 hover:border-rose-500/40' 
                : 'bg-white/5 border-white/5 hover:border-white/20'
              }
            `}
          >
            <div className="flex justify-between items-start mb-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-blue-400">{item.source}</span>
                <span className="text-[10px] text-gray-500 flex items-center gap-1">
                  <ClockCircleOutlined /> {item.time}
                </span>
              </div>
              {item.priority === 'high' && (
                <ThunderboltFilled className="text-rose-500 animate-pulse text-xs" />
              )}
            </div>
            
            <h4 className="text-sm font-semibold text-gray-200 mb-1 group-hover:text-white transition-colors">
              {item.title}
            </h4>
            
            <p className="text-xs text-gray-500 leading-relaxed font-mono">
              <span className="text-emerald-500 font-bold mr-1">AI:</span>
              {item.summary}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
