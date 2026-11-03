"use client";

import { Segmented } from "antd";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { useGevSelection } from "@/lib/globe/gev-events";
import { useGlobeRuntime } from "@/lib/globe/runtime-context";

import { MissionPanel } from "./mission-panel";
import { NearbyTargets } from "./nearby-targets";
import { TargetCardContainer } from "./target-card-container";

type ContextTab = "target" | "nearby" | "missions";

const PANEL_SHELL =
  "pointer-events-auto rounded-md border border-slate-700 bg-slate-950/85 text-slate-100";

/** 右侧情境面板：目标详情 / 附近目标 / 航天任务。 */
export function GlobeContextPanel() {
  const { t } = useTranslation();
  const runtime = useGlobeRuntime();
  const selection = useGevSelection();
  const [tab, setTab] = useState<ContextTab>("target");

  const options = useMemo(
    () => [
      { label: t("globe.context.tabs.target"), value: "target" },
      { label: t("globe.context.tabs.nearby"), value: "nearby" },
      { label: t("globe.context.tabs.missions"), value: "missions" },
    ],
    [t],
  );

  const changeTab = (value: string | number) => {
    const next = value as ContextTab;
    setTab(next);
    if (next === "nearby") {
      void runtime.actions.contextMode("contacts");
    } else if (next === "missions") {
      void runtime.actions.contextMode("space-missions");
    }
  };

  return (
    <aside
      aria-label={t("globe.context.aria")}
      className={`${PANEL_SHELL} absolute right-3 top-3 z-20 flex max-h-[calc(100%-6rem)] w-[340px] max-w-[calc(100vw-1.5rem)] flex-col`}
    >
      <div className="border-b border-slate-800 px-2 py-2">
        <Segmented
          block
          size="small"
          value={tab}
          options={options}
          onChange={changeTab}
        />
      </div>
      <div className="rail-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
        {tab === "target" ? (
          selection ? (
            <TargetCardContainer selection={selection} />
          ) : (
            <ChartEmptyState
              presentation="banner"
              title={t("globe.context.targetEmptyTitle")}
              description={t("globe.context.targetEmptyDescription")}
            />
          )
        ) : null}
        {tab === "nearby" ? <NearbyTargets /> : null}
        {tab === "missions" ? <MissionPanel /> : null}
      </div>
    </aside>
  );
}
