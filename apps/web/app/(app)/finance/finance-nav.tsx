"use client";

import { Tabs } from "antd";
import { usePathname, useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { resolveActiveRouteKey } from "@/lib/resolve-active-route";

const financeRoutes: {
  key: string;
  labelKey: string;
  defaultLabel: string;
}[] = [
  { key: "/finance", labelKey: "finance.nav.market", defaultLabel: "Market" },
  { key: "/finance/macro", labelKey: "finance.nav.macro", defaultLabel: "Macro" },
  { key: "/finance/livelihood", labelKey: "finance.nav.livelihood", defaultLabel: "Livelihood" }
];

export function FinanceNav() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();

  const activeKey =
    resolveActiveRouteKey(pathname, financeRoutes.map((route) => route.key)) ??
    financeRoutes[0]!.key;

  return (
    <Tabs
      activeKey={activeKey}
      onChange={(key) => router.push(key)}
      items={financeRoutes.map((route) => ({
        key: route.key,
        label: t(route.labelKey, { defaultValue: route.defaultLabel })
      }))}
    />
  );
}
