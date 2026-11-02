"use client";

import { ConfigProvider, theme } from "antd";
import dynamic from "next/dynamic";
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

  return (
    <div className="dark" data-theme="dark">
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <GlobeStage />
      </ConfigProvider>
    </div>
  );
}
