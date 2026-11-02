"use client";

import { Typography } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ItemsView } from "@/app/(app)/items/items-view";
import { AuraBentoCard } from "@/components/aura-bento-card";
import { PageHeader } from "@/components/page-header";
import dayjs from "@/lib/dayjs";

import { BreakingAlerts } from "./components/breaking-alerts";
import { Headlines } from "./components/headlines";
import { HotTopics } from "./components/hot-topics";
import { UserDigestPanel } from "./user-digest-panel";

export function TodayContent() {
  const { t } = useTranslation();
  const [todayLabel, setTodayLabel] = useState<string>("Today");
  const [todayDateRange, setTodayDateRange] = useState<
    [ReturnType<typeof dayjs>, ReturnType<typeof dayjs>] | undefined
  >(undefined);

  useEffect(() => {
    const now = dayjs();
    setTodayLabel(now.format("dddd, MMMM D"));
    setTodayDateRange([now.startOf("day"), now.endOf("day")]);
  }, []);

  return (
    <div className="flex flex-col gap-6 pb-10">
      {/* Header Section */}
      <PageHeader
        kicker={t("nav.groups.today")}
        title={<span suppressHydrationWarning>{todayLabel}</span>}
        description={t("pages.today.subtitle")}
      />

      {/* Bento Grid Layout */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Top: Alerts (Full Width) */}
        <div className="lg:col-span-12">
          <BreakingAlerts />
        </div>

        {/* Left: Headlines + User Digest (7 cols) */}
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-7">
          <Headlines />
          <UserDigestPanel />
        </div>

        {/* Right: Hot Topics + Feed (5 cols) */}
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-5">
          <HotTopics />
          <AuraBentoCard squish={false} className="flex min-h-viz-3xl flex-1 flex-col p-4">
            <Typography.Title level={5}>{t("pages.today.latestFeed")}</Typography.Title>
            <div className="flex-1 overflow-y-auto rail-scrollbar">
              <ItemsView
                surface="none"
                initialView="feed"
                emptyStateVariant="today"
                sortMode="publishedDesc"
                experiencePreset="reader"
                density="compact"
                initialFilters={{
                  dateRange: todayDateRange
                }}
              />
            </div>
          </AuraBentoCard>
        </div>
      </div>
    </div>
  );
}
