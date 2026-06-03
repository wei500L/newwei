"use client";

import { Skeleton, Tabs } from "antd";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

const DEFAULT_TAB = "overview";

const MarketOverview = dynamic(
  () => import("./market-overview").then((mod) => mod.MarketOverview),
  { loading: () => <Skeleton active paragraph={{ rows: 8 }} /> },
);

const KeyMonitorPage = dynamic(
  () => import("@/app/(app)/dashboard/key-monitor/page"),
  { loading: () => <Skeleton active paragraph={{ rows: 10 }} /> },
);

const NewsIndicatorAssociations = dynamic(
  () =>
    import("./news-indicator-associations").then(
      (mod) => mod.NewsIndicatorAssociations,
    ),
  { loading: () => <Skeleton active paragraph={{ rows: 8 }} /> },
);

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
      },
      {
        key: "monitor",
        label: t("finance.market.monitor"),
      },
      {
        key: "associations",
        label: t("finance.market.associations"),
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

  const renderTabContent = (key: string) => {
    if (key === "monitor") {
      return <KeyMonitorPage />;
    }
    if (key === "associations") {
      return <NewsIndicatorAssociations />;
    }
    return <MarketOverview />;
  };

  return (
    <Tabs
      activeKey={activeKey}
      onChange={handleChange}
      destroyOnHidden
      items={tabs.map((tab) => ({
        key: tab.key,
        label: tab.label,
        children: tab.key === activeKey ? renderTabContent(tab.key) : null
      }))}
    />
  );
}
