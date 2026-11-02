"use client";

import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/page-header";

export function NewsHubPageHeader() {
  const { t } = useTranslation();
  return (
    <PageHeader
      kicker={t("nav.groups.today")}
      title={t("pages.newsHub.title")}
      description={t("pages.newsHub.subtitle")}
    />
  );
}
