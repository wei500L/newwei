"use client";

import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/page-header";

export function ItemsPageHeader() {
  const { t } = useTranslation();
  return (
    <PageHeader
      kicker={t("nav.groups.today")}
      title={t("nav.items")}
      description={t("pages.items.subtitle")}
    />
  );
}
