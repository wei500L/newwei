"use client";

// Cesium 的控件样式必须在客户端组件里引入（本组件通过 next/dynamic ssr:false 加载）。
import "cesium/Build/Cesium/Widgets/widgets.css";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChartEmptyState } from "@/components/chart-empty-state";
import { useGevWindowEvent } from "@/lib/globe/gev-events";
import { parseGlobeParams } from "@/lib/globe/globe-link";
import { useIntelFeed } from "@/lib/globe/intel-feed";
import {
  createGlobeRuntime,
  type GlobeRuntime,
} from "@/lib/globe/runtime";
import { GlobeRuntimeProvider } from "@/lib/globe/runtime-context";
import {
  bindGlobeShortcuts,
  type GlobeShortcutActions,
} from "@/lib/globe/shortcuts";

import { CockpitDomContract } from "./components/cockpit-dom-contract";
import { CommandDock } from "./components/command-dock";
import { GlobeContextPanel } from "./components/globe-context-panel";
import { IntelHudLayer } from "./components/intel-hud";
import { LayerPanel } from "./components/layer-panel";

/** G6：只负责订阅情报数据并写入运行时（不渲染任何东西）。 */
function IntelFeedBridge({ runtime }: { runtime: GlobeRuntime }) {
  useIntelFeed(runtime);
  return null;
}

export interface GlobeStageProps {
  /** G4：F 键控制的图层面板显隐（由 globe-content 持有）。 */
  layersOpen: boolean;
  /** G4：V 键控制的纯净视图（隐藏所有 React 面板）。 */
  cleanView: boolean;
  onToggleLayers: () => void;
  onToggleCleanView: () => void;
}

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

export default function GlobeStage({
  layersOpen,
  cleanView,
  onToggleLayers,
  onToggleCleanView,
}: GlobeStageProps) {
  const { t, i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const initialLocaleRef = useRef<"zh-CN" | "en">(mapLocale(i18n.language));
  const intelNamesRef = useRef({
    events: t("globe.intel.events"),
    news: t("globe.intel.news"),
  });
  const searchParams = useSearchParams();
  const router = useRouter();
  const handledGlobeParamsRef = useRef(false);
  // 深链只读首帧的查询参数：浏览器导航后 searchParams 会变化，但这一轮
  // 处理不应被新的空参数打断。
  const initialSearchParamsRef = useRef(searchParams);

  const [runtime, setRuntime] = useState<GlobeRuntime | null>(null);
  const [status, setStatus] = useState<string>(() =>
    t("globe.status.starting"),
  );
  const [error, setError] = useState<string | null>(null);

  // G5：是否处于驾驶舱。GEV 在进入 / 退出时广播 `gev:cockpit-mode-changed`
  // （`ui/cockpitTrackingController.js:20-35`）。进入驾驶舱时隐藏左侧图层面板
  // 和命令坞，只保留退出按钮与视觉切换。
  const cockpitMode = useGevWindowEvent<{ active?: boolean }>(
    "gev:cockpit-mode-changed",
  );
  const cockpitActive = Boolean(cockpitMode?.active);

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
      intelLayerNames: intelNamesRef.current,
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

  // G6：`/globe?lat=..&lon=..&label=..&focus=..` 深链。运行时就绪后飞到目标
  // （300 km 观察高度），确保对应情报图层开启，数据到达后选中该要素，最后
  // 清掉查询参数，避免刷新页面时重复飞行。
  useEffect(() => {
    if (!runtime || handledGlobeParamsRef.current) return;
    const params = parseGlobeParams(initialSearchParamsRef.current);
    if (params.lat === undefined || params.lon === undefined) return;
    handledGlobeParamsRef.current = true;
    let cancelled = false;
    void (async () => {
      runtime.actions.flyToPlace({
        id: `globe-link:${params.lat},${params.lon}`,
        label: params.label ?? "",
        lat: params.lat as number,
        lon: params.lon as number,
        kind: "coordinate",
        rangeM: 300000,
      });
      const focus = params.focus;
      if (focus) {
        if (!runtime.dataManager.isEnabled(focus.layerId)) {
          await runtime.actions
            .toggleLayer(focus.layerId)
            .catch(() => undefined);
        }
        const deadline = Date.now() + 10_000;
        while (!cancelled && Date.now() < deadline) {
          if (
            runtime.actions.selectIntelFeature(focus.layerId, focus.newweiId)
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
      if (!cancelled) router.replace("/globe");
    })();
    return () => {
      cancelled = true;
    };
  }, [runtime, router]);

  // G4 快捷键：整页绑定（dock 被纯净视图隐藏时仍可操作）。
  useEffect(() => {
    if (!runtime) return undefined;
    const actions: GlobeShortcutActions = {
      setStyle: (style) => runtime.actions.setStyle(style),
      // Esc 关闭搜索：命令坞监听这个事件。
      dismissSearch: () =>
        window.dispatchEvent(new CustomEvent("globe:dismiss-search")),
      // H 交给 G5，本批先派发自定义事件。
      toggleHud: () => window.dispatchEvent(new CustomEvent("globe:toggle-hud")),
      toggleOrbit: () => {
        runtime.actions.toggleOrbit();
      },
      toggleCleanView: onToggleCleanView,
      toggleLayers: onToggleLayers,
      cycleDetection: () => runtime.actions.cycleDetection(),
      // C 开关摄像头图层（注意：不是驾驶舱）。
      toggleCctv: () => {
        void runtime.actions.toggleLayer("cctv").catch(() => undefined);
      },
    };
    return bindGlobeShortcuts(document, actions, {
      isSearchFocused: () => {
        const active = document.activeElement;
        if (!active) return false;
        return ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
      },
    });
  }, [runtime, onToggleCleanView, onToggleLayers]);

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
          {/* G6：订阅情报数据并写入 newwei-events / newwei-news 图层。 */}
          <IntelFeedBridge runtime={runtime} />
          {/* G5 HUD：地球之上、面板之下；纯净视图（V）时也不渲染。 */}
          <IntelHudLayer cleanView={cleanView} />

          {/* G5 驾驶舱骨架：始终挂载（不在驾驶舱时元素存在但隐藏）。 */}
          <CockpitDomContract />

          {/* V 纯净视图隐藏所有 React 面板；驾驶舱中只保留退出与视觉切换。 */}
          {!cleanView && !cockpitActive && layersOpen ? <LayerPanel /> : null}
          {!cleanView && !cockpitActive ? <GlobeContextPanel /> : null}
          {!cleanView && !cockpitActive ? <CommandDock /> : null}
        </GlobeRuntimeProvider>
      )}

      {/* #cesium-credits 由 GEV 挂到 document.body（许可要求，不能隐藏）。 */}
      <style dangerouslySetInnerHTML={{ __html: CESIUM_CREDITS_CSS }} />
    </div>
  );
}
