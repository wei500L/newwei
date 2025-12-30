"use client";

import { Typography } from "antd";

import { TimeRangeControls } from "@/components/time-range-controls";
import { WarMap } from "@/app/(app)/dashboard/charts/war-map";

export default function MapPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Typography.Title level={4}>Map Overview</Typography.Title>
        <TimeRangeControls />
      </div>
      <div className="glass-panel border border-[var(--primary)]/20 h-[600px] relative overflow-hidden">
        <div className="absolute top-4 left-4 z-10">
          <Typography.Text className="text-[var(--primary)] uppercase tracking-widest">
            Regional Situation Map
          </Typography.Text>
        </div>
        <WarMap />
      </div>
    </div>
  );
}
