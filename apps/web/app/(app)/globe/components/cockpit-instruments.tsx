"use client";

import { useCockpitStore as getCockpitStore } from "@gev/ui/stores/cockpit.js";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useGevStore } from "@/lib/globe/pinia-bridge";
import { useGlobeRuntime } from "@/lib/globe/runtime-context";

/**
 * `CockpitViewController` 在构造函数里按 id 抓取并绑定事件的**全部** DOM id
 * （`vendor/gods-eye-view/src/ui/cockpitController.js:99-141`）。
 * 这份清单是防回归契约：以后有人改 UI 时删掉任何 id，`cockpit-instruments.test.tsx`
 * 会失败。新增/删除都请先对照源码。
 */
export const COCKPIT_DOM_IDS = [
  // 入口 / 退出 / TR-3B
  "cockpit-entry",
  "tr3b-toggle",
  "map-view-switch",
  // 驾驶舱 HUD 外壳
  "cockpit-hud",
  // 视觉模式（上一个 / 当前 / 下一个）
  "cockpit-vision-previous",
  "cockpit-vision-current",
  "cockpit-vision-next",
  // Contact 卡
  "cockpit-context",
  "cockpit-context-previous",
  "cockpit-context-next",
  "cockpit-context-toggle",
  "cockpit-weather-toggle",
  // 信号流
  "cockpit-signal-stream",
  "cockpit-signal-list",
  "cockpit-signal-toggle",
  // 简报卡
  "cockpit-brief-previous",
  "cockpit-brief-next",
  "cockpit-brief-auto",
] as const;

/** 简报页签的选择器（`document.querySelectorAll('[data-cockpit-brief-index]')`）。 */
export const COCKPIT_BRIEF_TAB_ATTR = "data-cockpit-brief-index";

export interface CockpitRimTick {
  hidden?: boolean;
  slot?: number | null;
  depth?: number | null;
  major?: boolean;
  label?: string;
}

export interface CockpitRim {
  unavailable?: boolean;
  value?: string;
  ticks?: CockpitRimTick[];
}

/** `createInstrumentState()` / `updateHud()` 发布到 `useCockpitStore().instruments` 的字段。 */
export interface CockpitInstrumentState {
  layer?: string | null;
  callsign?: string;
  meta?: { text?: string; emergency?: boolean };
  speed?: string | number | null;
  altitude?: string | number | null;
  heading?: string | number | null;
  speedRim?: CockpitRim;
  altitudeRim?: CockpitRim;
  compass?: { slot: number; label: string }[];
  clock?: string;
  position?: string;
}

export interface CockpitPresence {
  active?: boolean;
  entryAvailable?: boolean;
  tr3b?: { converted?: boolean } | null;
  context?: boolean;
  contextCollapsed?: boolean;
  signalCollapsed?: boolean;
}

export interface CockpitVisionState {
  mode?: string;
  label?: string;
  name?: string;
}

const TICK = "block h-1 w-px bg-slate-400";
const BTN =
  "pointer-events-auto rounded border border-slate-600 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-200 hover:bg-slate-800";

function RimScale({ rim }: { rim?: CockpitRim }) {
  return (
    <div className="flex flex-col items-center gap-1">
      {(rim?.ticks ?? []).map((tick, index) => (
        <span
          key={index}
          hidden={tick.hidden}
          className={tick.major ? "h-1.5 w-px bg-slate-300" : TICK}
        />
      ))}
    </div>
  );
}

/**
 * 驾驶舱仪表（纯展示）。它同时提供 GEV `CockpitViewController` 需要的全部 id：
 * 骨架与仪表合并为一个组件（提示词允许的推荐做法），按钮不挂 React `onClick`，
 * 点击等事件由 GEV 绑定。
 */
