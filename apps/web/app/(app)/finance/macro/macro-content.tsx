"use client";

import { Tabs } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import EconomicMediumPage from "@/app/(app)/dashboard/economic-medium/page";
import EconomicLongPage from "@/app/(app)/dashboard/economic-long/page";

const DEFAULT_TAB = "overview";

export function MacroContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tabs = useMemo(
    () => [
      {
        key: "overview",
        label: t("finance.macro.overview", { defaultValue: "Macro Overview" }),
        content: <EconomicMediumPage />
      },
      {
        key: "long",
        label: t("finance.macro.longTerm", { defaultValue: "Long-term Trends" }),
        content: <EconomicLongPage />
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
      destroyInactiveTabPane
      items={tabs.map((tab) => ({
        key: tab.key,
        label: tab.label,
        children: tab.content
      }))}
    />
  );
}
