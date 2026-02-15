"use client";

import { Typography } from "antd";
import { useTranslation } from "react-i18next";

import { ItemsView } from "@/app/(app)/items/items-view";
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
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Top: Alerts (Full Width) */}
        <div className="lg:col-span-4">
          <BreakingAlerts />
        </div>

        {/* Left: Headlines + User Digest (2 cols) */}
        <div className="lg:col-span-2 space-y-4">
          <Headlines />
          <UserDigestPanel />
        </div>

        {/* Right: Hot Topics + Feed (2 cols) */}
        <div className="lg:col-span-2 space-y-4 h-full">
          <HotTopics />
          <div className="bg-white/50 dark:bg-black/20 rounded-xl p-4 min-h-[500px]">
            <Typography.Title level={5}>{t("pages.today.latestFeed", { defaultValue: "Latest Feed" })}</Typography.Title>
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
        </div>
      </div>
    </div>
  );
}
