"use client";

import { Select, Switch } from "antd";
import { useEffect, useState } from "react";

import type { LayerSummary } from "@/lib/globe/engine-types";
import { useGevSelection } from "@/lib/globe/gev-events";
import { useGlobeRuntime } from "@/lib/globe/runtime-context";

/**
 * G2 临时调试条（G3 删除）。
 *
 * - Select 列出 `dataManager.getAll()` 中 `showInTogglePanel` 为真的图层（name + id）；
 * - 旁边的开关调用 `dataManager.toggle(id, { origin: "user" })`；
 * - 订阅 `dataManager.subscribe` 刷新；
 * - 一行显示当前选中目标（`useGevSelection()` 的 record）。
 */
export function GlobeDebugBar() {
  const runtime = useGlobeRuntime();
  const manager = runtime.dataManager;
  const [layers, setLayers] = useState<LayerSummary[]>(() =>
    manager.getAll().filter((layer) => layer.showInTogglePanel),
  );
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => layers[0]?.id,
  );

  useEffect(() => {
    const refresh = () => {
      setLayers(manager.getAll().filter((layer) => layer.showInTogglePanel));
    };
    refresh();
    return manager.subscribe(refresh);
  }, [manager]);

  // 图层列表异步就绪后补一个默认选中项。
  useEffect(() => {
    if (selectedId && layers.some((layer) => layer.id === selectedId)) return;
    setSelectedId(layers[0]?.id);
  }, [layers, selectedId]);

  const selection = useGevSelection();
  const current = layers.find((layer) => layer.id === selectedId);
  const enabled = current ? manager.isEnabled(current.id) : false;
  const selectionLabel =
    selection?.record?.name ??
    selection?.record?.label ??
    selection?.record?.id ??
    "—";

  return (
    <div className="pointer-events-auto absolute left-3 top-3 z-30 flex w-[300px] flex-col gap-2 rounded-md border border-slate-700 bg-slate-950/80 p-2 font-mono text-xs">
      <div className="flex items-center gap-2">
        <Select
          size="small"
          className="min-w-0 flex-1"
          value={selectedId}
          onChange={setSelectedId}
          placeholder="图层 / layer"
          options={layers.map((layer) => ({
            value: layer.id,
            label: `${layer.name} (${layer.id})`,
          }))}
        />
        <Switch
          size="small"
          checked={enabled}
          onChange={() => {
            if (!current) return;
            void manager.toggle(current.id, { origin: "user" });
          }}
        />
      </div>
      <div className="truncate text-slate-200" title={String(selectionLabel)}>
        {selectionLabel}
      </div>
    </div>
  );
}
