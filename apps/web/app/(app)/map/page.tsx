"use client";

import { Typography } from "antd";
import { useTranslation } from "react-i18next";

import { WarMap } from "@/app/(app)/dashboard/charts/war-map";

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
            defaultValue:
              "Alerts, geo-tagged news, and military ADS-B flight activity by region."
          })}
        </Typography.Text>
      </div>
      <div className="glass-panel border border-[var(--border)] h-[600px] relative overflow-hidden">
        <div className="absolute top-4 left-4 z-10">
          <Typography.Text className="text-slate-600">
            {t("pages.map.overlay", {
              defaultValue: "Signals, News & Military Flights"
            })}
          </Typography.Text>
        </div>
        <WarMap className="h-full" />
      </div>
    </div>
  );
}
