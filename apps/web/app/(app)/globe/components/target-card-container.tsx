"use client";

import {
  clearSelectedEntityContextForLayer,
  getContextStore,
} from "@gev/data/contextStore.js";
import { shownLayerName } from "@gev/ui/layerNames.js";
import { useCockpitStore as getCockpitStore } from "@gev/ui/stores/cockpit.js";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { GlobeTargetRecord } from "@/lib/globe/engine-types";
import type { GevSelection } from "@/lib/globe/gev-events";
import { useGevStore } from "@/lib/globe/pinia-bridge";
import { useGlobeRuntime } from "@/lib/globe/runtime-context";
import { formatTarget } from "@/lib/globe/target-format";
import { normalizeLocale } from "@/lib/i18n";

import { TargetCard } from "./target-card";

const TRACKABLE_LAYERS = new Set([
  "flights",
  "military",
  "satellites",
  "ais-live-vessels",
  "military-installations",
  "local-adsb",
]);

/**
 * 订阅上下文仓库里的实时记录（`data/contextStore.js:103-120` 的
 * `refreshTrackedSubjectContext` 每秒刷新跟踪目标）。按 1 秒重读，不按帧读。
 */
function useLiveRecord(selection: GevSelection | null): GlobeTargetRecord | null {
  const base = (selection?.record ?? null) as GlobeTargetRecord | null;
  const id = base?.id !== undefined && base?.id !== null ? String(base.id) : null;
  const [record, setRecord] = useState<GlobeTargetRecord | null>(base);

  useEffect(() => {
    if (!id) {
      setRecord(null);
      return;
    }
    const read = () => {
      const stored = getContextStore().entities.get(id) as
        | GlobeTargetRecord
        | undefined;
      setRecord(stored ?? base);
    };
    read();
    const timer = window.setInterval(read, 1000);
    return () => window.clearInterval(timer);
  }, [id, base]);

  return record;
}

export function TargetCardContainer({
  selection,
}: {
  selection: GevSelection | null;
}) {
  const runtime = useGlobeRuntime();
  const pathRouter = useRouter();
  const { i18n } = useTranslation();
  const record = useLiveRecord(selection);
  const locale = normalizeLocale(i18n.language);

  // G5：驾驶舱入场可用性（`presence.entryAvailable` 由 CockpitViewController 发布）。
  const cockpitStore = useMemo(
    () => getCockpitStore(runtime.pinia as never),
    [runtime.pinia],
  );
  const presence = useGevStore(
    cockpitStore,
    (state: { presence: { entryAvailable?: boolean } | null }) =>
      state.presence,
  );
  const cockpitEntryAvailable = Boolean(presence?.entryAvailable);

  const view = useMemo(
    () => (record ? formatTarget(record, { locale }) : null),
    [record, locale],
  );

  if (!view || !record) return null;

  const layerId = String(record.layerId ?? "");
  const layerName =
    shownLayerName(String(record.layerName ?? ""), layerId) || layerId;

  const close = () => {
    runtime.actions.untrack();
    if (layerId) clearSelectedEntityContextForLayer(layerId);
  };

  return (
    <TargetCard
      view={view}
      layerName={layerName}
      tracking={TRACKABLE_LAYERS.has(layerId)}
      isTracked={selection?.source === "tracked"}
      onTrack={() => {
        runtime.actions.track(record);
      }}
      onUntrack={() => {
        runtime.actions.untrack();
      }}
      onFlyTo={() => {
        runtime.actions.flyTo(record);
      }}
      onClose={close}
      cockpitEntryAvailable={cockpitEntryAvailable}
      onOpenConsole={(href) => pathRouter.push(href)}
      onEnterCockpit={() => {
        // G3 的按钮不能再占用 `id="cockpit-entry"`（id 唯一）；骨架里的
        // `#cockpit-entry` 才是 GEV 绑定的入口，直接触发它的点击事件。
        document.getElementById("cockpit-entry")?.click();
      }}
    />
  );
}
