"use client";

import { Tooltip } from "antd";

import { useQueueStatsQuery } from "@/graphql/generated";

export function SystemDefcon() {
  const { data } = useQueueStatsQuery({
    pollInterval: 10000
  });

  const stats = data?.queueStats;
  const activeJobs = stats?.counts?.active ?? 0;
  const failedJobs = stats?.counts?.failed ?? 0;
  
  // Calculate health based on failed vs active ratio
  const healthLevel = failedJobs > 5 ? 'critical' : activeJobs > 50 ? 'warning' : 'healthy';

  const getStatusColor = (level: string) => {
    switch (level) {
      case 'critical': return 'bg-red-500';
      case 'warning': return 'bg-amber-500';
      default: return 'bg-emerald-500';
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 border-l border-[var(--border)] h-8">
      <Tooltip title={`System status: ${healthLevel.toUpperCase()} · Active ${activeJobs} · Failed ${failedJobs}`}>
        <div className="flex items-center gap-2 cursor-help">
          <span className="text-[11px] text-slate-500 tracking-wide">System Status</span>
          <div className="flex gap-1">
             {[1, 2, 3].map(i => (
                <div 
                  key={i} 
                  className={`w-1.5 h-1.5 rounded-full ${i === 1 || (healthLevel !== 'healthy' && i <= 2) || (healthLevel === 'critical') ? getStatusColor(healthLevel) : 'bg-slate-200'}`} 
                />
             ))}
          </div>
        </div>
      </Tooltip>
    </div>
  );
}
