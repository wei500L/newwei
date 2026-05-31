"use client";

import { Typography } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ItemsView } from "@/app/(app)/items/items-view";
import { AuraBentoCard } from "@/components/aura-bento-card";
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
    <div className="space-y-6 pb-10">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }} suppressHydrationWarning>
            {todayLabel}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t("pages.today.subtitle")}
          </Typography.Text>
        </div>
      </div>

      {/* Bento Grid Layout */}
      <div className="aura-bento-grid">
        {/* Top: Alerts (Full Width) */}
        <div className="lg:col-span-4">
          <BreakingAlerts />
        </div>

        {/* Left: Headlines + User Digest (2 cols) */}
        <div className="col-span-2 space-y-4">
          <Headlines />
          <UserDigestPanel />
        </div>

        {/* Right: Hot Topics + Feed (2 cols) */}
        <div className="col-span-2 space-y-4 h-full flex flex-col">
          <HotTopics />
          <AuraBentoCard squish={false} className="p-4 min-h-[500px] flex-1 flex flex-col">
            <Typography.Title level={5}>{t("pages.today.latestFeed")}</Typography.Title>
            <div className="flex-1 overflow-y-auto rail-scrollbar">
              <ItemsView
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
