"use client";

import { Skeleton, Typography } from "antd";
import dynamic from "next/dynamic";
import { useTranslation } from "react-i18next";

import { OnboardingPageVisit } from "../components/onboarding-page-visit";

import { GeocodeLookupCard } from "./geocode-lookup-card";

const WarMap = dynamic(
  () => import("@/app/(app)/dashboard/charts/war-map").then((mod) => mod.WarMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-[560px] w-full items-center justify-center">
        <Skeleton active paragraph={{ rows: 8 }} className="w-full" />
      </div>
    ),
  },
);

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
            {t("pages.map.title")}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t("pages.map.subtitle")}
          </Typography.Text>
        </div>
        <GeocodeLookupCard />
        <div className="glass-panel border border-[var(--border)] flex flex-col gap-4 overflow-hidden p-4 sm:p-5">
          <Typography.Text className="text-sm text-slate-600 sm:text-base">
            {t("pages.map.overlay")}
          </Typography.Text>
          <WarMap className="min-h-0 w-full" layoutVariant="standalone" />
        </div>
      </div>
    </OnboardingPageVisit>
  );
}
