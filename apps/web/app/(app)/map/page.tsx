"use client";

import { Typography } from "antd";
import { useTranslation } from "react-i18next";

import { WarMap } from "@/app/(app)/dashboard/charts/war-map";
import { TimeRangeControls } from "@/components/time-range-controls";

export default function MapPage() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.map.title", { defaultValue: "Regional Signals Map" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.map.subtitle", {
            defaultValue: "Alerts and geo-tagged news signals by region."
          })}
        </Typography.Text>
        <TimeRangeControls />
      </div>
      <div className="glass-panel border border-[var(--border)] h-[600px] relative overflow-hidden">
        <div className="absolute top-4 left-4 z-10">
          <Typography.Text className="text-slate-600">
            {t("pages.map.overlay", { defaultValue: "Alert & News Signals Overview" })}
          </Typography.Text>
        </div>
        <WarMap className="h-full" />
      </div>
    </div>
  );
}
