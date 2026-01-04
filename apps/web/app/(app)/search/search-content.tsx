"use client";

import { Alert, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";

import { ItemsView } from "@/app/(app)/items/items-view";

export function SearchContent() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <Space direction="vertical" size={2}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t("pages.search.title", { defaultValue: "Search" })}
        </Typography.Title>
        <Typography.Text type="secondary">
          {t("pages.search.subtitle", { defaultValue: "Search across processed items." })}
        </Typography.Text>
      </Space>
      <Alert
        type="info"
        showIcon
        message={t("pages.search.noticeTitle", { defaultValue: "Search scope" })}
        description={t("pages.search.noticeDescription", {
          defaultValue: "Searches titles, summaries, topics, entities, locations, and external IDs."
        })}
      />
      <ItemsView initialView="list" emptyStateVariant="search" />
    </div>
  );
}
