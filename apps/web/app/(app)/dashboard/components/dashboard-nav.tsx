"use client";

import { Tabs } from "antd";
import { usePathname, useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

const dashboardRoutes = [
  { key: "/dashboard", labelKey: "dashboard.tabs.overview" },
  { key: "/dashboard/key-monitor", labelKey: "dashboard.tabs.keyMonitor" },
  { key: "/dashboard/military-alert", labelKey: "dashboard.tabs.militaryAlert" },
  { key: "/dashboard/economic-alert", labelKey: "dashboard.tabs.economicAlert" },
  { key: "/dashboard/economic-short", labelKey: "dashboard.tabs.economicShort" },
  { key: "/dashboard/economic-medium", labelKey: "dashboard.tabs.economicMedium" },
  { key: "/dashboard/economic-long", labelKey: "dashboard.tabs.economicLong" },
  { key: "/dashboard/livelihood-prices", labelKey: "dashboard.tabs.livelihoodPrices" },
];

export function DashboardNav() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  if (dashboardRoutes.length === 0) {
    return null;
  }
  const activeItem =
    dashboardRoutes.find(
      (route) => pathname === route.key || pathname.startsWith(`${route.key}/`),
    ) ?? dashboardRoutes[0];
  const activeKey = activeItem?.key ?? dashboardRoutes[0]!.key;

  return (
    <Tabs
      activeKey={activeKey}
      onChange={(key) => router.push(key)}
      items={dashboardRoutes.map((route) => ({
        key: route.key,
        label: t(route.labelKey),
      }))}
    />
  );
}
