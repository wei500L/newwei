"use client";

import { Typography } from "antd";
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

  return (
    <div className="space-y-6 pb-10">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {dayjs().format("dddd, MMMM D")}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t("pages.today.subtitle", { defaultValue: "Your daily intelligence briefing." })}
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
            <Typography.Title level={5}>{t("pages.today.latestFeed", { defaultValue: "Latest Feed" })}</Typography.Title>
            <div className="flex-1 overflow-y-auto rail-scrollbar">
              <ItemsView
                initialView="feed"
                emptyStateVariant="today"
                sortMode="publishedDesc"
                experiencePreset="reader"
                density="compact"
                initialFilters={{
                  dateRange: [dayjs().startOf("day"), dayjs().endOf("day")]
                }}
              />
            </div>
          </AuraBentoCard>
        </div>
      </div>
    </div>
  );
}
