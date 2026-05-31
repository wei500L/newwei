"use client";

import { Tabs } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import KeyMonitorPage from "@/app/(app)/dashboard/key-monitor/page";

import { MarketOverview } from "./market-overview";
import { NewsIndicatorAssociations } from "./news-indicator-associations";

const DEFAULT_TAB = "overview";

export function MarketContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tabs = useMemo(
    () => [
      {
        key: "overview",
        label: t("finance.market.overview"),
        content: <MarketOverview />
      },
      {
        key: "monitor",
        label: t("finance.market.monitor"),
        content: <KeyMonitorPage />
      },
      {
        key: "associations",
        label: t("finance.market.associations"),
        content: <NewsIndicatorAssociations />
      }
    ],
    [t]
  );

  const activeKey = useMemo(() => {
    const candidate = searchParams.get("tab");
    return tabs.some((tab) => tab.key === candidate) ? (candidate as string) : DEFAULT_TAB;
  }, [searchParams, tabs]);

  const handleChange = (key: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (key === DEFAULT_TAB) {
      next.delete("tab");
    } else {
      next.set("tab", key);
    }
    const nextQuery = next.toString();
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  };

  return (
    <Tabs
      activeKey={activeKey}
      onChange={handleChange}
      destroyOnHidden
      items={tabs.map((tab) => ({
        key: tab.key,
        label: tab.label,
        children: tab.content
      }))}
    />
  );
}
