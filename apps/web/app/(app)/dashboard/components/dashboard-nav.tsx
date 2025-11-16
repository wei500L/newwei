"use client";

import { Tabs } from "antd";
import { usePathname, useRouter } from "next/navigation";

const dashboardRoutes = [
  { key: "/dashboard", label: "总览" },
  { key: "/dashboard/key-monitor", label: "重点监控" },
  { key: "/dashboard/military-alert", label: "军事预警" },
  { key: "/dashboard/economic-alert", label: "经济预警" },
  { key: "/dashboard/economic-short", label: "经济短期" },
  { key: "/dashboard/economic-medium", label: "经济中期" },
  { key: "/dashboard/economic-long", label: "经济长期" },
  { key: "/dashboard/livelihood-prices", label: "民生物价" }
];

export function DashboardNav() {
  const pathname = usePathname();
  const router = useRouter();
  const activeItem =
    dashboardRoutes.find((route) => pathname === route.key || pathname.startsWith(`${route.key}/`)) ??
    dashboardRoutes[0];

  return (
    <Tabs
      activeKey={activeItem.key}
      onChange={(key) => router.push(key)}
      items={dashboardRoutes.map((route) => ({
        key: route.key,
        label: route.label
      }))}
    />
  );
}
