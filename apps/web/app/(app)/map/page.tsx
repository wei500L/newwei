"use client";

import { Typography } from "antd";
import { useTranslation } from "react-i18next";

import { TimeRangeControls } from "@/components/time-range-controls";
import { WarMap } from "@/app/(app)/dashboard/charts/war-map";

export default function MapPage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Typography.Title level={4}>
          {t("pages.map.title", { defaultValue: "Indicator Situation Map" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.map.subtitle", { defaultValue: "Macro indicators by region" })}
        </Typography.Text>
        <TimeRangeControls />
      </div>
      <div className="glass-panel border border-[var(--border)] h-[600px] relative overflow-hidden">
        <div className="absolute top-4 left-4 z-10">
          <Typography.Text className="text-slate-600">
            {t("pages.map.overlay", { defaultValue: "Indicator Situation Overview" })}
          </Typography.Text>
        </div>
        <WarMap />
      </div>
    </div>
  );
}
