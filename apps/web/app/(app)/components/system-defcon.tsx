"use client";

import { useQueueStatsQuery } from "@/graphql/generated";
import { Tooltip } from "antd";

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
      case 'critical': return 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)]';
      case 'warning': return 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.8)]';
      default: return 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]';
    }
  };

  return (
    <div className="flex items-center gap-4 px-4 border-l border-white/10 h-8">
      <Tooltip title={`System Status: ${healthLevel.toUpperCase()} - Active: ${activeJobs}, Failed: ${failedJobs}`}>
        <div className="flex items-center gap-2 cursor-help">
          <span className="text-[10px] font-mono text-gray-500 tracking-wider">SYS.DEFCON</span>
          <div className="flex gap-1">
             {[1, 2, 3].map(i => (
                <div 
                  key={i} 
                  className={`w-1.5 h-1.5 rounded-full ${i === 1 || (healthLevel !== 'healthy' && i <= 2) || (healthLevel === 'critical') ? getStatusColor(healthLevel) : 'bg-gray-800'}`} 
                />
             ))}
          </div>
        </div>
      </Tooltip>
    </div>
  );
}
