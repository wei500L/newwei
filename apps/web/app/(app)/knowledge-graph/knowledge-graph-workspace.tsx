"use client";

import { Tabs } from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { KnowledgeGraphContent } from "./knowledge-graph-content";
import { KnowledgeGraphImpactContent } from "./knowledge-graph-impact-content";

type KnowledgeGraphWorkspaceTab = "explorer" | "impact";

function resolveTab(value: string | null): KnowledgeGraphWorkspaceTab {
  return value === "impact" ? "impact" : "explorer";
}

export function KnowledgeGraphWorkspace() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeKey = resolveTab(searchParams.get("tab"));
  const items = useMemo(
    () => [
      {
        key: "explorer",
        label: t("knowledgeGraph.workspace.tabs.explorer"),
        children: <KnowledgeGraphContent />,
      },
      {
        key: "impact",
        label: t("knowledgeGraph.workspace.tabs.impact"),
        children: <KnowledgeGraphImpactContent />,
      },
    ],
    [t],
  );

  return (
    <Tabs
      activeKey={activeKey}
      onChange={(key) => {
        const nextParams = new URLSearchParams(searchParams.toString());
        if (key === "impact") {
          nextParams.set("tab", "impact");
        } else {
          nextParams.delete("tab");
        }
        const nextQuery = nextParams.toString();
        router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
          scroll: false,
        });
      }}
      items={items}
      destroyOnHidden
    />
  );
}
