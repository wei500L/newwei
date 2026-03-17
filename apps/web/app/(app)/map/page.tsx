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
              "Alerts, geo-tagged news, and OpenSky flight activity by region.",
          })}
        </Typography.Text>
      </div>
      <div className="glass-panel border border-[var(--border)] h-[600px] overflow-hidden flex flex-col">
        <div className="px-5 pt-4">
          <Typography.Text className="text-slate-600">
            {t("pages.map.overlay", {
              defaultValue: "Signals, News & Flights",
            })}
          </Typography.Text>
        </div>
        <div className="min-h-0 flex-1">
          <WarMap className="h-full" />
        </div>
      </div>
    </div>
  );
}
