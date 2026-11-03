"use client";

import { useHudStore as getHudStore } from "@gev/ui/stores/hud.js";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useGevStore } from "@/lib/globe/pinia-bridge";
import { useGlobeRuntime } from "@/lib/globe/runtime-context";

/**
 * GEV `IntelHUD` 发布到 `hud` 仓库的视图对象。
 * 字段来源：`vendor/gods-eye-view/src/ui/views/IntelHudView.vue` + `hud.js:_initView`
 * （`classification` / `system` / `timestamp` / `mode` / `latlon` / `mgrs` /
 * `alt` / `gsd` / `ona` 等；`vessel` / `recShown` 等可能为空）。
 */
export interface HudView {
  active?: boolean;
  classification?: string;
  system?: string;
  timestamp?: string;
  mode?: string;
  latlon?: string;
  mgrs?: string;
  alt?: string;
  gsd?: string;
  ona?: string;
  orbital?: string;
  coll?: string;
  summary?: string;
  summaryLabel?: string;
  vessel?: { active?: boolean; text?: string };
  bottom?: string;
  [key: string]: unknown;
}

/** HUD 文字的风格：等宽、极小、全大写、宽字距、冷灰色。 */
const HUD_TEXT =
  "font-mono text-[11px] uppercase tracking-wider text-slate-200";

function Line({ children, className = "" }: { children: ReactNode; className?: string }) {
  if (children === null || children === undefined || children === "") {
    return null;
  }
  return <div className={`${HUD_TEXT} ${className}`}>{children}</div>;
}

/**
 * 四角角标（纯展示）。`view` 为 `null` / 不可见 / 纯净视图时不渲染。
 * 整个 HUD 层 `pointer-events-none`，位于地球之上、面板之下。
 */
export function IntelHud({
  view,
  cleanView = false,
}: {
  view: HudView | null;
  cleanView?: boolean;
}) {
  const { t } = useTranslation();

  if (cleanView || !view || !view.active) return null;

  return (
    <div
      aria-label={t("globe.hud.aria")}
      role="group"
      className="pointer-events-none absolute inset-0 z-10 select-none"
    >
      {/* 左上：classification（琥珀色 kicker）+ system */}
      <div className="absolute left-4 top-4 border-l border-t border-slate-500 px-2 py-1.5">
        <Line className="text-amber-400">{view.classification}</Line>
        <Line className="text-slate-300">{view.system}</Line>
      </div>

      {/* 右上：timestamp（UTC 等宽）+ mode + orbital */}
      <div className="absolute right-4 top-4 border-r border-t border-slate-500 px-2 py-1.5 text-right">
        <Line>{view.timestamp}</Line>
        <Line className="text-slate-300">{view.mode}</Line>
        <Line className="text-slate-400">{view.orbital}</Line>
      </div>

      {/* 左下：latlon、mgrs */}
      <div className="absolute bottom-4 left-4 border-b border-l border-slate-500 px-2 py-1.5">
        <Line>{view.latlon}</Line>
        <Line>{view.mgrs}</Line>
      </div>

      {/* 右下：alt、gsd、ona；整体上移 32px 让出数据署名（#cesium-credits）。 */}
      <div
        className="absolute right-4 border-b border-r border-slate-500 px-2 py-1.5 text-right"
        style={{ bottom: 48 }}
      >
        <Line>{view.alt}</Line>
        <Line>{view.gsd}</Line>
        <Line>{view.ona}</Line>
      </div>
    </div>
  );
}

/**
 * 订阅 `useHudStore().hud` 并渲染 `IntelHud`。
 * 与 G3/G4 的容器组件一致：用 `runtime.pinia` 取同一个 Pinia 实例。
 */
export function IntelHudLayer({ cleanView = false }: { cleanView?: boolean }) {
  const runtime = useGlobeRuntime();
  const store = useMemo(
    () => getHudStore(runtime.pinia as never),
    [runtime.pinia],
  );
  const view = useGevStore(store, (state: { hud: HudView | null }) => state.hud);
  return <IntelHud view={view} cleanView={cleanView} />;
}
