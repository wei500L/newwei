"use client";

// Cesium 的控件样式必须在客户端组件里引入（本组件通过 next/dynamic ssr:false 加载）。
import "cesium/Build/Cesium/Widgets/widgets.css";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import {
  createGlobeRuntime,
  type GlobeRuntime,
} from "@/lib/globe/runtime";
import { GlobeRuntimeProvider } from "@/lib/globe/runtime-context";

import { GlobeDebugBar } from "./globe-debug-bar";

/** 把 i18next 语言标签收敛到 GEV 只识别的两种 locale。 */
function mapLocale(language: string | undefined): "zh-CN" | "en" {
  return language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** #cesium-credits 由 GEV 挂到 document.body（许可要求，不能隐藏）。 */
const CESIUM_CREDITS_CSS = `
#cesium-credits {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 60;
  max-width: 60vw;
  text-align: right;
  font-size: 11px;
  line-height: 1.3;
  color: rgba(226, 232, 240, 0.78);
  pointer-events: auto;
}
#cesium-credits a { color: inherit; }
#cesium-credits .cesium-credit-lightbox-overlay { z-index: 61; }
`;

export default function GlobeStage() {
  const { t, i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const initialLocaleRef = useRef<"zh-CN" | "en">(mapLocale(i18n.language));

  const [runtime, setRuntime] = useState<GlobeRuntime | null>(null);
  const [status, setStatus] = useState<string>(() =>
    t("globe.status.starting"),
  );
  const [error, setError] = useState<string | null>(null);

  // 启动 / 销毁运行时。只运行一次；语言切换由下面的 effect 处理。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    let cancelled = false;
    let instance: GlobeRuntime | null = null;
    setError(null);

    const googleApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

    void createGlobeRuntime(element, {
      googleApiKey,
      locale: initialLocaleRef.current,
      onStatus: (text) => {
        if (!cancelled) setStatus(text);
      },
    })
      .then((created) => {
        if (cancelled) {
          // StrictMode 的「挂载 → 清理 → 再挂载」：这次结果已过期，销毁它
          // 以释放页面级 slot，让第二次启动可以开始。
          void created.destroy();
          return;
        }
        instance = created;
        setRuntime(created);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
      if (instance) {
        void instance.destroy();
      }
    };
  }, []);

  // 我们的 i18n 语言变化时，同步给 GEV 引擎。
  const locale = mapLocale(i18n.language);
  useEffect(() => {
    runtime?.setLocale(locale);
  }, [runtime, locale]);

  const loading = !runtime && !error;

  return (
    <div className="relative h-[calc(100dvh-var(--top-nav-height)-var(--ticker-height,0px))] w-full overflow-hidden bg-slate-950">
      <div id="cesiumContainer" ref={containerRef} className="absolute inset-0" />

      {loading && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <p className="kicker m-0 text-slate-300">{status}</p>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
          <ChartEmptyState
            variant="error"
            title={t("globe.error.title")}
            description={
              <span className="break-all font-mono text-xs">{error}</span>
            }
          />
        </div>
      )}

      {runtime && (
        <GlobeRuntimeProvider runtime={runtime}>
          <GlobeDebugBar />
        </GlobeRuntimeProvider>
      )}

      {/* #cesium-credits 由 GEV 挂到 document.body（许可要求，不能隐藏）。 */}
      <style dangerouslySetInnerHTML={{ __html: CESIUM_CREDITS_CSS }} />
    </div>
  );
}
