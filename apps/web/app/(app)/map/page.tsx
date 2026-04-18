"use client";

import { Typography } from "antd";
import { useTranslation } from "react-i18next";

import { WarMap } from "@/app/(app)/dashboard/charts/war-map";

import { OnboardingPageVisit } from "../components/onboarding-page-visit";

export default function MapPage() {
  const { t } = useTranslation();

  return (
    <OnboardingPageVisit
      step="map"
      title="Regional signals map"
      description="Use the map when location matters more than chronology. It is the quickest route from a headline cluster to a geographic pattern."
    >
      <div className="flex flex-col gap-4 pb-6 sm:gap-6">
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
        <div className="glass-panel border border-[var(--border)] flex flex-col gap-4 overflow-hidden p-4 sm:p-5">
          <Typography.Text className="text-sm text-slate-600 sm:text-base">
            {t("pages.map.overlay", {
              defaultValue: "Signals, News & Flights",
            })}
          </Typography.Text>
          <WarMap className="min-h-0 w-full" layoutVariant="standalone" />
        </div>
      </div>
    </OnboardingPageVisit>
  );
}
