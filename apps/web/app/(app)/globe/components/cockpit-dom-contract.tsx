"use client";

import { useEffect } from "react";

import { useGlobeRuntime } from "@/lib/globe/runtime-context";

import { CockpitInstruments } from "./cockpit-instruments";

/**
 * 驾驶舱 DOM 契约组件的入口：在 `/globe` 页面里**始终挂载**。
 *
 * `CockpitViewController` 在 `CockpitCoordinator` 的构造函数里创建，并按 id
 * 抓取 DOM（`ui/cockpitController.js:99-141`），所以必须在骨架渲染完成后
 * （`useEffect` 里）才调用 `runtime.actions.attachCockpit()`；卸载时调用返回的
 * 清理函数销毁 coordinator。
 *
 * 骨架与仪表合并到 `CockpitInstruments`：它既提供全部 id，也显示仓库内容；
 * 所有按钮都不加 React `onClick`，事件交给 GEV 绑定。
 */
export function CockpitDomContract() {
  const runtime = useGlobeRuntime();

  useEffect(() => runtime.actions.attachCockpit(), [runtime]);

  return <CockpitInstruments />;
}
