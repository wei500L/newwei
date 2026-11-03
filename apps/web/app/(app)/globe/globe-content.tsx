"use client";

import { ConfigProvider, theme } from "antd";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { usePageTitle } from "@/hooks/use-page-title";

function GlobeStageLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex h-[calc(100dvh-var(--top-nav-height)-var(--ticker-height,0px))] w-full items-center justify-center bg-slate-950">
      <p className="kicker m-0 text-slate-300">{t("globe.status.starting")}</p>
    </div>
  );
}

const GlobeStage = dynamic(() => import("./globe-stage"), {
  ssr: false,
  loading: () => <GlobeStageLoading />,
});

export function GlobeContent() {
  const { t } = useTranslation();
  usePageTitle(t("globe.title"));

  // G4 快捷键控制的两个 React 侧状态：
  // - layersOpen：F 切换图层面板显隐（传给 G3 的面板）；
  // - cleanView：V 隐藏所有 React 面板，只保留地球和数据署名。
  const [layersOpen, setLayersOpen] = useState(true);
  const [cleanView, setCleanView] = useState(false);

  return (
    <div className="dark" data-theme="dark">
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <GlobeStage
          layersOpen={layersOpen}
          cleanView={cleanView}
          onToggleLayers={() => setLayersOpen((open) => !open)}
          onToggleCleanView={() => setCleanView((clean) => !clean)}
        />
      </ConfigProvider>
    </div>
  );
}
