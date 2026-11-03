/**
 * gev-events.ts — 订阅 GEV 在 `window` 上广播的 `gev:*` 事件。
 *
 * 事件来源（读源码核实）：
 * - `gev:entity-selected`：`detail` 是上下文记录（`data/contextStore.js:44-60`，
 *   记录形如 `{ id, layerId, layerName, label, entity, ... }`）。
 * - `gev:awareness-subject-selected` / `-cleared`：跟踪型图层（飞机/卫星等）
 *   的选择通道，`detail` 形如 `{ layerId, id, label, position, origin }`
 *   （`layers/flights/tracking.js:70`、`:678`）。
 * - `gev:entity-selection-cleared`：`detail` 形如 `{ layerId, reason }`
 *   （`data/contextStore.js:165-176`）。
 * - `gev:awareness-subject-cleared`：跟踪型图层取消跟踪时的清除通道
 *   （`layers/flights/tracking.js:678`、`layers/satellites/tracking.js:124`）。
 * - `gev:map-stack-changed`：`detail` 是地图栈状态（`app/scene.js:118-122`）。
 * - `gev:style-change` / `gev:vision-change`：`detail` 形如 `{ style }` /
 *   `{ style, cockpit }`（`ui/visualSettings.js:1552` / `:412`）。
 */
import { useEffect, useState } from "react";

/** GEV 选择记录里我们展示/判断会用到的字段；其余字段原样保留。 */
export interface GevSelectionRecord {
  id?: string | number;
  name?: string;
  label?: string;
  layerId?: string;
  layerName?: string;
  [key: string]: unknown;
}

export interface GevSelection {
  source: "entity" | "tracked";
  record: GevSelectionRecord;
}

/** 订阅 window 上某个 `CustomEvent`，返回最近一次的 `detail`。 */
export function useGevWindowEvent<T>(type: string): T | null {
  const [detail, setDetail] = useState<T | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      setDetail(((event as CustomEvent<T>).detail ?? null) as T | null);
    };
    window.addEventListener(type, handler);
    return () => {
      window.removeEventListener(type, handler);
    };
  }, [type]);

  return detail;
}

/**
 * 合并实体选择与跟踪型选择两条通道；收到清除事件后回到 `null`。
 * 清除事件带 `layerId` 时，只清除同一图层的选择。
 */
export function useGevSelection(): GevSelection | null {
  const [selection, setSelection] = useState<GevSelection | null>(null);

  useEffect(() => {
    const onEntitySelected = (event: Event) => {
      const detail = (event as CustomEvent<GevSelectionRecord | undefined>)
        .detail;
      setSelection(detail ? { source: "entity", record: detail } : null);
    };
    const onTrackedSelected = (event: Event) => {
      const detail = (event as CustomEvent<GevSelectionRecord | undefined>)
        .detail;
      setSelection(detail ? { source: "tracked", record: detail } : null);
    };
    const onCleared = (event: Event) => {
      const detail = (
        event as CustomEvent<{ layerId?: string } | undefined>
      ).detail;
      setSelection((previous) => {
        if (!previous) return null;
        const clearedLayerId = detail?.layerId;
        const currentLayerId = previous.record?.layerId;
        if (
          clearedLayerId &&
          currentLayerId &&
          clearedLayerId !== currentLayerId
        ) {
          return previous;
        }
        return null;
      });
    };

    window.addEventListener("gev:entity-selected", onEntitySelected);
    window.addEventListener(
      "gev:awareness-subject-selected",
      onTrackedSelected,
    );
    window.addEventListener("gev:entity-selection-cleared", onCleared);
    // 跟踪型图层取消跟踪时只发 awareness-subject-cleared（`flights/tracking.js:678`）。
    window.addEventListener("gev:awareness-subject-cleared", onCleared);
    return () => {
      window.removeEventListener("gev:entity-selected", onEntitySelected);
      window.removeEventListener(
        "gev:awareness-subject-selected",
        onTrackedSelected,
      );
      window.removeEventListener("gev:entity-selection-cleared", onCleared);
      window.removeEventListener("gev:awareness-subject-cleared", onCleared);
    };
  }, []);

  return selection;
}

/** 地图栈变化。`detail` 是 `MapStackController.getState()` 的形状。 */
export function useMapStack<T = unknown>(): T | null {
  return useGevWindowEvent<T>("gev:map-stack-changed");
}

/** `gev:style-change` / `gev:vision-change` 的最近一次 `detail`。 */
export function useGevStyle<T = unknown>(): T | null {
  const [detail, setDetail] = useState<T | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      setDetail(((event as CustomEvent<T>).detail ?? null) as T | null);
    };
    window.addEventListener("gev:style-change", handler);
    window.addEventListener("gev:vision-change", handler);
    return () => {
      window.removeEventListener("gev:style-change", handler);
      window.removeEventListener("gev:vision-change", handler);
    };
  }, []);

  return detail;
}
