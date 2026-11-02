"use client";

import { Skeleton, Typography } from "antd";
import dynamic from "next/dynamic";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/page-header";

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
      <div className="flex flex-col gap-6 pb-6">
        <PageHeader
          kicker={t("nav.groups.situation")}
          title={t("pages.map.title")}
          description={t("pages.map.subtitle")}
        />
        <GeocodeLookupCard />
        <div className="glass-panel border border-[var(--border)] flex flex-col gap-4 overflow-hidden p-4 sm:p-5">
          <Typography.Text className="text-sm text-muted-foreground">
            {t("pages.map.overlay")}
          </Typography.Text>
          <WarMap className="min-h-0 w-full" layoutVariant="standalone" />
        </div>
      </div>
    </OnboardingPageVisit>
  );
}
