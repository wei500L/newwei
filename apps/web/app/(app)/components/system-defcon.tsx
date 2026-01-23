"use client";

import { Tooltip } from "antd";
import { useSession } from "next-auth/react";

import { useQueueStatsQuery } from "@/graphql/generated";

export function SystemDefcon() {
  const { data: session } = useSession();
  const permissions = session?.permissions ?? session?.user?.permissions ?? [];
  const canManageQueue = permissions.includes("queue.manage");

  const { data, loading, error } = useQueueStatsQuery({
    pollInterval: 10000,
    skip: !canManageQueue
  });

  const stats = canManageQueue ? data?.queueStats ?? null : null;
  const activeJobs = stats?.counts?.active ?? null;
  const failedJobs = stats?.counts?.failed ?? null;
  
  // Calculate health based on failed vs active ratio
  const healthLevel = (() => {
    if (!canManageQueue) {
      return "unauthorized";
    }
    if (!stats) {
      if (loading) return "loading";
      if (error) return "unavailable";
      return "unknown";
    }
    const resolvedActive = activeJobs ?? 0;
    const resolvedFailed = failedJobs ?? 0;
    if (resolvedFailed > 5) return "critical";
    if (resolvedActive > 50) return "warning";
    return "healthy";
  })();

  const getStatusColor = (level: string) => {
    switch (level) {
      case 'critical': return 'bg-red-500';
      case 'warning': return 'bg-amber-500';
      case 'healthy': return 'bg-emerald-500';
      default: return 'bg-slate-400';
    }
  };

  const activeDots =
    healthLevel === "critical" ? 3 : healthLevel === "warning" ? 2 : healthLevel === "healthy" ? 1 : 0;

  const tooltip = (() => {
    if (!canManageQueue) {
      return "System status: UNAUTHORIZED · Requires queue.manage permission.";
    }
    if (!stats) {
      if (healthLevel === "loading") {
        return "System status: LOADING · Waiting for queue stats...";
      }
      if (healthLevel === "unavailable") {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return `System status: UNAVAILABLE · ${errorMessage}`;
      }
      return "System status: UNKNOWN · No queue stats available.";
    }
    return `System status: ${healthLevel.toUpperCase()} · Active ${activeJobs ?? 0} · Failed ${failedJobs ?? 0}`;
  })();

  return (
    <div className="flex items-center gap-3 px-4 border-l border-[var(--border)] h-8">
      <Tooltip title={tooltip}>
        <div className="flex items-center gap-2 cursor-help">
          <span className="text-[11px] text-slate-500 tracking-wide">System Status</span>
          <div className="flex gap-1">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className={`w-1.5 h-1.5 rounded-full ${
                  i <= activeDots ? getStatusColor(healthLevel) : "bg-slate-200"
                }`}
              />
            ))}
          </div>
        </div>
      </Tooltip>
    </div>
  );
}
