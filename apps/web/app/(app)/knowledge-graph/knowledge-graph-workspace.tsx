"use client";

import { Skeleton, Tabs } from "antd";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

type KnowledgeGraphWorkspaceTab = "explorer" | "impact";

const KnowledgeGraphContent = dynamic(
  () =>
    import("./knowledge-graph-content").then(
      (mod) => mod.KnowledgeGraphContent,
    ),
  { loading: () => <Skeleton active paragraph={{ rows: 10 }} /> },
);

const KnowledgeGraphImpactContent = dynamic(
  () =>
    import("./knowledge-graph-impact-content").then(
      (mod) => mod.KnowledgeGraphImpactContent,
    ),
  { loading: () => <Skeleton active paragraph={{ rows: 8 }} /> },
);

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
      },
      {
        key: "impact",
        label: t("knowledgeGraph.workspace.tabs.impact"),
      },
    ],
    [t],
  );

  const renderTabContent = (key: KnowledgeGraphWorkspaceTab) => {
    if (key === "impact") {
      return <KnowledgeGraphImpactContent />;
    }
    return <KnowledgeGraphContent />;
  };

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
      items={items.map((item) => ({
        ...item,
        children:
          item.key === activeKey
            ? renderTabContent(item.key as KnowledgeGraphWorkspaceTab)
            : null,
      }))}
      destroyOnHidden
    />
  );
}
