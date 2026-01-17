"use client";

import { Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { ItemsView } from "@/app/(app)/items/items-view";
import dayjs from "@/lib/dayjs";

import { UserDigestPanel } from "./user-digest-panel";

export function TodayContent() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.today.title", { defaultValue: "Today Brief" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.today.subtitle", {
            defaultValue: "Get a quick read on today’s most important news."
          })}
        </Typography.Text>
      </Space>

      <UserDigestPanel />

      <ItemsView
        initialView="feed"
        emptyStateVariant="today"
        sortMode="publishedDesc"
        initialFilters={{
          dateRange: [dayjs().startOf("day"), dayjs().endOf("day")]
        }}
      />
    </div>
  );
}
