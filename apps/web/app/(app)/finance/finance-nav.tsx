"use client";

import { Tabs } from "antd";
import { usePathname, useRouter } from "next/navigation";

const financeRoutes = [
  { key: "/finance", label: "Market" },
  { key: "/finance/macro", label: "Macro" },
  { key: "/finance/trends", label: "Trends" },
  { key: "/finance/livelihood", label: "Livelihood" },
  { key: "/finance/key-monitor", label: "Key Monitor" }
];

export function FinanceNav() {
  const pathname = usePathname();
  const router = useRouter();

  const activeItem =
    financeRoutes.find(
      (route) => pathname === route.key || pathname.startsWith(`${route.key}/`)
    ) ?? financeRoutes[0];
  const activeKey = activeItem?.key ?? financeRoutes[0]!.key;

  return (
    <Tabs
      activeKey={activeKey}
      onChange={(key) => router.push(key)}
      items={financeRoutes.map((route) => ({
        key: route.key,
        label: route.label
      }))}
    />
  );
}