export function CockpitInstrumentsView({
  instruments,
  presence,
  vision,
}: {
  instruments: CockpitInstrumentState | null;
  presence: CockpitPresence | null;
  vision: CockpitVisionState | null;
}) {
  const { t } = useTranslation();
  const active = Boolean(presence?.active);
  const hud = instruments ?? {};
  const speed = hud.speed ?? "---";
  const altitude = hud.altitude ?? "-----";
  const heading = hud.heading ?? "---";
  const callsign = hud.callsign ?? "AIRCRAFT";
  const emergency = Boolean(hud.meta?.emergency);

  return (
    <>
      {/* 驾驶舱 HUD：始终挂载，非驾驶舱时 hidden。 */}
      <section
        id="cockpit-hud"
        aria-label={t("globe.cockpit.aria")}
        hidden={!active}
        data-layer={hud.layer ?? undefined}
        className="pointer-events-none absolute inset-0 z-20 select-none font-mono text-slate-100"
      >
        {/* 左上：呼号 + 机型元信息（紧急时玫红） */}
        <div className="absolute left-6 top-6 flex flex-col gap-0.5">
          <span className="kicker text-slate-400">{t("globe.cockpit.aria")}</span>
          <strong id="cockpit-callsign" className="text-xl font-normal tracking-wide">
            {callsign}
          </strong>
          <span
            id="cockpit-aircraft-meta"
            className={`text-[11px] uppercase tracking-wider ${
              emergency ? "text-rose-400" : "text-slate-400"
            }`}
          >
            {hud.meta?.text ?? ""}
          </span>
        </div>

        {/* 上方中央：视觉模式（上一个 / 当前 / 下一个） */}
        <div
          className="absolute left-1/2 top-6 flex -translate-x-1/2 items-stretch gap-1"
          role="group"
          aria-label={t("globe.cockpit.visionAria")}
        >
          <button id="cockpit-vision-previous" type="button" className={BTN}>
            {t("globe.cockpit.prev")}
          </button>
          <button
            id="cockpit-vision-current"
            type="button"
            className={`${BTN} min-w-20 text-center`}
            data-cockpit-vision={vision?.mode}
          >
            <small className="block text-[9px] text-slate-400">
              {t("globe.cockpit.current")}
            </small>
            <strong id="cockpit-vision-current-label" aria-live="polite">
              {vision?.label ?? ""}
            </strong>
          </button>
          <button id="cockpit-vision-next" type="button" className={BTN}>
            {t("globe.cockpit.next")}
          </button>
        </div>

        {/* 左侧：地速带 */}
        <div
          id="cockpit-speed-rim"
          className="absolute left-6 top-1/2 flex -translate-y-1/2 items-center gap-2"
        >
          <RimScale rim={hud.speedRim} />
          <div className="flex flex-col items-start border-l border-slate-500 pl-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-400">
              {t("globe.cockpit.groundSpeed")}
            </span>
            <strong id="cockpit-speed-rim-value" className="text-2xl font-normal">
              {hud.speedRim?.value ?? speed}
            </strong>
            <span id="cockpit-speed-value" className="text-lg font-normal">
              {speed}
            </span>
          </div>
        </div>

        {/* 右侧：高度带 */}
        <div
          id="cockpit-altitude-rim"
          className="absolute right-6 top-1/2 flex -translate-y-1/2 items-center gap-2"
        >
          <div className="flex flex-col items-end border-r border-slate-500 pr-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-400">
              {t("globe.cockpit.altitude")}
            </span>
            <strong
              id="cockpit-altitude-rim-value"
              className="text-2xl font-normal"
            >
              {hud.altitudeRim?.value ?? altitude}
            </strong>
            <span id="cockpit-altitude-value" className="text-lg font-normal">
              {altitude}
            </span>
          </div>
          <RimScale rim={hud.altitudeRim} />
        </div>

        {/* 底部中央：航向罗盘带 */}
        <div className="absolute bottom-16 left-1/2 flex -translate-x-1/2 flex-col items-center">
          <div className="flex items-baseline gap-1">
            <span className="text-[10px] uppercase tracking-wider text-slate-400">
              {t("globe.cockpit.heading")}
            </span>
            <span id="cockpit-heading-value" className="text-xl font-normal">
              {heading}
            </span>
            <small>°</small>
          </div>
          <div
            id="cockpit-compass-tape"
            aria-hidden="true"
            className="mt-1 flex items-end gap-3 text-[12px] text-slate-300"
          >
            {(hud.compass ?? []).map((division) => (
              <span
                key={division.slot}
                className={division.slot === 0 ? "text-slate-100" : "text-slate-500"}
              >
                {division.label}
              </span>
            ))}
          </div>
        </div>

        {/* 时钟 / 位置 */}
        <div className="absolute bottom-6 left-6 flex gap-3 text-[11px] text-slate-400">
          <span id="cockpit-clock">{hud.clock ?? ""}</span>
          <span id="cockpit-position">{hud.position ?? ""}</span>
        </div>

        {/* Contact 卡（结构占位；内容由 GEV 发布到 context 仓库） */}
        <section
          id="cockpit-context"
          className="pointer-events-auto absolute right-6 top-24 w-56 border border-slate-600 bg-slate-950/70 p-2 text-[11px]"
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="text-slate-400">CONTACT</span>
            <div className="flex gap-1">
              <button id="cockpit-context-previous" type="button" className={BTN}>
                ‹
              </button>
              <button id="cockpit-context-toggle" type="button" className={BTN}>
                ⌄
              </button>
              <button id="cockpit-context-next" type="button" className={BTN}>
                ›
              </button>
            </div>
          </div>
          <button id="cockpit-weather-toggle" type="button" className={BTN}>
            WX
          </button>
        </section>

        {/* 信号流 */}
        <section
          id="cockpit-signal-stream"
          className="pointer-events-auto absolute left-6 top-24 w-52 border border-slate-600 bg-slate-950/70 p-2 text-[11px]"
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="text-slate-400">SIGNALS</span>
            <button id="cockpit-signal-toggle" type="button" className={BTN}>
              ⌄
            </button>
          </div>
          <ul id="cockpit-signal-list" className="m-0 flex list-none flex-col gap-0.5 p-0" />
        </section>

        {/* 简报卡 */}
        <section className="pointer-events-auto absolute bottom-16 right-6 w-60 border border-slate-600 bg-slate-950/70 p-2 text-[11px]">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-slate-400">BRIEF</span>
            <div className="flex gap-1">
              <button id="cockpit-brief-previous" type="button" className={BTN}>
                ‹
              </button>
              <button id="cockpit-brief-next" type="button" className={BTN}>
                ›
              </button>
              <button id="cockpit-brief-auto" type="button" className={BTN}>
                ⟳
              </button>
            </div>
          </div>
          <div className="flex gap-1">
            {[0, 1, 2].map((index) => (
              <button
                key={index}
                type="button"
                data-cockpit-brief-index={index}
                className={BTN}
              >
                {index + 1}
              </button>
            ))}
          </div>
        </section>
      </section>

      {/* 退出驾驶舱按钮（`map-view-switch`）：GEV 绑定点击 → exit()。 */}
      <button
        id="map-view-switch"
        type="button"
        hidden={!active}
        aria-keyshortcuts="Escape C"
        className={`${BTN} absolute right-6 top-6 z-30`}
      >
        {t("globe.cockpit.mapView")}
      </button>

      {/* GEV 绑定的驾驶舱入口。详情卡通过 `.click()` 触发；本身不显示。 */}
      <button id="cockpit-entry" type="button" hidden aria-hidden="true">
        {t("globe.cockpit.entry")}
      </button>
      {/* TR-3B 重新分类按钮（结构占位，GEV 绑定点击）。 */}
      <button id="tr3b-toggle" type="button" hidden aria-hidden="true">
        🛸
      </button>
    </>
  );
}

/** 订阅 `useCockpitStore()` 的 instruments / presence / vision 并渲染。 */
export function CockpitInstruments() {
  const runtime = useGlobeRuntime();
  const store = useMemo(
    () => getCockpitStore(runtime.pinia as never),
    [runtime.pinia],
  );
  const instruments = useGevStore(
    store,
    (state: { instruments: CockpitInstrumentState | null }) =>
      state.instruments,
  );
  const presence = useGevStore(
    store,
    (state: { presence: CockpitPresence | null }) => state.presence,
  );
  const vision = useGevStore(
    store,
    (state: { vision: CockpitVisionState | null }) => state.vision,
  );
  return (
    <CockpitInstrumentsView
      instruments={instruments}
      presence={presence}
      vision={vision}
    />
  );
}
